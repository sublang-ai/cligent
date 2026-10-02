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
      const input: unknown = JSON.parse(JSON.stringify(native.input));
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
            else if (!request.choices.includes(decision)) settle('deny', 'error');
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
