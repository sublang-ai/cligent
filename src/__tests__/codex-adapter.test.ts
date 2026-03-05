// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, it, expect } from 'vitest';

import {
  CodexAdapter,
  mapAgentOptionsToCodexOptions,
  mapPermissionsToCodexOptions,
} from '../adapters/codex.js';
import type { AgentEvent, PermissionLevel, PermissionPolicy } from '../types.js';

interface MockRunOptions {
  signal?: AbortSignal;
  abortSignal?: AbortSignal;
}

interface MockThreadOptions {
  cwd?: string;
  model?: string;
  maxTurns?: number;
  sandboxMode?: string;
  approvalPolicy?: string;
  networkAccessEnabled?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  abortSignal?: AbortSignal;
  signal?: AbortSignal;
}

interface MockCodexThread {
  runStreamed(
    prompt: string,
    options?: MockRunOptions,
  ): Promise<{ events: AsyncIterable<unknown> }>;
}

interface MockCodexClient {
  startThread(options?: MockThreadOptions): MockCodexThread;
  resumeThread?(threadId: string, options?: MockThreadOptions): MockCodexThread;
}

function makeLoader(config: {
  events: unknown[];
  onStartThread?: (options: MockThreadOptions | undefined) => void;
  onResumeThread?: (
    threadId: string,
    options: MockThreadOptions | undefined,
  ) => void;
  onRun?: (prompt: string, options: MockRunOptions | undefined) => void;
  throwFromRun?: Error;
}): () => Promise<{ Codex: new () => MockCodexClient }> {
  return async () => ({
    Codex: class {
      startThread(options?: MockThreadOptions): MockCodexThread {
        config.onStartThread?.(options);
        return {
          async runStreamed(
            prompt: string,
            runOptions?: MockRunOptions,
          ): Promise<{ events: AsyncIterable<unknown> }> {
            config.onRun?.(prompt, runOptions);
            return {
              events: {
                async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, void> {
                  for (const event of config.events) {
                    yield event;
                  }
                  if (config.throwFromRun) {
                    throw config.throwFromRun;
                  }
                },
              },
            };
          },
        };
      }

      resumeThread(
        threadId: string,
        options?: MockThreadOptions,
      ): MockCodexThread {
        config.onResumeThread?.(threadId, options);
        return {
          async runStreamed(
            prompt: string,
            runOptions?: MockRunOptions,
          ): Promise<{ events: AsyncIterable<unknown> }> {
            config.onRun?.(prompt, runOptions);
            return {
              events: {
                async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, void> {
                  for (const event of config.events) {
                    yield event;
                  }
                  if (config.throwFromRun) {
                    throw config.throwFromRun;
                  }
                },
              },
            };
          },
        };
      }
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

describe('CodexAdapter', () => {
  it('maps codex stream events to unified events', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'item.completed',
            sessionId: 'thread-1',
            item: {
              type: 'message',
              content: [
                { type: 'output_text', text: 'Hello from Codex' },
                {
                  type: 'tool_call',
                  id: 'call-1',
                  name: 'bash',
                  arguments: '{"command":"ls"}',
                },
                {
                  type: 'tool_result',
                  tool_call_id: 'call-1',
                  toolName: 'bash',
                  status: 'success',
                  output: { stdout: 'file.txt' },
                  duration_ms: 15,
                },
                { type: 'file_change', path: '/repo/file.txt', action: 'modified' },
              ],
            },
          },
          {
            type: 'file.changed',
            sessionId: 'thread-1',
            file: {
              path: '/repo/another.ts',
              action: 'created',
            },
          },
          {
            type: 'error',
            sessionId: 'thread-1',
            code: 'TEMP',
            message: 'transient hiccup',
            recoverable: true,
          },
          {
            type: 'turn.completed',
            sessionId: 'thread-1',
            turn: {
              status: 'max_turns',
              result: 'final summary',
              usage: {
                input_tokens: 33,
                output_tokens: 44,
                tool_uses: 2,
                total_cost_usd: 0.17,
              },
              duration_ms: 222,
            },
          },
        ],
      }),
    });

    const events = await collect(
      adapter.run('do it', {
        model: 'gpt-5-codex',
        cwd: '/repo',
        allowedTools: ['bash'],
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      'init',
      'text',
      'tool_use',
      'tool_result',
      'codex:file_change',
      'codex:file_change',
      'error',
      'done',
    ]);

    const init = events[0] as AgentEvent & {
      payload: { model: string; cwd: string; tools: string[] };
    };
    expect(init.payload.model).toBe('gpt-5-codex');
    expect(init.payload.cwd).toBe('/repo');
    expect(init.payload.tools).toEqual(['bash']);
    expect(events[0].sessionId).toBe('thread-1');
    expect(events[1].sessionId).toBe('thread-1');

    const text = events[1] as AgentEvent & { payload: { content: string } };
    expect(text.payload.content).toBe('Hello from Codex');

    const toolUse = events[2] as AgentEvent & {
      payload: { toolName: string; toolUseId: string; input: Record<string, unknown> };
    };
    expect(toolUse.payload.toolName).toBe('bash');
    expect(toolUse.payload.toolUseId).toBe('call-1');
    expect(toolUse.payload.input).toEqual({ command: 'ls' });

    const toolResult = events[3] as AgentEvent & {
      payload: {
        toolName: string;
        toolUseId: string;
        status: string;
        output: unknown;
        durationMs?: number;
      };
    };
    expect(toolResult.payload.toolName).toBe('bash');
    expect(toolResult.payload.toolUseId).toBe('call-1');
    expect(toolResult.payload.status).toBe('success');
    expect(toolResult.payload.output).toEqual({ stdout: 'file.txt' });
    expect(toolResult.payload.durationMs).toBe(15);

    const fileChangeOne = events[4] as AgentEvent & { payload: Record<string, unknown> };
    expect(fileChangeOne.type).toBe('codex:file_change');
    expect(fileChangeOne.payload.path).toBe('/repo/file.txt');

    const fileChangeTwo = events[5] as AgentEvent & { payload: Record<string, unknown> };
    expect(fileChangeTwo.type).toBe('codex:file_change');
    expect(fileChangeTwo.payload.path).toBe('/repo/another.ts');

    const error = events[6] as AgentEvent & {
      payload: { code: string; message: string; recoverable: boolean };
    };
    expect(error.payload.code).toBe('TEMP');
    expect(error.payload.message).toBe('transient hiccup');
    expect(error.payload.recoverable).toBe(true);

    const done = events[7] as AgentEvent & {
      payload: {
        status: string;
        result: string;
        usage: {
          inputTokens: number;
          outputTokens: number;
          toolUses: number;
          totalCostUsd: number;
        };
        durationMs: number;
      };
    };
    expect(done.payload.status).toBe('max_turns');
    expect(done.payload.result).toBe('final summary');
    expect(done.payload.usage).toEqual({
      inputTokens: 33,
      outputTokens: 44,
      toolUses: 2,
      totalCostUsd: 0.17,
    });
    expect(done.payload.durationMs).toBe(222);
  });

  it('preserves item.completed content block order', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'item.completed',
            item: {
              type: 'message',
              content: [
                { type: 'tool_call', id: 'call-order', name: 'bash', arguments: '{}' },
                { type: 'output_text', text: 'After tool call' },
                {
                  type: 'tool_result',
                  tool_call_id: 'call-order',
                  toolName: 'bash',
                  status: 'success',
                  output: { ok: true },
                },
              ],
            },
          },
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
            },
          },
        ],
      }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'tool_use',
      'text',
      'tool_result',
      'done',
    ]);
  });

  it('does not duplicate text when top-level item.text mirrors content text', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'item.completed',
            item: {
              type: 'message',
              text: 'hello',
              content: [{ type: 'output_text', text: 'hello' }],
            },
          },
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
            },
          },
        ],
      }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual(['init', 'text', 'done']);
    const textEvents = events.filter((event) => event.type === 'text');
    expect(textEvents).toHaveLength(1);
    expect((textEvents[0] as AgentEvent & { payload: { content: string } }).payload.content).toBe(
      'hello',
    );
  });

  it('emits unknown-tools init when tool set cannot be inferred', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'item.completed',
            sessionId: 'thread-unknown-tools',
            item: {
              type: 'message',
              text: 'hello',
            },
          },
          {
            type: 'turn.completed',
            sessionId: 'thread-unknown-tools',
            turn: {
              status: 'success',
              usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
            },
          },
        ],
      }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual(['init', 'text', 'done']);

    const init = events[0] as AgentEvent & {
      payload: {
        tools: string[];
        capabilities: { toolsKnown: boolean; toolsSource: string };
      };
    };
    expect(init.payload.tools).toEqual([]);
    expect(init.payload.capabilities.toolsKnown).toBe(false);
    expect(init.payload.capabilities.toolsSource).toBe('unavailable');
  });

  it('emits degraded init before terminal events when stream throws immediately', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [],
        throwFromRun: new Error('boom-before-first-event'),
      }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual(['init', 'error', 'done']);

    const init = events[0] as AgentEvent & {
      payload: {
        model: string;
        cwd: string;
        tools: string[];
        capabilities: { toolsKnown: boolean; toolsSource: string };
      };
    };
    expect(init.payload.model).toBe('unknown');
    expect(init.payload.tools).toEqual([]);
    expect(init.payload.capabilities.toolsKnown).toBe(false);
    expect(init.payload.capabilities.toolsSource).toBe('unavailable');

    const error = events[1] as AgentEvent & {
      payload: { code: string; message: string; recoverable: boolean };
    };
    expect(error.payload.code).toBe('SDK_STREAM_ERROR');
    expect(error.payload.message).toBe('boom-before-first-event');
    expect(error.payload.recoverable).toBe(false);

    const done = events[2] as AgentEvent & { payload: { status: string } };
    expect(done.payload.status).toBe('error');
  });

  it('returns false from isAvailable when SDK load fails', async () => {
    const adapter = new CodexAdapter({
      loadSdk: async () => {
        throw new Error('missing sdk');
      },
    });

    await expect(adapter.isAvailable()).resolves.toBe(false);
  });

  it('throws from run when SDK is not installed', async () => {
    const adapter = new CodexAdapter({
      loadSdk: async () => {
        throw new Error('missing sdk');
      },
    });

    const stream = adapter.run('prompt');
    await expect(stream.next()).rejects.toThrow(
      'CodexAdapter requires @openai/codex-sdk. Install it to use this adapter.',
    );
  });

  it('maps UPM permissions to codex controls for all combinations', () => {
    const levels: PermissionLevel[] = ['allow', 'ask', 'deny'];

    for (const fileWrite of levels) {
      for (const shellExecute of levels) {
        for (const networkAccess of levels) {
          const policy: PermissionPolicy = {
            fileWrite,
            shellExecute,
            networkAccess,
          };

          const mapped = mapPermissionsToCodexOptions(policy);

          const expectedSandbox =
            fileWrite === 'deny' || shellExecute === 'deny'
              ? 'read-only'
              : fileWrite === 'allow' && shellExecute === 'allow'
                ? 'danger-full-access'
                : 'workspace-write';

          const allAllow =
            fileWrite === 'allow' &&
            shellExecute === 'allow' &&
            networkAccess === 'allow';

          const anyAsk =
            fileWrite === 'ask' ||
            shellExecute === 'ask' ||
            networkAccess === 'ask';

          const expectedApproval = allAllow
            ? 'never'
            : anyAsk
              ? 'untrusted'
              : 'on-request';

          expect(mapped.sandboxMode).toBe(expectedSandbox);
          expect(mapped.approvalPolicy).toBe(expectedApproval);
          expect(mapped.networkAccessEnabled).toBe(networkAccess === 'allow');
        }
      }
    }
  });

  it('passes AgentOptions through to thread/run options', async () => {
    let capturedThreadOptions: MockThreadOptions | undefined;
    let capturedRunPrompt: string | undefined;
    let capturedRunOptions: MockRunOptions | undefined;

    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
            },
          },
        ],
        onStartThread(options) {
          capturedThreadOptions = options;
        },
        onRun(prompt, options) {
          capturedRunPrompt = prompt;
          capturedRunOptions = options;
        },
      }),
    });

    await collect(
      adapter.run('implement feature', {
        cwd: '/tmp/repo',
        model: 'gpt-5-codex',
        maxTurns: 12,
        permissions: {
          fileWrite: 'allow',
          shellExecute: 'ask',
          networkAccess: 'deny',
        },
        allowedTools: ['bash', 'read_file'],
        disallowedTools: ['web_fetch'],
      }),
    );

    expect(capturedThreadOptions).toMatchObject({
      cwd: '/tmp/repo',
      model: 'gpt-5-codex',
      maxTurns: 12,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'untrusted',
      networkAccessEnabled: false,
      allowedTools: ['bash', 'read_file'],
      disallowedTools: ['web_fetch'],
    });
    expect(capturedThreadOptions?.abortSignal).toBeUndefined();
    expect(capturedThreadOptions?.signal).toBeUndefined();

    expect(capturedRunPrompt).toBe('implement feature');
    expect(capturedRunOptions?.abortSignal).toBeUndefined();
    expect(capturedRunOptions?.signal).toBeUndefined();
  });

  it('resumes thread when resume option is provided', async () => {
    let startThreadCalled = false;
    let resumeThreadCalledWith: string | undefined;

    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              usage: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
            },
          },
        ],
        onStartThread() {
          startThreadCalled = true;
        },
        onResumeThread(threadId) {
          resumeThreadCalledWith = threadId;
        },
      }),
    });

    await collect(
      adapter.run('continue', {
        resume: 'thread-xyz',
      }),
    );

    expect(startThreadCalled).toBe(false);
    expect(resumeThreadCalledWith).toBe('thread-xyz');
  });

  it('throws when resume is requested but SDK lacks resumeThread', async () => {
    const adapter = new CodexAdapter({
      loadSdk: async () => ({
        Codex: class {
          startThread(): MockCodexThread {
            return {
              async runStreamed(): Promise<{ events: AsyncIterable<unknown> }> {
                return {
                  events: {
                    async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, void> {},
                  },
                };
              },
            };
          }
        },
      }),
    });

    const stream = adapter.run('continue', { resume: 'thread-missing' });
    await expect(stream.next()).rejects.toThrow(
      'Codex SDK does not support resumeThread() in this version',
    );
  });

  it('propagates AbortSignal and emits interrupted done when aborted', async () => {
    const externalAbort = new AbortController();
    let capturedSignal: AbortSignal | undefined;

    const adapter = new CodexAdapter({
      loadSdk: async () => ({
        Codex: class {
          startThread(options?: MockThreadOptions): MockCodexThread {
            capturedSignal = options?.abortSignal;
            return {
              async runStreamed(
                _prompt: string,
                _runOptions?: MockRunOptions,
              ): Promise<{ events: AsyncIterable<unknown> }> {
                return {
                  events: {
                    async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, void> {
                      yield {
                        type: 'item.completed',
                        item: { type: 'message', text: 'started' },
                      };

                      await new Promise<void>((resolve) => {
                        if (options?.abortSignal?.aborted) {
                          resolve();
                          return;
                        }
                        options?.abortSignal?.addEventListener('abort', () => resolve(), {
                          once: true,
                        });
                      });
                    },
                  },
                };
              },
            };
          }
        },
      }),
    });

    const stream = adapter.run('prompt', { abortSignal: externalAbort.signal });

    const first = await stream.next();
    expect(first.done).toBe(false);
    expect(first.value?.type).toBe('init');

    const second = await stream.next();
    expect(second.done).toBe(false);
    expect(second.value?.type).toBe('text');

    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    externalAbort.abort();

    expect(capturedSignal?.aborted).toBe(true);

    const rest = await collect(stream);
    expect(rest.map((event) => event.type)).toEqual(['done']);
    const done = rest[0] as AgentEvent & { payload: { status: string } };
    expect(done.payload.status).toBe('interrupted');
  });

  it('builds mapped options helper with synced abort signal wiring', () => {
    const externalAbort = new AbortController();
    const mapped = mapAgentOptionsToCodexOptions({
      abortSignal: externalAbort.signal,
      permissions: {
        fileWrite: 'allow',
        shellExecute: 'allow',
        networkAccess: 'allow',
      },
    });

    expect(mapped.threadOptions.sandboxMode).toBe('danger-full-access');
    expect(mapped.threadOptions.approvalPolicy).toBe('never');
    expect(mapped.threadOptions.networkAccessEnabled).toBe(true);

    expect(mapped.threadOptions.abortSignal).toBeDefined();
    expect(mapped.threadOptions.abortSignal).toBe(mapped.runOptions.abortSignal);

    externalAbort.abort();

    expect(mapped.threadOptions.abortSignal?.aborted).toBe(true);

    mapped.cleanupAbort();
  });

  it('sets resumeToken on done when backend provides a new thread ID', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'item.completed',
            item: { type: 'message', text: 'hello' },
            threadId: 'thread-new-abc',
          },
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              result: 'done',
              usage: { inputTokens: 5, outputTokens: 10, toolUses: 0 },
              durationMs: 100,
            },
            threadId: 'thread-new-abc',
          },
        ],
      }),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((e) => e.type === 'done')!;
    const payload = done.payload as { resumeToken?: string };
    expect(payload.resumeToken).toBe('thread-new-abc');
  });

  it('omits resumeToken when backend provides no thread ID', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              result: 'done',
              usage: { inputTokens: 5, outputTokens: 10, toolUses: 0 },
              durationMs: 100,
            },
          },
        ],
      }),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((e) => e.type === 'done')!;
    const payload = done.payload as { resumeToken?: string };
    expect(payload.resumeToken).toBeUndefined();
  });
});
