// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, it, expect } from 'vitest';

import {
  ClaudeCodeAdapter,
  mapAgentOptionsToClaudeQueryOptions,
  mapPermissionsToClaudeOptions,
} from '../adapters/claude-code.js';
import type { AgentEvent, PermissionLevel, PermissionPolicy } from '../types.js';

interface MockSdkInnerOptions {
  cwd?: string;
  model?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  resume?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  canUseTool?: (tool: { name?: string; toolName?: string }) => boolean | undefined;
  abortController?: AbortController;
  env?: Record<string, string | undefined>;
}

interface MockSdkOptions {
  prompt: string;
  options?: MockSdkInnerOptions;
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
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
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
            total_cost_usd: 0.25,
          },
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
      payload: { toolName: string; toolUseId: string; input: Record<string, unknown> };
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
    expect(done.payload.result).toBe('done text');
    expect(done.payload.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      toolUses: 1,
      totalCostUsd: 0.25,
    });
    expect(done.payload.durationMs).toBe(321);
  });

  it('preserves assistant content-block order in emitted events', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
          model: 'claude',
          cwd: '/repo',
          tools: ['Write', 'Bash'],
          sessionId: 'session-order',
        },
        {
          type: 'assistant',
          content: [
            { type: 'tool_use', id: 'tool-9', name: 'Bash', input: { command: 'pwd' } },
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

  it('maps permission policy combinations correctly', () => {
    const levels: PermissionLevel[] = ['allow', 'ask', 'deny'];

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

          expect(mapped.permissionMode).toBe('default');
          expect(mapped.canUseTool).toBeTypeOf('function');

          const canUseWrite = mapped.canUseTool?.({ name: 'Write' });
          const canUseEdit = mapped.canUseTool?.({ name: 'Edit' });
          const canUseBash = mapped.canUseTool?.({ name: 'Bash' });
          const canUseWebFetch = mapped.canUseTool?.({ name: 'WebFetch' });
          const canUseWriteConfig = mapped.canUseTool?.({ name: 'WriteConfig' });

          expect(canUseWrite).toBe(
            fileWrite === 'allow' ? true : fileWrite === 'deny' ? false : undefined,
          );
          expect(canUseEdit).toBe(
            fileWrite === 'allow' ? true : fileWrite === 'deny' ? false : undefined,
          );
          expect(canUseBash).toBe(
            shellExecute === 'allow'
              ? true
              : shellExecute === 'deny'
                ? false
                : undefined,
          );
          expect(canUseWebFetch).toBe(
            networkAccess === 'allow'
              ? true
              : networkAccess === 'deny'
                ? false
                : undefined,
          );
          expect(canUseWriteConfig).toBe(undefined);
        }
      }
    }
  });

  it('passes agent options through to SDK query options', async () => {
    let captured: (MockSdkInnerOptions & { prompt: string }) | undefined;

    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader(
        [
          { type: 'result', status: 'success', usage: { input_tokens: 0, output_tokens: 0 } },
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
      allowedTools: ['Bash', 'Write'],
      disallowedTools: ['WebFetch'],
      permissionMode: 'default',
    });
    expect(captured?.canUseTool).toBeTypeOf('function');
    expect(captured?.canUseTool?.({ name: 'Write' })).toBe(false);
    expect(captured?.canUseTool?.({ name: 'Bash' })).toBe(true);
    expect(captured?.canUseTool?.({ name: 'WebFetch' })).toBe(undefined);
  });

  it('propagates abort signal to SDK abortController', async () => {
    const externalAbort = new AbortController();
    let innerAbortController: AbortController | undefined;

    const adapter = new ClaudeCodeAdapter({
      loadSdk: async () => ({
        query(opts: MockSdkOptions): AsyncIterable<unknown> {
          innerAbortController = opts.options?.abortController;
          return {
            async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, void> {
              yield {
                type: 'system',
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
            async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, void> {
              yield {
                type: 'system',
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
                opts.options?.abortController?.signal.addEventListener('abort', () => resolve(), {
                  once: true,
                });
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
            async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, void> {
              yield {
                type: 'system',
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
                opts.options?.abortController?.signal.addEventListener('abort', () => resolve(), {
                  once: true,
                });
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

  it('emits error + done when SDK stream throws', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: async () => ({
        query(): AsyncIterable<unknown> {
          return {
            async *[Symbol.asyncIterator](): AsyncGenerator<unknown, void, void> {
              yield {
                type: 'system',
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
    expect(events.map((event) => event.type)).toEqual(['init', 'error', 'done']);

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
              { type: 'tool_use', id: 'tool-n1', name: 'Write', input: { path: '/tmp/f' } },
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
    expect(events.map((e) => e.type)).toEqual(['init', 'text', 'tool_use', 'done']);

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

  it('omits resumeToken when backend provides no session ID', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: makeLoader([
        {
          type: 'system',
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
      ]),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((e) => e.type === 'done')!;
    const payload = done.payload as { resumeToken?: string };
    expect(payload.resumeToken).toBeUndefined();
  });
});
