// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  DonePayload,
  GeminiEffort,
  InitPayload,
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

// Mirrors the Gemini CLI 0.61.0 stream-json result stats emitted by
// StreamJsonFormatter.convertToStreamStats().
interface GeminiStreamStats {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cached: number;
  input: number;
  duration_ms: number;
  tool_calls: number;
  models: Record<
    string,
    {
      total_tokens: number;
      input_tokens: number;
      output_tokens: number;
      cached: number;
      input: number;
    }
  >;
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

function apiResponseLog(values: {
  timestamp: string;
  model: string;
  input: number;
  output: number;
  cached: number;
  thoughts: number;
  tool?: number;
  total: number;
  promptId?: string;
  role?: string;
  authType?: string;
}): string {
  return JSON.stringify(
    {
      timestamp: values.timestamp,
      attributes: {
        'event.name': 'gemini_cli.api_response',
        model: values.model,
        input_token_count: values.input,
        output_token_count: values.output,
        cached_content_token_count: values.cached,
        thoughts_token_count: values.thoughts,
        tool_token_count: values.tool ?? 0,
        total_token_count: values.total,
        prompt_id: values.promptId ?? 'prompt-1',
        role: values.role ?? 'model',
        auth_type: values.authType ?? 'gemini-api-key',
        duration_ms: 12,
        status_code: 200,
      },
    },
    null,
    2,
  );
}

function telemetryCapture(source: string, onRead?: () => void) {
  return async () => ({
    env: {
      GEMINI_TELEMETRY_ENABLED: 'true',
      GEMINI_TELEMETRY_TARGET: 'local',
      GEMINI_TELEMETRY_OUTFILE: '/tmp/gemini-test-telemetry.json',
      GEMINI_TELEMETRY_LOG_PROMPTS: 'false',
      GEMINI_TELEMETRY_TRACES_ENABLED: 'false',
      GEMINI_TELEMETRY_USE_COLLECTOR: 'false',
    },
    read: async () => {
      onRead?.();
      return source;
    },
    cleanup: async () => {},
  });
}

function successResult(): string {
  return JSON.stringify({
    type: 'result',
    status: 'success',
    stats: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
  });
}

// gemini-34: each test gives the adapter its own real Gemini home, temporary
// directory, and system settings paths, so the default settings overlay
// never reaches the host's home or configuration. The runtime gate stays off:
// these runs spawn a fake child, so the host's own `gemini` version must not
// decide them; runtime-version.test.ts verifies the gate.
let fixtureRoot: string;
let realHome: string;
let overlayTmp: string;

function overlaysLeft(): string[] {
  return readdirSync(overlayTmp).filter((name) =>
    name.startsWith('cligent-gemini-home-'),
  );
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'cligent-gemini-fixture-'));
  realHome = join(fixtureRoot, 'home');
  overlayTmp = join(fixtureRoot, 'tmp');
  mkdirSync(realHome);
  mkdirSync(overlayTmp);
  vi.stubEnv('CLIGENT_RUNTIME_GATE', 'off');
  vi.stubEnv('GEMINI_CLI_HOME', realHome);
  vi.stubEnv('TMPDIR', overlayTmp);
  vi.stubEnv('TMP', overlayTmp);
  vi.stubEnv('TEMP', overlayTmp);
  vi.stubEnv('GEMINI_SANDBOX', undefined);
  vi.stubEnv('SANDBOX', undefined);
  vi.stubEnv(
    'GEMINI_CLI_SYSTEM_SETTINGS_PATH',
    join(fixtureRoot, 'system', 'settings.json'),
  );
  vi.stubEnv(
    'GEMINI_CLI_SYSTEM_DEFAULTS_PATH',
    join(fixtureRoot, 'system', 'system-defaults.json'),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('GeminiAdapter', () => {
  it('rejects typed attachments before starting Gemini with native @file guidance', async () => {
    const { spawnProcess, invocations } = makeSpawn(() => {});
    await expect(
      collect(
        new GeminiAdapter({ spawnProcess }).run('Describe', {
          attachments: [{ path: './clip.mp4' }],
        }),
      ),
    ).rejects.toThrow(/@/);
    expect(invocations).toHaveLength(0);
  });

  it.each([undefined, []])(
    'preserves native media @references with attachments %j',
    async (attachments) => {
      const prompt =
        'Describe @./photo.png @./clip.mp4 @./audio.wav @./report.pdf';
      const { spawnProcess, invocations } = makeSpawn((process) => {
        writeEventsAndClose(process, [
          JSON.stringify({ type: 'result', status: 'success' }),
        ]);
      });
      const events = await collect(
        new GeminiAdapter({ spawnProcess }).run(prompt, { attachments }),
      );
      expect(invocations[0]?.args.at(-1)).toBe(`--prompt=${prompt}`);
      expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
    },
  );

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
      payload: {
        toolName: string;
        toolUseId: string;
        input: Record<string, unknown>;
      };
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
          toolUses: number;
        };
        durationMs: number;
      };
    };
    expect(done.payload.status).toBe('max_turns');
    expect(done.payload.result).toBe('summary');
    expect(done.payload.usage).toEqual({
      toolUses: 1,
    });
    expect(done.payload.durationMs).toBe(222);
  });

  it('reports an explicit empty allowlist as configured and known', async () => {
    const { spawnProcess } = makeSpawn((process) => {
      writeEventsAndClose(
        process,
        [
          JSON.stringify({
            type: 'init',
            sessionId: 'gemini-tool-free',
            model: 'gemini-2.5-pro',
            cwd: '/repo',
            tools: ['replace', 'run_shell_command'],
          }),
          JSON.stringify({
            type: 'result',
            sessionId: 'gemini-tool-free',
            status: 'success',
            stats: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
          }),
        ],
        0,
        null,
      );
    });
    const adapter = new GeminiAdapter({ spawnProcess });

    const events = await collect(
      adapter.run('route only', { allowedTools: [] }),
    );
    const init = events[0] as AgentEvent & {
      payload: {
        tools: string[];
        capabilities: Record<string, unknown>;
      };
    };

    expect(init.payload.tools).toEqual([]);
    expect(init.payload.capabilities).toMatchObject({
      toolsKnown: true,
      toolsSource: 'configured',
    });
    const done = events.find((event) => event.type === 'done')!;
    expect((done.payload as DonePayload).usage).toEqual({ toolUses: 0 });
  });

  it('marks missing token accounting unavailable and keeps observed tool uses', async () => {
    const { spawnProcess } = makeSpawn((process) => {
      writeEventsAndClose(
        process,
        [
          JSON.stringify({
            type: 'init',
            sessionId: 'gemini-no-usage',
            model: 'gemini-pro',
            cwd: '/repo',
            tools: ['run_shell_command'],
          }),
          JSON.stringify({
            type: 'tool_use',
            sessionId: 'gemini-no-usage',
            toolUseId: 'gemini-tool-no-usage',
            toolName: 'run_shell_command',
            input: { command: 'true' },
          }),
        ],
        0,
        null,
      );
    });
    const adapter = new GeminiAdapter({ spawnProcess });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((event) => event.type === 'done')!;
    expect((done.payload as DonePayload).usage).toEqual({
      toolUses: 1,
    });
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
      payload: {
        toolName: string;
        toolUseId: string;
        input: Record<string, unknown>;
      };
    };
    expect(toolUse).toBeDefined();
    expect(toolUse.payload.toolName).toBe('Read');
    expect(toolUse.payload.toolUseId).toBe('read-42');
    expect(toolUse.payload.input).toEqual({ file_path: '/repo/file.txt' });

    const toolResult = events.find(
      (e) => e.type === 'tool_result',
    ) as AgentEvent & {
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
      payload: {
        toolName: string;
        toolUseId: string;
        input: Record<string, unknown>;
      };
    };
    expect(toolUse).toBeDefined();
    expect(toolUse.payload.toolName).toBe('Read');
    expect(toolUse.payload.toolUseId).toBe('call-99');
    expect(toolUse.payload.input).toEqual({ path: '/a' });

    const toolResult = events.find(
      (e) => e.type === 'tool_result',
    ) as AgentEvent & {
      payload: {
        toolName: string;
        toolUseId: string;
        status: string;
        output: unknown;
      };
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
              functionCall: {
                name: 'Bash',
                id: 'bash-1',
                args: { command: 'ls' },
              },
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
      payload: {
        toolName: string;
        toolUseId: string;
        input: Record<string, unknown>;
      };
    };
    expect(toolUse).toBeDefined();
    expect(toolUse.payload.toolName).toBe('Bash');
    expect(toolUse.payload.toolUseId).toBe('bash-1');
    expect(toolUse.payload.input).toEqual({ command: 'ls' });

    const toolResult = events.find(
      (e) => e.type === 'tool_result',
    ) as AgentEvent & {
      payload: {
        toolName: string;
        toolUseId: string;
        status: string;
        output: unknown;
      };
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
          JSON.stringify({
            type: 'init',
            sessionId: 's-parse',
            model: 'gem',
            cwd: '/tmp',
          }),
          '{bad json',
          JSON.stringify({
            type: 'message',
            sessionId: 's-parse',
            content: 'after parse error',
          }),
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

    expect(events.map((event) => event.type)).toEqual([
      'init',
      'error',
      'text',
      'done',
    ]);

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
          JSON.stringify({
            type: 'init',
            sessionId: 's-err',
            model: 'gem',
            cwd: '/tmp',
          }),
          JSON.stringify({
            type: 'result',
            sessionId: 's-err',
            status: 'error',
            error: {
              message: 'API key not valid. Please pass a valid API key.',
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
          JSON.stringify({
            type: 'init',
            sessionId: 's-bare',
            model: 'gem',
            cwd: '/tmp',
          }),
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
  ])(
    'maps exit code $code to done status $expected',
    async ({ code, expected, hasError }) => {
      const { spawnProcess } = makeSpawn((process) => {
        writeEventsAndClose(
          process,
          [
            JSON.stringify({
              type: 'init',
              sessionId: `exit-${code}`,
              model: 'gem',
              cwd: '/repo',
            }),
            JSON.stringify({
              type: 'message',
              sessionId: `exit-${code}`,
              content: 'no result event',
            }),
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

      const done = events[events.length - 1] as AgentEvent & {
        payload: { status: string; result?: string };
      };
      expect(done.payload.status).toBe(expected);

      if (hasError) {
        const errorEvt = events[events.length - 2] as AgentEvent & {
          payload: { code?: string; message: string };
        };
        expect(errorEvt.payload.code).toBe('GEMINI_EXIT_ERROR');
        expect(errorEvt.payload.message).toContain(`code ${code}`);
        expect(done.payload.result).toContain(`code ${code}`);
      }
    },
  );

  it('normalizes asynchronous child process errors', async () => {
    const { spawnProcess } = makeSpawn((process) => {
      const error = Object.assign(new Error('spawn gemini ENOENT'), {
        code: 'ENOENT',
      });
      process.emit('error', error);
      setImmediate(() => {
        process.stdout.end();
        process.stderr.end();
      });
    });
    const adapter = new GeminiAdapter({
      spawnProcess,
      probeAvailability: async () => true,
    });

    const events = await collect(adapter.run('prompt'));

    expect(events.map((event) => event.type)).toEqual([
      'init',
      'error',
      'done',
    ]);
    expect(events[1]?.payload).toMatchObject({
      code: 'GEMINI_STREAM_ERROR',
      message: 'spawn gemini ENOENT',
      recoverable: false,
    });
    expect(events[2]?.payload).toMatchObject({ status: 'error' });
  });

  it.each([
    {
      name: 'iterator failure after a backend identifier',
      failure: 'iterator',
      backendSessionId: 'gemini-stream-backend',
      resume: undefined,
      expectedResume: 'gemini-stream-backend',
    },
    {
      name: 'child failure on a resumed run without a backend identifier',
      failure: 'child',
      backendSessionId: undefined,
      resume: 'gemini-inbound-resume',
      expectedResume: undefined,
    },
  ] as const)(
    'selects normal terminal continuity for $name',
    async ({ failure, backendSessionId, resume, expectedResume }) => {
      const { spawnProcess } = makeSpawn((process) => {
        process.stdout.write(
          `${JSON.stringify({
            type: 'init',
            model: 'gem',
            cwd: '/repo',
            ...(backendSessionId ? { sessionId: backendSessionId } : {}),
          })}\n`,
        );

        setImmediate(() => {
          process.stderr.end();
          if (failure === 'iterator') {
            process.stdout.destroy(new Error('fake stream failed'));
            process.emit('close', 1, null);
          } else {
            process.stdout.end();
            process.emit('error', new Error('fake child failed'));
          }
        });
      });
      const adapter = new GeminiAdapter({ spawnProcess });

      const events = await collect(
        adapter.run('prompt', { ...(resume ? { resume } : {}) }),
      );

      expect(events.map((event) => event.type)).toEqual([
        'init',
        'error',
        'done',
      ]);
      const done = events[2] as AgentEvent & {
        payload: { status: string; resumeToken?: string };
      };
      expect(done.payload.status).toBe('error');
      if (expectedResume) {
        expect(done.payload.resumeToken).toBe(expectedResume);
      } else {
        expect(done.payload).not.toHaveProperty('resumeToken');
      }
    },
  );

  it('awaits a stdout-less child close before temporary cleanup', async () => {
    const order: string[] = [];
    const controller = new AbortController();
    const process = new MockGeminiProcess();
    Object.defineProperty(process, 'stdout', { value: undefined });
    process.kill = (signal?: NodeJS.Signals | number): boolean => {
      process.killed = true;
      process.killSignals.push(signal);
      order.push(`kill:${String(signal)}`);
      queueMicrotask(() => {
        order.push('close');
        process.stderr.end();
        process.emit('close', null, 'SIGTERM');
      });
      return true;
    };
    const adapter = new GeminiAdapter({
      spawnProcess: () =>
        process as unknown as ChildProcessWithoutNullStreams,
      createSettingsOverride: async () => ({
        env: {},
        cleanup: async () => {
          order.push('settings-cleanup');
        },
      }),
      createPolicyOverride: async () => ({
        args: [],
        cleanup: async () => {
          order.push('policy-cleanup');
        },
      }),
      createTelemetryCapture: async () => ({
        env: {},
        read: async () => '',
        cleanup: async () => {
          order.push('telemetry-cleanup');
        },
      }),
    });

    const events = await collect(
      adapter.run('prompt', { abortSignal: controller.signal }),
    );

    expect(events.map((event) => event.type)).toEqual([
      'init',
      'error',
      'done',
    ]);
    expect(process.killSignals).toEqual(['SIGTERM']);
    expect(order.slice(0, 2)).toEqual(['kill:SIGTERM', 'close']);
    for (const cleanup of [
      'telemetry-cleanup',
      'policy-cleanup',
      'settings-cleanup',
    ]) {
      expect(order.indexOf(cleanup)).toBeGreaterThan(order.indexOf('close'));
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

  it('treats an empty resume value as a fresh run', async () => {
    const { spawnProcess, invocations } = makeSpawn((process) => {
      writeEventsAndClose(
        process,
        [
          JSON.stringify({
            type: 'init',
            model: 'gem',
            cwd: '/repo',
          }),
          JSON.stringify({
            type: 'result',
            status: 'success',
            result: 'done',
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

    const events = await collect(adapter.run('start fresh', { resume: '' }));

    expect(invocations[0]?.args.some((arg) => arg.startsWith('--resume='))).toBe(
      false,
    );
    expect(events.every((event) => event.sessionId.length > 0)).toBe(true);
    expect(new Set(events.map((event) => event.sessionId)).size).toBe(1);
    expect((events.at(-1)?.payload as DonePayload).resumeToken).toBeUndefined();
  });

  it('passes the prompt through one joined headless option token', () => {
    const mapped = mapAgentOptionsToGeminiCommand(
      'explain this code',
      undefined,
    );

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

  it('reports only a model the native init names (gemini-201, engine-28)', async () => {
    const cases: Array<
      [
        Record<string, unknown> | undefined,
        AgentOptions<GeminiEffort>,
        string | undefined,
      ]
    > = [
      [{ model: 'auto-gemini-3' }, {}, 'auto-gemini-3'],
      [{ model: 'gemini-3-pro' }, { model: 'gemini-3-pro' }, 'gemini-3-pro'],
      // The runtime names this run's effort alias rather than a model.
      [
        { model: GEMINI_REASONING_EFFORT_ALIAS },
        { model: 'gemini-3-pro', effort: 'high' },
        undefined,
      ],
      [{}, { model: 'gemini-2.5-pro' }, undefined],
      // The stream closes before any native event.
      [undefined, { model: 'gemini-2.5-pro' }, undefined],
    ];
    for (const [init, options, expected] of cases) {
      const { spawnProcess } = makeSpawn((process) => {
        writeEventsAndClose(
          process,
          init === undefined
            ? []
            : [
                JSON.stringify({
                  type: 'init',
                  sessionId: 'gemini-session',
                  ...init,
                }),
                JSON.stringify({
                  type: 'result',
                  sessionId: 'gemini-session',
                  status: 'success',
                  stats: { input_tokens: 0, output_tokens: 0, tool_uses: 0 },
                }),
              ],
          init === undefined ? 1 : 0,
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

      const events = await collect(adapter.run('prompt', options));
      const payload = events[0]!.payload as InitPayload;
      expect(events[0]!.type).toBe('init');
      expect(payload.model).toBe(
        options.model ?? (init?.model as string | undefined) ?? 'unknown',
      );
      if (expected === undefined) {
        expect(payload).not.toHaveProperty('reportedModel');
      } else {
        expect(payload.reportedModel).toBe(expected);
      }
    }
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

  it('delivers effort through a private home over the real user settings', async () => {
    const realGemini = join(realHome, '.gemini');
    mkdirSync(realGemini);
    const userSettings = [
      '{',
      '  // Gemini settings accept JSON comments.',
      '  "futureKey": { "kept": true },',
      '  "security": { "auth": { "selectedType": "oauth-personal" } }, /* kept */',
      '  "modelConfigs": {',
      '    "routing": { "enabled": true },',
      '    "customAliases": {',
      '      "existing": { "modelConfig": { "model": "gemini-existing" } }',
      '    }',
      '  }',
      '}',
      '',
    ].join('\n');
    writeFileSync(join(realGemini, 'settings.json'), userSettings);
    writeFileSync(join(realGemini, 'oauth_creds.json'), '{"token":"old"}', {
      mode: 0o600,
    });
    writeFileSync(join(realHome, '.env'), 'KEY=value\n');
    mkdirSync(join(realHome, '.agents'));

    const linked = ['.env', '.agents', '.gemini/oauth_creds.json'] as const;
    const shared = ['.gemini/tmp', '.gemini/history'] as const;
    let home: string | undefined;
    let settingsMode: number | undefined;
    let settingsIsLink: boolean | undefined;
    let settings: unknown;
    let targets: Record<string, string> = {};
    let allLinks = false;
    const { spawnProcess, invocations } = makeSpawn((child) => {
      home = invocations[0]!.options.env!.GEMINI_CLI_HOME!;
      const settingsPath = join(home, '.gemini', 'settings.json');
      settingsMode = statSync(settingsPath).mode & 0o777;
      settingsIsLink = lstatSync(settingsPath).isSymbolicLink();
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      targets = Object.fromEntries(
        [...linked, ...shared].map((name) => [
          name,
          realpathSync(join(home!, name)),
        ]),
      );
      allLinks = [...linked, ...shared].every((name) =>
        lstatSync(join(home!, name)).isSymbolicLink(),
      );
      // Gemini refreshes OAuth credentials by writing the file in place.
      writeFileSync(
        join(home, '.gemini', 'oauth_creds.json'),
        '{"token":"refreshed"}',
        { mode: 0o600 },
      );
      writeEventsAndClose(child, [successResult()], 0, null);
    });

    await collect(
      new GeminiAdapter({ spawnProcess }).run('prompt', {
        model: 'gemini-3-pro',
        effort: 'low',
      }),
    );

    expect(modelArg(invocations[0]!.args)).toBe(GEMINI_REASONING_EFFORT_ALIAS);
    expect(home).toBeDefined();
    expect(realpathSync(dirname(home!))).toBe(realpathSync(overlayTmp));
    expect(settingsMode).toBe(0o600);
    expect(settingsIsLink).toBe(false);
    expect(settings).toEqual({
      futureKey: { kept: true },
      security: { auth: { selectedType: 'oauth-personal' } },
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
    expect(allLinks).toBe(true);
    for (const name of [...linked, ...shared]) {
      expect(targets[name]).toBe(realpathSync(join(realHome, name)));
    }
    expect(statSync(join(realGemini, 'tmp')).isDirectory()).toBe(true);
    expect(statSync(join(realGemini, 'history')).isDirectory()).toBe(true);
    expect(readFileSync(join(realGemini, 'oauth_creds.json'), 'utf8')).toBe(
      '{"token":"refreshed"}',
    );
    expect(statSync(join(realGemini, 'oauth_creds.json')).mode & 0o777).toBe(
      0o600,
    );
    expect(readFileSync(join(realGemini, 'settings.json'), 'utf8')).toBe(
      userSettings,
    );
    expect(readdirSync(realGemini).sort()).toEqual([
      'history',
      'oauth_creds.json',
      'settings.json',
      'tmp',
    ]);
    expect(invocations[0]?.options.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH).toBe(
      process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH,
    );
    expect(invocations[0]?.options.env?.GEMINI_CLI_SYSTEM_DEFAULTS_PATH).toBe(
      process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH,
    );
    expect(existsSync(home!)).toBe(false);
    expect(overlaysLeft()).toEqual([]);
  });

  it('reconciles what the run changed in its home before removing it', async () => {
    const realGemini = join(realHome, '.gemini');
    mkdirSync(join(realGemini, 'acknowledgments'), { recursive: true });
    writeFileSync(join(realGemini, 'acknowledgments', 'agents.json'), 'real');
    writeFileSync(join(realGemini, 'settings.json'), '{}');
    writeFileSync(
      join(realGemini, 'projects.json'),
      JSON.stringify({ projects: { '/work/known': 'known' } }),
    );
    writeFileSync(join(realGemini, 'trustedFolders.json'), 'trust-before');
    writeFileSync(join(realGemini, 'google_accounts.json'), 'accounts');
    writeFileSync(join(realGemini, 'oauth_creds.json'), 'creds');
    writeFileSync(join(realHome, '.env'), 'KEY=old\n');
    writeFileSync(join(realHome, 'unrelated.txt'), 'untouched\n');

    const { spawnProcess, invocations } = makeSpawn((child) => {
      const home = invocations[0]!.options.env!.GEMINI_CLI_HOME!;
      const gemini = join(home, '.gemini');
      // Gemini saves these files through a temporary file and a rename.
      const replace = (path: string, content: string) => {
        writeFileSync(`${path}.staged`, content);
        renameSync(`${path}.staged`, path);
      };
      replace(
        join(gemini, 'projects.json'),
        JSON.stringify({
          projects: {
            '/work/known': 'known',
            '/work/new': 'new',
            '/work/shared': 'shared-run',
          },
        }),
      );
      // Meanwhile another run registers projects in the real registry.
      writeFileSync(
        join(realGemini, 'projects.json'),
        JSON.stringify({
          projects: {
            '/work/known': 'known',
            '/work/other': 'other',
            '/work/shared': 'shared-real',
          },
        }),
      );
      replace(join(gemini, 'trustedFolders.json'), 'trust-after');
      replace(join(home, '.env'), 'KEY=new\n');
      writeFileSync(join(gemini, 'installation_id'), 'install-1');
      mkdirSync(join(gemini, 'policies'));
      writeFileSync(join(gemini, 'policies', 'auto-saved.toml'), 'rule');
      unlinkSync(join(gemini, 'acknowledgments'));
      mkdirSync(join(gemini, 'acknowledgments'));
      writeFileSync(join(gemini, 'acknowledgments', 'agents.json'), 'run');
      writeFileSync(join(gemini, 'acknowledgments', 'extra.json'), 'extra');
      writeFileSync(join(home, 'notes.txt'), 'from the run\n');
      writeFileSync(join(home, 'draft.tmp'), 'draft');
      writeFileSync(join(gemini, 'projects.json.123.tmp'), 'partial');
      writeFileSync(join(gemini, 'GEMINI.md.rollback'), 'staged');
      mkdirSync(join(gemini, 'state.json.lock'));
      writeFileSync(join(gemini, 'settings.json'), '{"model":{"name":"x"}}');
      unlinkSync(join(gemini, 'google_accounts.json'));
      // A link recreated to the same real entry is still that link.
      const creds = join(gemini, 'oauth_creds.json');
      const credsTarget = readlinkSync(creds);
      unlinkSync(creds);
      symlinkSync(credsTarget, creds);
      writeEventsAndClose(child, [successResult()], 0, null);
    });

    const events = await collect(
      new GeminiAdapter({ spawnProcess }).run('prompt', {
        model: 'gemini-3-pro',
        effort: 'low',
      }),
    );

    expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
    expect(
      JSON.parse(readFileSync(join(realGemini, 'projects.json'), 'utf8')),
    ).toEqual({
      projects: {
        '/work/known': 'known',
        '/work/other': 'other',
        '/work/shared': 'shared-real',
        '/work/new': 'new',
      },
    });
    const real = (path: string) => readFileSync(join(realHome, path), 'utf8');
    expect(real('.gemini/trustedFolders.json')).toBe('trust-after');
    expect(real('.env')).toBe('KEY=new\n');
    expect(real('.gemini/installation_id')).toBe('install-1');
    expect(real('.gemini/policies/auto-saved.toml')).toBe('rule');
    expect(real('.gemini/acknowledgments/agents.json')).toBe('real');
    expect(real('.gemini/acknowledgments/extra.json')).toBe('extra');
    expect(real('notes.txt')).toBe('from the run\n');
    expect(real('draft.tmp')).toBe('draft');
    expect(real('.gemini/settings.json')).toBe('{}');
    expect(real('.gemini/google_accounts.json')).toBe('accounts');
    expect(lstatSync(join(realGemini, 'oauth_creds.json')).isFile()).toBe(true);
    expect(real('.gemini/oauth_creds.json')).toBe('creds');
    expect(real('unrelated.txt')).toBe('untouched\n');
    for (const leftover of [
      'projects.json.123.tmp',
      'GEMINI.md.rollback',
      'state.json.lock',
      'projects.json.lock',
    ]) {
      expect(existsSync(join(realGemini, leftover))).toBe(false);
    }
    expect(overlaysLeft()).toEqual([]);
  });

  it.each(['the real home', 'a link to the real home'] as const)(
    'sends the concrete model without an overlay when the workspace is %s',
    async (form) => {
      const cwd =
        form === 'the real home' ? realHome : join(fixtureRoot, 'home-link');
      if (cwd !== realHome) symlinkSync(realHome, cwd, 'dir');
      const { spawnProcess, invocations } = makeSpawn((child) => {
        writeEventsAndClose(child, [successResult()], 0, null);
      });

      const events = await collect(
        new GeminiAdapter({ spawnProcess }).run('prompt', {
          model: 'gemini-3-pro',
          effort: 'high',
          cwd,
        }),
      );

      expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
      expect(modelArg(invocations[0]!.args)).toBe('gemini-3-pro');
      expect(invocations[0]!.args).not.toContain(
        `--model=${GEMINI_REASONING_EFFORT_ALIAS}`,
      );
      expect(invocations[0]!.options.env!.GEMINI_CLI_HOME).toBe(realHome);
      expect(existsSync(join(realHome, '.gemini'))).toBe(false);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.each([
    ['GEMINI_SANDBOX=true', { GEMINI_SANDBOX: 'true' }, {}, false],
    [
      'GEMINI_SANDBOX naming a command',
      { GEMINI_SANDBOX: 'docker' },
      {},
      false,
    ],
    ['user settings', {}, { user: { sandbox: true } }, false],
    [
      'an enabled user settings object',
      {},
      { user: { sandbox: { enabled: true, command: 'sandbox-exec' } } },
      false,
    ],
    ['system settings', {}, { system: { sandbox: 'docker' } }, false],
    ['system defaults', {}, { defaults: { sandbox: true } }, false],
    [
      'workspace settings over user settings',
      {},
      { user: { sandbox: true }, workspace: { sandbox: false } },
      true,
    ],
    [
      'user settings over system defaults',
      {},
      { defaults: { sandbox: true }, user: { sandbox: false } },
      true,
    ],
    [
      'GEMINI_SANDBOX=false over settings',
      { GEMINI_SANDBOX: 'false' },
      { user: { sandbox: true } },
      true,
    ],
    [
      'a child already inside a sandbox',
      { SANDBOX: 'sandbox-exec', GEMINI_SANDBOX: 'true' },
      {},
      true,
    ],
    [
      'a disabled settings object',
      {},
      { user: { sandbox: { enabled: false } } },
      true,
    ],
  ] satisfies Array<
    [
      string,
      Record<string, string>,
      Partial<
        Record<
          'system' | 'workspace' | 'user' | 'defaults',
          { sandbox: unknown }
        >
      >,
      boolean,
    ]
  >)(
    'honors a Gemini sandbox request from %s',
    async (_source, env, layers, overlay) => {
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      const cwd = join(fixtureRoot, 'work');
      const paths = {
        system: process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!,
        workspace: join(cwd, '.gemini', 'settings.json'),
        user: join(realHome, '.gemini', 'settings.json'),
        defaults: process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH!,
      };
      mkdirSync(join(cwd, '.gemini'), { recursive: true });
      for (const [layer, tools] of Object.entries(layers)) {
        const path = paths[layer as keyof typeof paths];
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ tools }));
      }
      const { spawnProcess, invocations } = makeSpawn((child) => {
        writeEventsAndClose(child, [successResult()], 0, null);
      });

      await collect(
        new GeminiAdapter({ spawnProcess }).run('prompt', {
          model: 'gemini-3-pro',
          effort: 'medium',
          cwd,
        }),
      );

      const childHome = invocations[0]!.options.env!.GEMINI_CLI_HOME;
      if (overlay) {
        expect(modelArg(invocations[0]!.args)).toBe(
          GEMINI_REASONING_EFFORT_ALIAS,
        );
        expect(childHome).not.toBe(realHome);
      } else {
        expect(modelArg(invocations[0]!.args)).toBe('gemini-3-pro');
        expect(childHome).toBe(realHome);
      }
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'overlays the operating-system home when GEMINI_CLI_HOME is unset',
    async () => {
      vi.stubEnv('GEMINI_CLI_HOME', undefined);
      vi.stubEnv('HOME', realHome);
      writeFileSync(join(realHome, '.profile'), 'profile\n');
      let settings: unknown;
      let profile: string | undefined;
      const { spawnProcess, invocations } = makeSpawn((child) => {
        const home = invocations[0]!.options.env!.GEMINI_CLI_HOME!;
        settings = JSON.parse(
          readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'),
        );
        profile = readFileSync(join(home, '.profile'), 'utf8');
        writeEventsAndClose(child, [successResult()], 0, null);
      });

      await collect(
        new GeminiAdapter({ spawnProcess }).run('prompt', {
          model: 'gemini-2.5-flash',
          effort: 'max',
        }),
      );

      expect(modelArg(invocations[0]!.args)).toBe(
        GEMINI_REASONING_EFFORT_ALIAS,
      );
      expect(settings).toEqual({
        modelConfigs: {
          customAliases: {
            [GEMINI_REASONING_EFFORT_ALIAS]: {
              modelConfig: {
                model: 'gemini-2.5-flash',
                generateContentConfig: {
                  thinkingConfig: { thinkingBudget: 24576 },
                },
              },
            },
          },
        },
      });
      expect(profile).toBe('profile\n');
      expect(readdirSync(join(realHome, '.gemini')).sort()).toEqual([
        'history',
        'tmp',
      ]);
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.each([
    [
      'malformed JSON',
      '{ "modelConfigs": ',
      'Unable to parse Gemini user settings at',
    ],
    ['a non-object root', '[]', 'must be a JSON object'],
    [
      'non-object modelConfigs',
      '{ "modelConfigs": 1 }',
      'Gemini user settings modelConfigs at',
    ],
    [
      'non-object customAliases',
      '{ "modelConfigs": { "customAliases": [] } }',
      'Gemini user settings modelConfigs.customAliases at',
    ],
  ])(
    'rejects %s user settings before spawning',
    async (_name, content, message) => {
      mkdirSync(join(realHome, '.gemini'));
      writeFileSync(join(realHome, '.gemini', 'settings.json'), content);
      const { spawnProcess, invocations } = makeSpawn(() => {});

      const events = await collect(
        new GeminiAdapter({ spawnProcess }).run('prompt', {
          model: 'gemini-3-pro',
          effort: 'low',
        }),
      );

      expect(invocations).toHaveLength(0);
      expect(events.map((event) => event.type)).toEqual([
        'init',
        'error',
        'done',
      ]);
      expect(events[1]?.payload).toMatchObject({ code: 'GEMINI_STREAM_ERROR' });
      expect((events[1]?.payload as { message: string }).message).toContain(
        message,
      );
      expect(overlaysLeft()).toEqual([]);
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'removes a partly built overlay when setup fails',
    async () => {
      const realGemini = join(realHome, '.gemini');
      mkdirSync(join(realGemini, 'tmp'), { recursive: true });
      mkdirSync(join(realGemini, 'history'));
      writeFileSync(join(realHome, '.env'), 'KEY=value\n');
      // The home links, then the unlistable .gemini fails the overlay.
      chmodSync(realGemini, 0o300);
      const { spawnProcess, invocations } = makeSpawn(() => {});

      try {
        const events = await collect(
          new GeminiAdapter({ spawnProcess }).run('prompt', {
            model: 'gemini-3-pro',
            effort: 'low',
          }),
        );

        expect(invocations).toHaveLength(0);
        expect(events.map((event) => event.type)).toEqual([
          'init',
          'error',
          'done',
        ]);
        expect((events[1]?.payload as { message: string }).message).toMatch(
          /EACCES|permission denied/i,
        );
        expect(overlaysLeft()).toEqual([]);
        expect(readFileSync(join(realHome, '.env'), 'utf8')).toBe(
          'KEY=value\n',
        );
      } finally {
        chmodSync(realGemini, 0o700);
      }
    },
  );

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

  it('forces private run-scoped local telemetry after settings environment values', async () => {
    const { spawnProcess, invocations } = makeSpawn((process) => {
      writeEventsAndClose(
        process,
        [JSON.stringify({ type: 'result', status: 'success' })],
        0,
        null,
      );
    });
    const adapter = new GeminiAdapter({
      spawnProcess,
      createSettingsOverride: async () => ({
        env: {
          GEMINI_TELEMETRY_ENABLED: 'false',
          GEMINI_TELEMETRY_TARGET: 'gcp',
          GEMINI_TELEMETRY_OUTFILE: '/wrong/shared-file.json',
          GEMINI_TELEMETRY_LOG_PROMPTS: 'true',
          GEMINI_TELEMETRY_TRACES_ENABLED: 'true',
          GEMINI_TELEMETRY_USE_COLLECTOR: 'true',
        },
        cleanup: async () => {},
      }),
    });

    await collect(adapter.run('private prompt'));

    const env = invocations[0]?.options.env;
    expect(env).toMatchObject({
      GEMINI_TELEMETRY_ENABLED: 'true',
      GEMINI_TELEMETRY_TARGET: 'local',
      GEMINI_TELEMETRY_LOG_PROMPTS: 'false',
      GEMINI_TELEMETRY_TRACES_ENABLED: 'false',
      GEMINI_TELEMETRY_USE_COLLECTOR: 'false',
    });
    expect(env?.GEMINI_TELEMETRY_OUTFILE).toMatch(
      /cligent-gemini-telemetry-[^/]+\/telemetry\.json$/u,
    );
  });

  it.each(['success', 'error', 'abort'] as const)(
    'cleans run-owned telemetry after %s',
    async (outcome) => {
      const controller = new AbortController();
      let cleanupCalls = 0;
      const { spawnProcess } = makeSpawn((process) => {
        if (outcome === 'success') {
          writeEventsAndClose(
            process,
            [JSON.stringify({ type: 'result', status: 'success' })],
            0,
            null,
          );
          return;
        }

        if (outcome === 'error') {
          process.stderr.end();
          process.stdout.destroy(new Error('fake stream failed'));
          process.emit('close', 1, null);
          return;
        }

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
          `${JSON.stringify({ type: 'init', sessionId: 'telemetry-abort' })}\n`,
        );
        queueMicrotask(() => controller.abort());
      });
      const adapter = new GeminiAdapter({
        spawnProcess,
        createTelemetryCapture: async () => ({
          env: {},
          read: async () => '',
          cleanup: async () => {
            cleanupCalls += 1;
          },
        }),
      });

      await collect(
        adapter.run('private prompt', {
          ...(outcome === 'abort' ? { abortSignal: controller.signal } : {}),
        }),
      );

      expect(cleanupCalls).toBe(1);
    },
  );

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

  it('cleans the policy and home overlay after a stream error', async () => {
    let policyPath: string | undefined;
    let home: string | undefined;
    const { spawnProcess, invocations } = makeSpawn((process) => {
      policyPath = invocations[0]?.args
        .find((arg) => arg.startsWith('--policy='))
        ?.slice('--policy='.length);
      home = invocations[0]?.options.env?.GEMINI_CLI_HOME;
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
    expect(home).toBeDefined();
    expect(home).not.toBe(realHome);
    expect(existsSync(policyPath!)).toBe(false);
    expect(existsSync(home!)).toBe(false);
    expect(overlaysLeft()).toEqual([]);
  });

  it('cleans the policy and home overlay after abort', async () => {
    const controller = new AbortController();
    let policyPath: string | undefined;
    let home: string | undefined;

    const { spawnProcess, invocations } = makeSpawn((process) => {
      policyPath = invocations[0]?.args
        .find((arg) => arg.startsWith('--policy='))
        ?.slice('--policy='.length);
      home = invocations[0]?.options.env?.GEMINI_CLI_HOME;
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
    expect(home).toBeDefined();
    expect(home).not.toBe(realHome);
    expect(existsSync(policyPath!)).toBe(false);
    expect(existsSync(home!)).toBe(false);
    expect(overlaysLeft()).toEqual([]);
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

  it('sends SIGTERM on abort and omits interrupted close stderr', async () => {
    const controller = new AbortController();

    let spawned: MockGeminiProcess | undefined;
    const { spawnProcess } = makeSpawn((process) => {
      spawned = process;

      process.kill = (signal?: NodeJS.Signals | number): boolean => {
        process.killed = true;
        process.killSignals.push(signal);

        queueMicrotask(() => {
          process.stderr.write('shutdown diagnostic');
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

    const done = events[1] as AgentEvent & {
      payload: { status: string; result?: string };
    };
    expect(done.payload.status).toBe('interrupted');
    expect(done.payload).not.toHaveProperty('result');

    expect(spawned).toBeDefined();
    expect(spawned?.killSignals).toContain('SIGTERM');
  });

  it('gives abort precedence over a buffered native result', async () => {
    const controller = new AbortController();
    const process = new MockGeminiProcess();
    const stdout = {
      async *[Symbol.asyncIterator]() {
        yield `${JSON.stringify({
          type: 'result',
          status: 'error',
          result: 'native result',
          error: { code: 'NATIVE_ERROR', message: 'native rejection' },
          sessionId: 'gemini-result-backend',
          stats: { input_tokens: 3, output_tokens: 2, tool_uses: 0 },
        })}\n`;
        controller.abort();
      },
    };
    Object.defineProperty(process, 'stdout', { value: stdout });
    process.kill = (signal?: NodeJS.Signals | number): boolean => {
      process.killed = true;
      process.killSignals.push(signal);
      queueMicrotask(() => {
        process.stderr.end();
        process.emit('close', null, 'SIGTERM');
      });
      return true;
    };
    const adapter = new GeminiAdapter({
      spawnProcess: () =>
        process as unknown as ChildProcessWithoutNullStreams,
      createTelemetryCapture: async () => ({
        env: {},
        read: async () =>
          JSON.stringify({
            type: 'gemini_cli.api_response',
            model: 'gem',
          }),
        cleanup: async () => {},
      }),
    });

    const events = await collect(
      adapter.run('prompt', { abortSignal: controller.signal }),
    );

    expect(events.map((event) => event.type)).toEqual(['init', 'done']);
    const done = events[1] as AgentEvent & { payload: DonePayload };
    expect(done.payload).toEqual({
      status: 'interrupted',
      resumeToken: 'gemini-result-backend',
      usage: { toolUses: 0 },
      durationMs: expect.any(Number),
    });
    expect(process.killSignals).toEqual(['SIGTERM']);
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

      const done = events.find(
        (event) => event.type === 'done',
      ) as AgentEvent & {
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

  it('reports complete telemetry with tool prompts in inclusive input', async () => {
    const stats = {
      total_tokens: 156,
      input_tokens: 120,
      output_tokens: 20,
      cached: 80,
      input: 40,
      duration_ms: 50,
      tool_calls: 5,
      models: {
        'gemini-2.5-pro': {
          total_tokens: 156,
          input_tokens: 120,
          output_tokens: 20,
          cached: 80,
          input: 40,
        },
      },
    } satisfies GeminiStreamStats;
    let closed = false;
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
            stats,
            duration_ms: 50,
          }),
        ],
        0,
        null,
      );
      closed = true;
    });

    const telemetry = [
      JSON.stringify(
        {
          timestamp: '2026-08-13T01:00:00.000Z',
          attributes: {
            'event.name': 'gemini_cli.config',
            note: 'quoted braces do not split { objects }',
          },
        },
        null,
        2,
      ),
      apiResponseLog({
        timestamp: '2026-08-13T01:00:01.000Z',
        model: 'gemini-2.5-pro',
        input: 120,
        output: 20,
        cached: 80,
        thoughts: 10,
        tool: 6,
        total: 156,
      }),
    ].join('\n');

    const adapter = new GeminiAdapter({
      spawnProcess,
      probeAvailability: async () => true,
      createSettingsOverride: async () => ({
        env: {},
        cleanup: async () => {},
      }),
      createTelemetryCapture: telemetryCapture(telemetry, () => {
        expect(closed).toBe(true);
      }),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((e) => e.type === 'done')!;
    const usage = (done.payload as DonePayload).usage;
    expect(usage).toEqual({
      toolUses: 0,
      tokens: {
        coverage: 'complete',
        totals: {
          input: { total: 126, uncached: 46, cacheRead: 80 },
          output: { total: 30, visible: 20, reasoning: 10 },
        },
        records: [
          {
            model: 'gemini-2.5-pro',
            provider: 'gemini-api-key',
            requests: 1,
            tokens: {
              input: { total: 126, uncached: 46, cacheRead: 80 },
              output: { total: 30, visible: 20, reasoning: 10 },
            },
          },
        ],
      },
    });
  });

  it('deduplicates exact exporter records and preserves one record per model request', async () => {
    const first = apiResponseLog({
      timestamp: '2026-08-13T02:00:00.000Z',
      model: 'gemini-2.5-pro',
      input: 10,
      output: 3,
      cached: 2,
      thoughts: 1,
      total: 14,
    });
    const second = apiResponseLog({
      timestamp: '2026-08-13T02:00:01.000Z',
      model: 'gemini-2.5-flash',
      input: 5,
      output: 2,
      cached: 0,
      thoughts: 0,
      total: 7,
      promptId: 'prompt-2',
      role: 'subagent',
      authType: 'vertex-ai',
    });
    const stats: GeminiStreamStats = {
      total_tokens: 21,
      input_tokens: 15,
      output_tokens: 5,
      cached: 2,
      input: 13,
      duration_ms: 1,
      tool_calls: 7,
      models: {
        'gemini-2.5-pro': {
          total_tokens: 14,
          input_tokens: 10,
          output_tokens: 3,
          cached: 2,
          input: 8,
        },
        'gemini-2.5-flash': {
          total_tokens: 7,
          input_tokens: 5,
          output_tokens: 2,
          cached: 0,
          input: 5,
        },
      },
    };
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
          JSON.stringify({ type: 'result', status: 'success', stats }),
        ],
        0,
        null,
      );
    });
    const adapter = new GeminiAdapter({
      spawnProcess,
      createTelemetryCapture: telemetryCapture(
        [first, first, second].join('\n'),
      ),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((event) => event.type === 'done')!;
    const usage = (done.payload as DonePayload).usage;
    expect(usage.toolUses).toBe(0);
    expect(usage.tokens?.totals).toEqual({
      input: { total: 15, uncached: 13, cacheRead: 2 },
      output: { total: 6, visible: 5, reasoning: 1 },
    });
    expect(usage.tokens?.records).toHaveLength(2);
    expect(
      usage.tokens?.records?.map(({ model, provider, requests }) => ({
        model,
        provider,
        requests,
      })),
    ).toEqual([
      {
        model: 'gemini-2.5-pro',
        provider: 'gemini-api-key',
        requests: 1,
      },
      {
        model: 'gemini-2.5-flash',
        provider: 'vertex-ai',
        requests: 1,
      },
    ]);
  });

  it('marks exact successful-response tokens partial after an API error', async () => {
    const stats: GeminiStreamStats = {
      total_tokens: 3,
      input_tokens: 1,
      output_tokens: 2,
      cached: 0,
      input: 1,
      duration_ms: 1,
      tool_calls: 0,
      models: {
        'gemini-pro': {
          total_tokens: 3,
          input_tokens: 1,
          output_tokens: 2,
          cached: 0,
          input: 1,
        },
      },
    };
    const { spawnProcess } = makeSpawn((process) => {
      writeEventsAndClose(
        process,
        [
          JSON.stringify({ type: 'init', model: 'gemini-pro', tools: [] }),
          JSON.stringify({ type: 'result', status: 'success', stats }),
        ],
        0,
        null,
      );
    });
    const apiError = JSON.stringify({
      timestamp: '2026-08-13T02:59:59.000Z',
      attributes: {
        'event.name': 'gemini_cli.api_error',
        model_name: 'gemini-pro',
        prompt_id: 'failed-prompt',
        auth_type: 'gemini-api-key',
      },
    });
    const successful = apiResponseLog({
      timestamp: '2026-08-13T03:00:00.000Z',
      model: 'gemini-pro',
      input: 1,
      output: 2,
      cached: 0,
      thoughts: 0,
      total: 3,
    });
    const adapter = new GeminiAdapter({
      spawnProcess,
      createTelemetryCapture: telemetryCapture(
        [apiError, successful].join('\n'),
      ),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((event) => event.type === 'done')!;
    const usage = (done.payload as DonePayload).usage;
    expect(usage.tokens?.coverage).toBe('partial');
    expect(usage.tokens?.totals).toEqual({
      input: { total: 1, uncached: 1, cacheRead: 0 },
      output: { total: 2, visible: 2, reasoning: 0 },
    });
  });

  it('marks tokens partial when StreamStats retains a failed zero-token model', async () => {
    const stats: GeminiStreamStats = {
      total_tokens: 3,
      input_tokens: 1,
      output_tokens: 2,
      cached: 0,
      input: 1,
      duration_ms: 1,
      tool_calls: 0,
      models: {
        'gemini-pro': {
          total_tokens: 3,
          input_tokens: 1,
          output_tokens: 2,
          cached: 0,
          input: 1,
        },
        'gemini-failed-route': {
          total_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
          cached: 0,
          input: 0,
        },
      },
    };
    const { spawnProcess } = makeSpawn((process) => {
      writeEventsAndClose(
        process,
        [
          JSON.stringify({ type: 'init', model: 'gemini-pro', tools: [] }),
          JSON.stringify({ type: 'result', status: 'success', stats }),
        ],
        0,
        null,
      );
    });
    const adapter = new GeminiAdapter({
      spawnProcess,
      createTelemetryCapture: telemetryCapture(
        apiResponseLog({
          timestamp: '2026-08-13T03:00:00.000Z',
          model: 'gemini-pro',
          input: 1,
          output: 2,
          cached: 0,
          thoughts: 0,
          total: 3,
        }),
      ),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((event) => event.type === 'done')!;
    const usage = (done.payload as DonePayload).usage;
    expect(usage.tokens?.coverage).toBe('partial');
    expect(usage.tokens?.records).toHaveLength(1);
  });

  it.each([
    ['missing exporter data', ''],
    [
      'malformed response accounting',
      apiResponseLog({
        timestamp: '2026-08-13T03:00:00.000Z',
        model: 'gemini-pro',
        input: 1,
        output: 2,
        cached: 0,
        thoughts: 1,
        total: 3,
      }),
    ],
    [
      'stream/exporter mismatch',
      apiResponseLog({
        timestamp: '2026-08-13T03:00:01.000Z',
        model: 'gemini-pro',
        input: 2,
        output: 1,
        cached: 0,
        thoughts: 0,
        total: 3,
      }),
    ],
    [
      'tool-prompt/stream total mismatch',
      apiResponseLog({
        timestamp: '2026-08-13T03:00:02.000Z',
        model: 'gemini-pro',
        input: 1,
        output: 2,
        cached: 0,
        thoughts: 0,
        tool: 1,
        total: 4,
      }),
    ],
    [
      'missing authentication rate-card identity',
      apiResponseLog({
        timestamp: '2026-08-13T03:00:02.500Z',
        model: 'gemini-pro',
        input: 1,
        output: 2,
        cached: 0,
        thoughts: 0,
        total: 3,
        authType: '',
      }),
    ],
    [
      'conflicting duplicate identity',
      [
        apiResponseLog({
          timestamp: '2026-08-13T03:00:03.000Z',
          model: 'gemini-pro',
          input: 0,
          output: 1,
          cached: 0,
          thoughts: 0,
          total: 1,
        }),
        apiResponseLog({
          timestamp: '2026-08-13T03:00:03.000Z',
          model: 'gemini-pro',
          input: 1,
          output: 1,
          cached: 0,
          thoughts: 0,
          total: 2,
        }),
      ].join('\n'),
    ],
  ])('omits tokens for %s', async (_case, telemetry) => {
    const stats: GeminiStreamStats = {
      total_tokens: 3,
      input_tokens: 1,
      output_tokens: 2,
      cached: 0,
      input: 1,
      duration_ms: 1,
      tool_calls: 0,
      models: {
        'gemini-pro': {
          total_tokens: 3,
          input_tokens: 1,
          output_tokens: 2,
          cached: 0,
          input: 1,
        },
      },
    };
    const { spawnProcess } = makeSpawn((process) => {
      writeEventsAndClose(
        process,
        [
          JSON.stringify({ type: 'init', model: 'gemini-pro', tools: [] }),
          JSON.stringify({ type: 'result', status: 'success', stats }),
        ],
        0,
        null,
      );
    });
    const adapter = new GeminiAdapter({
      spawnProcess,
      createTelemetryCapture: telemetryCapture(telemetry),
    });

    const events = await collect(adapter.run('prompt'));
    const done = events.find((event) => event.type === 'done')!;
    expect((done.payload as DonePayload).usage).toEqual({
      toolUses: 0,
    });
  });

  it('maps both PermissionPolicy.mode = "auto" and "bypass" to --approval-mode yolo per engine-52', () => {
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

  it('mode overrides per-capability levels in gemini per engine-52', () => {
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

// engine-85: process diagnostics are not pre-execution rejection proof.
it('does not promote a Gemini stream error to resume rejection', async () => {
  const { spawnProcess, invocations } = makeSpawn((process) => {
    writeEventsAndClose(process, [
      JSON.stringify({ type: 'error', code: 'SESSION_RESUME_REJECTED', message: 'session not found', retryable: true }),
      JSON.stringify({ type: 'result', status: 'error', error: { message: 'failed' } }),
    ], 1, null);
  });
  const events = await collect(new GeminiAdapter({ spawnProcess }).run('continue', { resume: 'saved' }));
  expect(events.find((event) => event.type === 'error')?.payload).toMatchObject({ code: 'GEMINI_STREAM_ERROR', message: 'session not found' });
  expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  expect(invocations).toHaveLength(1);
});
