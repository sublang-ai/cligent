// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { GeminiAdapter } from '../adapters/gemini.js';
import {
  assertGeminiAttachmentContext,
  prepareGeminiAttachments,
} from '../adapters/gemini-attachments.js';

let root: string;
let workspace: string;
let temporary: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cligent-gemini-stage-test-'));
  workspace = join(root, 'workspace');
  temporary = join(root, 'temp space');
  await mkdir(workspace);
  await mkdir(temporary);
  await writeFile(
    join(workspace, 'image [ab].bin'),
    Buffer.from([0, 1, 2, 255]),
  );
  vi.stubEnv('CLIGENT_RUNTIME_GATE', 'off');
  vi.stubEnv('TMPDIR', temporary);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});

function fixtureAdapter(
  observe: (args: readonly string[], cwd: unknown) => void,
  hold = false,
) {
  return new GeminiAdapter({
    createSettingsOverride: async () => ({ env: {}, cleanup: async () => {} }),
    createPolicyOverride: async () => ({ args: [], cleanup: async () => {} }),
    createTelemetryCapture: async () => ({
      env: {},
      read: async () => '',
      cleanup: async () => {},
    }),
    spawnProcess: (_command, args, options) => {
      observe(args, options.cwd);
      return spawn(
        process.execPath,
        [
          '-e',
          hold
            ? `console.log(JSON.stringify({type:'init',session_id:'fixture'}));setInterval(()=>{},1000)`
            : `console.log(JSON.stringify({type:'result',status:'success'}))`,
        ],
        { ...options, stdio: 'pipe' },
      );
    },
  });
}

it('snapshots ordered original bytes and MIME independently of names, preserving cwd and cleaning before done (gemini-47)', async () => {
  const original = join(workspace, 'image [ab].bin');
  let directory = '';
  let prompt = '';
  const adapter = fixtureAdapter((args, cwd) => {
    directory = args
      .find((arg) => arg.startsWith('--include-directories='))!
      .split('=')[1]!;
    prompt = args.at(-1)!;
    expect(cwd).toBe(workspace);
    expect(existsSync(directory)).toBe(true);
  });
  const options = {
    cwd: workspace,
    attachments: [
      { path: 'image [ab].bin', mimeType: 'IMAGE/PNG' },
      { path: original, mimeType: 'image/jpeg' },
    ],
  };
  for await (const event of adapter.run('Inspect', options)) {
    if (event.type === 'done') {
      expect(event.payload.status).toBe('success');
      expect(existsSync(directory)).toBe(false);
    }
  }
  expect(prompt).not.toContain(original);
  expect(prompt).toContain('temp\\ space');
  expect(prompt).toMatch(/0-[a-f0-9]{64}\.png.*1-[a-f0-9]{64}\.jpg/s);
  expect(await readFile(original)).toEqual(Buffer.from([0, 1, 2, 255]));
  expect(options.attachments[0].mimeType).toBe('IMAGE/PNG');
  expect(await readdir(temporary)).toEqual([]);
});

it('rejects every size and path constraint before child work and reports contextual capability facts (gemini-47)', async () => {
  const oversized = join(workspace, 'large.png');
  await writeFile(oversized, '');
  await truncate(oversized, 20 * 1024 * 1024 + 1);
  let spawned = false;
  const adapter = fixtureAdapter(() => {
    spawned = true;
  });
  const events = [];
  for await (const event of adapter.run('inspect', {
    cwd: workspace,
    attachments: [
      { path: 'image [ab].bin', mimeType: 'image/png' },
      { path: oversized },
    ],
  }))
    events.push(event);
  expect(events.find((event) => event.type === 'error')?.payload).toMatchObject(
    { message: expect.stringContaining('attachments[1]') },
  );
  expect(spawned).toBe(false);
  expect(await readdir(temporary)).toEqual([]);
  for (const bad of [
    '/tmp/[glob]',
    '/tmp/comma,name',
    '/tmp/control\n',
    '/tmp/back\\slash',
  ])
    expect(() => assertGeminiAttachmentContext(bad)).toThrow(
      'temporary directory',
    );
  expect(() => assertGeminiAttachmentContext('/tmp', 'win32')).toThrow(
    'native Windows',
  );
  const ambiguous = join(root, '[ambiguous]');
  await mkdir(ambiguous);
  vi.stubEnv('TMPDIR', ambiguous);
  const facts = await adapter.getCapabilities({ cwd: workspace });
  expect(facts.attachments?.mimeTypes).toEqual([]);
  expect(facts.attachments?.notes).toContain('temporary directory');
  expect(facts.browser).toEqual({ status: 'supported' });
});

it('cleans snapshots for pre-abort, active abort, and early stream return (gemini-47)', async () => {
  const attachments = [
    { path: join(workspace, 'image [ab].bin'), mimeType: 'image/png' },
  ];
  const aborted = new AbortController();
  aborted.abort();
  let spawned = false;
  const events = [];
  for await (const event of fixtureAdapter(() => {
    spawned = true;
  }).run('', { attachments, abortSignal: aborted.signal }))
    events.push(event);
  expect(spawned).toBe(false);
  expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  expect(events.at(-1)?.payload).toMatchObject({ status: 'interrupted' });
  for (const mode of ['abort', 'return']) {
    let directory = '';
    const controller = new AbortController();
    const adapter = fixtureAdapter((args) => {
      directory = args
        .find((arg) => arg.startsWith('--include-directories='))!
        .split('=')[1]!;
    }, true);
    const stream = adapter.run('', {
      attachments,
      abortSignal: controller.signal,
    });
    expect((await stream.next()).value?.type).toBe('init');
    expect(existsSync(directory)).toBe(true);
    if (mode === 'abort') {
      controller.abort();
      const remaining = [];
      for await (const event of stream) {
        remaining.push(event);
        if (event.type === 'done') expect(existsSync(directory)).toBe(false);
      }
      expect(remaining.filter((event) => event.type === 'done')).toHaveLength(
        1,
      );
      expect(remaining.at(-1)?.payload).toMatchObject({
        status: 'interrupted',
      });
    } else await stream.return();
    expect(existsSync(directory)).toBe(false);
  }
});

it('does not create a stage for ordinary native prompts or absent attachments', async () => {
  for (const value of [undefined, []]) {
    const stage = await prepareGeminiAttachments('Inspect @native.png', value);
    expect(stage.prompt).toBe('Inspect @native.png');
    expect(stage.directory).toBeUndefined();
    await stage.cleanup();
  }
  expect(await readdir(temporary)).toEqual([]);
});
