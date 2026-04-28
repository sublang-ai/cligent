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

  it('parses snake_case tool_use fields from Gemini CLI v0.31+', async () => {
    const { spawnProcess } = makeSpawn((process) => {
      writeEventsAndClose(
        process,
        [
          JSON.stringify({
            type: 'init',
            sessionId: 'snake-session',
            model: 'gemini-2.5-pro',
            cwd: '/repo',
            tools: ['Read', 'Bash'],
          }),
          JSON.stringify({
            type: 'tool_use',
            sessionId: 'snake-session',
            tool_name: 'Read',
            tool_id: 'read-42',
            parameters: { file_path: '/repo/file.txt' },
          }),
          JSON.stringify({
            type: 'tool_result',
            sessionId: 'snake-session',
            tool_name: 'Read',
            tool_id: 'read-42',
            status: 'success',
            output: 'file contents',
            duration_ms: 5,
          }),
          JSON.stringify({
            type: 'result',
            sessionId: 'snake-session',
            status: 'success',
            stats: { input_tokens: 10, output_tokens: 20, tool_uses: 1 },
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

    const events = await collect(adapter.run('read a file'));

    const toolUse = events.find((e) => e.type === 'tool_use') as AgentEvent & {
      payload: { toolName: string; toolUseId: string; input: Record<string, unknown> };
    };
    expect(toolUse).toBeDefined();
    expect(toolUse.payload.toolName).toBe('Read');
    expect(toolUse.payload.toolUseId).toBe('read-42');
    expect(toolUse.payload.input).toEqual({ file_path: '/repo/file.txt' });

    const toolResult = events.find((e) => e.type === 'tool_result') as AgentEvent & {
      payload: { toolName: string; toolUseId: string; status: string };
    };
    expect(toolResult).toBeDefined();
    expect(toolResult.payload.toolName).toBe('Read');
    expect(toolResult.payload.toolUseId).toBe('read-42');
    expect(toolResult.payload.status).toBe('success');
  });

  it('parses nested functionResponse tool_result payload', async () => {
    const { spawnProcess } = makeSpawn((process) => {
      writeEventsAndClose(
        process,
        [
          JSON.stringify({
            type: 'init',
            sessionId: 'fn-resp',
            model: 'gemini-2.5-pro',
            cwd: '/repo',
          }),
          // tool_use with functionCall nesting
          JSON.stringify({
            type: 'tool_use',
            sessionId: 'fn-resp',
            functionCall: { name: 'Read', id: 'call-99', args: { path: '/a' } },
          }),
          // tool_result with functionResponse nesting (Gemini API style)
          JSON.stringify({
            type: 'tool_result',
            sessionId: 'fn-resp',
            functionResponse: {
              name: 'Read',
              id: 'call-99',
              status: 'success',
              response: 'file contents here',
            },
          }),
          JSON.stringify({
            type: 'result',
            sessionId: 'fn-resp',
            status: 'success',
            stats: { input_tokens: 5, output_tokens: 10, tool_uses: 1 },
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

    const events = await collect(adapter.run('read it'));

    const toolUse = events.find((e) => e.type === 'tool_use') as AgentEvent & {
      payload: { toolName: string; toolUseId: string; input: Record<string, unknown> };
    };
    expect(toolUse).toBeDefined();
    expect(toolUse.payload.toolName).toBe('Read');
    expect(toolUse.payload.toolUseId).toBe('call-99');
    expect(toolUse.payload.input).toEqual({ path: '/a' });

    const toolResult = events.find((e) => e.type === 'tool_result') as AgentEvent & {
      payload: { toolName: string; toolUseId: string; status: string; output: unknown };
    };
    expect(toolResult).toBeDefined();
    expect(toolResult.payload.toolName).toBe('Read');
    expect(toolResult.payload.toolUseId).toBe('call-99');
    expect(toolResult.payload.status).toBe('success');
    expect(toolResult.payload.output).toBe('file contents here');
  });

  it('parses value-wrapped functionCall/functionResponse payloads', async () => {
    const { spawnProcess } = makeSpawn((process) => {
      writeEventsAndClose(
        process,
        [
          JSON.stringify({
            type: 'init',
            sessionId: 'val-wrap',
            model: 'gemini-2.5-pro',
            cwd: '/repo',
          }),
          // value wrapper around functionCall (raw Turn event shape)
          JSON.stringify({
            type: 'tool_use',
            sessionId: 'val-wrap',
            value: {
              functionCall: { name: 'Bash', id: 'bash-1', args: { command: 'ls' } },
            },
          }),
          // value wrapper around functionResponse
          JSON.stringify({
            type: 'tool_result',
            sessionId: 'val-wrap',
            value: {
              functionResponse: {
                name: 'Bash',
                id: 'bash-1',
                status: 'success',
                response: 'file1.txt\nfile2.txt',
              },
            },
          }),
          JSON.stringify({
            type: 'result',
            sessionId: 'val-wrap',
            status: 'success',
            stats: { input_tokens: 3, output_tokens: 7, tool_uses: 1 },
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

    const events = await collect(adapter.run('list files'));

    const toolUse = events.find((e) => e.type === 'tool_use') as AgentEvent & {
      payload: { toolName: string; toolUseId: string; input: Record<string, unknown> };
    };
    expect(toolUse).toBeDefined();
    expect(toolUse.payload.toolName).toBe('Bash');
    expect(toolUse.payload.toolUseId).toBe('bash-1');
    expect(toolUse.payload.input).toEqual({ command: 'ls' });

    const toolResult = events.find((e) => e.type === 'tool_result') as AgentEvent & {
      payload: { toolName: string; toolUseId: string; status: string; output: unknown };
    };
    expect(toolResult).toBeDefined();
    expect(toolResult.payload.toolName).toBe('Bash');
    expect(toolResult.payload.toolUseId).toBe('bash-1');
    expect(toolResult.payload.status).toBe('success');
    expect(toolResult.payload.output).toBe('file1.txt\nfile2.txt');
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

  it('surfaces error.message from terminal result events', async () => {
    const { spawnProcess } = makeSpawn((process) => {
      writeEventsAndClose(
        process,
        [
          JSON.stringify({ type: 'init', sessionId: 's-err', model: 'gem', cwd: '/tmp' }),
          JSON.stringify({
            type: 'result',
            sessionId: 's-err',
            status: 'error',
            error: { message: 'API key not valid. Please pass a valid API key.' },
            stats: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
          }),
        ],
        1,
        null,
      );
    });

    const adapter = new GeminiAdapter({
      spawnProcess,
      probeAvailability: async () => true,
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((e) => e.type)).toEqual(['init', 'error', 'done']);

    const errorEvt = events[1] as AgentEvent & {
      payload: { message: string; recoverable: boolean };
    };
    expect(errorEvt.payload.message).toBe(
      'API key not valid. Please pass a valid API key.',
    );
    expect(errorEvt.payload.recoverable).toBe(false);

    const done = events[2] as AgentEvent & {
      payload: { status: string; result?: string };
    };
    expect(done.payload.status).toBe('error');
    expect(done.payload.result).toBe(
      'API key not valid. Please pass a valid API key.',
    );
  });

  it('surfaces diagnostic dump when result has error status but no error.message', async () => {
    const { spawnProcess } = makeSpawn((process) => {
      writeEventsAndClose(
        process,
        [
          JSON.stringify({ type: 'init', sessionId: 's-bare', model: 'gem', cwd: '/tmp' }),
          JSON.stringify({
            type: 'result',
            sessionId: 's-bare',
            status: 'error',
            stats: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
          }),
        ],
        1,
        null,
      );
    });

    const adapter = new GeminiAdapter({
      spawnProcess,
      probeAvailability: async () => true,
    });

    const events = await collect(adapter.run('prompt'));
    expect(events.map((e) => e.type)).toEqual(['init', 'error', 'done']);

    const errorEvt = events[1] as AgentEvent & {
      payload: { code?: string; message: string; recoverable: boolean };
    };
    expect(errorEvt.payload.code).toBe('GEMINI_RESULT_ERROR');
    expect(errorEvt.payload.message).toContain('Gemini result error');
    expect(errorEvt.payload.message).toContain('"status":"error"');
    expect(errorEvt.payload.recoverable).toBe(false);
  });

  it.each([
    { code: 0, expected: 'success', hasError: false },
    { code: 1, expected: 'error', hasError: true },
    { code: 42, expected: 'error', hasError: true },
    { code: 53, expected: 'max_turns', hasError: false },
  ])('maps exit code $code to done status $expected', async ({ code, expected, hasError }) => {
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
    const expectedTypes = hasError
      ? ['init', 'text', 'error', 'done']
      : ['init', 'text', 'done'];
    expect(events.map((event) => event.type)).toEqual(expectedTypes);

    const done = events[events.length - 1] as AgentEvent & { payload: { status: string; result?: string } };
    expect(done.payload.status).toBe(expected);

    if (hasError) {
      const errorEvt = events[events.length - 2] as AgentEvent & {
        payload: { code?: string; message: string };
      };
      expect(errorEvt.payload.code).toBe('GEMINI_EXIT_ERROR');
      expect(errorEvt.payload.message).toContain(`code ${code}`);
      expect(done.payload.result).toContain(`code ${code}`);
    }
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

  it('trusts the workspace for headless Gemini CLI runs by default', async () => {
    const previousTrust = process.env.GEMINI_CLI_TRUST_WORKSPACE;
    delete process.env.GEMINI_CLI_TRUST_WORKSPACE;

    try {
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
      });

      await collect(adapter.run('prompt'));

      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.options.env?.GEMINI_CLI_TRUST_WORKSPACE).toBe(
        'true',
      );
    } finally {
      if (previousTrust === undefined) {
        delete process.env.GEMINI_CLI_TRUST_WORKSPACE;
      } else {
        process.env.GEMINI_CLI_TRUST_WORKSPACE = previousTrust;
      }
    }
  });

  it('preserves an existing Gemini workspace trust environment value', async () => {
    const previousTrust = process.env.GEMINI_CLI_TRUST_WORKSPACE;
    process.env.GEMINI_CLI_TRUST_WORKSPACE = 'false';

    try {
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
      });

      await collect(adapter.run('prompt'));

      expect(invocations).toHaveLength(1);
      expect(invocations[0]?.options.env?.GEMINI_CLI_TRUST_WORKSPACE).toBe(
        'false',
      );
    } finally {
      if (previousTrust === undefined) {
        delete process.env.GEMINI_CLI_TRUST_WORKSPACE;
      } else {
        process.env.GEMINI_CLI_TRUST_WORKSPACE = previousTrust;
      }
    }
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

  it('sums cache tokens into inputTokens', async () => {
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
            result: 'ok',
            stats: {
              input_tokens: 7,
              output_tokens: 15,
              cache_read_input_tokens: 60,
              cache_creation_input_tokens: 25,
              tool_uses: 0,
            },
            duration_ms: 50,
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
    const usage = (done.payload as { usage: { inputTokens: number } }).usage;
    expect(usage.inputTokens).toBe(92);
  });
});
