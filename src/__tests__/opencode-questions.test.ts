// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter, once } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createServer, type ServerResponse } from 'node:http';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeAdapter, wrapOpencodeClient } from '../adapters/opencode.js';
import { Cligent } from '../cligent.js';
import type { AgentEvent, RunOptions } from '../types.js';

const prompt = 'Continue this owned task';
const request = {
  id: 'question-1',
  sessionID: 'root',
  questions: [
    {
      question: 'Which?',
      header: 'Choice',
      options: [{ label: 'One', description: 'First' }],
    },
  ],
  tool: { messageID: 'assistant-1', callID: 'tool-1' },
};
const event = (type: string, properties: unknown) => ({ type, properties });
const asked = (value = request, version = 'legacy') =>
  event(version === 'v2' ? 'question.v2.asked' : 'question.asked', value);
const idle = event('session.idle', { sessionID: 'root' });
const ownership = [
  event('message.updated', {
    info: { id: 'user-1', sessionID: 'root', role: 'user' },
  }),
  event('message.part.updated', {
    part: {
      id: 'text-1',
      sessionID: 'root',
      messageID: 'user-1',
      type: 'text',
      text: prompt,
    },
  }),
  event('message.updated', {
    info: {
      id: 'assistant-1',
      sessionID: 'root',
      role: 'assistant',
      parentID: 'user-1',
    },
  }),
];

function fixture(version: 'legacy' | 'v2' = 'legacy', managed = false) {
  let pending: unknown[] = [structuredClone(request)];
  let lookup: (() => Promise<unknown>) | undefined;
  let rejectResult: unknown =
    version === 'legacy'
      ? { data: true }
      : { data: {}, response: { status: 204 } };
  let rejectHook: (() => Promise<unknown>) | undefined;
  const replies: unknown[] = [];
  const signals: AbortSignal[] = [];
  const abort = vi.fn(async () => {});
  const handler = vi.fn(async () => 'allow_once' as const);
  const route: Record<string, unknown> = {
    async list(_input: unknown, options: { signal: AbortSignal }) {
      signals.push(options.signal);
      return lookup
        ? lookup()
        : { data: version === 'v2' ? { data: pending } : pending };
    },
    async reject(input: unknown, options: { signal: AbortSignal }) {
      signals.push(options.signal);
      replies.push(input);
      if (rejectHook) return rejectHook();
      pending = [];
      return rejectResult;
    },
  };
  const wrapped = wrapOpencodeClient(
    {
      session: { create: async () => ({}), promptAsync: async () => ({}) },
      event: { subscribe: async () => ({}) },
      ...(version === 'legacy'
        ? { question: route }
        : { v2: { session: { question: route } } }),
    },
    { apiVersion: 'v2' },
  );
  const output: AgentEvent[] = [];
  return {
    replies,
    signals,
    abort,
    handler,
    output,
    route,
    pending(value: unknown[]) {
      pending = value;
    },
    lookup(value: () => Promise<unknown>) {
      lookup = value;
    },
    reject(value: unknown) {
      rejectResult = value;
    },
    rejectHook(value: () => Promise<unknown>) {
      rejectHook = value;
    },
    async run(
      events: unknown[] = [...ownership, asked(request, version), idle],
      options: RunOptions = {},
    ) {
      const adapter = new OpenCodeAdapter(
        {
          mode: managed ? 'managed' : 'external',
          serverUrl: 'http://127.0.0.1:4096',
        },
        {
          ...(managed
            ? {
                spawnProcess: () => {
                  const child = Object.assign(new EventEmitter(), {
                    stdout: new PassThrough(),
                    stderr: new PassThrough(),
                    kill: () => {
                      queueMicrotask(() => child.emit('close', 0, null));
                      return true;
                    },
                  });
                  return child as unknown as ChildProcessWithoutNullStreams;
                },
                waitForServerReady: async () => 'http://127.0.0.1:4096',
              }
            : {}),
          loadSdk: async () => ({
            createClient: () => ({
              ...wrapped,
              run: async () => ({
                sessionId: 'root',
                promptMessageId: 'user-1',
              }),
              async *events() {
                yield* events;
              },
              abortSession: abort,
            }),
          }),
        },
      );
      for await (const item of new Cligent(adapter).run(prompt, {
        approvalHandler: handler,
        ...options,
      }))
        output.push(item);
      return output;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('OpenCode unsupported native questions (opencode-66)', () => {
  it.each(['legacy', 'v2'] as const)(
    'declines a fresh owned %s question without a host decision',
    async (version) => {
      const f = fixture(version);
      const output = await f.run([
        ...ownership,
        asked(request, version),
        asked(request, version),
        idle,
      ]);
      expect(f.replies).toEqual([
        version === 'v2'
          ? { sessionID: 'root', requestID: 'question-1' }
          : { requestID: 'question-1' },
      ]);
      expect(f.handler).not.toHaveBeenCalled();
      expect(
        output.filter(
          (e) =>
            e.type === 'approval_request' || e.type === 'approval_response',
        ),
      ).toEqual([]);
      expect(output.at(-1)?.payload).toMatchObject({ status: 'success' });
      expect(f.abort).not.toHaveBeenCalled();
    },
  );

  it('reconsiders a resumed question after late causal metadata', async () => {
    const f = fixture();
    await f.run([asked(), ...ownership, idle], { resume: 'root' });
    expect(f.replies).toHaveLength(1);
  });

  it('declines only explicit descendant lineage on its adapter-owned managed server', async () => {
    const f = fixture('legacy', true);
    const child = { ...request, sessionID: 'child' };
    const foreign = { ...request, id: 'foreign-question', sessionID: 'other' };
    f.pending([child, foreign]);
    await f.run([
      event('session.created', { info: { id: 'child', parentID: 'root' } }),
      asked(child),
      asked(foreign),
      idle,
    ]);
    expect(f.replies).toEqual([{ requestID: request.id }]);
    expect(f.abort).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'leaves external descendant questions untouched even with accounting linkage (linked=%s)',
    async (linked) => {
      const f = fixture();
      const childQuestion = {
        ...request,
        sessionID: 'child',
        tool: { messageID: 'child-assistant', callID: 'child-call' },
      };
      f.pending([childQuestion]);
      await f.run(
        [
          ...ownership,
          event('session.created', { info: { id: 'child', parentID: 'root' } }),
          asked(childQuestion),
          ...(linked
            ? [
                event('message.part.updated', {
                  part: {
                    id: 'task-part',
                    sessionID: 'root',
                    messageID: 'assistant-1',
                    type: 'tool',
                    tool: 'task',
                    callID: 'task-call',
                    state: {
                      status: 'running',
                      input: {},
                      metadata: { sessionId: 'child' },
                    },
                  },
                }),
              ]
            : []),
          event('message.updated', {
            info: { id: 'child-user', sessionID: 'child', role: 'user' },
          }),
          event('message.updated', {
            info: {
              id: 'child-assistant',
              sessionID: 'child',
              role: 'assistant',
              parentID: 'child-user',
            },
          }),
          idle,
        ],
        { resume: 'root' },
      );
      expect(f.replies).toHaveLength(0);
      expect(f.abort).not.toHaveBeenCalled();
    },
  );

  it('uses the v2 data envelope request identity rather than outer event id', async () => {
    const f = fixture('v2');
    await f.run([
      ...ownership,
      { type: 'question.v2.asked', id: 'transport-id', data: request },
      idle,
    ]);
    expect(f.replies).toEqual([{ sessionID: 'root', requestID: 'question-1' }]);
  });

  it('does not claim a tool-free question belongs to its prompt', async () => {
    const withoutTool = {
      id: request.id,
      sessionID: request.sessionID,
      questions: request.questions,
    };
    for (const resume of [undefined, 'root']) {
      const f = fixture();
      f.pending([withoutTool]);
      await f.run(
        [asked(withoutTool as typeof request), idle],
        resume ? { resume } : {},
      );
      expect(f.replies).toHaveLength(0);
      expect(f.abort).not.toHaveBeenCalled();
    }
  });

  it.each([
    'unknown',
    'foreign-message',
    'foreign-session',
    'ambiguous-prompt',
    'answered-before-proof',
  ])(
    'does not reject or abort a %s question in a shared session',
    async (mode) => {
      const f = fixture();
      const info =
        mode === 'foreign-session'
          ? { ...request, sessionID: 'other' }
          : request;
      const events: unknown[] = [asked(info)];
      if (mode === 'foreign-message')
        events.push(
          ...ownership.slice(0, 2),
          event('message.updated', {
            info: {
              id: 'assistant-1',
              sessionID: 'root',
              role: 'assistant',
              parentID: 'another-user',
            },
          }),
        );
      if (mode === 'ambiguous-prompt')
        events.push(
          ...ownership.slice(0, 2),
          event('message.part.updated', {
            part: {
              id: 'text-2',
              sessionID: 'root',
              messageID: 'user-2',
              type: 'text',
              text: prompt,
            },
          }),
          event('message.updated', {
            info: {
              id: 'assistant-1',
              sessionID: 'root',
              role: 'assistant',
              parentID: 'user-2',
            },
          }),
        );
      if (mode === 'answered-before-proof')
        events.push(
          event('question.replied', {
            sessionID: 'root',
            requestID: 'question-1',
          }),
          ...ownership,
        );
      events.push(idle);
      await f.run(events, { resume: 'root' });
      expect(f.replies).toEqual([]);
      expect(f.abort).not.toHaveBeenCalled();
      expect(f.handler).not.toHaveBeenCalled();
    },
  );

  it('never treats an earlier identical foreign prompt as current control authority', async () => {
    const f = fixture();
    const foreign = {
      ...request,
      id: 'foreign-question',
      tool: { messageID: 'foreign-assistant', callID: 'foreign-call' },
    };
    f.pending([foreign, request]);
    await f.run(
      [
        event('message.updated', {
          info: { id: 'foreign-user', sessionID: 'root', role: 'user' },
        }),
        event('message.part.updated', {
          part: {
            id: 'foreign-text',
            sessionID: 'root',
            messageID: 'foreign-user',
            type: 'text',
            text: prompt,
          },
        }),
        event('message.updated', {
          info: {
            id: 'foreign-assistant',
            sessionID: 'root',
            role: 'assistant',
            parentID: 'foreign-user',
          },
        }),
        asked(foreign),
        ...ownership,
        asked(),
        idle,
      ],
      { resume: 'root' },
    );
    expect(f.replies).toEqual([{ requestID: request.id }]);
    expect(f.abort).not.toHaveBeenCalled();
  });

  it.each(['id', 'sessionID', 'questions', 'messageID', 'callID', 'removed'])(
    'ignores a pending question changed in %s',
    async (field) => {
      const f = fixture();
      const changed = structuredClone(request);
      if (field === 'id') changed.id = 'other';
      if (field === 'sessionID') changed.sessionID = 'other';
      if (field === 'questions') changed.questions[0]!.question = 'Changed';
      if (field === 'messageID') changed.tool.messageID = 'other';
      if (field === 'callID') changed.tool.callID = 'other';
      f.pending(field === 'removed' ? [] : [changed]);
      await f.run();
      expect(f.replies).toEqual([]);
      expect(f.abort).not.toHaveBeenCalled();
    },
  );

  it('treats only matching typed question-not-found as already answered', async () => {
    const f = fixture();
    f.reject({
      error: {
        _tag: 'QuestionNotFoundError',
        requestID: request.id,
        message: 'Already answered',
      },
    });
    await f.run();
    expect(f.output.at(-1)?.payload).toMatchObject({ status: 'success' });
    expect(f.abort).not.toHaveBeenCalled();
  });

  it.each([
    'missing-route',
    'lookup-error',
    'malformed-registry',
    'wrong-notfound',
    'generic404',
    'unconfirmed',
    'missing-id',
    'missing-tool-call',
  ])('fails boundedly on proved-owned %s', async (mode) => {
    const f = fixture();
    if (mode === 'missing-route') delete f.route.reject;
    if (mode === 'lookup-error')
      f.lookup(async () => {
        throw new Error('disconnected');
      });
    if (mode === 'malformed-registry') f.lookup(async () => ({ data: {} }));
    if (mode === 'wrong-notfound')
      f.reject({
        error: {
          _tag: 'QuestionNotFoundError',
          requestID: 'wrong',
          message: 'missing',
        },
      });
    if (mode === 'generic404')
      f.reject({ error: { code: 404, message: 'missing' } });
    if (mode === 'unconfirmed') f.reject({ data: false });
    const native = structuredClone(request);
    if (mode === 'missing-id') native.id = '';
    if (mode === 'missing-tool-call') native.tool.callID = '';
    f.pending([native]);
    await f.run([...ownership, asked(native), idle]);
    expect(f.abort).toHaveBeenCalledTimes(1);
    expect(f.output.filter((e) => e.type === 'error')).toMatchObject([
      { payload: { code: 'OPENCODE_QUESTION_REPLY_FAILED' } },
    ]);
    expect(f.output.filter((e) => e.type === 'done')).toMatchObject([
      { payload: { status: 'error' } },
    ]);
    expect(f.handler).not.toHaveBeenCalled();
  });

  it.each(['lookup', 'reject'] as const)(
    'bounds a nonsettling %s and cancels its native I/O',
    async (phase) => {
      vi.useFakeTimers();
      const f = fixture();
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const hang = () => {
        entered();
        return new Promise<never>(() => {});
      };
      if (phase === 'lookup') f.lookup(hang);
      else f.rejectHook(hang);
      const run = f.run();
      await ready;
      await vi.advanceTimersByTimeAsync(5_001);
      await run;
      expect(f.abort).toHaveBeenCalledTimes(1);
      expect(f.signals.every((signal) => signal.aborted)).toBe(true);
      expect(f.output.at(-1)?.payload).toMatchObject({ status: 'error' });
    },
  );

  it('caller cancellation wins while a native lookup is pending', async () => {
    const f = fixture();
    const controller = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.lookup(() => {
      entered();
      return new Promise<never>(() => {});
    });
    const run = f.run(undefined, { abortSignal: controller.signal });
    await ready;
    controller.abort();
    await run;
    expect(f.replies).toEqual([]);
    expect(f.signals.every((signal) => signal.aborted)).toBe(true);
    expect(f.output.filter((e) => e.type === 'error')).toEqual([]);
    expect(f.output.at(-1)?.payload).toMatchObject({ status: 'interrupted' });
  });

  it('shares one five-second budget across lookup and rejection', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.lookup(async () => {
      entered();
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return { data: [request] };
    });
    f.rejectHook(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      return { data: true };
    });
    const run = f.run();
    await ready;
    await vi.advanceTimersByTimeAsync(5_001);
    await run;
    expect(f.output.at(-1)?.payload).toMatchObject({ status: 'error' });
    expect(f.abort).toHaveBeenCalledTimes(1);
    expect(f.signals.every((signal) => signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.output.filter((item) => item.type === 'done')).toHaveLength(1);
  });

  it.each(['legacy', 'v2'] as const)(
    'uses the installed SDK %s question HTTP codec without mutating policy',
    async (version) => {
      const calls: Array<{ method: string; path: string; body: unknown }> = [];
      const subscribers = new Set<ServerResponse>();
      const send = (value: unknown) => {
        for (const subscriber of subscribers)
          subscriber.write(`data: ${JSON.stringify(value)}\n\n`);
      };
      const server = createServer((incoming, response) => {
        void (async () => {
          const url = new URL(incoming.url!, 'http://localhost');
          let body = '';
          for await (const chunk of incoming) body += String(chunk);
          calls.push({
            method: incoming.method!,
            path: url.pathname,
            body: body ? JSON.parse(body) : undefined,
          });
          if (url.pathname === '/event') {
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            subscribers.add(response);
            response.on('close', () => subscribers.delete(response));
            send(event('server.connected', {}));
            return;
          }
          if (url.pathname.endsWith('/prompt_async')) {
            response.writeHead(204).end();
            const submittedId = (JSON.parse(body) as { messageID: string })
              .messageID;
            send(
              event('message.updated', {
                info: {
                  id: 'assistant-1',
                  sessionID: 'root',
                  role: 'assistant',
                  parentID: submittedId,
                },
              }),
            );
            send(asked(request, version));
            return;
          }
          if (url.pathname.endsWith('/reject')) {
            if (version === 'v2') response.writeHead(204).end();
            else
              response
                .writeHead(200, { 'content-type': 'application/json' })
                .end('true');
            send(idle);
            return;
          }
          const data =
            url.pathname === '/global/health'
              ? { healthy: true, version: '1.18.33' }
              : url.pathname === '/question'
                ? [request]
                : url.pathname === '/api/session/root/question'
                  ? { data: [request] }
                  : { id: 'root', title: 'Cligent run' };
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(data));
        })().catch((error) => response.writeHead(500).end(String(error)));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No fixture port');
      const serverUrl = `http://127.0.0.1:${address.port}`;
      const adapter = new OpenCodeAdapter(
        { mode: 'external', serverUrl },
        {
          loadSdk: async () => ({
            createClient: () =>
              wrapOpencodeClient(
                createOpencodeClient({
                  baseUrl: serverUrl,
                }) as unknown as Record<string, unknown>,
                { apiVersion: 'v2' },
              ),
          }),
        },
      );
      try {
        const output: AgentEvent[] = [];
        for await (const item of new Cligent(adapter).run(prompt, {
          permissions: { fileWrite: 'deny', shellExecute: 'ask' },
        }))
          output.push(item);
        expect(output.at(-1)?.payload, JSON.stringify(output)).toMatchObject({
          status: 'success',
        });
        expect(calls.filter((call) => call.path.endsWith('/reject'))).toEqual([
          {
            method: 'POST',
            path:
              version === 'v2'
                ? '/api/session/root/question/question-1/reject'
                : '/question/question-1/reject',
            body: undefined,
          },
        ]);
        expect(
          calls.find(
            (call) => call.path === '/session' && call.method === 'POST',
          )?.body,
        ).toMatchObject({
          permission: [
            { permission: 'edit', pattern: '*', action: 'deny' },
            { permission: 'bash', pattern: '*', action: 'ask' },
            { permission: 'webfetch', pattern: '*', action: 'ask' },
          ],
        });
        expect(
          calls.find((call) => call.path.endsWith('/prompt_async'))?.body,
        ).not.toHaveProperty('tools');
      } finally {
        for (const subscriber of subscribers) subscriber.end();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
