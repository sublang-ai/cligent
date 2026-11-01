// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
// Real installed SDK -> runtime carrier -> independent supervisor -> native fixture.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
if (process.platform !== 'win32')
  throw Error('This integration check requires native Windows');
const adapter =
  process.env.CLIGENT_WINDOWS_TEST_ADAPTER ??
  fileURLToPath(new URL('../dist/adapters/codex.js', import.meta.url));
const sdk = process.env.CLIGENT_WINDOWS_TEST_SDK ?? '@openai/codex-sdk';
const { createCodexConfigOverrideWrapper, mapPermissionsToCodexOptions } =
  await import(pathToFileURL(adapter).href);
const { Codex } = await import(
  sdk.startsWith('@') ? sdk : pathToFileURL(sdk).href
);
const root = await mkdtemp(join(tmpdir(), 'cligent Windows 中文 '));
const native = join(root, 'bin', 'recording CLI.exe');
const helperPath = join(root, 'codex-path');
await mkdir(dirname(native));
await mkdir(helperPath);
const compiler = join(
  process.env.WINDIR,
  'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
);
const compiled = spawnSync(
  compiler,
  [
    '/nologo',
    '/r:System.Web.Extensions.dll',
    '/out:' + native,
    fileURLToPath(new URL('./fixtures/codex-windows.cs', import.meta.url)),
  ],
  { encoding: 'utf8', windowsHide: true },
);
assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
let count = 0;
const wrappers = [];
const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
};
const make = async (mode) => {
  const wrapper = await createCodexConfigOverrideWrapper(
    ['fixture.setting="中文 & space"'],
    ['--ignore-user-config'],
    native,
  );
  wrappers.push(wrapper);
  const record = join(root, 'record-' + count++ + '.json');
  const env = {
    ...wrapper.env,
    CLIGENT_CASE: mode,
    CLIGENT_RECORD: record,
    CODEX_HOME: join(root, 'unchanged home'),
  };
  // Exercise the actual Windows mixed-case environment key, as desktop
  // launchers preserve it, rather than a POSIX-only PATH spelling.
  const inheritedPath = process.env.PATH ?? '';
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  env.Path = inheritedPath;
  const codex = new Codex({
    codexPathOverride: wrapper.path,
    env,
    configOverrides: ['fixture.sdk="exact"'],
  });
  const read = async () => JSON.parse(await readFile(record, 'utf8'));
  const cleanup = async () => {
    await wrapper.cleanup();
    assert(gone((await read()).pid), 'native fixture must have exited');
    const bootstrap = new URL(
      wrapper.env.NODE_OPTIONS.split('--import=').at(-1),
    );
    assert(
      !existsSync(dirname(fileURLToPath(bootstrap))),
      'carrier removed after settled evidence',
    );
  };
  return { wrapper, codex, read, cleanup };
};
const collect = async (codex, signal) => {
  const stream = await codex
    .startThread()
    .runStreamed('exact 中文\nprompt & "quoted"', { signal });
  const events = [];
  for await (const event of stream.events) events.push(event);
  return events;
};
const checks = [];
try {
  assert.equal(
    mapPermissionsToCodexOptions({ mode: 'auto' }).codexOptions.config
      .default_permissions,
    ':workspace',
  );
  const f = await make('success');
  const events = await collect(f.codex);
  assert.equal(events[1].item.text, 'left\u2028middle\u2029right 中文 😀');
  const record = await f.read();
  assert.deepEqual(record.args.slice(0, 5), [
    'exec',
    '--ignore-user-config',
    '--config',
    'fixture.setting="中文 & space"',
    '--experimental-json',
  ]);
  assert.equal(record.prompt, 'exact 中文\nprompt & "quoted"');
  assert.equal(record.home, join(root, 'unchanged home'));
  assert.equal(record.electron, process.env.ELECTRON_RUN_AS_NODE ?? null);
  assert.equal(record.nodeOptions, process.env.NODE_OPTIONS ?? null);
  assert.deepEqual(record.path.split(delimiter), [helperPath, ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)]);
  await f.cleanup();
  checks.push(
    'arguments, Unicode JSONL, stdin, native environment, home, cleanup',
  );
  checks.push('mixed-case Windows Path preserves inherited entries');
  if (process.env.CLIGENT_WINDOWS_TEST_BUNDLED_GIT) {
    const git = await make('git');
    const events = await collect(git.codex);
    assert.match(events[1].item.text, /^git version /);
    await git.cleanup();
    checks.push('native fixture invokes bundled Git through mixed-case Path');
  }
  for (const originalFlag of [undefined, '0', '1']) {
    const previousFlag = process.env.ELECTRON_RUN_AS_NODE;
    const previousOptions = process.env.NODE_OPTIONS;
    let f;
    try {
      if (originalFlag === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = originalFlag;
      process.env.NODE_OPTIONS = '--stack-trace-limit=27';
      f = await make('success');
    } finally {
      if (previousFlag === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = previousFlag;
      if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousOptions;
    }
    await collect(f.codex);
    const record = await f.read();
    assert.equal(record.electron, originalFlag ?? null);
    assert.equal(record.nodeOptions, '--stack-trace-limit=27');
    await f.cleanup();
  }
  checks.push(
    'original Electron flag absent/zero/one and Node options restored',
  );
  for (const mode of ['nonzero', 'malformed']) {
    const f = await make(mode);
    await assert.rejects(
      collect(f.codex),
      mode === 'nonzero'
        ? /code 7: native failure evidence/
        : /Failed to parse item/,
    );
    await f.cleanup();
    checks.push(mode);
  }
  for (const mode of ['abort', 'early-return']) {
    const f = await make('hang');
    const abort = new AbortController();
    const iterator = (
      await f.codex
        .startThread()
        .runStreamed('exact prompt', { signal: abort.signal })
    ).events;
    assert.equal((await iterator.next()).value.type, 'thread.started');
    if (mode === 'abort') {
      abort.abort();
      await assert.rejects(iterator.next());
    } else await iterator.return();
    await f.cleanup();
    checks.push(mode + ' reaps native child');
  }
  const unused = await make('hang');
  const already = new AbortController();
  already.abort();
  await assert.rejects(collect(unused.codex, already.signal));
  await unused.wrapper.cleanup();
  assert(!existsSync(join(root, 'record-' + (count - 1) + '.json')));
  checks.push('already-aborted request prevents native spawn');
  console.log(
    JSON.stringify(
      { passed: true, runtime: process.versions, checks },
      null,
      2,
    ),
  );
} finally {
  const failures = await Promise.allSettled(
    wrappers.map((wrapper) => wrapper.cleanup()),
  );
  if (failures.some((result) => result.status === 'rejected'))
    console.error('Retained unproven carrier');
  await rm(root, { recursive: true, force: true });
}
