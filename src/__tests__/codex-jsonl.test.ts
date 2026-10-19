// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// codex-81: the real installed SDK owns framing and JSON.parse. Only the
// SDK-owned CLI entry is replaced by a recording subprocess (never a provider).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { Codex } from '@openai/codex-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CodexAdapter,
  createCodexConfigOverrideWrapper,
} from '../adapters/codex.js';

const roots: string[] = [];
const wrappers: Array<
  NonNullable<Awaited<ReturnType<typeof createCodexConfigOverrideWrapper>>>
> = [];
const FIXTURE = String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
const config = JSON.parse(readFileSync(process.env.JSONL_CASE, 'utf8'));
if (config.hang && config.resist) process.on('SIGTERM', () => {});
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString();
writeFileSync(process.env.JSONL_RECORD, JSON.stringify({
  pid: process.pid, args: process.argv.slice(2), prompt,
  home: process.env.CODEX_HOME, marker: process.env.JSONL_ENV_MARKER,
  resistant: Boolean(config.hang && config.resist),
  path: process.env.PATH,
  electronPresent: Object.hasOwn(process.env, 'ELECTRON_RUN_AS_NODE'),
  electron: process.env.ELECTRON_RUN_AS_NODE,
}));
if (config.hang) {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'recording-thread' }) + '\n');
  setInterval(() => {}, 1000);
} else {
  let body = config.raw ?? config.events.map((event) => JSON.stringify(event)).join(config.eol);
  if (!config.raw && !config.tail) body += config.eol;
  if (config.escaped) body = body.replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const bytes = Buffer.from(body);
  for (let offset = 0; offset < bytes.length; offset += config.chunk) {
    if (!process.stdout.write(bytes.subarray(offset, offset + config.chunk))) await once(process.stdout, 'drain');
    if (config.chunk < 4) await new Promise((resolve) => setImmediate(resolve));
  }
  if (config.stderr) process.stderr.write(config.stderr);
  process.exitCode = config.code ?? 0;
}
`;

type Case = {
  events?: unknown[];
  eol?: string;
  tail?: boolean;
  chunk?: number;
  escaped?: boolean;
  raw?: string;
  code?: number;
  stderr?: string;
  hang?: boolean;
  resist?: boolean;
};
const started = { type: 'thread.started', thread_id: 'recording-thread' };
const completed = {
  type: 'turn.completed',
  usage: {
    input_tokens: 1,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 1,
  },
};
function events(text: string) {
  return [
    started,
    {
      type: 'item.completed',
      item: { id: 'message', type: 'agent_message', text },
    },
    completed,
  ];
}
async function setup(input: Case = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cligent jsonl '));
  roots.push(root);
  const executable = join(root, 'bin', 'recording CLI.mjs');
  const helperPath = join(root, 'codex-path');
  await mkdir(dirname(executable));
  await mkdir(helperPath);
  await writeFile(executable, `#!${process.execPath}\n${FIXTURE}`);
  await chmod(executable, 0o700);
  const record = join(root, 'record.json');
  const data = join(root, 'case.json');
  const home = join(root, 'home');
  await mkdir(home);
  await writeFile(join(home, 'config.toml'), '# preserved configuration\n');
  await writeFile(
    data,
    JSON.stringify({ eol: '\n', chunk: 65536, events: events('ok'), ...input }),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (row): row is [string, string] => row[1] !== undefined,
    ),
  );
  Object.assign(env, {
    JSONL_CASE: data,
    JSONL_RECORD: record,
    CODEX_HOME: home,
    JSONL_ENV_MARKER: 'unchanged',
  });
  const wrapper = await createCodexConfigOverrideWrapper([], [], executable);
  if (!wrapper) throw new Error('POSIX wrapper missing');
  wrappers.push(wrapper);
  const codex = new Codex({ codexPathOverride: wrapper.path, env });
  return {
    root,
    executable,
    helperPath,
    home,
    env,
    wrapper,
    codex,
    recordPath: record,
    record: async () => {
      await expect.poll(() => existsSync(record), { timeout: 5000 }).toBe(true);
      return JSON.parse(await readFile(record, 'utf8')) as {
        pid: number;
        args: string[];
        prompt: string;
        home: string;
        marker: string;
        resistant: boolean;
        path: string;
        electronPresent: boolean;
        electron?: string;
      };
    },
  };
}
async function collect(codex: Codex, signal?: AbortSignal) {
  const turn = await codex
    .startThread()
    .runStreamed('exact prompt', signal ? { signal } : {});
  const actual = [];
  for await (const event of turn.events) actual.push(event);
  return actual;
}
function gone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
afterEach(async () => {
  await Promise.all(wrappers.splice(0).map((wrapper) => wrapper.cleanup()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(process.platform === 'win32')(
  'installed SDK JSONL transport (codex-81)',
  () => {
    it.each([
      ['LF split bytes', '\n', false, 1, false],
      ['CRLF split bytes', '\r\n', false, 2, false],
      ['unterminated tail', '\n', true, 3, false],
      ['already escaped', '\n', false, 1, true],
    ] as const)(
      'preserves nested/raw strings: %s',
      async (_name, eol, tail, chunk, escaped) => {
        const text =
          'nested {"value":"left\u2028middle\u2029right"} 😀 \\u2028';
        const expected = [
          started,
          {
            type: 'item.completed',
            item: {
              id: 'command',
              type: 'command_execution',
              command: 'printf \"raw\u2028and\u2029escaped\\u2028\"',
              aggregated_output: JSON.stringify({ nested: { text } }),
              exit_code: 0,
              status: 'completed',
            },
          },
          ...events(text).slice(1),
        ];
        const f = await setup({ events: expected, eol, tail, chunk, escaped });
        expect(await collect(f.codex)).toEqual(expected);
        expect(await f.record()).toMatchObject({
          prompt: 'exact prompt',
          home: f.home,
          marker: 'unchanged',
        });
        await f.wrapper.cleanup();
        expect(existsSync(dirname(f.wrapper.path))).toBe(false);
      },
    );

    it('drains large JSON output with backpressure before successful exit', async () => {
      const expected = events('large\u2028\u2029😀'.repeat(60000));
      const f = await setup({ events: expected, chunk: 4096 });
      expect(await collect(f.codex)).toEqual(expected);
      await f.wrapper.cleanup();
      expect(gone((await f.record()).pid)).toBe(true);
    });

    it.each([
      ['malformed', { raw: '{"type":"broken\u2028\n' }, /Failed to parse item/],
      [
        'nonzero',
        { events: [started], code: 7, stderr: 'real child failure' },
        /code 7: real child failure/,
      ],
    ] as const)('retains real SDK %s errors', async (_name, data, error) => {
      const f = await setup(data);
      await expect(collect(f.codex)).rejects.toThrow(error);
      await f.wrapper.cleanup();
      expect(gone((await f.record()).pid)).toBe(true);
    });

    it('retains turn.failed instead of suppressing its actual event', async () => {
      const f = await setup({
        events: [
          started,
          {
            type: 'turn.failed',
            error: { message: 'native failure\u2028detail' },
          },
        ],
        code: 9,
      });
      const stream = (await f.codex.startThread().runStreamed('exact prompt'))
        .events;
      const actual = [];
      for await (const event of stream) {
        actual.push(event);
        if (event.type === 'turn.failed') break;
      }
      expect(actual).toEqual([
        started,
        {
          type: 'turn.failed',
          error: { message: 'native failure\u2028detail' },
        },
      ]);
      await f.wrapper.cleanup();
      expect(gone((await f.record()).pid)).toBe(true);
    });

    it.each([false, true])(
      'aborts and reaps a hanging child (resistant=%s)',
      async (resist) => {
        const f = await setup({ hang: true, resist });
        const abort = new AbortController();
        const running = collect(f.codex, abort.signal);
        const rejection = expect(running).rejects.toThrow();
        let record: Awaited<ReturnType<typeof f.record>> | undefined;
        try {
          record = await f.record();
          expect(record.resistant).toBe(resist);
        } finally {
          abort.abort();
          await rejection;
          await f.wrapper.cleanup();
        }
        expect(gone(record.pid)).toBe(true);
        expect(existsSync(dirname(f.wrapper.path))).toBe(false);
      },
    );

    it.each([false, true])(
      'reaps after an early SDK iterator return (resistant=%s)',
      async (resist) => {
        const f = await setup({ hang: true, resist });
        const iterator = (
          await f.codex.startThread().runStreamed('exact prompt')
        ).events;
        expect((await iterator.next()).value).toEqual(started);
        expect((await f.record()).resistant).toBe(resist);
        await iterator.return();
        await f.wrapper.cleanup();
        expect(gone((await f.record()).pid)).toBe(true);
      },
    );

    it('handles downstream EPIPE without unhandled errors or a live child', async () => {
      const f = await setup({
        events: events('x'.repeat(2000000)),
        chunk: 4096,
      });
      const child = spawn(f.wrapper.path, ['exec', '--json'], { env: f.env });
      child.stdin.end('exact prompt');
      const closed = new Promise<number | null>((resolve) =>
        child.on('close', resolve),
      );
      child.stdout.once('data', () => child.stdout.destroy());
      let stderr = '';
      child.stderr.on('data', (data) => {
        stderr += data;
      });
      expect(await closed).toBe(1);
      await f.wrapper.cleanup();
      expect(gone((await f.record()).pid)).toBe(true);
      expect(stderr).not.toContain('Unhandled');
    });

    it('forwards --json with exact escaped wire bytes and native args', async () => {
      const raw =
        '{"outer":{"value":"left\u2028middle\u2029right","escaped":"\\\\u2028"}}\r\n';
      const expected =
        '{"outer":{"value":"left\\u2028middle\\u2029right","escaped":"\\\\u2028"}}\r\n';
      const f = await setup({ raw, chunk: 1 });
      const args = [
        'exec',
        '--json',
        '--config',
        'public.setting="path with spaces"',
      ];
      const child = spawn(f.wrapper.path, args, { env: f.env });
      child.stdin.end('exact prompt');
      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      expect(await new Promise((resolve) => child.on('close', resolve))).toBe(
        0,
      );
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(expected));
      expect((await f.record()).args).toEqual(args);
      await f.wrapper.cleanup();
      expect(gone((await f.record()).pid)).toBe(true);
    });

    it('forwards non-JSON stdout unchanged', async () => {
      const raw = 'raw\u2028data\u2029\r\ntail';
      const f = await setup({ raw, chunk: 1 });
      const child = spawn(f.wrapper.path, ['models'], { env: f.env });
      child.stdin.end('exact prompt');
      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      expect(await new Promise((resolve) => child.on('close', resolve))).toBe(
        0,
      );
      expect(Buffer.concat(chunks).toString()).toBe(raw);
      expect((await f.record()).args).toEqual(['models']);
      await f.wrapper.cleanup();
      expect(gone((await f.record()).pid)).toBe(true);
    });

    it.each([false, true])(
      'adapter preserves native configuration and resumed args (policy=%s)',
      async (policy) => {
        const f = await setup({ events: events('same\u2028value') });
        const paths: string[] = [];
        const adapter = new CodexAdapter({
          probeExecutable: () => ({ state: 'present', path: f.executable }),
          loadSdk: async () => ({
            Codex: class extends Codex {
              constructor(options?: ConstructorParameters<typeof Codex>[0]) {
                if (options?.codexPathOverride)
                  paths.push(options.codexPathOverride);
                super({ ...options, env: f.env });
              }
            },
          }),
        });
        const actual = [];
        for await (const event of adapter.run('exact prompt', {
          resume: 'recording-thread',
          ...(policy ? { permissions: { mode: 'auto' as const } } : {}),
        }))
          actual.push(event);
        const record = await f.record();
        expect(record.args).toContain('exec');
        expect(record.args).toContain('--experimental-json');
        expect(record.args).toContain('resume');
        expect(record.args).toContain('recording-thread');
        expect(record.args.includes('--ignore-user-config')).toBe(policy);
        expect(record).toMatchObject({
          prompt: 'exact prompt',
          home: f.home,
          marker: 'unchanged',
        });
        expect(await readFile(join(f.home, 'config.toml'), 'utf8')).toBe(
          '# preserved configuration\n',
        );
        expect(paths).toHaveLength(1);
        expect(paths.every((path) => !existsSync(dirname(path)))).toBe(true);
        expect(actual.at(-1)?.payload).toMatchObject({ status: 'success' });
      },
    );

    it.each([undefined, '', '1', 'original-value'])(
      'preserves native Electron flag and SDK helper PATH (flag=%s)',
      async (electron) => {
        const f = await setup();
        const env = { ...f.env };
        if (electron === undefined) delete env.ELECTRON_RUN_AS_NODE;
        else env.ELECTRON_RUN_AS_NODE = electron;
        const other = join(f.root, 'other');
        env.PATH = [other, '', f.helperPath, other, f.helperPath].join(
          delimiter,
        );
        const codex = new Codex({ codexPathOverride: f.wrapper.path, env });
        expect(await collect(codex)).toEqual(events('ok'));
        expect(await f.record()).toMatchObject({
          path: [f.helperPath, other, other].join(delimiter),
          electronPresent: electron !== undefined,
          ...(electron === undefined ? {} : { electron }),
        });
        await f.wrapper.cleanup();
      },
    );

    it('cleans after the SDK rejects an already-aborted request', async () => {
      const f = await setup();
      const controller = new AbortController();
      controller.abort();
      await expect(collect(f.codex, controller.signal)).rejects.toThrow();
      await f.wrapper.cleanup();
      expect(existsSync(dirname(f.wrapper.path))).toBe(false);
      expect(existsSync(f.recordPath)).toBe(false);
    });

    it('settles startup racing with cleanup without leaving a native child', async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const f = await setup();
        const child = spawn(f.wrapper.path, ['exec', '--json'], { env: f.env });
        child.stdin.on('error', () => {});
        child.stdin.end('exact prompt');
        child.stdout.resume();
        child.stderr.resume();
        const closed = new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', () => resolve());
        });
        await f.wrapper.cleanup();
        await closed;
        if (existsSync(f.recordPath))
          expect(gone((await f.record()).pid)).toBe(true);
        expect(existsSync(dirname(f.wrapper.path))).toBe(false);
      }
    });

    it('cleans an unused carrier without waiting for an impossible completion marker', async () => {
      const f = await setup();
      await f.wrapper.cleanup();
      expect(existsSync(dirname(f.wrapper.path))).toBe(false);
    });
  },
);
