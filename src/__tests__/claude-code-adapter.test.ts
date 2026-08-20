// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, it, expect } from 'vitest';

import {
  ClaudeCodeAdapter,
  mapAgentOptionsToClaudeQueryOptions,
  mapEffortToClaudeOptions,
  mapPermissionsToClaudeOptions,
} from '../adapters/claude-code.js';
import type {
  AgentEvent,
  AgentOptions,
  ClaudeEffort,
  DonePayload,
  InitPayload,
  PermissionLevel,
  PermissionPolicy,
} from '../types.js';

// Derived from the adapter so the mock SDK and the decision assertions cannot
// drift from the adapter's actual `canUseTool` type / `PermissionResult`.
type AdapterCanUseTool = NonNullable<
  ReturnType<typeof mapPermissionsToClaudeOptions>['canUseTool']
>;
type ClaudeDecision = Awaited<ReturnType<AdapterCanUseTool>>;

interface MockSdkInnerOptions {
  cwd?: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  resume?: string;
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  settingSources?: Array<'user' | 'project' | 'local'>;
  strictMcpConfig?: boolean;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  canUseTool?: AdapterCanUseTool;
  abortController?: AbortController;
  env?: Record<string, string | undefined>;
  effort?: string;
  settings?: { ultracode?: boolean };
  sessionId?: string;
}

interface MockSdkOptions {
  prompt: string;
  options?: MockSdkInnerOptions;
}

// 'allow' resolves to a pass-through allow; 'ask' and 'deny' both resolve to a
// headless deny with a message per claude-code-5.
function expectClaudeDecision(
  decision: ClaudeDecision,
  level: PermissionLevel,
  input: Record<string, unknown>,
): void {
  if (level === 'allow') {
    expect(decision).toEqual({ behavior: 'allow', updatedInput: input });
    return;
  }
  expect(decision.behavior).toBe('deny');
  if (decision.behavior === 'deny') {
    expect(decision.message.length).toBeGreaterThan(0);
  }
}

function makeLoader(
  messages: unknown[],
  onOptions?: (options: MockSdkInnerOptions & { prompt: string }) => void,
): () => Promise<{ query(options: MockSdkOptions): AsyncIterable<unknown> }> {
  return async () => ({
    query(options: MockSdkOptions): AsyncIterable<unknown> {
      if (onOptions) {
        onOptions({ prompt: options.prompt, ...options.options });
      }
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, void> {
          for (const message of messages) {
            yield message;
          }
        },
      };
    },
  });
}

async function collect(
  stream: AsyncGenerator<AgentEvent, void, void>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('ClaudeCodeAdapter', () => {
  it('maps SDK messages to unified events', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude-3-7-sonnet',
          cwd: '/repo',
          tools: ['Write', 'Bash'],
          sessionId: 'session-1',
        },
        {
          type: 'assistant',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'thinking', summary: 'Planning file edits' },
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Bash',
              input: { command: 'ls' },
            },
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              toolName: 'Bash',
              status: 'success',
              content: { stdout: 'file-a\\nfile-b' },
              duration_ms: 12,
            },
          ],
        },
        { type: 'stream', delta: ' there' },
        {
          type: 'error',
          code: 'TRANSIENT',
          message: 'temporary backend issue',
          recoverable: true,
        },
        {
          type: 'result',
          status: 'max_turns',
          result: 'done text',
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            tool_uses: 1,
          },
          // Cost is a sibling of `usage` on the result message, not a member.
          total_cost_usd: 0.25,
          duration_ms: 321,
        },
      ]),
    });

    const events = await collect(adapter.run('hi'));

    expect(events.map((event) => event.type)).toEqual([
      'init',
      'text',
      'thinking',
      'tool_use',
      'tool_result',
      'text_delta',
      'error',
      'done',
    ]);

    const init = events[0] as AgentEvent & {
      payload: { model: string; cwd: string; tools: string[] };
    };
    expect(init.payload.model).toBe('claude-3-7-sonnet');
    expect(init.payload.cwd).toBe('/repo');
    expect(init.payload.tools).toEqual(['Write', 'Bash']);

    const text = events[1] as AgentEvent & { payload: { content: string } };
    expect(text.payload.content).toBe('hello');

    const thinking = events[2] as AgentEvent & { payload: { summary: string } };
    expect(thinking.payload.summary).toBe('Planning file edits');

    const toolUse = events[3] as AgentEvent & {
      payload: {
        toolName: string;
        toolUseId: string;
        input: Record<string, unknown>;
      };
    };
    expect(toolUse.payload.toolName).toBe('Bash');
    expect(toolUse.payload.toolUseId).toBe('tool-1');
    expect(toolUse.payload.input).toEqual({ command: 'ls' });

    const toolResult = events[4] as AgentEvent & {
      payload: {
        toolName: string;
        toolUseId: string;
        status: string;
        output: unknown;
        durationMs?: number;
      };
    };
    expect(toolResult.payload.toolName).toBe('Bash');
    expect(toolResult.payload.toolUseId).toBe('tool-1');
    expect(toolResult.payload.status).toBe('success');
    expect(toolResult.payload.output).toEqual({ stdout: 'file-a\\nfile-b' });
    expect(toolResult.payload.durationMs).toBe(12);

    const textDelta = events[5] as AgentEvent & { payload: { delta: string } };
    expect(textDelta.payload.delta).toBe(' there');

    const error = events[6] as AgentEvent & {
      payload: { code: string; message: string; recoverable: boolean };
    };
    expect(error.payload.code).toBe('TRANSIENT');
    expect(error.payload.message).toBe('temporary backend issue');
    expect(error.payload.recoverable).toBe(true);

    const done = events[7] as AgentEvent & {
      payload: {
        status: string;
        result: string;
        usage: DonePayload['usage'];
        durationMs: number;
      };
    };
    expect(done.payload.status).toBe('max_turns');
    expect(done.payload.result).toBe('done text');
    expect(done.payload.usage).toEqual({
      toolUses: 1,
      cost: {
        amount: 0.25,
        currency: 'USD',
        source: 'agent-estimate',
      },
    });
    expect(done.payload.durationMs).toBe(321);
  });

  it('preserves assistant content-block order in emitted events', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: ['Write', 'Bash'],
          sessionId: 'session-order',
        },
        {
          type: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-9',
              name: 'Bash',
              input: { command: 'pwd' },
            },
            { type: 'thinking', summary: 'Checking working directory' },
            {
              type: 'tool_result',
              tool_use_id: 'tool-9',
              toolName: 'Bash',
              status: 'success',
              content: { stdout: '/repo' },
            },
            { type: 'text', text: 'Done.' },
          ],
          sessionId: 'session-order',
        },
        {
          type: 'result',
          status: 'success',
          usage: { input_tokens: 1, output_tokens: 2, tool_uses: 1 },
          sessionId: 'session-order',
        },
      ]),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'tool_use',
      'thinking',
      'tool_result',
      'text',
      'done',
    ]);
  });

  it('returns false from isAvailable when SDK load fails', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: async () => {
        throw new Error('not installed');
      },
    });

    await expect(adapter.isAvailable()).resolves.toBe(false);
  });

  it('throws from run when SDK is not installed', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: async () => {
        throw new Error('not installed');
      },
    });

    const stream = adapter.run('prompt');
    await expect(stream.next()).rejects.toThrow(
      'ClaudeCodeAdapter requires @anthropic-ai/claude-agent-sdk. Install it to use this adapter.',
    );
  });

  it('maps permission policy combinations correctly', async () => {
    const levels: PermissionLevel[] = ['allow', 'ask', 'deny'];
    const input: Record<string, unknown> = { file_path: '/tmp/scratch.txt' };

    for (const fileWrite of levels) {
      for (const shellExecute of levels) {
        for (const networkAccess of levels) {
          const policy: PermissionPolicy = {
            fileWrite,
            shellExecute,
            networkAccess,
          };

          const mapped = mapPermissionsToClaudeOptions(policy);

          const allAllow =
            fileWrite === 'allow' &&
            shellExecute === 'allow' &&
            networkAccess === 'allow';

          if (allAllow) {
            expect(mapped.permissionMode).toBe('bypassPermissions');
            expect(mapped.allowDangerouslySkipPermissions).toBe(true);
            expect(mapped.canUseTool).toBeUndefined();
            continue;
          }

          const acceptEditsCase =
            fileWrite === 'allow' &&
            shellExecute === 'ask' &&
            networkAccess === 'ask';

          if (acceptEditsCase) {
            expect(mapped.permissionMode).toBe('acceptEdits');
            expect(mapped.canUseTool).toBeUndefined();
            continue;
          }

          const hasDirective = [fileWrite, shellExecute, networkAccess].some(
            (level) => level === 'allow' || level === 'deny',
          );
          if (!hasDirective) {
            // Every capability 'ask': no enforceable directive. Per DR-005
            // cligent imposes no posture — bare 'default', no callback.
            expect(mapped.permissionMode).toBe('default');
            expect(mapped.canUseTool).toBeUndefined();
            continue;
          }

          expect(mapped.permissionMode).toBe('default');
          expect(mapped.canUseTool).toBeTypeOf('function');

          // The callback conforms to the SDK CanUseTool contract: invoked
          // (toolName, input), it resolves to a PermissionResult.
          expectClaudeDecision(
            await mapped.canUseTool!('Write', input),
            fileWrite,
            input,
          );
          expectClaudeDecision(
            await mapped.canUseTool!('Edit', input),
            fileWrite,
            input,
          );
          expectClaudeDecision(
            await mapped.canUseTool!('Bash', input),
            shellExecute,
            input,
          );
          expectClaudeDecision(
            await mapped.canUseTool!('WebFetch', input),
            networkAccess,
            input,
          );
          // A tool matching no UPM capability is not permission-gated.
          expect(await mapped.canUseTool!('WriteConfig', input)).toEqual({
            behavior: 'allow',
            updatedInput: input,
          });
        }
      }
    }
  });

  it('treats a missing permissions policy as no override (DR-005)', () => {
    // Regression: a tmux-play player with no `permissions` block reaches the
    // adapter as `undefined`. It must yield bare 'default' with no
    // `canUseTool` — synthesizing a callback here is the defect that made
    // the real SDK ZodError on every Write/Bash call.
    const mapped = mapPermissionsToClaudeOptions(undefined);
    expect(mapped.permissionMode).toBe('default');
    expect(mapped.canUseTool).toBeUndefined();
    expect(mapped.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it('passes agent options through to SDK query options', async () => {
    let captured: (MockSdkInnerOptions & { prompt: string }) | undefined;

    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader(
        [
          {
            type: 'result',
            status: 'success',
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        ],
        (options) => {
          captured = options;
        },
      ),
    });

    await collect(
      adapter.run('prompt text', {
        cwd: '/tmp/workdir',
        model: 'claude-3-5-sonnet',
        maxTurns: 9,
        maxBudgetUsd: 4.5,
        resume: 'session-abc',
        permissions: {
          fileWrite: 'deny',
          shellExecute: 'allow',
          networkAccess: 'ask',
        },
        allowedTools: ['Bash', 'Write'],
        disallowedTools: ['WebFetch'],
      }),
    );

    expect(captured).toBeDefined();
    expect(captured).toMatchObject({
      prompt: 'prompt text',
      cwd: '/tmp/workdir',
      model: 'claude-3-5-sonnet',
      maxTurns: 9,
      maxBudgetUsd: 4.5,
      resume: 'session-abc',
      tools: ['Bash', 'Write'],
      allowedTools: ['Bash', 'Write'],
      disallowedTools: ['WebFetch'],
      strictMcpConfig: true,
      permissionMode: 'default',
    });
    expect(captured?.sessionId).toBeUndefined();
    expect(captured?.canUseTool).toBeTypeOf('function');
    const toolInput: Record<string, unknown> = { file_path: '/tmp/x' };
    // fileWrite 'deny' -> deny; shellExecute 'allow' -> allow;
    // networkAccess 'ask' -> headless deny.
    expect(await captured!.canUseTool!('Write', toolInput)).toMatchObject({
      behavior: 'deny',
    });
    expect(await captured!.canUseTool!('Bash', toolInput)).toEqual({
      behavior: 'allow',
      updatedInput: toolInput,
    });
    expect(await captured!.canUseTool!('WebFetch', toolInput)).toMatchObject({
      behavior: 'deny',
    });
  });

  it('uses SDK tool and ambient-source isolation for an empty allowlist', () => {
    const isolated = mapAgentOptionsToClaudeQueryOptions({
      allowedTools: [],
    }).queryOptions;

    expect(isolated.tools).toEqual([]);
    expect(isolated.allowedTools).toEqual([]);
    expect(isolated.settingSources).toEqual([]);
    expect(isolated.strictMcpConfig).toBe(true);

    const native = mapAgentOptionsToClaudeQueryOptions(undefined).queryOptions;
    expect(native.tools).toBeUndefined();
    expect(native.allowedTools).toBeUndefined();
    expect(native.settingSources).toBeUndefined();
    expect(native.strictMcpConfig).toBeUndefined();
  });

  it('treats an empty resume value as absent for SDK query options', async () => {
    let captured: (MockSdkInnerOptions & { prompt: string }) | undefined;

    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader(
        [
          {
            type: 'result',
            status: 'success',
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        ],
        (options) => {
          captured = options;
        },
      ),
    });

    await collect(adapter.run('prompt text', { resume: '' }));

    expect(captured?.resume).toBeUndefined();
    expect(captured?.sessionId).toBeDefined();
  });

  it('propagates abort signal to SDK abortController', async () => {
    const externalAbort = new AbortController();
    let innerAbortController: AbortController | undefined;

    const adapter = new ClaudeCodeAdapter({
      loadSdk: async () => ({
        query(opts: MockSdkOptions): AsyncIterable<unknown> {
          innerAbortController = opts.options?.abortController;
          return {
            async *[Symbol.asyncIterator](): AsyncGenerator<
              unknown,
              void,
              void
            > {
              yield {
                type: 'system',
                subtype: 'init',
                model: 'claude',
                cwd: '/cwd',
                tools: [],
              };

              await new Promise<void>((resolve) => {
                if (opts.options?.abortController?.signal.aborted) {
                  resolve();
                  return;
                }
                opts.options?.abortController?.signal.addEventListener(
                  'abort',
                  () => resolve(),
                  {
                    once: true,
                  },
                );
              });

              yield {
                type: 'result',
                status: 'interrupted',
                usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
              };
            },
          };
        },
      }),
    });

    const stream = adapter.run('prompt', { abortSignal: externalAbort.signal });

    const first = await stream.next();
    expect(first.done).toBe(false);
    expect(first.value?.type).toBe('init');

    expect(innerAbortController).toBeDefined();
    expect(innerAbortController?.signal.aborted).toBe(false);

    externalAbort.abort();

    expect(innerAbortController?.signal.aborted).toBe(true);

    const second = await stream.next();
    expect(second.done).toBe(false);
    expect(second.value?.type).toBe('done');
  });

  it('emits interrupted done when aborted stream ends without result', async () => {
    const externalAbort = new AbortController();

    const adapter = new ClaudeCodeAdapter({
      loadSdk: async () => ({
        query(opts: MockSdkOptions): AsyncIterable<unknown> {
          return {
            async *[Symbol.asyncIterator](): AsyncGenerator<
              unknown,
              void,
              void
            > {
              yield {
                type: 'system',
                subtype: 'init',
                model: 'claude',
                cwd: '/repo',
                tools: [],
                sessionId: 'session-abort',
              };

              await new Promise<void>((resolve) => {
                if (opts.options?.abortController?.signal.aborted) {
                  resolve();
                  return;
                }
                opts.options?.abortController?.signal.addEventListener(
                  'abort',
                  () => resolve(),
                  {
                    once: true,
                  },
                );
              });
            },
          };
        },
      }),
    });

    const stream = adapter.run('prompt', { abortSignal: externalAbort.signal });
    const first = await stream.next();
    expect(first.done).toBe(false);
    expect(first.value?.type).toBe('init');

    externalAbort.abort();

    const rest = await collect(stream);
    expect(rest.map((event) => event.type)).toEqual(['done']);
    const done = rest[0] as AgentEvent & { payload: { status: string } };
    expect(done.payload.status).toBe('interrupted');
  });

  it('emits interrupted done when aborted stream throws', async () => {
    const externalAbort = new AbortController();

    const adapter = new ClaudeCodeAdapter({
      loadSdk: async () => ({
        query(opts: MockSdkOptions): AsyncIterable<unknown> {
          return {
            async *[Symbol.asyncIterator](): AsyncGenerator<
              unknown,
              void,
              void
            > {
              yield {
                type: 'system',
                subtype: 'init',
                model: 'claude',
                cwd: '/repo',
                tools: [],
                sessionId: 'session-abort-throw',
              };

              await new Promise<void>((resolve) => {
                if (opts.options?.abortController?.signal.aborted) {
                  resolve();
                  return;
                }
                opts.options?.abortController?.signal.addEventListener(
                  'abort',
                  () => resolve(),
                  {
                    once: true,
                  },
                );
              });

              throw new Error('AbortError');
            },
          };
        },
      }),
    });

    const stream = adapter.run('prompt', { abortSignal: externalAbort.signal });
    const first = await stream.next();
    expect(first.done).toBe(false);
    expect(first.value?.type).toBe('init');

    externalAbort.abort();

    const rest = await collect(stream);
    expect(rest.map((event) => event.type)).toEqual(['done']);
    const done = rest[0] as AgentEvent & { payload: { status: string } };
    expect(done.payload.status).toBe('interrupted');
  });

  it('sets interrupted resumeToken from activity id or inbound resume, not init-only fresh id', async () => {
    async function interruptedResumeToken(options: {
      backendSessionId?: string;
      resume?: string;
      assistantActivity?: boolean;
    }): Promise<{
      resumeToken: string | undefined;
      sdkSessionId: string | undefined;
    }> {
      const externalAbort = new AbortController();
      let sdkSessionId: string | undefined;
      const adapter = new ClaudeCodeAdapter({
        loadSdk: async () => ({
          query(opts: MockSdkOptions): AsyncIterable<unknown> {
            sdkSessionId = opts.options?.sessionId;
            return {
              async *[Symbol.asyncIterator](): AsyncGenerator<
                unknown,
                void,
                void
              > {
                yield {
                  type: 'system',
                  subtype: 'init',
                  model: 'claude',
                  cwd: '/repo',
                  tools: [],
                  ...(options.backendSessionId
                    ? { sessionId: options.backendSessionId }
                    : {}),
                };
                if (options.assistantActivity) {
                  yield {
                    type: 'assistant',
                    text: 'started',
                    ...(options.backendSessionId
                      ? { sessionId: options.backendSessionId }
                      : {}),
                  };
                }

                await new Promise<void>((resolve) => {
                  if (opts.options?.abortController?.signal.aborted) {
                    resolve();
                    return;
                  }
                  opts.options?.abortController?.signal.addEventListener(
                    'abort',
                    () => resolve(),
                    { once: true },
                  );
                });
              },
            };
          },
        }),
      });

      const stream = adapter.run('prompt', {
        abortSignal: externalAbort.signal,
        ...(options.resume ? { resume: options.resume } : {}),
      });
      const first = await stream.next();
      expect(first.done).toBe(false);
      expect(first.value?.type).toBe('init');

      externalAbort.abort();

      const rest = await collect(stream);
      const done = rest.find((event) => event.type === 'done') as AgentEvent & {
        payload: { status: string; resumeToken?: string };
      };
      expect(done.payload.status).toBe('interrupted');
      return { resumeToken: done.payload.resumeToken, sdkSessionId };
    }

    await expect(
      interruptedResumeToken({
        backendSessionId: 'session-abort-new',
        assistantActivity: true,
      }),
    ).resolves.toMatchObject({
      resumeToken: 'session-abort-new',
    });
    await expect(
      interruptedResumeToken({ resume: 'session-abort-resume' }),
    ).resolves.toEqual({
      resumeToken: 'session-abort-resume',
      sdkSessionId: undefined,
    });
    const activeFresh = await interruptedResumeToken({
      assistantActivity: true,
    });
    expect(activeFresh.sdkSessionId).toBeDefined();
    expect(activeFresh.resumeToken).toBe(activeFresh.sdkSessionId);
    const initOnlyFresh = await interruptedResumeToken({});
    expect(initOnlyFresh.sdkSessionId).toBeDefined();
    expect(initOnlyFresh.resumeToken).toBeUndefined();
  });

  it('sets fresh sessionId before the first SDK message without treating it as persisted', async () => {
    const externalAbort = new AbortController();
    let sdkSessionId: string | undefined;
    let resolveQueryStarted: (() => void) | undefined;
    const queryStarted = new Promise<void>((resolve) => {
      resolveQueryStarted = resolve;
    });
    const adapter = new ClaudeCodeAdapter({
      loadSdk: async () => ({
        query(opts: MockSdkOptions): AsyncIterable<unknown> {
          sdkSessionId = opts.options?.sessionId;
          resolveQueryStarted?.();
          return {
            async *[Symbol.asyncIterator](): AsyncGenerator<
              unknown,
              void,
              void
            > {
              await new Promise<void>((resolve) => {
                if (opts.options?.abortController?.signal.aborted) {
                  resolve();
                  return;
                }
                opts.options?.abortController?.signal.addEventListener(
                  'abort',
                  () => resolve(),
                  { once: true },
                );
              });
            },
          };
        },
      }),
    });

    const eventsPromise = collect(
      adapter.run('prompt', { abortSignal: externalAbort.signal }),
    );
    await queryStarted;
    externalAbort.abort();

    const events = await eventsPromise;
    const done = events.find((event) => event.type === 'done') as AgentEvent & {
      payload: { status: string; resumeToken?: string };
    };

    expect(sdkSessionId).toBeDefined();
    expect(done.payload).toMatchObject({
      status: 'interrupted',
    });
    expect(done.payload.resumeToken).toBeUndefined();
  });

  it('builds query options with mapped permissions helper', () => {
    const mapped = mapAgentOptionsToClaudeQueryOptions({
      permissions: {
        fileWrite: 'allow',
        shellExecute: 'ask',
        networkAccess: 'ask',
      },
    });

    expect(mapped.queryOptions.permissionMode).toBe('acceptEdits');
    expect(mapped.queryOptions.allowDangerouslySkipPermissions).toBeUndefined();
    expect(mapped.queryOptions.canUseTool).toBeUndefined();
  });

  it('emits error + done when stream ends without result', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: [],
          sessionId: 'session-1',
        },
        {
          type: 'assistant',
          content: [{ type: 'text', text: 'partial response' }],
          sessionId: 'session-1',
        },
      ]),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'text',
      'error',
      'done',
    ]);

    const error = events[2] as AgentEvent & {
      payload: { code: string; message: string; recoverable: boolean };
    };
    expect(error.payload.code).toBe('MISSING_RESULT');
    expect(error.payload.recoverable).toBe(false);

    const done = events[3] as AgentEvent & { payload: { status: string } };
    expect(done.payload.status).toBe('error');
  });

  it('skips the resume-repair no-op result and terminates on the real result', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: [],
          sessionId: 'session-resume',
        },
        // Internal continuation-repair no-op turn emitted by Claude Code when
        // resuming a session whose previous turn ended with a dangling tool
        // call: success-classified, no result text, zero usage.
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          stop_reason: null,
          result: '',
          usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
          duration_ms: 5,
          sessionId: 'session-resume',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'real answer' }] },
          sessionId: 'session-resume',
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          stop_reason: null,
          result: 'real answer',
          usage: { input_tokens: 12, output_tokens: 7, tool_uses: 0 },
          duration_ms: 456,
          sessionId: 'session-resume',
        },
      ]),
    });

    const events = await collect(
      adapter.run('prompt', { resume: 'session-resume' }),
    );
    expect(events.map((event) => event.type)).toEqual(['init', 'text', 'done']);

    const done = events[2] as AgentEvent & {
      payload: {
        status: string;
        result?: string;
        usage: DonePayload['usage'];
        durationMs: number;
      };
    };
    expect(done.payload.status).toBe('success');
    expect(done.payload.result).toBe('real answer');
    expect(done.payload.usage.tokens).toBeUndefined();
    expect(done.payload.durationMs).toBe(456);
  });

  it('classifies a stream ending after the no-op result as missing-result error', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: [],
          sessionId: 'session-resume',
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          stop_reason: null,
          result: '',
          usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
          duration_ms: 5,
          sessionId: 'session-resume',
        },
      ]),
    });

    const events = await collect(
      adapter.run('prompt', { resume: 'session-resume' }),
    );
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'error',
      'done',
    ]);

    const error = events[1] as AgentEvent & {
      payload: { code: string; recoverable: boolean };
    };
    expect(error.payload.code).toBe('MISSING_RESULT');
    expect(error.payload.recoverable).toBe(false);

    const done = events[2] as AgentEvent & {
      payload: { status: string; result?: string };
    };
    expect(done.payload.status).toBe('error');
    expect(done.payload.result).toBeUndefined();
  });

  it('treats a fresh run zero-usage empty success result as terminal without draining further', async () => {
    // No resume option: a fresh run cannot carry the CLI's continuation-
    // repair no-op turn, so its empty zero-usage success is a genuine (if
    // empty) terminal and must not be skipped into a MISSING_RESULT error.
    const pulled: string[] = [];
    const messages: unknown[] = [
      {
        type: 'system',
        subtype: 'init',
        model: 'claude',
        cwd: '/repo',
        tools: [],
        sessionId: 'session-fresh',
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        stop_reason: null,
        result: '',
        usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
        duration_ms: 5,
        sessionId: 'session-fresh',
      },
      // Poison tail: reachable only if the adapter wrongly skips the fresh
      // run's empty result and keeps draining the stream.
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        stop_reason: null,
        result: 'poison',
        usage: { input_tokens: 99, output_tokens: 99, tool_uses: 0 },
        duration_ms: 999,
        sessionId: 'session-fresh',
      },
    ];
    const adapter = new ClaudeCodeAdapter({
      loadSdk: async () => ({
        query(): AsyncIterable<unknown> {
          return {
            async *[Symbol.asyncIterator](): AsyncGenerator<
              unknown,
              void,
              void
            > {
              for (const message of messages) {
                pulled.push((message as { type: string }).type);
                yield message;
              }
            },
          };
        },
      }),
    });

    const events = await collect(adapter.run('prompt'));

    expect(events.map((event) => event.type)).toEqual(['init', 'done']);
    const done = events[1] as AgentEvent & {
      payload: {
        status: string;
        result?: string;
        usage: DonePayload['usage'];
        durationMs: number;
      };
    };
    expect(done.payload.status).toBe('success');
    expect(done.payload.result).toBeUndefined();
    expect(done.payload.usage).toEqual({ toolUses: 0 });
    expect(done.payload.durationMs).toBe(5);
    // Terminal means terminal: the adapter stopped at the first result and
    // never pulled the poison tail.
    expect(pulled).toEqual(['system', 'result']);
  });

  it('marks absent token accounting unavailable while preserving observed tools', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: ['Bash'],
        },
        {
          type: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tool-without-usage',
              name: 'Bash',
              input: { command: 'true' },
            },
          ],
        },
        {
          type: 'result',
          status: 'success',
          result: 'done',
          duration_ms: 5,
        },
      ]),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((event) => event.type === 'done')!;
    expect((done.payload as DonePayload).usage).toEqual({
      toolUses: 1,
    });
  });

  it('keeps the narrow main-loop tool counter internal', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: [],
        },
        {
          type: 'result',
          status: 'success',
          result: 'done',
          usage: { input_tokens: 1, output_tokens: 1, tool_uses: 4 },
        },
      ]),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((event) => event.type === 'done')!;
    expect((done.payload as DonePayload).usage).toEqual({ toolUses: 0 });
  });

  it('treats a zero-usage empty result after real turn activity as terminal on a resumed run', async () => {
    // The continuation-repair no-op arrives before the submitted turn
    // produces anything. Once assistant/tool activity has streamed, an
    // empty zero-usage result is the real turn's terminal — downstream
    // derives the final text from the captured text events — and skipping
    // it would discard a legitimate termination as MISSING_RESULT.
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: [],
          sessionId: 'session-resume',
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'work in progress' },
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Bash',
                input: { command: 'ls' },
              },
            ],
          },
          sessionId: 'session-resume',
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          stop_reason: null,
          result: '',
          usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
          duration_ms: 7,
          sessionId: 'session-resume',
        },
      ]),
    });

    const events = await collect(
      adapter.run('prompt', { resume: 'session-resume' }),
    );

    expect(events.map((event) => event.type)).toEqual([
      'init',
      'text',
      'tool_use',
      'done',
    ]);
    const done = events[3] as AgentEvent & {
      payload: {
        status: string;
        result?: string;
        usage: DonePayload['usage'];
      };
    };
    expect(done.payload.status).toBe('success');
    expect(done.payload.result).toBeUndefined();
    expect(done.payload.usage.tokens).toBeUndefined();
  });

  it('maps SDK error_during_execution result to error done with API error text', async () => {
    const apiError =
      'API Error: Repeated 529 Overloaded errors. The API is at capacity, this is usually temporary. Try again in a moment. If it persists, check status.claude.com';
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: [],
          sessionId: 'session-overload',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: apiError }] },
          sessionId: 'session-overload',
        },
        {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          stop_reason: null,
          errors: [apiError],
          usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
          duration_ms: 123,
          sessionId: 'session-overload',
        },
      ]),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'text',
      'error',
      'done',
    ]);

    const error = events[2] as AgentEvent & {
      payload: { code?: string; message: string; recoverable: boolean };
    };
    expect(error.payload.code).toBe('error_during_execution');
    expect(error.payload.message).toBe(apiError);
    expect(error.payload.recoverable).toBe(false);

    const done = events[3] as AgentEvent & {
      payload: { status: string; result?: string };
    };
    expect(done.payload.status).toBe('error');
    expect(done.payload.result).toBe(apiError);
  });

  it('preserves max_turns status (not error) when SDK signals error_max_turns', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: [],
          sessionId: 'session-maxturns',
        },
        {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'partial work' }] },
          sessionId: 'session-maxturns',
        },
        {
          type: 'result',
          subtype: 'error_max_turns',
          is_error: true,
          stop_reason: null,
          errors: ['Maximum turns reached'],
          usage: { input_tokens: 5, output_tokens: 10, tool_uses: 0 },
          duration_ms: 90,
          sessionId: 'session-maxturns',
        },
      ]),
    });

    const events = await collect(adapter.run('prompt'));
    // No 'error' event — max_turns is a protocol terminal state, not a failure.
    expect(events.map((event) => event.type)).toEqual(['init', 'text', 'done']);

    const done = events[2] as AgentEvent & {
      payload: { status: string; result?: string };
    };
    expect(done.payload.status).toBe('max_turns');
    expect(done.payload.result).toBe('Maximum turns reached');
  });

  it('emits error + done when SDK stream throws', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: async () => ({
        query(): AsyncIterable<unknown> {
          return {
            async *[Symbol.asyncIterator](): AsyncGenerator<
              unknown,
              void,
              void
            > {
              yield {
                type: 'system',
                subtype: 'init',
                model: 'claude',
                cwd: '/repo',
                tools: [],
                sessionId: 'session-err',
              };
              throw new Error('stream boom');
            },
          };
        },
      }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'error',
      'done',
    ]);

    const error = events[1] as AgentEvent & {
      payload: { code: string; message: string; recoverable: boolean };
    };
    expect(error.payload.code).toBe('SDK_STREAM_ERROR');
    expect(error.payload.message).toBe('stream boom');
    expect(error.payload.recoverable).toBe(false);

    const done = events[2] as AgentEvent & { payload: { status: string } };
    expect(done.payload.status).toBe('error');
  });

  it('sets resumeToken on done when backend provides a new session ID', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: [],
          sessionId: 'backend-session-xyz',
        },
        {
          type: 'result',
          status: 'success',
          result: 'done',
          usage: { input_tokens: 5, output_tokens: 10, tool_uses: 0 },
          duration_ms: 100,
          sessionId: 'backend-session-xyz',
        },
      ]),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((e) => e.type === 'done')!;
    const payload = done.payload as { resumeToken?: string };
    expect(payload.resumeToken).toBe('backend-session-xyz');
  });

  it('parses assistant content from nested message.content (real SDK shape)', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude-3-7-sonnet',
          cwd: '/repo',
          tools: ['Write'],
          sessionId: 'session-nested',
        },
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'nested hello' },
              {
                type: 'tool_use',
                id: 'tool-n1',
                name: 'Write',
                input: { path: '/tmp/f' },
              },
            ],
          },
          sessionId: 'session-nested',
        },
        {
          type: 'result',
          status: 'success',
          usage: { input_tokens: 5, output_tokens: 10, tool_uses: 1 },
          duration_ms: 50,
          sessionId: 'session-nested',
        },
      ]),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((e) => e.type)).toEqual([
      'init',
      'text',
      'tool_use',
      'done',
    ]);

    const text = events[1] as AgentEvent & { payload: { content: string } };
    expect(text.payload.content).toBe('nested hello');

    const toolUse = events[2] as AgentEvent & {
      payload: { toolName: string; toolUseId: string };
    };
    expect(toolUse.payload.toolName).toBe('Write');
    expect(toolUse.payload.toolUseId).toBe('tool-n1');
  });

  it('excludes CLAUDECODE from env passed to SDK query options', () => {
    const original = process.env.CLAUDECODE;
    process.env.CLAUDECODE = '1';

    try {
      const mapped = mapAgentOptionsToClaudeQueryOptions({});
      expect(mapped.queryOptions.env).toBeDefined();
      expect(mapped.queryOptions.env!.CLAUDECODE).toBeUndefined();
      // process.env is NOT mutated
      expect(process.env.CLAUDECODE).toBe('1');
    } finally {
      if (original !== undefined) {
        process.env.CLAUDECODE = original;
      } else {
        delete process.env.CLAUDECODE;
      }
    }
  });

  it('uses fresh SDK sessionId as resumeToken when backend provides no session ID', async () => {
    let sdkSessionId: string | undefined;
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader(
        [
          {
            type: 'system',
            subtype: 'init',
            model: 'claude',
            cwd: '/repo',
            tools: [],
          },
          {
            type: 'result',
            status: 'success',
            result: 'done',
            usage: { input_tokens: 5, output_tokens: 10, tool_uses: 0 },
            duration_ms: 100,
          },
        ],
        (options) => {
          sdkSessionId = options.sessionId;
        },
      ),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((e) => e.type === 'done')!;
    const payload = done.payload as { resumeToken?: string };
    expect(sdkSessionId).toBeDefined();
    expect(payload.resumeToken).toBe(sdkSessionId);
  });

  it('reports whole-run tokens from snake_case model usage', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: [],
        },
        {
          type: 'result',
          status: 'success',
          result: 'ok',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            tool_uses: 0,
          },
          modelUsage: {
            claude: {
              input_tokens: 5,
              output_tokens: 20,
              cache_read_input_tokens: 100,
              cache_creation_input_tokens: 50,
            },
          },
          duration_ms: 50,
        },
      ]),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((e) => e.type === 'done')!;
    const usage = (done.payload as DonePayload).usage;
    expect(usage.tokens).toMatchObject({
      coverage: 'complete',
      totals: {
        input: {
          total: 155,
          uncached: 5,
          cacheRead: 100,
          cacheWrite: 50,
        },
        output: { total: 20 },
      },
    });
  });

  it('omits tokens when a model-usage entry is incomplete', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: [],
        },
        {
          type: 'result',
          status: 'success',
          result: 'ok',
          usage: { input_tokens: 7, output_tokens: 3 },
          modelUsage: {
            claude: { inputTokens: 7, outputTokens: 3 },
          },
          duration_ms: 50,
        },
      ]),
    });

    const events = await collect(adapter.run('prompt'));
    const usage = (
      events.find((e) => e.type === 'done')!.payload as DonePayload
    ).usage;
    expect(usage.tokens).toBeUndefined();
  });

  it('reports whole-run accounting rather than main-loop counters', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: [],
        },
        {
          type: 'result',
          status: 'success',
          result: 'ok',
          // The main-loop counters exclude subagent work; modelUsage covers
          // every request the run made, across models.
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 50,
            output_tokens: 20,
          },
          modelUsage: {
            'claude-haiku-4-5': {
              inputTokens: 10,
              cacheReadInputTokens: 100,
              cacheCreationInputTokens: 50,
              outputTokens: 20,
            },
            'claude-sonnet-5': {
              inputTokens: 5,
              cacheReadInputTokens: 900,
              cacheCreationInputTokens: 200,
              outputTokens: 400,
            },
          },
          duration_ms: 50,
        },
      ]),
    });

    const usage = (
      (await collect(adapter.run('prompt'))).find((e) => e.type === 'done')!
        .payload as DonePayload
    ).usage;
    expect(usage.tokens).toMatchObject({
      coverage: 'complete',
      totals: {
        input: {
          total: 1265,
          uncached: 15,
          cacheRead: 1000,
          cacheWrite: 250,
        },
        output: { total: 420 },
      },
    });
  });

  // claude-code-240
  it('decomposes the run into one billable record per model', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: [],
        },
        {
          type: 'result',
          status: 'success',
          result: 'ok',
          usage: { input_tokens: 10, output_tokens: 20 },
          modelUsage: {
            'claude-haiku-4-5-20251001': {
              inputTokens: 10,
              cacheReadInputTokens: 100,
              cacheCreationInputTokens: 50,
              outputTokens: 20,
              costUSD: 0.01,
              canonicalModel: 'claude-haiku-4-5',
              provider: 'firstParty',
              webSearchRequests: 0,
            },
            'claude-sonnet-5': {
              inputTokens: 5,
              cacheReadInputTokens: 900,
              cacheCreationInputTokens: 200,
              outputTokens: 400,
              costUSD: 0.22,
              canonicalModel: 'claude-sonnet-5',
              provider: 'firstParty',
              webSearchRequests: 3,
            },
          },
          duration_ms: 50,
        },
      ]),
    });

    const usage = (
      (await collect(adapter.run('prompt'))).find((e) => e.type === 'done')!
        .payload as DonePayload
    ).usage;

    // The rate-card key is the canonical id, not the map key that may carry
    // an alias or a context-window suffix.
    expect(usage.tokens?.records).toEqual([
      {
        model: 'claude-haiku-4-5',
        provider: 'firstParty',
        tokens: {
          input: {
            total: 160,
            uncached: 10,
            cacheRead: 100,
            cacheWrite: 50,
          },
          output: { total: 20 },
        },
        cost: {
          amount: 0.01,
          currency: 'USD',
          source: 'agent-estimate',
        },
        pricedUnits: [{ name: 'web_search_request', quantity: 0 }],
      },
      {
        model: 'claude-sonnet-5',
        provider: 'firstParty',
        tokens: {
          input: {
            total: 1105,
            uncached: 5,
            cacheRead: 900,
            cacheWrite: 200,
          },
          output: { total: 400 },
        },
        cost: {
          amount: 0.22,
          currency: 'USD',
          source: 'agent-estimate',
        },
        pricedUnits: [{ name: 'web_search_request', quantity: 3 }],
      },
    ]);
    expect(usage.tokens?.totals).toEqual({
      input: {
        total: 1265,
        uncached: 15,
        cacheRead: 1000,
        cacheWrite: 250,
      },
      output: { total: 420 },
    });
  });

  it('publishes no records when the run reports no per-model map', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: [],
        },
        {
          type: 'result',
          status: 'success',
          result: 'ok',
          usage: { input_tokens: 7, output_tokens: 3 },
          duration_ms: 50,
        },
      ]),
    });

    const usage = (
      (await collect(adapter.run('prompt'))).find((e) => e.type === 'done')!
        .payload as DonePayload
    ).usage;
    expect(usage.tokens).toBeUndefined();
  });

  it('omits malformed optional cost and priced units without losing tokens', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: [],
        },
        {
          type: 'result',
          status: 'success',
          result: 'ok',
          usage: { input_tokens: 1, output_tokens: 1 },
          total_cost_usd: -1,
          modelUsage: {
            claude: {
              inputTokens: 4,
              cacheReadInputTokens: 3,
              cacheCreationInputTokens: 2,
              outputTokens: 5,
              costUSD: -0.5,
              webSearchRequests: 1.5,
            },
          },
          duration_ms: 50,
        },
      ]),
    });

    const usage = (
      (await collect(adapter.run('prompt'))).find((e) => e.type === 'done')!
        .payload as DonePayload
    ).usage;
    expect(usage.cost).toBeUndefined();
    expect(usage.tokens?.totals).toEqual({
      input: { total: 9, uncached: 4, cacheRead: 3, cacheWrite: 2 },
      output: { total: 5 },
    });
    expect(usage.tokens?.records?.[0]).not.toHaveProperty('cost');
    expect(usage.tokens?.records?.[0]).not.toHaveProperty('pricedUnits');
  });

  it('retains whole-run cost but not main-loop tokens without a model map', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: [],
        },
        {
          type: 'result',
          status: 'success',
          result: 'ok',
          usage: { input_tokens: 7, output_tokens: 3 },
          total_cost_usd: 0.04,
          duration_ms: 50,
        },
      ]),
    });

    const usage = (
      (await collect(adapter.run('prompt'))).find((e) => e.type === 'done')!
        .payload as DonePayload
    ).usage;
    expect(usage).toEqual({
      toolUses: 0,
      cost: {
        amount: 0.04,
        currency: 'USD',
        source: 'agent-estimate',
      },
    });
  });

  it('keeps the no-op repair skip keyed on the main-loop counters', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: [],
        },
        {
          // The continuation-repair no-op: zero main-loop tokens, while the
          // run's per-model total is already non-zero. The skip must still
          // fire, or the submitted turn below is never reached.
          type: 'result',
          status: 'success',
          usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
          modelUsage: {
            'claude-haiku-4-5': {
              inputTokens: 900,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              outputTokens: 40,
            },
          },
          duration_ms: 5,
        },
        { type: 'assistant', text: 'the real answer' },
        {
          type: 'result',
          status: 'success',
          result: 'the real answer',
          usage: { input_tokens: 12, output_tokens: 8 },
          duration_ms: 20,
        },
      ]),
    });

    const events = await collect(
      adapter.run('prompt', { resume: 'session-abc' }),
    );
    expect(events.map((event) => event.type)).toEqual(['init', 'text', 'done']);
    expect(
      (events.find((e) => e.type === 'done')!.payload as DonePayload).result,
    ).toBe('the real answer');
  });

  it('establishes capabilities once across repeated system notices', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        // Only the opening handshake carries the tool surface; Claude Code
        // emits further system notices (compaction, retries, background
        // tasks) throughout a run.
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: ['Bash', 'Read'],
        },
        { type: 'system', subtype: 'compact_boundary' },
        { type: 'assistant', text: 'working' },
        { type: 'system', subtype: 'api_retry' },
        { type: 'system', subtype: 'background_tasks' },
        {
          type: 'result',
          status: 'success',
          result: 'ok',
          usage: { input_tokens: 1, output_tokens: 1 },
          duration_ms: 5,
        },
      ]),
    });

    const events = await collect(adapter.run('prompt'));
    const inits = events.filter((event) => event.type === 'init');
    expect(inits).toHaveLength(1);
    // The one init retains the handshake's tool surface rather than being
    // overwritten by a later notice that carries none.
    expect((inits[0]!.payload as InitPayload).tools).toEqual(['Bash', 'Read']);
    expect(events.map((event) => event.type)).toEqual(['init', 'text', 'done']);
  });

  it('ignores system notices that precede the handshake', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        // A configured SessionStart hook puts its own notices on the stream
        // before the handshake, so position cannot identify the handshake.
        { type: 'system', subtype: 'hook_started' },
        { type: 'system', subtype: 'hook_response' },
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: ['Bash', 'Read'],
        },
        { type: 'system', subtype: 'thinking_tokens' },
        { type: 'assistant', text: 'working' },
        {
          type: 'result',
          status: 'success',
          result: 'ok',
          usage: { input_tokens: 1, output_tokens: 1 },
          duration_ms: 5,
        },
      ]),
    });

    const events = await collect(adapter.run('prompt'));
    const inits = events.filter((event) => event.type === 'init');
    expect(inits).toHaveLength(1);
    // The surviving init is the handshake's, not the hook notice's empty one.
    expect((inits[0]!.payload as InitPayload).tools).toEqual(['Bash', 'Read']);
    expect(events.map((event) => event.type)).toEqual(['init', 'text', 'done']);
  });

  it('publishes no tokens when whole-run usage is unavailable', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: [],
        },
        {
          type: 'result',
          status: 'success',
          result: 'ok',
          usage: { input_tokens: 5 },
          duration_ms: 50,
        },
      ]),
    });

    const events = await collect(adapter.run('prompt'));
    const usage = (
      events.find((e) => e.type === 'done')!.payload as DonePayload
    ).usage;
    expect(usage.tokens).toBeUndefined();
  });

  it.each([
    ['negative input', { input_tokens: -1, output_tokens: 2 }],
    ['fractional output', { input_tokens: 1, output_tokens: 2.5 }],
    [
      'invalid cache read',
      {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: '3',
      },
    ],
    [
      'invalid cache creation',
      {
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: -1,
      },
    ],
    [
      'non-finite cache creation',
      {
        input_tokens: 1,
        output_tokens: 2,
        cache_creation_input_tokens: Number.POSITIVE_INFINITY,
      },
    ],
  ])('omits tokens for %s model usage', async (_case, rawUsage) => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: [],
        },
        {
          type: 'result',
          status: 'success',
          usage: { input_tokens: 1, output_tokens: 1 },
          modelUsage: {
            claude: {
              input_tokens: 1,
              output_tokens: 2,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              ...rawUsage,
            },
          },
          duration_ms: 50,
        },
      ]),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((event) => event.type === 'done')!;
    expect((done.payload as DonePayload).usage.tokens).toBeUndefined();
  });

  it('maps every Claude effort to SDK effort and ultracode settings', () => {
    const cases: Array<
      [ClaudeEffort | undefined, string | undefined, boolean | undefined]
    > = [
      [undefined, undefined, undefined],
      ['minimal', 'low', false],
      ['low', 'low', false],
      ['medium', 'medium', false],
      ['high', 'high', false],
      ['xhigh', 'xhigh', false],
      ['max', 'max', false],
      ['ultracode', 'xhigh', true],
    ];

    for (const [input, expectedEffort, expectedUltracode] of cases) {
      expect(mapEffortToClaudeOptions(input)).toEqual(
        input === undefined
          ? {}
          : {
              effort: expectedEffort,
              settings: { ultracode: expectedUltracode },
            },
      );

      const mapped = mapAgentOptionsToClaudeQueryOptions(
        input === undefined ? {} : { effort: input },
      );
      if (input === undefined) {
        expect(mapped.queryOptions).not.toHaveProperty('effort');
        expect(mapped.queryOptions).not.toHaveProperty('settings');
      } else {
        expect(mapped.queryOptions.effort).toBe(expectedEffort);
        expect(mapped.queryOptions.settings?.ultracode).toBe(expectedUltracode);
      }
    }
  });

  it('forwards ultracode through the SDK query() native controls', async () => {
    let captured: MockSdkInnerOptions | undefined;

    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader(
        [
          {
            type: 'system',
            subtype: 'init',
            model: 'claude-opus-4-7',
            cwd: '/repo',
            tools: [],
            sessionId: 'session-effort',
          },
          {
            type: 'result',
            status: 'success',
            result: 'ok',
            usage: { input_tokens: 1, output_tokens: 1, tool_uses: 0 },
            duration_ms: 1,
            sessionId: 'session-effort',
          },
        ],
        (options) => {
          captured = options;
        },
      ),
    });

    await collect(adapter.run('prompt', { effort: 'ultracode' }));

    expect(captured?.effort).toBe('xhigh');
    expect(captured?.settings).toEqual({ ultracode: true });
  });

  it('rejects Codex and unknown effort values before invoking query()', async () => {
    let queryCalls = 0;
    const adapter = new ClaudeCodeAdapter({
      loadSdk: async () => ({
        query(): AsyncIterable<unknown> {
          queryCalls += 1;
          return {
            async *[Symbol.asyncIterator]() {},
          };
        },
      }),
    });

    for (const effort of ['ultra', 'future-effort']) {
      const invalid = { effort } as unknown as AgentOptions<ClaudeEffort>;
      await expect(collect(adapter.run('prompt', invalid))).rejects.toThrow(
        `effort for adapter "claude-code" must be one of: minimal, low, medium, high, xhigh, max, ultracode`,
      );
    }
    expect(queryCalls).toBe(0);
  });

  it('keeps permission controls unchanged for ultracode', () => {
    const permissions: PermissionPolicy = {
      mode: 'auto',
      fileWrite: 'deny',
      shellExecute: 'allow',
      networkAccess: 'ask',
    };
    const ordinary = mapAgentOptionsToClaudeQueryOptions({ permissions });
    const ultracode = mapAgentOptionsToClaudeQueryOptions({
      permissions,
      effort: 'ultracode',
    });

    expect({
      permissionMode: ultracode.queryOptions.permissionMode,
      allowDangerouslySkipPermissions:
        ultracode.queryOptions.allowDangerouslySkipPermissions,
      canUseTool: ultracode.queryOptions.canUseTool,
    }).toEqual({
      permissionMode: ordinary.queryOptions.permissionMode,
      allowDangerouslySkipPermissions:
        ordinary.queryOptions.allowDangerouslySkipPermissions,
      canUseTool: ordinary.queryOptions.canUseTool,
    });
  });

  it('surfaces an upstream ultracode rejection without substitution', async () => {
    let captured: MockSdkInnerOptions | undefined;
    const adapter = new ClaudeCodeAdapter({
      loadSdk: async () => ({
        query(options): AsyncIterable<unknown> {
          captured = options.options;
          return {
            async *[Symbol.asyncIterator]() {
              throw new Error('ultracode is unavailable for this account');
            },
          };
        },
      }),
    });

    const events = await collect(
      adapter.run('prompt', { effort: 'ultracode' }),
    );

    expect(captured?.effort).toBe('xhigh');
    expect(captured?.settings).toEqual({ ultracode: true });
    expect(events.map((event) => event.type)).toEqual(['error', 'done']);
    expect(events[0]?.payload).toMatchObject({
      code: 'SDK_STREAM_ERROR',
      message: 'ultracode is unavailable for this account',
      recoverable: false,
    });
    expect(events[1]?.payload).toMatchObject({ status: 'error' });
  });

  it('maps camelCase model usage into nested inclusive totals', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          subtype: 'init',
          model: 'claude',
          cwd: '/repo',
          tools: [],
        },
        {
          type: 'result',
          status: 'success',
          result: 'ok',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            toolUses: 0,
          },
          modelUsage: {
            claude: {
              inputTokens: 8,
              outputTokens: 15,
              cacheReadInputTokens: 200,
              cacheCreationInputTokens: 0,
            },
          },
          duration_ms: 50,
        },
      ]),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((e) => e.type === 'done')!;
    const usage = (done.payload as DonePayload).usage;
    expect(usage.tokens?.totals).toEqual({
      input: {
        total: 208,
        uncached: 8,
        cacheRead: 200,
        cacheWrite: 0,
      },
      output: { total: 15 },
    });
  });

  it('maps PermissionPolicy.mode to claude permissionMode per ENG-021', () => {
    const auto = mapPermissionsToClaudeOptions({ mode: 'auto' });
    expect(auto.permissionMode).toBe('auto');
    expect(auto.allowDangerouslySkipPermissions).toBeUndefined();
    expect(auto.canUseTool).toBeUndefined();

    const bypass = mapPermissionsToClaudeOptions({ mode: 'bypass' });
    expect(bypass.permissionMode).toBe('bypassPermissions');
    expect(bypass.allowDangerouslySkipPermissions).toBe(true);
    expect(bypass.canUseTool).toBeUndefined();

    // mode takes precedence over per-capability levels.
    const autoOverridesLevels = mapPermissionsToClaudeOptions({
      mode: 'auto',
      fileWrite: 'deny',
      shellExecute: 'deny',
      networkAccess: 'deny',
    });
    expect(autoOverridesLevels.permissionMode).toBe('auto');
    expect(autoOverridesLevels.canUseTool).toBeUndefined();
  });

  it('accepts writablePaths and reports ambient enforcement', () => {
    const mapped = mapPermissionsToClaudeOptions({
      mode: 'auto',
      writablePaths: ['./.git/', 'generated/./cache//'],
    });

    expect(mapped.permissionMode).toBe('auto');
    expect(mapped.writablePaths).toEqual({
      paths: ['.git', 'generated/cache'],
      enforcement: 'ambient',
    });

    expect(() =>
      mapPermissionsToClaudeOptions({ writablePaths: ['../cache'] }),
    ).toThrow("permissions.writablePaths[0] must not contain '..'");
  });
});
