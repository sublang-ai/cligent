// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  buildGeminiPolicyToml,
  buildGeminiSettings,
  buildGeminiToolSettings,
  GEMINI_REASONING_EFFORT_ALIAS,
  GeminiAdapter,
  mapAgentOptionsToGeminiCommand,
  mapPermissionsToGeminiToolConfig,
} from '../adapters/gemini.js';
import type {
  AgentEvent,
  AgentOptions,
  GeminiEffort,
  PermissionLevel,
  PermissionPolicy,
} from '../types.js';

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

function modelArg(args: readonly string[]): string | undefined {
  const prefix = '--model=';
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function expectReasoningAlias(
  mapped: ReturnType<typeof mapAgentOptionsToGeminiCommand>,
  model: string,
  thinkingConfig: Record<string, unknown>,
): void {
  expect(modelArg(mapped.args)).toBe(GEMINI_REASONING_EFFORT_ALIAS);
  expect(buildGeminiSettings(mapped.settingsConfig)).toEqual({
    modelConfigs: {
      customAliases: {
        [GEMINI_REASONING_EFFORT_ALIAS]: {
          modelConfig: {
            model,
            generateContentConfig: {
              thinkingConfig,
            },
          },
        },
      },
    },
  });
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

  it('maps permission policy combinations to Gemini 0.50 policy rules', () => {
    const levels: PermissionLevel[] = ['allow', 'ask', 'deny'];
    const toolGroups = {
      fileWrite: ['replace', 'write_file'],
      shellExecute: ['run_shell_command'],
      networkAccess: ['google_web_search', 'web_fetch'],
    } as const;

    for (const fileWrite of levels) {
      for (const shellExecute of levels) {
        for (const networkAccess of levels) {
          const policy: PermissionPolicy = {
            fileWrite,
            shellExecute,
            networkAccess,
          };

          const mapped = mapPermissionsToGeminiToolConfig(policy);
          const expectedLevels = { fileWrite, shellExecute, networkAccess };

          for (const capability of Object.keys(toolGroups) as Array<
            keyof typeof toolGroups
          >) {
            const level = expectedLevels[capability];
            for (const toolName of toolGroups[capability]) {
              const rule = mapped.policyRules.find(
                (candidate) => candidate.toolName === toolName,
              );
              expect(rule).toEqual({
                toolName,
                decision:
                  level === 'allow'
                    ? 'allow'
                    : level === 'ask'
                      ? 'ask_user'
                      : 'deny',
                priority: level === 'deny' ? 999 : 997,
                interactive: false,
              });
            }
          }
        }
      }
    }
  });

  it('keeps the legacy tool-settings helper compatibility-only', () => {
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
        core: ['custom-tool'],
        exclude: [
          'blocked-tool',
          'google_web_search',
          'replace',
          'web_fetch',
          'write_file',
        ],
      },
    });
    expect(config.args).toEqual([]);
  });

  it('accepts legacy GeminiToolConfig values without policyRules', () => {
    expect(
      buildGeminiSettings({
        toolConfig: {
          allowedTools: ['legacy-tool'],
          disallowedTools: ['legacy-blocked'],
          args: [],
        },
      }),
    ).toEqual({
      tools: {
        core: ['legacy-tool'],
        exclude: ['legacy-blocked'],
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
      '--model=gemini-2.5-pro',
      '--prompt=build this',
    ]);
    expect(mapped.args).not.toContain('--max-session-turns');
    expect(mapped.args).not.toContain('--allowed-tools');
    expect(mapped.toolConfig.disallowedTools).toEqual([
      'never-tool',
      'replace',
      'write_file',
    ]);
    expect(mapped.toolConfig.allowedTools).toEqual(['custom-tool']);
  });

  it('distinguishes native defaults from an explicit empty policy', () => {
    const native = mapPermissionsToGeminiToolConfig(undefined);
    expect(native.policyRules).toEqual([]);

    const explicit = mapPermissionsToGeminiToolConfig({});
    expect(explicit.policyRules).toHaveLength(5);
    expect(explicit.policyRules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: 'replace',
          decision: 'ask_user',
          interactive: false,
        }),
        expect.objectContaining({
          toolName: 'run_shell_command',
          decision: 'ask_user',
          interactive: false,
        }),
        expect.objectContaining({
          toolName: 'web_fetch',
          decision: 'ask_user',
          interactive: false,
        }),
      ]),
    );
  });

  it('keeps explicit allowlists closed and serializes denies before allows', () => {
    const mapped = mapPermissionsToGeminiToolConfig(
      {
        fileWrite: 'deny',
        shellExecute: 'allow',
        networkAccess: 'allow',
      },
      {
        allowedTools: ['custom-tool', 'replace', 'safe-tool'],
        disallowedTools: ['custom-tool'],
      },
    );

    expect(mapped.allowedTools).toEqual(['safe-tool']);
    expect(mapped.policyRules.slice(0, 4)).toEqual([
      {
        toolName: 'custom-tool',
        decision: 'deny',
        priority: 999,
        interactive: false,
      },
      {
        toolName: 'replace',
        decision: 'deny',
        priority: 999,
        interactive: false,
      },
      {
        toolName: 'write_file',
        decision: 'deny',
        priority: 999,
        interactive: false,
      },
      {
        toolName: 'safe-tool',
        decision: 'allow',
        priority: 999,
        interactive: false,
      },
    ]);
    expect(mapped.policyRules[4]).toEqual({
      toolName: '*',
      decision: 'deny',
      priority: 998,
      interactive: false,
    });
    expect(mapped.policyRules).toContainEqual({
      toolName: 'run_shell_command',
      decision: 'allow',
      priority: 997,
      interactive: false,
    });
  });

  it('emits a closed catch-all policy for an explicit empty allowlist', () => {
    const mapped = mapPermissionsToGeminiToolConfig(undefined, {
      allowedTools: [],
    });

    expect(mapped.policyRules).toEqual([
      {
        toolName: '*',
        decision: 'deny',
        priority: 998,
        interactive: false,
      },
    ]);
  });

  it('escapes accepted tool names as valid TOML basic strings', () => {
    const toolName = 'tool"\\\n\u0001\u007f\u{1F680}';
    const mapped = mapPermissionsToGeminiToolConfig(undefined, {
      disallowedTools: [toolName],
    });

    expect(buildGeminiPolicyToml(mapped.policyRules)).toContain(
      'toolName = "tool\\"\\\\\\n\\u0001\\u007F\u{1F680}"',
    );
  });

  it.each([
    ['allowedTools', ['safe', ''], 1, 'must not be empty'],
    ['disallowedTools', [''], 0, 'must not be empty'],
    [
      'allowedTools',
      ['safe', 'bad*name'],
      1,
      'must not contain Gemini Policy Engine wildcard syntax "*"',
    ],
    [
      'disallowedTools',
      ['bad\ud800name'],
      0,
      'must not contain an unpaired Unicode surrogate',
    ],
    [
      'allowedTools',
      ['bad\udc00name'],
      0,
      'must not contain an unpaired Unicode surrogate',
    ],
  ] as const)(
    'rejects invalid %s policy names before spawn',
    async (option, values, index, detail) => {
      let spawnCount = 0;
      const adapter = new GeminiAdapter({
        spawnProcess: () => {
          spawnCount += 1;
          throw new Error('must not spawn');
        },
      });

      const runOptions = {
        [option]: values,
      } as unknown as AgentOptions<GeminiEffort>;
      await expect(collect(adapter.run('prompt', runOptions))).rejects.toThrow(
        `${option}[${index}] ${detail}`,
      );
      expect(spawnCount).toBe(0);
    },
  );

  it('maps an explicit resume token to one joined --resume token', () => {
    const mapped = mapAgentOptionsToGeminiCommand('continue this', {
      resume: '01234567-89ab-cdef-0123-456789abcdef',
    });

    expect(mapped.args).toEqual([
      '--output-format',
      'stream-json',
      '--resume=01234567-89ab-cdef-0123-456789abcdef',
      '--prompt=continue this',
    ]);
  });

  it('passes the prompt through one joined headless option token', () => {
    const mapped = mapAgentOptionsToGeminiCommand('explain this code', undefined);

    expect(mapped.args[mapped.args.length - 1]).toBe(
      '--prompt=explain this code',
    );
    expect(mapped.args).not.toContain('--prompt');
  });

  it('spawns 0.50 joined arguments without a turn-limit flag', async () => {
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
        env: {},
        cleanup: async () => {},
      }),
    });

    await collect(
      adapter.run('--leading prompt=value', {
        model: '--leading model=value',
        resume: '--leading resume=value',
        maxTurns: 7,
      }),
    );

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.args).toEqual([
      '--output-format',
      'stream-json',
      '--model=--leading model=value',
      '--resume=--leading resume=value',
      '--prompt=--leading prompt=value',
    ]);
    expect(invocations[0]?.args).not.toContain('--max-session-turns');
  });

  it('passes a temporary User-tier policy and cleans it after success', async () => {
    let policyPath: string | undefined;
    let policyToml: string | undefined;
    const { spawnProcess, invocations } = makeSpawn((process) => {
      const policyArg = invocations[0]?.args.find((arg) =>
        arg.startsWith('--policy='),
      );
      policyPath = policyArg?.slice('--policy='.length);
      policyToml = policyPath ? readFileSync(policyPath, 'utf8') : undefined;
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
    const adapter = new GeminiAdapter({ spawnProcess });

    await collect(
      adapter.run('policy prompt', {
        permissions: {
          fileWrite: 'deny',
          shellExecute: 'allow',
          networkAccess: 'ask',
        },
        allowedTools: ['custom-tool'],
        disallowedTools: ['blocked-tool'],
      }),
    );

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.args).toContain(`--policy=${policyPath}`);
    expect(invocations[0]?.args).not.toContain('--policy');
    expect(invocations[0]?.args).not.toContain('--allowed-tools');
    expect(invocations[0]?.args.at(-1)).toBe('--prompt=policy prompt');
    expect(policyToml).toContain('toolName = "blocked-tool"');
    expect(policyToml).toContain('toolName = "custom-tool"');
    expect(policyToml).toContain('toolName = "*"');
    expect(policyToml?.match(/interactive = false/g)).toHaveLength(8);
    expect(invocations[0]?.options.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(
      process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH,
    );
    expect(invocations[0]?.options.env?.GEMINI_CLI_SYSTEM_DEFAULTS_PATH).toBe(
      process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH,
    );
    expect(policyPath).toBeDefined();
    expect(existsSync(policyPath!)).toBe(false);
  });

  it('cleans a temporary policy when spawn fails', async () => {
    let policyPath: string | undefined;
    const adapter = new GeminiAdapter({
      spawnProcess: (_command, args) => {
        policyPath = args
          .find((arg) => arg.startsWith('--policy='))
          ?.slice('--policy='.length);
        throw new Error('fake spawn failed');
      },
    });

    const events = await collect(
      adapter.run('prompt', { permissions: { fileWrite: 'deny' } }),
    );

    expect(events.map((event) => event.type)).toEqual([
      'init',
      'error',
      'done',
    ]);
    expect(policyPath).toBeDefined();
    expect(existsSync(policyPath!)).toBe(false);
  });

  it.each([
    ['minimal', 'MINIMAL'],
    ['low', 'LOW'],
    ['medium', 'MEDIUM'],
    ['high', 'HIGH'],
    ['xhigh', 'HIGH'],
    ['max', 'HIGH'],
  ] satisfies Array<[GeminiEffort, string]>)(
    'maps Gemini 3 effort %s to thinkingLevel %s',
    (effort, thinkingLevel) => {
      const mapped = mapAgentOptionsToGeminiCommand('prompt', {
        model: 'gemini-3-flash',
        effort,
      });

      expectReasoningAlias(mapped, 'gemini-3-flash', { thinkingLevel });
      expect(mapped.args).not.toContain('gemini-3-flash');
      expect(mapped.args).not.toContain('--thinking-level');
    },
  );

  it.each([
    ['minimal', 1024],
    ['low', 4096],
    ['medium', 8192],
    ['high', 16384],
    ['xhigh', 24576],
    ['max', 24576],
  ] satisfies Array<[GeminiEffort, number]>)(
    'maps Gemini 2.5 Flash effort %s to thinkingBudget %s',
    (effort, thinkingBudget) => {
      const mapped = mapAgentOptionsToGeminiCommand('prompt', {
        model: 'gemini-2.5-flash',
        effort,
      });

      expectReasoningAlias(mapped, 'gemini-2.5-flash', { thinkingBudget });
      expect(mapped.args).not.toContain('gemini-2.5-flash');
      expect(mapped.args).not.toContain('--thinking-budget');
    },
  );

  it('rejects provider-native and unknown effort before spawning', async () => {
    const { spawnProcess, invocations } = makeSpawn(() => {});
    const adapter = new GeminiAdapter({
      spawnProcess,
      probeAvailability: async () => true,
    });

    for (const effort of ['ultracode', 'future-effort']) {
      const invalid = { effort } as unknown as AgentOptions<GeminiEffort>;
      await expect(collect(adapter.run('prompt', invalid))).rejects.toThrow(
        'effort for adapter "gemini" must be one of: minimal, low, medium, high, xhigh, max',
      );
    }
    expect(invocations).toHaveLength(0);
  });

  it('surfaces a model rejection for valid effort without substitution', async () => {
    const { spawnProcess, invocations } = makeSpawn((process) => {
      writeEventsAndClose(
        process,
        [
          JSON.stringify({
            type: 'result',
            status: 'error',
            error: {
              code: 'UNSUPPORTED_THINKING_LEVEL',
              message: 'HIGH thinking is unavailable for this model',
            },
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
      createSettingsOverride: async () => ({
        env: {},
        cleanup: async () => {},
      }),
    });

    const events = await collect(
      adapter.run('prompt', {
        model: 'gemini-3-pro',
        effort: 'max',
      }),
    );

    expect(invocations[0]?.args).toContain(
      `--model=${GEMINI_REASONING_EFFORT_ALIAS}`,
    );
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'error',
      'done',
    ]);
    expect(events[1]?.payload).toMatchObject({
      code: 'UNSUPPORTED_THINKING_LEVEL',
      message: 'HIGH thinking is unavailable for this model',
    });
    expect(events[2]?.payload).toMatchObject({ status: 'error' });
  });

  it('maps Gemini 2.5 Pro max to its model-family upper bound', () => {
    const pro = mapAgentOptionsToGeminiCommand('prompt', {
      model: 'gemini-2.5-pro',
      effort: 'max',
    });

    expectReasoningAlias(pro, 'gemini-2.5-pro', { thinkingBudget: 32768 });
  });

  it.each([
    ['unset model', { effort: 'high' }, undefined],
    ['CLI alias', { model: 'flash', effort: 'high' }, 'flash'],
    [
      'non-matching concrete model',
      { model: 'gemini-4-pro', effort: 'high' },
      'gemini-4-pro',
    ],
  ] satisfies Array<[string, AgentOptions, string | undefined]>)(
    'skips Gemini reasoning alias for %s',
    (_name, options, expectedModel) => {
      const mapped = mapAgentOptionsToGeminiCommand('prompt', options);

      expect(buildGeminiSettings(mapped.settingsConfig)).toBeUndefined();
      expect(modelArg(mapped.args)).toBe(expectedModel);
      expect(mapped.args).not.toContain(GEMINI_REASONING_EFFORT_ALIAS);
      expect(mapped.args).not.toContain('--thinking-budget');
      expect(mapped.args).not.toContain('--thinking-level');
    },
  );

  it('keeps legacy combined settings output available to callers', () => {
    const mapped = mapAgentOptionsToGeminiCommand('prompt', {
      model: 'gemini-3-pro',
      effort: 'low',
      permissions: {
        fileWrite: 'deny',
        shellExecute: 'allow',
        networkAccess: 'ask',
      },
    });

    expect(buildGeminiSettings(mapped.settingsConfig)).toEqual({
      tools: {
        core: ['run_shell_command'],
        exclude: ['replace', 'write_file'],
      },
      modelConfigs: {
        customAliases: {
          [GEMINI_REASONING_EFFORT_ALIAS]: {
            modelConfig: {
              model: 'gemini-3-pro',
              generateContentConfig: {
                thinkingConfig: { thinkingLevel: 'LOW' },
              },
            },
          },
        },
      },
    });
  });

  it('preserves a leading-dash prompt inside the joined option token', () => {
    const mapped = mapAgentOptionsToGeminiCommand('--help', undefined);

    expect(mapped.args[mapped.args.length - 1]).toBe('--prompt=--help');
    expect(mapped.args).not.toContain('--help');
    expect(mapped.args).not.toContain('--');
  });

  it('overlays effort onto configured system defaults without replacing system settings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cligent-gemini-defaults-test-'));
    const configuredDefaults = join(root, 'configured-defaults.json');
    const originalDefaults = {
      security: { disableAlwaysAllow: true },
      modelConfigs: {
        routing: { enabled: true },
        customAliases: {
          existing: { modelConfig: { model: 'gemini-existing' } },
        },
      },
    };
    writeFileSync(configuredDefaults, JSON.stringify(originalDefaults), 'utf8');

    const previousDefaults = process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH;
    const previousSettings = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
    process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = configuredDefaults;
    process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = '/admin/gemini/settings.json';

    let temporaryDefaults: string | undefined;
    let mergedDefaults: Record<string, unknown> | undefined;

    try {
      const { spawnProcess, invocations } = makeSpawn((process) => {
        temporaryDefaults =
          invocations[0]?.options.env?.GEMINI_CLI_SYSTEM_DEFAULTS_PATH;
        mergedDefaults = temporaryDefaults
          ? (JSON.parse(readFileSync(temporaryDefaults, 'utf8')) as Record<
              string,
              unknown
            >)
          : undefined;
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
      const adapter = new GeminiAdapter({ spawnProcess });

      await collect(
        adapter.run('prompt', {
          model: 'gemini-3-pro',
          effort: 'low',
        }),
      );

      expect(invocations).toHaveLength(1);
      expect(temporaryDefaults).not.toBe(configuredDefaults);
      expect(invocations[0]?.options.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(
        '/admin/gemini/settings.json',
      );
      expect(mergedDefaults).toMatchObject({
        security: { disableAlwaysAllow: true },
        modelConfigs: {
          routing: { enabled: true },
          customAliases: {
            existing: { modelConfig: { model: 'gemini-existing' } },
            [GEMINI_REASONING_EFFORT_ALIAS]: {
              modelConfig: {
                model: 'gemini-3-pro',
                generateContentConfig: {
                  thinkingConfig: { thinkingLevel: 'LOW' },
                },
              },
            },
          },
        },
      });
      expect(JSON.parse(readFileSync(configuredDefaults, 'utf8'))).toEqual(
        originalDefaults,
      );
      expect(temporaryDefaults).toBeDefined();
      expect(existsSync(temporaryDefaults!)).toBe(false);
    } finally {
      if (previousDefaults === undefined) {
        delete process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH;
      } else {
        process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = previousDefaults;
      }
      if (previousSettings === undefined) {
        delete process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
      } else {
        process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = previousSettings;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('derives system defaults beside system settings when the defaults env is empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cligent-gemini-system-test-'));
    const configuredSettings = join(root, 'settings.json');
    const siblingDefaults = join(root, 'system-defaults.json');
    writeFileSync(configuredSettings, '{}', 'utf8');
    writeFileSync(
      siblingDefaults,
      '{\n  // Gemini settings accept JSON comments.\n  "siblingMarker": true /* keep */\n}\n',
      'utf8',
    );

    const previousDefaults = process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH;
    const previousSettings = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
    process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = '';
    process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = configuredSettings;

    let mergedDefaults: Record<string, unknown> | undefined;

    try {
      const { spawnProcess, invocations } = makeSpawn((process) => {
        const temporaryDefaults =
          invocations[0]?.options.env?.GEMINI_CLI_SYSTEM_DEFAULTS_PATH;
        mergedDefaults = temporaryDefaults
          ? (JSON.parse(readFileSync(temporaryDefaults, 'utf8')) as Record<
              string,
              unknown
            >)
          : undefined;
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
      const adapter = new GeminiAdapter({ spawnProcess });

      await collect(
        adapter.run('prompt', {
          model: 'gemini-2.5-pro',
          effort: 'minimal',
        }),
      );

      expect(mergedDefaults).toMatchObject({ siblingMarker: true });
      expect(invocations[0]?.options.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(
        configuredSettings,
      );
    } finally {
      if (previousDefaults === undefined) {
        delete process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH;
      } else {
        process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = previousDefaults;
      }
      if (previousSettings === undefined) {
        delete process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
      } else {
        process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = previousSettings;
      }
      rmSync(root, { recursive: true, force: true });
    }
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

  it('cleans policy and defaults files after a stream error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cligent-gemini-cleanup-error-'));
    const configuredDefaults = join(root, 'system-defaults.json');
    writeFileSync(configuredDefaults, '{}', 'utf8');
    const previousDefaults = process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH;
    process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = configuredDefaults;

    let policyPath: string | undefined;
    let defaultsPath: string | undefined;

    try {
      const { spawnProcess, invocations } = makeSpawn((process) => {
        policyPath = invocations[0]?.args
          .find((arg) => arg.startsWith('--policy='))
          ?.slice('--policy='.length);
        defaultsPath =
          invocations[0]?.options.env?.GEMINI_CLI_SYSTEM_DEFAULTS_PATH;
        process.stderr.end();
        process.stdout.destroy(new Error('fake stream failed'));
        process.emit('close', 1, null);
      });
      const adapter = new GeminiAdapter({ spawnProcess });

      const events = await collect(
        adapter.run('prompt', {
          model: 'gemini-3-pro',
          effort: 'high',
          permissions: {},
        }),
      );

      expect(events.map((event) => event.type)).toEqual([
        'init',
        'error',
        'done',
      ]);
      expect(policyPath).toBeDefined();
      expect(defaultsPath).toBeDefined();
      expect(existsSync(policyPath!)).toBe(false);
      expect(existsSync(defaultsPath!)).toBe(false);
    } finally {
      if (previousDefaults === undefined) {
        delete process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH;
      } else {
        process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = previousDefaults;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cleans policy and defaults files after abort', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cligent-gemini-cleanup-abort-'));
    const configuredDefaults = join(root, 'system-defaults.json');
    writeFileSync(configuredDefaults, '{}', 'utf8');
    const previousDefaults = process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH;
    process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = configuredDefaults;

    const controller = new AbortController();
    let policyPath: string | undefined;
    let defaultsPath: string | undefined;

    try {
      const { spawnProcess, invocations } = makeSpawn((process) => {
        policyPath = invocations[0]?.args
          .find((arg) => arg.startsWith('--policy='))
          ?.slice('--policy='.length);
        defaultsPath =
          invocations[0]?.options.env?.GEMINI_CLI_SYSTEM_DEFAULTS_PATH;
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
            sessionId: 'cleanup-abort',
            model: 'gemini-3-pro',
            cwd: '/repo',
          })}\n`,
        );
      });
      const adapter = new GeminiAdapter({ spawnProcess });
      const events: AgentEvent[] = [];

      for await (const event of adapter.run('prompt', {
        model: 'gemini-3-pro',
        effort: 'high',
        permissions: {},
        abortSignal: controller.signal,
      })) {
        events.push(event);
        if (event.type === 'init') controller.abort();
      }

      expect(events.map((event) => event.type)).toEqual(['init', 'done']);
      expect(policyPath).toBeDefined();
      expect(defaultsPath).toBeDefined();
      expect(existsSync(policyPath!)).toBe(false);
      expect(existsSync(defaultsPath!)).toBe(false);
    } finally {
      if (previousDefaults === undefined) {
        delete process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH;
      } else {
        process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH = previousDefaults;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('attempts both cleanups and surfaces cleanup failures', async () => {
    const cleanupCalls: string[] = [];
    const { spawnProcess } = makeSpawn((process) => {
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
      createSettingsOverride: async () => ({
        env: {},
        cleanup: async () => {
          cleanupCalls.push('defaults');
          throw new Error('defaults cleanup failed');
        },
      }),
      createPolicyOverride: async () => ({
        args: [],
        cleanup: async () => {
          cleanupCalls.push('policy');
          throw new Error('policy cleanup failed');
        },
      }),
    });

    await expect(collect(adapter.run('prompt'))).rejects.toThrow(
      'Failed to clean up Gemini temporary runtime files',
    );
    expect(cleanupCalls).toEqual(['policy', 'defaults']);
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

  it('sets interrupted resumeToken from backend id, inbound resume, or omission', async () => {
    async function interruptedResumeToken(options: {
      backendSessionId?: string;
      resume?: string;
    }): Promise<string | undefined> {
      const controller = new AbortController();
      const { spawnProcess } = makeSpawn((process) => {
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
            model: 'gem',
            cwd: '/repo',
            ...(options.backendSessionId
              ? { sessionId: options.backendSessionId }
              : {}),
          })}\n`,
        );
      });
      const adapter = new GeminiAdapter({
        spawnProcess,
        probeAvailability: async () => true,
      });

      const events: AgentEvent[] = [];
      for await (const event of adapter.run('prompt', {
        abortSignal: controller.signal,
        ...(options.resume ? { resume: options.resume } : {}),
      })) {
        events.push(event);
        if (event.type === 'init') {
          controller.abort();
        }
      }

      const done = events.find((event) => event.type === 'done') as AgentEvent & {
        payload: { status: string; resumeToken?: string };
      };
      expect(done.payload.status).toBe('interrupted');
      return done.payload.resumeToken;
    }

    await expect(
      interruptedResumeToken({ backendSessionId: 'gemini-abort-new' }),
    ).resolves.toBe('gemini-abort-new');
    await expect(
      interruptedResumeToken({ resume: 'gemini-abort-resume' }),
    ).resolves.toBe('gemini-abort-resume');
    await expect(interruptedResumeToken({})).resolves.toBeUndefined();
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

  it('maps both PermissionPolicy.mode = "auto" and "bypass" to --approval-mode yolo per ENG-021', () => {
    const auto = mapPermissionsToGeminiToolConfig({ mode: 'auto' });
    expect(auto.approvalMode).toBe('yolo');
    expect(auto.policyRules).toEqual([]);

    // gemini exposes no distinct bypass tier beyond yolo, so both modes
    // map to the same SDK setting — recorded in adapter docs and DR-005.
    const bypass = mapPermissionsToGeminiToolConfig({ mode: 'bypass' });
    expect(bypass.approvalMode).toBe('yolo');
    expect(bypass.policyRules).toEqual([]);

    for (const mode of ['auto', 'bypass'] as const) {
      const cmd = mapAgentOptionsToGeminiCommand('hi', {
        permissions: { mode },
      });
      expect(cmd.args).toContain('--approval-mode');
      const idx = cmd.args.indexOf('--approval-mode');
      expect(cmd.args[idx + 1]).toBe('yolo');
    }
  });

  it('mode overrides per-capability levels in gemini per ENG-021', () => {
    // mode set together with explicit per-capability denies: the per-
    // capability path is short-circuited so the deny levels do not push
    // tools into disallowedTools / settings. Only the session-wide
    // --approval-mode yolo applies.
    const config = mapPermissionsToGeminiToolConfig({
      mode: 'auto',
      fileWrite: 'deny',
      shellExecute: 'deny',
      networkAccess: 'deny',
    });
    expect(config.approvalMode).toBe('yolo');
    expect(config.disallowedTools).toEqual([]);
    expect(config.allowedTools).toEqual([]);

    // User-passed allowedTools / disallowedTools (independent from
    // `permissions`) still apply.
    const withUserTools = mapPermissionsToGeminiToolConfig(
      { mode: 'auto', fileWrite: 'deny' },
      { allowedTools: ['mytool'], disallowedTools: ['othertool'] },
    );
    expect(withUserTools.allowedTools).toContain('mytool');
    expect(withUserTools.disallowedTools).toContain('othertool');
    // The fileWrite: 'deny' from the policy did NOT add write tools to
    // disallowedTools — mode took precedence.
    expect(withUserTools.disallowedTools).not.toContain('replace');
    expect(withUserTools.disallowedTools).not.toContain('write_file');
    expect(withUserTools.policyRules).toEqual([
      {
        toolName: 'othertool',
        decision: 'deny',
        priority: 999,
        interactive: false,
      },
      {
        toolName: 'mytool',
        decision: 'allow',
        priority: 999,
        interactive: false,
      },
      {
        toolName: '*',
        decision: 'deny',
        priority: 998,
        interactive: false,
      },
    ]);
  });

  it('accepts writablePaths and reports ambient enforcement', () => {
    const mapped = mapPermissionsToGeminiToolConfig({
      mode: 'auto',
      writablePaths: ['./.git/', 'generated/./cache//'],
    });

    expect(mapped.approvalMode).toBe('yolo');
    expect(mapped.writablePaths).toEqual({
      paths: ['.git', 'generated/cache'],
      enforcement: 'ambient',
    });

    expect(() =>
      mapPermissionsToGeminiToolConfig({ writablePaths: ['../cache'] }),
    ).toThrow("permissions.writablePaths[0] must not contain '..'");
  });
});
