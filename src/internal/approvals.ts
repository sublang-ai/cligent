// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { randomUUID } from 'node:crypto';
import { createEvent } from '../events.js';
import type {
  AgentEvent,
  AgentType,
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  ApprovalResponsePayload,
} from '../types.js';

interface ApprovalControllerOptions {
  agent: AgentType;
  handler?: ApprovalHandler;
  signal?: AbortSignal;
  emit: (event: AgentEvent) => void;
  /** Internal fixture seam, never a public permission-policy option. */
  timeoutMs?: number;
}
type NativeApproval = Pick<
  ApprovalRequest,
  | 'sessionId'
  | 'toolUseId'
  | 'toolName'
  | 'input'
  | 'reason'
  | 'details'
  | 'choices'
>;

/** Copy actual JSON data without invoking getters/toJSON or silently losing values. */
function cloneJsonInput(
  value: unknown,
  ancestors = new Set<object>(),
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || ancestors.has(value))
    throw new Error('Approval input must contain only lossless JSON data');

  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    array
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  )
    throw new Error('Approval input must contain only plain JSON objects');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    array &&
    (keys.length !== value.length + 1 ||
      !Array.from({ length: value.length }, (_, index) => String(index)).every(
        (key) => Object.hasOwn(descriptors, key),
      ))
  )
    throw new Error('Approval input must contain only dense JSON arrays');

  const result: unknown[] | Record<string, unknown> = array ? [] : {};
  ancestors.add(value);
  try {
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string')
        throw new Error('Approval input cannot contain symbol keys');
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
        throw new Error(
          'Approval input cannot contain hidden fields or accessors',
        );
      Object.defineProperty(result, key, {
        value: cloneJsonInput(descriptor.value, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function freezeJson<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

/** One invocation's pending native asks; never owns or broadens native policy. */
export class ApprovalController {
  private closed = false;
  private readonly pending = new Set<() => void>();
  private readonly onAbort = (): void => this.close();

  constructor(private readonly options: ApprovalControllerOptions) {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    )
      throw new Error('Approval timeout must be a positive finite duration');
    options.signal?.addEventListener('abort', this.onAbort, { once: true });
    if (options.signal?.aborted) this.close();
  }

  request(
    native: NativeApproval,
    nativeSignal?: AbortSignal,
  ): Promise<ApprovalDecision> {
    const { handler, agent, emit } = this.options;
    if (!handler || this.closed || nativeSignal?.aborted)
      return Promise.resolve('deny');
    if (
      !native.sessionId ||
      !native.toolUseId ||
      !native.toolName ||
      !native.choices.includes('deny') ||
      native.choices.some(
        (choice) => choice !== 'allow_once' && choice !== 'deny',
      )
    )
      return Promise.resolve('deny');

    let request: ApprovalRequest;
    try {
      const createdAt = Date.now();
      const input = cloneJsonInput(native.input);
      if (!input || typeof input !== 'object' || Array.isArray(input))
        return Promise.resolve('deny');
      const details: unknown =
        native.details === undefined
          ? undefined
          : JSON.parse(JSON.stringify(native.details));
      if (
        details !== undefined &&
        (!details || typeof details !== 'object' || Array.isArray(details))
      )
        return Promise.resolve('deny');
      request = freezeJson({
        sessionId: native.sessionId,
        toolUseId: native.toolUseId,
        toolName: native.toolName,
        ...(native.reason !== undefined ? { reason: native.reason } : {}),
        ...(details !== undefined
          ? { details: details as Record<string, unknown> }
          : {}),
        input: input as Record<string, unknown>,
        choices: [...new Set(native.choices)],
        id: randomUUID(),
        kind: 'tool',
        agent,
        createdAt,
        expiresAt: createdAt + (this.options.timeoutMs ?? 600_000),
      });
    } catch {
      return Promise.resolve('deny');
    }

    return new Promise<ApprovalDecision>((resolve) => {
      const controller = new AbortController();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (
        decision: ApprovalDecision,
        source: ApprovalResponsePayload['source'],
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(cancel);
        nativeSignal?.removeEventListener('abort', cancel);
        if (source !== 'host') controller.abort();
        try {
          emit(
            createEvent(
              'approval_response',
              agent,
              { requestId: request.id, decision, source },
              request.sessionId,
            ),
          );
        } catch {
          controller.abort();
          decision = 'deny';
        }
        resolve(decision);
      };
      const cancel = (): void => settle('deny', 'cancelled');
      this.pending.add(cancel);
      nativeSignal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(
        () => settle('deny', 'timeout'),
        request.expiresAt - Date.now(),
      );
      timer.unref?.();
      try {
        emit(
          createEvent('approval_request', agent, request, request.sessionId),
        );
      } catch {
        settle('deny', 'error');
        return;
      }
      // The observer may synchronously cancel when receiving the request.
      if (this.closed || nativeSignal?.aborted) cancel();
      if (settled) return;
      void Promise.resolve()
        .then(() => {
          if (settled) return 'deny' as const;
          return handler(request, { signal: controller.signal });
        })
        .then(
          (decision) => {
            if (Date.now() >= request.expiresAt) settle('deny', 'timeout');
            else if (!request.choices.includes(decision))
              settle('deny', 'error');
            else settle(decision, 'host');
          },
          () => settle('deny', 'error'),
        );
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.options.signal?.removeEventListener('abort', this.onAbort);
    for (const cancel of [...this.pending]) cancel();
  }
}
