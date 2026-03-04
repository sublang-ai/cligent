// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  buildGeminiToolSettings,
  GeminiAdapter,
  mapAgentOptionsToGeminiCommand,
  mapPermissionsToGeminiToolConfig,
} from '../adapters/gemini.js';
import type { AgentEvent, PermissionLevel, PermissionPolicy } from '../types.js';

class MockGeminiProcess extends EventEmitter {
  readonly stdout = new PassThrough();

  readonly stderr = new PassThrough();

  killed = false;

  killSignals: Array<NodeJS.Signals | number | undefined> = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignals.push(signal);
    return true;
  }
}

interface SpawnInvocation {
  command: string;
  args: readonly string[];
  options: SpawnOptionsWithoutStdio;
  process: MockGeminiProcess;
}

function makeSpawn(script: (process: MockGeminiProcess) => void): {
  spawnProcess: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcessWithoutNullStreams;
  invocations: SpawnInvocation[];
} {
  const invocations: SpawnInvocation[] = [];

  const spawnProcess = (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio,
  ): ChildProcessWithoutNullStreams => {
    const process = new MockGeminiProcess();
    invocations.push({ command, args, options, process });

    queueMicrotask(() => {
      script(process);
    });

    return process as unknown as ChildProcessWithoutNullStreams;
  };

  return { spawnProcess, invocations };
}

function writeEventsAndClose(
  process: MockGeminiProcess,
  events: string[],
  closeCode: number | null,
  closeSignal: NodeJS.Signals | null,
  stderr?: string,
): void {
  for (const event of events) {
    process.stdout.write(`${event}\n`);
  }

  if (stderr) {
    process.stderr.write(stderr);
  }

  process.stdout.end();
  process.stderr.end();
  process.emit('close', closeCode, closeSignal);
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

describe('GeminiAdapter', () => {
  it('maps Gemini NDJSON events to unified events', async () => {
    const { spawnProcess } = makeSpawn((process) => {
      writeEventsAndClose(
        process,
        [
          JSON.stringify({
            type: 'init',
            sessionId: 'gemini-session-1',
            model: 'gemini-2.5-pro',
            cwd: '/repo',
            tools: ['edit', 'ShellTool'],
          }),
          JSON.stringify({
            type: 'message',
            sessionId: 'gemini-session-1',
            content: 'Hello from Gemini',
          }),
          JSON.stringify({
            type: 'tool_use',
            sessionId: 'gemini-session-1',
            id: 'tool-1',
            name: 'ShellTool',
            input: { command: 'ls' },
          }),
          JSON.stringify({
            type: 'tool_result',
            sessionId: 'gemini-session-1',
            toolUseId: 'tool-1',
            toolName: 'ShellTool',
            status: 'success',
            output: { stdout: 'file.txt' },
            duration_ms: 10,
          }),
          JSON.stringify({
            type: 'error',
            sessionId: 'gemini-session-1',
            code: 'TRANSIENT',
            message: 'temporary error',
            recoverable: true,
          }),
          JSON.stringify({
            type: 'result',
            sessionId: 'gemini-session-1',
            status: 'max_turns',
            result: 'summary',
            stats: {
              input_tokens: 12,
              output_tokens: 34,
              tool_uses: 1,
              total_cost_usd: 0.02,
            },
            duration_ms: 222,
          }),
        ],
        0,
        null,
      );
    });

    const adapter = new GeminiAdapter({
      spawnProcess,
      probeAvailability: async () => true,
    });

    const events = await collect(adapter.run('run prompt'));

    expect(events.map((event) => event.type)).toEqual([
      'init',
      'text',
      'tool_use',
      'tool_result',
      'error',
      'done',
    ]);

    const init = events[0] as AgentEvent & {
      payload: { model: string; cwd: string; tools: string[] };
    };
    expect(init.payload.model).toBe('gemini-2.5-pro');
    expect(init.payload.cwd).toBe('/repo');
    expect(init.payload.tools).toEqual(['edit', 'ShellTool']);
    expect(events[0].sessionId).toBe('gemini-session-1');

    const text = events[1] as AgentEvent & { payload: { content: string } };
    expect(text.payload.content).toBe('Hello from Gemini');

    const toolUse = events[2] as AgentEvent & {
      payload: { toolName: string; toolUseId: string; input: Record<string, unknown> };
    };
    expect(toolUse.payload.toolName).toBe('ShellTool');
    expect(toolUse.payload.toolUseId).toBe('tool-1');
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
    expect(toolResult.payload.toolName).toBe('ShellTool');
    expect(toolResult.payload.toolUseId).toBe('tool-1');
    expect(toolResult.payload.status).toBe('success');
    expect(toolResult.payload.output).toEqual({ stdout: 'file.txt' });
    expect(toolResult.payload.durationMs).toBe(10);

    const error = events[4] as AgentEvent & {
      payload: { code: string; message: string; recoverable: boolean };
    };
    expect(error.payload.code).toBe('TRANSIENT');
    expect(error.payload.message).toBe('temporary error');
    expect(error.payload.recoverable).toBe(true);

    const done = events[5] as AgentEvent & {
      payload: {
        status: string;
        result?: string;
        usage: {
          inputTokens: number;
          outputTokens: number;
          toolUses: number;
          totalCostUsd?: number;
        };
        durationMs: number;
      };
    };
    expect(done.payload.status).toBe('max_turns');
    expect(done.payload.result).toBe('summary');
    expect(done.payload.usage).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      toolUses: 1,
      totalCostUsd: 0.02,
    });
    expect(done.payload.durationMs).toBe(222);
  });

  it('emits recoverable error on malformed NDJSON line and continues', async () => {
    const { spawnProcess } = makeSpawn((process) => {
      writeEventsAndClose(
        process,
        [
          JSON.stringify({ type: 'init', sessionId: 's-parse', model: 'gem', cwd: '/tmp' }),
          '{bad json',
          JSON.stringify({ type: 'message', sessionId: 's-parse', content: 'after parse error' }),
          JSON.stringify({
            type: 'result',
            sessionId: 's-parse',
            status: 'success',
            stats: { input_tokens: 0, output_tokens: 1, tool_uses: 0 },
          }),
        ],
        0,
        null,
      );
    });

    const adapter = new GeminiAdapter({
      spawnProcess,
      probeAvailability: async () => true,
    });

    const events = await collect(adapter.run('prompt'));

    expect(events.map((event) => event.type)).toEqual(['init', 'error', 'text', 'done']);

    const parseError = events[1] as AgentEvent & {
      payload: { code?: string; message: string; recoverable: boolean };
    };
    expect(parseError.payload.code).toBe('NDJSON_PARSE_ERROR');
    expect(parseError.payload.recoverable).toBe(true);
    expect(parseError.payload.message).toContain('raw: {bad json');

    const text = events[2] as AgentEvent & { payload: { content: string } };
    expect(text.payload.content).toBe('after parse error');
  });

  it.each([
    { code: 0, expected: 'success' },
    { code: 1, expected: 'error' },
    { code: 42, expected: 'error' },
    { code: 53, expected: 'max_turns' },
  ])('maps exit code $code to done status $expected', async ({ code, expected }) => {
    const { spawnProcess } = makeSpawn((process) => {
      writeEventsAndClose(
        process,
        [
          JSON.stringify({ type: 'init', sessionId: `exit-${code}`, model: 'gem', cwd: '/repo' }),
          JSON.stringify({ type: 'message', sessionId: `exit-${code}`, content: 'no result event' }),
        ],
        code,
        null,
      );
    });

    const adapter = new GeminiAdapter({
      spawnProcess,
      probeAvailability: async () => true,
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((event) => event.type)).toEqual(['init', 'text', 'done']);

    const done = events[2] as AgentEvent & { payload: { status: string } };
    expect(done.payload.status).toBe(expected);
  });

  it('maps permission policy combinations to tool groups', () => {
    const levels: PermissionLevel[] = ['allow', 'ask', 'deny'];

    for (const fileWrite of levels) {
      for (const shellExecute of levels) {
        for (const networkAccess of levels) {
          const policy: PermissionPolicy = {
            fileWrite,
            shellExecute,
            networkAccess,
          };

          const mapped = mapPermissionsToGeminiToolConfig(policy);

          expect(mapped.allowedTools.includes('edit')).toBe(fileWrite === 'allow');
          expect(mapped.allowedTools.includes('ShellTool')).toBe(shellExecute === 'allow');
          expect(mapped.allowedTools.includes('webfetch')).toBe(networkAccess === 'allow');

          expect(mapped.disallowedTools.includes('edit')).toBe(fileWrite === 'deny');
          expect(mapped.disallowedTools.includes('ShellTool')).toBe(shellExecute === 'deny');
          expect(mapped.disallowedTools.includes('webfetch')).toBe(networkAccess === 'deny');
        }
      }
    }
  });

  it('builds Gemini settings with tools.exclude for denied capabilities', () => {
    const config = mapPermissionsToGeminiToolConfig(
      {
        fileWrite: 'deny',
        shellExecute: 'allow',
        networkAccess: 'deny',
      },
      {
        allowedTools: ['custom-tool'],
        disallowedTools: ['blocked-tool'],
      },
    );

    const settings = buildGeminiToolSettings(config);
    expect(settings).toEqual({
      tools: {
        core: ['ShellTool', 'custom-tool'],
        exclude: ['blocked-tool', 'edit', 'webfetch'],
      },
    });
  });

  it('maps agent options to Gemini command flags', () => {
    const mapped = mapAgentOptionsToGeminiCommand('build this', {
      cwd: '/repo',
      model: 'gemini-2.5-pro',
      maxTurns: 7,
      permissions: {
        fileWrite: 'deny',
        shellExecute: 'allow',
        networkAccess: 'ask',
      },
      allowedTools: ['custom-tool'],
      disallowedTools: ['never-tool'],
    });

    expect(mapped.command).toBe('gemini');
    expect(mapped.spawnOptions.cwd).toBe('/repo');
    expect(mapped.args).toEqual([
      '--output-format',
      'stream-json',
      '--model',
      'gemini-2.5-pro',
      '--max-session-turns',
      '7',
      '--allowed-tools',
      'ShellTool,custom-tool',
      'build this',
    ]);
    expect(mapped.toolConfig.disallowedTools).toEqual(['edit', 'never-tool']);
  });

  it('passes prompt as final positional argument (not --prompt flag)', () => {
    const mapped = mapAgentOptionsToGeminiCommand('explain this code', undefined);

    // Prompt must be the last element, with no --prompt flag
    expect(mapped.args[mapped.args.length - 1]).toBe('explain this code');
    expect(mapped.args).not.toContain('--prompt');
  });

  it('passes leading-dash prompt as positional without -- separator', () => {
    // Gemini CLI does not support -- as end-of-options marker.
    // Prompts starting with - are passed as-is; single-word flag-like
    // prompts (e.g. "--help") may be misinterpreted by the CLI.
    const mapped = mapAgentOptionsToGeminiCommand('-v explain', undefined);

    expect(mapped.args[mapped.args.length - 1]).toBe('-v explain');
    expect(mapped.args).not.toContain('--');
  });

  it('passes settings override environment to spawned process', async () => {
    const { spawnProcess, invocations } = makeSpawn((process) => {
      writeEventsAndClose(
        process,
        [
          JSON.stringify({
            type: 'result',
            status: 'success',
            stats: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
          }),
        ],
        0,
        null,
      );
    });

    const adapter = new GeminiAdapter({
      spawnProcess,
      probeAvailability: async () => true,
      createSettingsOverride: async () => ({
        env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/tmp/gemini-settings.json' },
        cleanup: async () => {},
      }),
    });

    await collect(adapter.run('prompt'));

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.options.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(
      '/tmp/gemini-settings.json',
    );
  });

  it('sends SIGTERM on abort and emits interrupted done status', async () => {
    const controller = new AbortController();

    let spawned: MockGeminiProcess | undefined;
    const { spawnProcess } = makeSpawn((process) => {
      spawned = process;

      process.kill = (signal?: NodeJS.Signals | number): boolean => {
        process.killed = true;
        process.killSignals.push(signal);

        queueMicrotask(() => {
          process.stdout.end();
          process.stderr.end();
          process.emit('close', null, 'SIGTERM');
        });

        return true;
      };

      process.stdout.write(
        `${JSON.stringify({
          type: 'init',
          sessionId: 'abort-session',
          model: 'gem',
          cwd: '/repo',
        })}\n`,
      );
    });

    const adapter = new GeminiAdapter({
      spawnProcess,
      probeAvailability: async () => true,
    });

    const stream = adapter.run('prompt', { abortSignal: controller.signal });
    const events: AgentEvent[] = [];

    for await (const event of stream) {
      events.push(event);
      if (event.type === 'init') {
        controller.abort();
      }
    }

    expect(events.map((event) => event.type)).toEqual(['init', 'done']);

    const done = events[1] as AgentEvent & { payload: { status: string } };
    expect(done.payload.status).toBe('interrupted');

    expect(spawned).toBeDefined();
    expect(spawned?.killSignals).toContain('SIGTERM');
  });

  it('returns false from isAvailable when probe fails', async () => {
    const adapter = new GeminiAdapter({
      probeAvailability: async () => false,
    });

    await expect(adapter.isAvailable()).resolves.toBe(false);
  });

  it('returns true from isAvailable when probe succeeds', async () => {
    const adapter = new GeminiAdapter({
      probeAvailability: async () => true,
    });

    await expect(adapter.isAvailable()).resolves.toBe(true);
  });

  it('sets resumeToken on done when backend provides a new session ID', async () => {
    const { spawnProcess } = makeSpawn((process) => {
      writeEventsAndClose(
        process,
        [
          JSON.stringify({
            type: 'init',
            model: 'gemini-pro',
            cwd: '/repo',
            tools: [],
            sessionId: 'gemini-session-new',
          }),
          JSON.stringify({
            type: 'result',
            status: 'success',
            result: 'done',
            stats: { inputTokens: 5, outputTokens: 10, toolUses: 0 },
            durationMs: 100,
            sessionId: 'gemini-session-new',
          }),
        ],
        0,
        null,
      );
    });

    const adapter = new GeminiAdapter({
      spawnProcess,
      probeAvailability: async () => true,
      createSettingsOverride: async () => ({
        env: {},
        cleanup: async () => {},
      }),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((e) => e.type === 'done')!;
    const payload = done.payload as { resumeToken?: string };
    expect(payload.resumeToken).toBe('gemini-session-new');
  });

  it('omits resumeToken when backend provides no session ID', async () => {
    const { spawnProcess } = makeSpawn((process) => {
      writeEventsAndClose(
        process,
        [
          JSON.stringify({
            type: 'init',
            model: 'gemini-pro',
            cwd: '/repo',
            tools: [],
          }),
          JSON.stringify({
            type: 'result',
            status: 'success',
            result: 'done',
            stats: { inputTokens: 5, outputTokens: 10, toolUses: 0 },
            durationMs: 100,
          }),
        ],
        0,
        null,
      );
    });

    const adapter = new GeminiAdapter({
      spawnProcess,
      probeAvailability: async () => true,
      createSettingsOverride: async () => ({
        env: {},
        cleanup: async () => {},
      }),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((e) => e.type === 'done')!;
    const payload = done.payload as { resumeToken?: string };
    expect(payload.resumeToken).toBeUndefined();
  });
});
