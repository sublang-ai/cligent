// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { existsSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import {
  CodexAdapter,
  mapAgentOptionsToCodexOptions,
  mapPermissionsToCodexOptions,
  mapReasoningEffortToCodexEffort,
} from '../adapters/codex.js';
import type {
  AgentEvent,
  PermissionLevel,
  PermissionPolicy,
  ReasoningEffort,
} from '../types.js';

interface MockRunOptions {
  signal?: AbortSignal;
  abortSignal?: AbortSignal;
}

interface MockThreadOptions {
  cwd?: string;
  workingDirectory?: string;
  model?: string;
  modelReasoningEffort?: string;
  maxTurns?: number;
  sandboxMode?: string;
  approvalPolicy?: string;
  networkAccessEnabled?: boolean;
  skipGitRepoCheck?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  abortSignal?: AbortSignal;
  signal?: AbortSignal;
}

interface MockCodexConstructorOptions {
  codexPathOverride?: string;
  config?: Record<string, unknown>;
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
  onConstruct?: (options: MockCodexConstructorOptions | undefined) => void;
  onStartThread?: (options: MockThreadOptions | undefined) => void;
  onResumeThread?: (
    threadId: string,
    options: MockThreadOptions | undefined,
  ) => void;
  onRun?: (prompt: string, options: MockRunOptions | undefined) => void;
  onEventConsumed?: (event: unknown) => void;
  throwFromRun?: Error;
}): () => Promise<{ Codex: new () => MockCodexClient }> {
  async function* eventStream(): AsyncGenerator<unknown, void, void> {
    for (const event of config.events) {
      config.onEventConsumed?.(event);
      yield event;
    }
    if (config.throwFromRun) {
      throw config.throwFromRun;
    }
  }

  return async () => ({
    Codex: class {
      constructor(options?: MockCodexConstructorOptions) {
        config.onConstruct?.(options);
      }

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
                [Symbol.asyncIterator]: () => eventStream(),
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
                [Symbol.asyncIterator]: () => eventStream(),
              },
            };
          },
        };
      }
    },
  }) as unknown as { Codex: new (options?: unknown) => MockCodexClient };
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

  it('surfaces turn.failed message and stops iterating before SDK exit', async () => {
    let eventsConsumed = 0;
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'thread.started',
            thread_id: 'thread-fail',
          },
          {
            type: 'turn.started',
          },
          {
            type: 'turn.failed',
            error: {
              message:
                "The 'gpt-5.5' model requires a newer version of Codex.",
              code: 'model_not_found',
            },
          },
          {
            type: 'item.completed',
            item: {
              type: 'message',
              content: [{ type: 'output_text', text: 'never read' }],
            },
          },
        ],
        onEventConsumed: () => {
          eventsConsumed += 1;
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
      payload: { code?: string; message: string; recoverable: boolean };
    };
    expect(error.payload.message).toContain('gpt-5.5');
    expect(error.payload.message).toContain(
      'requires a newer version of Codex',
    );
    expect(error.payload.code).toBe('model_not_found');

    const done = events[2] as AgentEvent & {
      payload: { status: string; resumeToken?: string };
    };
    expect(done.payload.status).toBe('error');
    expect(done.payload.resumeToken).toBe('thread-fail');

    // Iteration must stop at turn.failed; trailing events shall not be read.
    expect(eventsConsumed).toBe(3);
  });

  it('unwraps JSON-encoded Codex error details', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'turn.failed',
            message: JSON.stringify({
              detail:
                "The 'gpt-5.5' model requires a newer version of Codex.",
              code: 'model_not_found',
            }),
          },
        ],
      }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'error',
      'done',
    ]);

    const error = events[1] as AgentEvent & {
      payload: { code?: string; message: string; recoverable: boolean };
    };
    expect(error.payload.message).toBe(
      "The 'gpt-5.5' model requires a newer version of Codex.",
    );
    expect(error.payload.message).not.toContain('{"detail"');
    expect(error.payload.code).toBe('model_not_found');
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

  it('maps UPM permissions to codex modern permission-profile controls for all combinations', () => {
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

          const allAllow =
            fileWrite === 'allow' &&
            shellExecute === 'allow' &&
            networkAccess === 'allow';

          const expectedDefaultPermissions = allAllow
            ? ':danger-full-access'
            : fileWrite === 'deny' || shellExecute === 'deny'
              ? ':read-only'
              : ':workspace';

          const anyAsk =
            fileWrite === 'ask' ||
            shellExecute === 'ask' ||
            networkAccess === 'ask';

          const expectedApproval = allAllow
            ? 'never'
            : anyAsk
              ? 'untrusted'
              : 'on-request';

          expect(mapped.codexOptions).toEqual({
            config: {
              default_permissions: expectedDefaultPermissions,
            },
          });
          expect(mapped.approvalPolicy).toBe(expectedApproval);
          expect(mapped).not.toHaveProperty('sandboxMode');
          expect(mapped).not.toHaveProperty('networkAccessEnabled');
        }
      }
    }
  });

  it('leaves Codex permission knobs unset when no policy is provided', () => {
    const mapped = mapPermissionsToCodexOptions(undefined);
    expect(mapped).toEqual({});

    const agentMapped = mapAgentOptionsToCodexOptions({});
    expect(agentMapped.codexOptions).toBeUndefined();
    expect(agentMapped.threadOptions).not.toHaveProperty('approvalPolicy');
    expect(agentMapped.threadOptions).not.toHaveProperty('sandboxMode');
    expect(agentMapped.threadOptions).not.toHaveProperty('networkAccessEnabled');
  });

  it('keeps network-only deny on the workspace default_permissions profile', () => {
    const mapped = mapPermissionsToCodexOptions({
      fileWrite: 'allow',
      shellExecute: 'allow',
      networkAccess: 'deny',
    });

    expect(mapped.codexOptions).toEqual({
      config: {
        default_permissions: ':workspace',
      },
    });
    expect(mapped.approvalPolicy).toBe('on-request');
    expect(mapped).not.toHaveProperty('sandboxMode');
    expect(mapped).not.toHaveProperty('networkAccessEnabled');
  });

  it('treats omitted capability fields as unset within a provided Codex policy', () => {
    const mapped = mapPermissionsToCodexOptions({});

    expect(mapped.codexOptions).toEqual({
      config: {
        default_permissions: ':workspace',
      },
    });
    expect(mapped.approvalPolicy).toBe('on-request');
    expect(mapped).not.toHaveProperty('sandboxMode');
    expect(mapped).not.toHaveProperty('networkAccessEnabled');
  });

  it('maps workspace writablePaths to a custom Codex permission profile', () => {
    const mapped = mapPermissionsToCodexOptions({
      mode: 'auto',
      writablePaths: ['./.git/', 'generated/./cache//'],
    });

    expect(mapped.approvalPolicy).toBe('on-request');
    expect(mapped.writablePaths).toEqual({
      paths: ['.git', 'generated/cache'],
      enforcement: 'profile',
    });
    expect(mapped.codexOptions).toEqual({
      config: {
        default_permissions: 'cligent-workspace-extra-writes',
        approvals_reviewer: 'auto_review',
      },
    });
    expect(mapped.codexCliConfigOverrides).toEqual([
      'permissions.cligent-workspace-extra-writes={extends=":workspace", filesystem={":workspace_roots"={".git"="write", "generated/cache"="write"}}}',
    ]);
    expect(mapped).not.toHaveProperty('sandboxMode');
    expect(mapped).not.toHaveProperty('networkAccessEnabled');
  });

  it('injects generated Codex profile config through a temporary CLI wrapper', async () => {
    let capturedCodexOptions: MockCodexConstructorOptions | undefined;
    let wrapperScript: string | undefined;
    let wrapperPath: string | undefined;

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
        onConstruct(options) {
          capturedCodexOptions = options;
          wrapperPath = options?.codexPathOverride;
          if (wrapperPath) {
            wrapperScript = readFileSync(wrapperPath, 'utf8');
          }
        },
      }),
    });

    await collect(
      adapter.run('implement feature', {
        permissions: { mode: 'auto', writablePaths: ['.git'] },
      }),
    );

    expect(capturedCodexOptions?.config).toEqual({
      default_permissions: 'cligent-workspace-extra-writes',
      approvals_reviewer: 'auto_review',
    });
    expect(wrapperPath).toBeDefined();
    expect(wrapperScript).toContain(
      'permissions.cligent-workspace-extra-writes={extends=\\"' +
        ':workspace\\", filesystem={\\":workspace_roots\\"={\\".git\\"=\\"write\\"}}}',
    );
    expect(existsSync(wrapperPath!)).toBe(false);
  });

  it('rejects writablePaths that conflict with read-only Codex local access', () => {
    expect(() =>
      mapPermissionsToCodexOptions({
        fileWrite: 'deny',
        writablePaths: ['.git'],
      }),
    ).toThrow(
      'Codex permission policy cannot combine non-empty writablePaths with read-only local access',
    );

    expect(() =>
      mapPermissionsToCodexOptions({
        shellExecute: 'deny',
        writablePaths: ['.git'],
      }),
    ).toThrow(/read-only local access/);
  });

  it('keeps danger-full-access broad when writablePaths are redundant', () => {
    const mapped = mapPermissionsToCodexOptions({
      mode: 'bypass',
      writablePaths: ['./.git/'],
    });

    expect(mapped.writablePaths).toEqual({
      paths: ['.git'],
      enforcement: 'ambient',
    });
    expect(mapped.codexOptions).toEqual({
      config: {
        default_permissions: ':danger-full-access',
      },
    });
    expect(mapped.approvalPolicy).toBe('never');
  });

  it('passes AgentOptions through to thread/run options', async () => {
    let capturedCodexOptions: MockCodexConstructorOptions | undefined;
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
        onConstruct(options) {
          capturedCodexOptions = options;
        },
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

    expect(capturedCodexOptions).toEqual({
      config: {
        default_permissions: ':workspace',
      },
    });
    expect(capturedThreadOptions).toMatchObject({
      workingDirectory: '/tmp/repo',
      model: 'gpt-5-codex',
      approvalPolicy: 'untrusted',
      skipGitRepoCheck: true,
    });
    expect(capturedThreadOptions).not.toHaveProperty('sandboxMode');
    expect(capturedThreadOptions).not.toHaveProperty('networkAccessEnabled');

    expect(capturedRunPrompt).toBe('implement feature');
    expect(capturedRunOptions?.signal).toBeUndefined();
  });

  it('passes auto-review config to the Codex SDK constructor for auto mode', async () => {
    let capturedCodexOptions: MockCodexConstructorOptions | undefined;
    let capturedThreadOptions: MockThreadOptions | undefined;

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
        onConstruct(options) {
          capturedCodexOptions = options;
        },
        onStartThread(options) {
          capturedThreadOptions = options;
        },
      }),
    });

    await collect(
      adapter.run('implement feature', {
        permissions: { mode: 'auto' },
      }),
    );

    expect(capturedCodexOptions).toEqual({
      config: {
        default_permissions: ':workspace',
        approvals_reviewer: 'auto_review',
      },
    });
    expect(capturedThreadOptions).toMatchObject({
      approvalPolicy: 'on-request',
    });
    expect(capturedThreadOptions).not.toHaveProperty('sandboxMode');
    expect(capturedThreadOptions).not.toHaveProperty('networkAccessEnabled');
  });

  it('sets danger-full-access default_permissions without auto-review for bypass mode', async () => {
    let capturedCodexOptions: MockCodexConstructorOptions | undefined;
    let capturedThreadOptions: MockThreadOptions | undefined;

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
        onConstruct(options) {
          capturedCodexOptions = options;
        },
        onStartThread(options) {
          capturedThreadOptions = options;
        },
      }),
    });

    await collect(
      adapter.run('implement feature', {
        permissions: { mode: 'bypass' },
      }),
    );

    expect(capturedCodexOptions).toEqual({
      config: {
        default_permissions: ':danger-full-access',
      },
    });
    expect(capturedThreadOptions).toMatchObject({
      approvalPolicy: 'never',
    });
    expect(capturedThreadOptions).not.toHaveProperty('sandboxMode');
    expect(capturedThreadOptions).not.toHaveProperty('networkAccessEnabled');
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
          startThread(_options?: MockThreadOptions): MockCodexThread {
            return {
              async runStreamed(
                _prompt: string,
                runOptions?: MockRunOptions,
              ): Promise<{ events: AsyncIterable<unknown> }> {
                capturedSignal = runOptions?.signal;
                return {
                  events: {
                    async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, void> {
                      yield {
                        type: 'item.completed',
                        item: { type: 'message', text: 'started' },
                      };

                      await new Promise<void>((resolve) => {
                        if (runOptions?.signal?.aborted) {
                          resolve();
                          return;
                        }
                        runOptions?.signal?.addEventListener('abort', () => resolve(), {
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

  it('sets interrupted resumeToken from backend id, inbound resume, or omission', async () => {
    async function interruptedResumeToken(options: {
      backendThreadId?: string;
      resume?: string;
    }): Promise<string | undefined> {
      const externalAbort = new AbortController();
      const makeThread = (): MockCodexThread => ({
        async runStreamed(
          _prompt: string,
          runOptions?: MockRunOptions,
        ): Promise<{ events: AsyncIterable<unknown> }> {
          return {
            events: {
              async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, void> {
                yield {
                  type: 'item.completed',
                  item: { type: 'message', text: 'started' },
                  ...(options.backendThreadId
                    ? { threadId: options.backendThreadId }
                    : {}),
                };

                await new Promise<void>((resolve) => {
                  if (runOptions?.signal?.aborted) {
                    resolve();
                    return;
                  }
                  runOptions?.signal?.addEventListener('abort', () => resolve(), {
                    once: true,
                  });
                });
              },
            },
          };
        },
      });

      const adapter = new CodexAdapter({
        loadSdk: async () => ({
          Codex: class {
            startThread(_options?: MockThreadOptions): MockCodexThread {
              return makeThread();
            }

            resumeThread(
              threadId: string,
              _options?: MockThreadOptions,
            ): MockCodexThread {
              expect(threadId).toBe(options.resume);
              return makeThread();
            }
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
      return done.payload.resumeToken;
    }

    await expect(
      interruptedResumeToken({ backendThreadId: 'thread-abort-new' }),
    ).resolves.toBe('thread-abort-new');
    await expect(
      interruptedResumeToken({ resume: 'thread-abort-resume' }),
    ).resolves.toBe('thread-abort-resume');
    await expect(interruptedResumeToken({})).resolves.toBeUndefined();
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

    expect(mapped.codexOptions).toEqual({
      config: {
        default_permissions: ':danger-full-access',
      },
    });
    expect(mapped.threadOptions.approvalPolicy).toBe('never');
    expect(mapped.threadOptions).not.toHaveProperty('sandboxMode');
    expect(mapped.threadOptions).not.toHaveProperty('networkAccessEnabled');

    expect(mapped.runOptions.signal).toBeDefined();

    externalAbort.abort();

    expect(mapped.runOptions.signal?.aborted).toBe(true);

    mapped.cleanupAbort();
  });

  it('sets skipGitRepoCheck so the SDK accepts non-git working directories', () => {
    // Asserted even with no cwd: programmatic callers (tmux-play) choose
    // workingDirectory deliberately and frequently target tmpdirs.
    const mapped = mapAgentOptionsToCodexOptions({});
    expect(mapped.threadOptions.skipGitRepoCheck).toBe(true);

    const mappedWithCwd = mapAgentOptionsToCodexOptions({ cwd: '/tmp/elsewhere' });
    expect(mappedWithCwd.threadOptions.workingDirectory).toBe('/tmp/elsewhere');
    expect(mappedWithCwd.threadOptions.skipGitRepoCheck).toBe(true);
  });

  it('maps reasoningEffort to SDK modelReasoningEffort per CODEX-007', () => {
    const cases: Array<[ReasoningEffort | undefined, string | undefined]> = [
      [undefined, undefined],
      ['minimal', 'minimal'],
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
      ['xhigh', 'xhigh'],
      ['max', 'xhigh'],
    ];

    for (const [input, expected] of cases) {
      expect(mapReasoningEffortToCodexEffort(input)).toBe(expected);

      const mapped = mapAgentOptionsToCodexOptions(
        input === undefined ? {} : { reasoningEffort: input },
      );
      expect(mapped.threadOptions.modelReasoningEffort).toBe(expected);
    }
  });

  it('forwards reasoningEffort to startThread()', async () => {
    let captured: MockThreadOptions | undefined;

    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              usage: { input_tokens: 1, output_tokens: 1, tool_uses: 0 },
            },
          },
        ],
        onStartThread: (options) => {
          captured = options;
        },
      }),
    });

    await collect(adapter.run('prompt', { reasoningEffort: 'high' }));

    expect(captured?.modelReasoningEffort).toBe('high');
  });

  it('throws descriptive error when Codex constructor fails', async () => {
    const adapter = new CodexAdapter({
      loadSdk: async () => ({
        Codex: class {
          constructor() {
            throw new Error('Unable to locate Codex CLI binaries');
          }

          startThread(): MockCodexThread {
            throw new Error('unreachable');
          }
        },
      }),
    });

    const stream = adapter.run('prompt');
    await expect(stream.next()).rejects.toThrow(
      'CodexAdapter failed to initialize: Unable to locate Codex CLI binaries',
    );
  });

  it('handles runStreamed returning a direct AsyncIterable without events wrapper', async () => {
    const adapter = new CodexAdapter({
      loadSdk: async () => ({
        Codex: class {
          startThread(): {
            runStreamed(
              prompt: string,
              options?: MockRunOptions,
            ): Promise<AsyncIterable<unknown>>;
          } {
            return {
              async runStreamed(): Promise<AsyncIterable<unknown>> {
                return {
                  async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, void> {
                    yield {
                      type: 'item.completed',
                      item: { type: 'message', text: 'direct iterable' },
                    };
                    yield {
                      type: 'turn.completed',
                      turn: {
                        status: 'success',
                        usage: { input_tokens: 1, output_tokens: 2, tool_uses: 0 },
                      },
                    };
                  },
                };
              },
            };
          }
        },
      }),
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((e) => e.type)).toEqual(['init', 'text', 'done']);

    const text = events[1] as AgentEvent & { payload: { content: string } };
    expect(text.payload.content).toBe('direct iterable');

    const done = events[2] as AgentEvent & { payload: { status: string } };
    expect(done.payload.status).toBe('success');
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

  it('sums cache tokens into inputTokens', async () => {
    const adapter = new CodexAdapter({
      loadSdk: makeLoader({
        events: [
          {
            type: 'turn.completed',
            turn: {
              status: 'success',
              result: 'ok',
              usage: {
                input_tokens: 10,
                output_tokens: 20,
                cache_read_input_tokens: 80,
                cache_creation_input_tokens: 30,
                tool_uses: 0,
              },
              duration_ms: 50,
            },
          },
        ],
      }),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((e) => e.type === 'done')!;
    const usage = (done.payload as { usage: { inputTokens: number } }).usage;
    expect(usage.inputTokens).toBe(120);
  });

  it('maps PermissionPolicy.mode to Codex approval axis and default_permissions per ENG-021', () => {
    const auto = mapPermissionsToCodexOptions({ mode: 'auto' });
    expect(auto.approvalPolicy).toBe('on-request');
    expect(auto.codexOptions).toEqual({
      config: {
        default_permissions: ':workspace',
        approvals_reviewer: 'auto_review',
      },
    });
    expect(auto).not.toHaveProperty('sandboxMode');
    expect(auto).not.toHaveProperty('networkAccessEnabled');

    const autoAllAllow = mapPermissionsToCodexOptions({
      mode: 'auto',
      fileWrite: 'allow',
      shellExecute: 'allow',
      networkAccess: 'allow',
    });
    expect(autoAllAllow.approvalPolicy).toBe('on-request');
    expect(autoAllAllow.codexOptions).toEqual({
      config: {
        default_permissions: ':danger-full-access',
        approvals_reviewer: 'auto_review',
      },
    });

    const bypass = mapPermissionsToCodexOptions({ mode: 'bypass' });
    expect(bypass.approvalPolicy).toBe('never');
    expect(bypass.codexOptions).toEqual({
      config: {
        default_permissions: ':danger-full-access',
      },
    });
    expect(bypass).not.toHaveProperty('sandboxMode');
    expect(bypass).not.toHaveProperty('networkAccessEnabled');

    // Codex models automation and local access independently: auto still
    // selects auto-review, while denied file/shell access narrows the profile.
    const autoNarrowsLocalAccess = mapPermissionsToCodexOptions({
      mode: 'auto',
      fileWrite: 'deny',
      shellExecute: 'deny',
      networkAccess: 'allow',
    });
    expect(autoNarrowsLocalAccess.approvalPolicy).toBe('on-request');
    expect(autoNarrowsLocalAccess.codexOptions).toEqual({
      config: {
        default_permissions: ':read-only',
        approvals_reviewer: 'auto_review',
      },
    });
    expect(autoNarrowsLocalAccess).not.toHaveProperty('sandboxMode');
    expect(autoNarrowsLocalAccess).not.toHaveProperty('networkAccessEnabled');
  });
});
