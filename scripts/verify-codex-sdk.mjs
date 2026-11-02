// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
// Recording executables are test doubles. Production always uses native Codex.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const { CodexAdapter } = await import(
  pathToFileURL(
    process.env.CLIGENT_TEST_ADAPTER ??
      fileURLToPath(new URL('../dist/adapters/codex.js', import.meta.url)),
  ).href
);
const { Codex } = await import(
  process.env.CLIGENT_TEST_SDK
    ? pathToFileURL(process.env.CLIGENT_TEST_SDK).href
    : '@openai/codex-sdk'
);
const root = await mkdtemp(join(tmpdir(), 'cligent SDK 中文 '));
const native = join(
  root,
  process.platform === 'win32' ? 'recording CLI.exe' : 'recording CLI.mjs',
);
const home = join(root, 'unchanged home');
await mkdir(home);
await writeFile(join(home, 'config.toml'), '# unchanged user configuration\n');
const fixture = String.raw`
import { readFileSync, writeFileSync } from 'node:fs';
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
writeFileSync(process.env.CLIGENT_RECORD, JSON.stringify({pid:process.pid,args:process.argv.slice(2),prompt,home:process.env.CODEX_HOME}));
console.log(JSON.stringify({type:'thread.started',thread_id:'recording-thread'}));
const mode=process.env.CLIGENT_CASE;
if(mode==='hang') setInterval(()=>{},1000);
else if(mode==='nonzero') { console.error('native failure evidence'); process.exitCode=7; }
else if(mode==='malformed') console.log('{broken');
else {
for(const [id,text]of [['one','progress one'],['two','progress two'],['final','{"ok":true,"text":"中文 space"}']])
console.log(JSON.stringify({type:'item.completed',item:{id,type:'agent_message',text}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}));
}
`;
const checks = [];
const pids = [];
const gone = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
};
async function waitGone(pid) {
  for (let i = 0; i < 100 && !gone(pid); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert(gone(pid), `SDK child ${pid} remains alive`);
}
try {
  if (process.platform === 'win32') {
    const compiler = join(
      process.env.WINDIR,
      'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
    );
    const build = spawnSync(
      compiler,
      [
        '/nologo',
        '/r:System.Web.Extensions.dll',
        '/out:' + native,
        fileURLToPath(new URL('./fixtures/codex-windows.cs', import.meta.url)),
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(build.status, 0, build.stdout + build.stderr);
  } else {
    await writeFile(native, `#!${process.execPath}\n${fixture}`);
    await chmod(native, 0o700);
  }
  let index = 0;
  function adapter(mode, captured) {
    const record = join(root, `record-${index++}.json`);
    return {
      record,
      instance: new CodexAdapter({
        probeExecutable: () => ({ state: 'present', path: native }),
        loadSdk: async () => ({
          Codex: class extends Codex {
            constructor(options) {
              captured.push(options);
              assert.equal(
                options?.codexPathOverride,
                undefined,
                'ordinary callers leave platform selection to SDK',
              );
              assert.equal(
                options?.env,
                undefined,
                'adapter must not inject startup hooks',
              );
              // Replace only the native executable with a recording test double.
              super({
                ...options,
                codexPathOverride: native,
                env: {
                  ...process.env,
                  CODEX_HOME: home,
                  CLIGENT_RECORD: record,
                  CLIGENT_CASE: mode,
                },
              });
            }
          },
        }),
      }),
    };
  }
  async function read(record) {
    const r = JSON.parse(await readFile(record, 'utf8'));
    pids.push(r.pid);
    return r;
  }
  for (const permissions of [
    undefined,
    { mode: 'auto' },
    { mode: 'bypass' },
    { fileWrite: 'deny' },
    { mode: 'auto', writablePaths: ['.git'] },
  ]) {
    const captured = [];
    const f = adapter('success', captured);
    const events = [];
    for await (const event of f.instance.run('exact 中文\nprompt & "quoted"', {
      cwd: root,
      permissions,
    }))
      events.push(event);
    const done = events.at(-1).payload;
    assert.equal(done.status, 'success');
    assert.deepEqual(JSON.parse(done.result), { ok: true, text: '中文 space' });
    assert.deepEqual(
      events.filter((e) => e.type === 'text').map((e) => e.payload.content),
      ['progress one', 'progress two', '{"ok":true,"text":"中文 space"}'],
    );
    const r = await read(f.record);
    assert(!r.args.includes('--ignore-user-config'));
    assert.equal(r.prompt, 'exact 中文\nprompt & "quoted"');
    assert.equal(r.home, home);
    if (permissions) assert(captured[0].config.default_permissions);
    await waitGone(r.pid);
  }
  checks.push(
    'direct installed SDK, per-call mappings, progress plus independently parseable final JSON, Chinese/space paths, unchanged config home, normal exit',
  );
  for (const mode of ['nonzero', 'malformed']) {
    const f = adapter(mode, []);
    const events = [];
    for await (const e of f.instance.run('failure')) events.push(e);
    assert.equal(events.at(-1).payload.status, 'error');
    assert.equal(events.at(-1).payload.result, undefined);
    assert(
      events.some(
        (e) => e.type === 'error' && e.payload.code === 'SDK_STREAM_ERROR',
      ),
    );
    if (mode === 'nonzero')
      assert(
        events.some(
          (e) =>
            e.type === 'error' &&
            /code 7.*native failure evidence/s.test(e.payload.message),
        ),
      );
    await waitGone((await read(f.record)).pid);
  }
  checks.push('nonzero and malformed-stream errors preserve adapter status');
  for (const mode of ['abort', 'early-return']) {
    const f = adapter('hang', []);
    const controller = new AbortController();
    const stream = f.instance.run('cancel', { abortSignal: controller.signal });
    assert.equal((await stream.next()).value.type, 'init');
    const r = await read(f.record);
    if (mode === 'abort') {
      controller.abort();
      const rest = [];
      for await (const e of stream) rest.push(e);
      assert.equal(rest.at(-1).payload.status, 'interrupted');
      assert.equal(rest.at(-1).payload.result, undefined);
    } else await stream.return();
    await waitGone(r.pid);
  }
  checks.push(
    'abort and early return: SDK native child exits without supervisor',
  );
  assert.equal(
    await readFile(join(home, 'config.toml'), 'utf8'),
    '# unchanged user configuration\n',
  );
  console.log(
    JSON.stringify(
      {
        passed: true,
        platform: process.platform,
        runtime: process.versions.node,
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  // Only test-double processes: never terminate unrelated user Codex instances.
  for (const pid of pids) if (!gone(pid)) process.kill(pid);
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}
