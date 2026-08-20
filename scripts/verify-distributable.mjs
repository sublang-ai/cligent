#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  EXPECTED_PROTOCOL_VERSIONS,
  EXPECTED_SDK_VERSIONS,
} from './verify-agent-targets.mjs';
import { AGENT_RUNTIME_TARGETS } from '../dist/runtime-targets.js';

const PACKAGE_NAME = '@sublang/cligent';
const NODE_RUNTIME_VERSION = '18.3.0';
const TYPESCRIPT_VERSION = '5.4.5';
const NODE_TYPES_VERSION = '18.19.24';
const EXPECTED_RUNTIME_DEPENDENCIES = Object.freeze({
  '@agentclientprotocol/sdk': '1.3.0',
  yaml: '^2.8.4',
  zod: '4.4.3',
});
// package-26: derived from the shipped descriptor, never restated here. A
// second copy of a floor is exactly the drift this work removes.
const EXPECTED_OPTIONAL_PEERS = Object.freeze(
  Object.fromEntries(
    Object.values(AGENT_RUNTIME_TARGETS)
      .flat()
      .filter((target) => target.kind === 'peer')
      .map((target) => [target.package, `>=${target.supportedFrom}`]),
  ),
);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// Canonical, because tmux-play reports the tree it actually resolves from and
// macOS exposes the same temporary directory through both /var and /private/var.
const verificationRoot = realpathSync(
  mkdtempSync(join(tmpdir(), 'cligent-distributable-')),
);
const npmCache = join(verificationRoot, 'npm-cache');
const packDirectory = join(verificationRoot, 'pack');
const consumerDirectory = join(verificationRoot, 'consumer');
const codexGlobalPrefix = join(verificationRoot, 'codex-global');
const codexNestedConsumerDirectory = join(
  verificationRoot,
  'codex-nested-consumer',
);
const CODEX_PROBE_FILENAME = 'codex-resolution-probe.mjs';
const codexProbeHomeDirectory = join(verificationRoot, 'codex-home');
const codexProbeWorkDirectory = join(verificationRoot, 'codex-probe-workdir');
const codexSdkInstallSpec = `@openai/codex-sdk@${EXPECTED_SDK_VERSIONS['@openai/codex-sdk']}`;
const tmuxPlayGlobalPrefix = join(verificationRoot, 'tmux-play-global');
const tmuxPlayHarnessBin = join(verificationRoot, 'tmux-play-harness-bin');
const tmuxPlayConfigHome = join(verificationRoot, 'tmux-play-xdg');
const tmuxPlayHome = join(verificationRoot, 'tmux-play-home');
const tmuxPlayWorkDirectory = join(verificationRoot, 'tmux-play-workdir');
const tmuxPlayTmp = join(verificationRoot, 'tmux-play-tmp');
const tmuxPlayLog = join(verificationRoot, 'tmux-play-tmux.jsonl');
const tmuxPlayHomeConfig = join(tmuxPlayConfigHome, 'tmux-play', 'config.yaml');

function fail(message) {
  throw new Error(`distributable verification: ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    timeout: options.timeout ?? 300_000,
    env: {
      ...process.env,
      npm_config_cache: npmCache,
      npm_config_fund: 'false',
      ...options.env,
    },
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const output = `${stdout}${stderr ? `${stdout ? '\n' : ''}${stderr}` : ''}`;

  if (result.error) {
    fail(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(' ')} exited ${String(result.status)}${
        output.trim() ? `:\n${output.trim()}` : ''
      }`,
    );
  }

  return { stdout, stderr, output };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function assertDeepEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    fail(
      `${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function assertRuntimeDependencyShape(
  packageName,
  manifest,
  expectedPeerDependencies = {},
) {
  assertDeepEqual(
    manifest.dependencies ?? {},
    {},
    `${packageName} transitive runtime dependencies`,
  );
  assertDeepEqual(
    manifest.optionalDependencies ?? {},
    {},
    `${packageName} optional transitive runtime dependencies`,
  );
  assertDeepEqual(
    manifest.peerDependencies ?? {},
    expectedPeerDependencies,
    `${packageName} runtime peer dependencies`,
  );
  assertDeepEqual(
    manifest.bundleDependencies ?? manifest.bundledDependencies ?? [],
    [],
    `${packageName} bundled transitive runtime dependencies`,
  );
}

function parsePackResult(stdout) {
  const start = stdout.search(/\[\s*\{/);
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end < start) {
    fail(`npm pack did not return JSON metadata:\n${stdout.trim()}`);
  }

  let result;
  try {
    result = JSON.parse(stdout.slice(start, end + 1));
  } catch (error) {
    fail(
      `npm pack returned invalid JSON metadata: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!Array.isArray(result) || result.length !== 1) {
    fail('npm pack did not describe exactly one tarball');
  }
  return result[0];
}

function assertManifestPlacement(manifest, label) {
  assertEqual(manifest.name, PACKAGE_NAME, `${label} package name`);
  assertEqual(manifest.engines?.node, '>=18.3.0', `${label} Node floor`);
  assertDeepEqual(
    manifest.dependencies ?? {},
    EXPECTED_RUNTIME_DEPENDENCIES,
    `${label} runtime dependencies`,
  );
  assertDeepEqual(
    manifest.optionalDependencies ?? {},
    {},
    `${label} optional dependencies`,
  );
  assertDeepEqual(
    manifest.bundleDependencies ?? manifest.bundledDependencies ?? [],
    [],
    `${label} bundled dependencies`,
  );
  assertDeepEqual(
    manifest.peerDependencies ?? {},
    EXPECTED_OPTIONAL_PEERS,
    `${label} agent peers`,
  );

  const expectedPeerMeta = Object.fromEntries(
    Object.keys(EXPECTED_OPTIONAL_PEERS).map((packageName) => [
      packageName,
      { optional: true },
    ]),
  );
  assertDeepEqual(
    manifest.peerDependenciesMeta ?? {},
    expectedPeerMeta,
    `${label} optional peer metadata`,
  );

  for (const [packageName, version] of Object.entries(EXPECTED_SDK_VERSIONS)) {
    if (manifest.dependencies?.[packageName] !== undefined) {
      fail(`${label} places ${packageName} in runtime dependencies`);
    }
    if (manifest.optionalDependencies?.[packageName] !== undefined) {
      fail(`${label} places ${packageName} in optionalDependencies`);
    }
    if (label === 'repository') {
      assertEqual(
        manifest.devDependencies?.[packageName],
        version,
        `${label} exact ${packageName} development target`,
      );
    }
  }

  for (const [packageName, version] of Object.entries(
    EXPECTED_PROTOCOL_VERSIONS,
  )) {
    assertEqual(
      manifest.dependencies?.[packageName],
      version,
      `${label} exact ${packageName} runtime target`,
    );
    if (manifest.devDependencies?.[packageName] !== undefined) {
      fail(`${label} duplicates ${packageName} in devDependencies`);
    }
    if (manifest.optionalDependencies?.[packageName] !== undefined) {
      fail(`${label} places ${packageName} in optionalDependencies`);
    }
  }
}

function packagedTargets(manifest) {
  const targets = new Set(['package.json', 'LICENSE', 'README.md']);

  for (const value of [manifest.main, manifest.types]) {
    if (typeof value === 'string') targets.add(value.replace(/^\.\//, ''));
  }
  for (const value of Object.values(manifest.bin ?? {})) {
    if (typeof value === 'string') targets.add(value.replace(/^\.\//, ''));
  }
  for (const conditions of Object.values(manifest.exports ?? {})) {
    if (typeof conditions === 'string') {
      targets.add(conditions.replace(/^\.\//, ''));
      continue;
    }
    for (const value of Object.values(conditions ?? {})) {
      if (typeof value === 'string') targets.add(value.replace(/^\.\//, ''));
    }
  }

  return targets;
}

function assertTarballManifest(packed, manifest) {
  if (!packed || typeof packed.filename !== 'string') {
    fail('npm pack metadata did not include a tarball filename');
  }
  const tarballPath = join(packDirectory, packed.filename);
  if (!existsSync(tarballPath)) {
    fail(`npm pack did not create ${packed.filename}`);
  }

  const packedPaths = new Set(
    Array.isArray(packed.files)
      ? packed.files.map((file) => file?.path).filter(Boolean)
      : [],
  );
  for (const target of packagedTargets(manifest)) {
    if (!packedPaths.has(target)) {
      fail(`tarball omitted public package target ${target}`);
    }
  }
  for (const path of packedPaths) {
    if (
      path.startsWith('src/') ||
      path.startsWith('scripts/') ||
      path.startsWith('node_modules/')
    ) {
      fail(`tarball unexpectedly contains repository-only path ${path}`);
    }
  }

  return tarballPath;
}

function assertAuditClean(label, args) {
  const { stdout } = run(npm, args);
  let audit;
  try {
    audit = JSON.parse(stdout);
  } catch (error) {
    fail(
      `${label} audit did not return JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const vulnerabilities = audit.metadata?.vulnerabilities;
  if (!vulnerabilities || typeof vulnerabilities.total !== 'number') {
    fail(`${label} audit omitted vulnerability metadata`);
  }
  if (vulnerabilities.total !== 0) {
    fail(
      `${label} audit reported vulnerabilities: ${JSON.stringify(vulnerabilities)}`,
    );
  }
}

function writeConsumerFiles() {
  writeFileSync(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'cligent-distributable-consumer',
        private: true,
        type: 'module',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  writeFileSync(
    join(consumerDirectory, 'runtime-consumer.mjs'),
    `import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

const expectedVersion = 'v${NODE_RUNTIME_VERSION}';
if (process.version !== expectedVersion) {
  throw new Error(\`expected Node \${expectedVersion}, received \${process.version}\`);
}

const nodeModulesRoot = join(process.cwd(), 'node_modules');
const [root, claude, codex, gemini, kimi, opencode, tmuxPlay, fanout] =
  await Promise.all([
    import('@sublang/cligent'),
    import('@sublang/cligent/adapters/claude-code'),
    import('@sublang/cligent/adapters/codex'),
    import('@sublang/cligent/adapters/gemini'),
    import('@sublang/cligent/adapters/kimi'),
    import('@sublang/cligent/adapters/opencode'),
    import('@sublang/cligent/tmux-play'),
    import('@sublang/cligent/captains/fanout'),
  ]);

for (const [label, value] of [
  ['root Cligent', root.Cligent],
  ['ClaudeCodeAdapter', claude.ClaudeCodeAdapter],
  ['CodexAdapter', codex.CodexAdapter],
  ['GeminiAdapter', gemini.GeminiAdapter],
  ['KimiAdapter', kimi.KimiAdapter],
  ['OpenCodeAdapter', opencode.OpenCodeAdapter],
  ['TmuxPlayRuntime', tmuxPlay.TmuxPlayRuntime],
  ['FanoutCaptain', fanout.FanoutCaptain],
  ['fanout default factory', fanout.default],
]) {
  if (typeof value !== 'function') throw new Error(\`missing public export \${label}\`);
}
if (root.EFFORT_SUPPORT['claude-code'].values.at(-1) !== 'ultracode') {
  throw new Error('root effort metadata is unavailable or stale');
}
if (root.EFFORT_SUPPORT.codex.values.at(-1) !== 'ultra') {
  throw new Error('Codex effort metadata is unavailable or stale');
}
if (root.EFFORT_SUPPORT.kimi.values.join(',') !== 'off,on') {
  throw new Error('Kimi effort metadata is unavailable or stale');
}

const installedBin = join(
  nodeModulesRoot,
  '.bin',
  process.platform === 'win32' ? 'tmux-play.cmd' : 'tmux-play',
);
if (!existsSync(installedBin)) throw new Error('installed tmux-play bin link is missing');

const help = spawnSync(
  installedBin,
  ['--help'],
  {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: [dirname(process.execPath), process.env.PATH]
        .filter(Boolean)
        .join(delimiter),
    },
    shell: process.platform === 'win32',
  },
);
const helpOutput = \`\${help.stdout ?? ''}\n\${help.stderr ?? ''}\`;
if (help.error) throw help.error;
if (help.status !== 0 || !/Usage:\\r?\\n  tmux-play/.test(helpOutput)) {
  throw new Error(\`installed tmux-play --help failed: \${helpOutput.trim()}\`);
}

process.stdout.write(
  'Node 18.3.0 peer-free imports and installed launcher verified.\\n',
);
`,
    'utf8',
  );

  writeFileSync(
    join(consumerDirectory, 'type-consumer.ts'),
    `import {
  Cligent,
  EFFORT_SUPPORT,
  type ClaudeEffort,
  type CodexEffort,
  type GeminiEffort,
  type KimiEffort,
  type OpenCodeEffort,
} from '@sublang/cligent';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';
import { CodexAdapter } from '@sublang/cligent/adapters/codex';
import { GeminiAdapter } from '@sublang/cligent/adapters/gemini';
import { KimiAdapter } from '@sublang/cligent/adapters/kimi';
import { OpenCodeAdapter } from '@sublang/cligent/adapters/opencode';
import type {
  Captain,
  CaptainConfig,
  PlayerConfig,
} from '@sublang/cligent/tmux-play';
import createFanoutCaptain, {
  FanoutCaptain,
} from '@sublang/cligent/captains/fanout';

const claude = new Cligent(new ClaudeCodeAdapter(), { effort: 'ultracode' });
const codex = new Cligent(new CodexAdapter(), { effort: 'ultra' });
const gemini = new Cligent(new GeminiAdapter(), { effort: 'max' });
const kimi = new Cligent(new KimiAdapter(), { effort: 'on' });
const opencode = new Cligent(new OpenCodeAdapter(), { effort: 'minimal' });

claude.run('typed consumer', { effort: 'ultracode' });
codex.run('typed consumer', { effort: 'ultra' });
gemini.run('typed consumer', { effort: 'xhigh' });
kimi.run('typed consumer', { effort: 'off' });
opencode.run('typed consumer', { effort: 'high' });
// @ts-expect-error Codex-native effort must not reach Claude.
claude.run('typed consumer', { effort: 'ultra' });
// @ts-expect-error Claude-native effort must not reach Codex.
codex.run('typed consumer', { effort: 'ultracode' });
// @ts-expect-error Gemini accepts only portable effort values.
gemini.run('typed consumer', { effort: 'ultra' });
// @ts-expect-error OpenCode accepts only portable effort values.
opencode.run('typed consumer', { effort: 'ultracode' });
// @ts-expect-error Kimi accepts only its binary native effort values.
kimi.run('typed consumer', { effort: 'high' });

const claudeValues: readonly ClaudeEffort[] = EFFORT_SUPPORT['claude-code'].values;
const codexValues: readonly CodexEffort[] = EFFORT_SUPPORT.codex.values;
const geminiValues: readonly GeminiEffort[] = EFFORT_SUPPORT.gemini.values;
const kimiValues: readonly KimiEffort[] = EFFORT_SUPPORT.kimi.values;
const opencodeValues: readonly OpenCodeEffort[] = EFFORT_SUPPORT.opencode.values;
const players: PlayerConfig[] = [
  { id: 'claude', adapter: 'claude', effort: 'ultracode' },
  { id: 'codex', adapter: 'codex', effort: 'ultra' },
  { id: 'gemini', adapter: 'gemini', effort: 'max' },
  { id: 'kimi', adapter: 'kimi', effort: 'on' },
  { id: 'opencode', adapter: 'opencode', effort: 'minimal' },
];
const captain: CaptainConfig = {
  adapter: 'codex',
  from: '@sublang/cligent/captains/fanout',
  effort: 'ultra',
  options: null,
};
const fanout: Captain = createFanoutCaptain();
const namedFanout: Captain = new FanoutCaptain();

void claudeValues;
void codexValues;
void geminiValues;
void kimiValues;
void opencodeValues;
void players;
void captain;
void fanout;
void namedFanout;
`,
    'utf8',
  );

  writeFileSync(
    join(consumerDirectory, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          target: 'ES2022',
          module: 'Node16',
          moduleResolution: 'Node16',
          types: ['node'],
        },
        include: ['type-consumer.ts'],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

// codex-205: the Codex CLI entry must resolve from install layouts that do
// not hoist @openai/codex out of the SDK's own tree (npm global prefixes,
// nested-strategy consumers), and a real permission-managed adapter
// invocation must get past executable resolution. The probe is written into
// the consumer directory it verifies because ESM bare specifiers resolve
// from the importing file's location, not the working directory.
function writeCodexResolutionProbe(directory) {
  const probePath = join(directory, CODEX_PROBE_FILENAME);
  writeFileSync(
    probePath,
    `import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const adapterSpecifier = process.env.CODEX_PROBE_ADAPTER;
const expectation = process.env.CODEX_PROBE_EXPECT ?? 'sdk-owned';
const sdkOwnedPrefix = process.env.CODEX_PROBE_SDK_OWNED_PREFIX ?? '';

if (!adapterSpecifier) throw new Error('CODEX_PROBE_ADAPTER is required');
if (
  process.env.CODEX_PROBE_REQUIRE_NO_LOADER === '1' &&
  typeof import.meta.resolve === 'function'
) {
  throw new Error(
    \`expected a runtime without import.meta.resolve, got \${process.version}\`,
  );
}

const adapterModule = await import(adapterSpecifier);
const { CodexAdapter, createCodexConfigOverrideWrapper, resolveCodexBinPath } =
  adapterModule;
for (const [label, value] of [
  ['CodexAdapter', CodexAdapter],
  ['createCodexConfigOverrideWrapper', createCodexConfigOverrideWrapper],
  ['resolveCodexBinPath', resolveCodexBinPath],
]) {
  if (typeof value !== 'function') {
    throw new Error(\`missing adapter export \${label}\`);
  }
}

if (expectation === 'missing') {
  let failure;
  try {
    resolveCodexBinPath();
  } catch (error) {
    failure = error;
  }
  if (!failure) {
    throw new Error(
      'Codex executable resolution unexpectedly succeeded without @openai/codex-sdk',
    );
  }
  const message = failure instanceof Error ? failure.message : String(failure);
  for (const marker of [
    "'@openai/codex/bin/codex.js'",
    "'@openai/codex-sdk'",
    'Attempted:',
    'npm install -g @openai/codex-sdk',
  ]) {
    if (!message.includes(marker)) {
      throw new Error(\`resolution diagnostic lacks \${marker}: \${message}\`);
    }
  }
  process.stdout.write('codex resolution diagnostic verified\\n');
} else {
  const binPath = resolveCodexBinPath();
  if (!existsSync(binPath)) {
    throw new Error(\`resolved Codex entry does not exist: \${binPath}\`);
  }
  if (sdkOwnedPrefix && !binPath.startsWith(sdkOwnedPrefix)) {
    throw new Error(
      \`resolved \${binPath}, expected the SDK-owned entry under \${sdkOwnedPrefix}\`,
    );
  }

  const wrapper = await createCodexConfigOverrideWrapper(
    ['permissions.cligent_probe="resolution"'],
    ['--ignore-user-config'],
  );
  if (!wrapper) throw new Error('config override wrapper was not created');
  try {
    const scriptPath = wrapper.path.endsWith('.cmd')
      ? join(dirname(wrapper.path), 'codex-wrapper.mjs')
      : wrapper.path;
    const script = readFileSync(scriptPath, 'utf8');
    if (!script.includes(JSON.stringify(binPath))) {
      throw new Error(\`wrapper does not embed resolved Codex entry \${binPath}\`);
    }
  } finally {
    await wrapper.cleanup();
  }

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 3000);
  const adapter = new CodexAdapter();
  const events = [];
  let runFailure;
  try {
    for await (const event of adapter.run('cligent codex resolution probe', {
      cwd: process.cwd(),
      permissions: { mode: 'auto' },
      abortSignal: controller.signal,
    })) {
      events.push(event);
    }
  } catch (error) {
    runFailure = error;
  } finally {
    clearTimeout(abortTimer);
  }

  const failureText = runFailure ? \`\${runFailure?.stack ?? runFailure}\` : '';
  if (
    /Cannot find module '@openai\\/codex/.test(failureText) ||
    failureText.includes("could not resolve '@openai/codex/bin/codex.js'")
  ) {
    throw new Error(
      \`adapter run failed at Codex executable resolution: \${failureText}\`,
    );
  }
  // The only run() failure preceding executable resolution; without this the
  // leg would pass without ever reaching the path it claims to verify.
  if (failureText.includes('CodexAdapter requires @openai/codex-sdk')) {
    throw new Error(\`adapter run failed before resolution: \${failureText}\`);
  }
  if (!runFailure && !events.some((event) => event?.type === 'done')) {
    throw new Error(
      \`adapter run yielded no terminal done event: \${events
        .map((event) => event?.type)
        .join(',')}\`,
    );
  }
  process.stdout.write(\`codex resolution verified: \${binPath}\\n\`);
}
`,
    'utf8',
  );
  return probePath;
}

// tmux-play-201: the documented onboarding path (`npm install -g @sublang/cligent`
// then `tmux-play`) has to reach a session whose adapters resolve. Driving the
// installed executable is the only way to see that: the launcher, the config
// it generates, and the adapter runtimes it needs all live behind the bin.
// `tmux` and `glow` are stubbed because the runner has no glow and a real tmux
// session cannot be attached headlessly; the stub log doubles as mock-free
// evidence of whether a session was ever created.
function writeTmuxPlayHarness() {
  mkdirSync(tmuxPlayHarnessBin, { recursive: true });
  mkdirSync(tmuxPlayConfigHome, { recursive: true });
  mkdirSync(tmuxPlayHome, { recursive: true });
  mkdirSync(tmuxPlayWorkDirectory, { recursive: true });
  mkdirSync(tmuxPlayTmp, { recursive: true });

  // A PATH holding only node and the stubs: the CI runner installs the
  // gemini, kimi, and opencode CLIs globally, and any of them on PATH would
  // make an adapter look ready and change the generated roster.
  symlinkSync(realpathSync(process.execPath), join(tmuxPlayHarnessBin, 'node'));

  const fakeTmux = join(tmuxPlayHarnessBin, 'tmux');
  writeFileSync(
    fakeTmux,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "if (args[0] === '-V') {",
      "  console.log('tmux 3.4');",
      '  process.exit(0);',
      '}',
      "fs.appendFileSync(process.env.FAKE_TMUX_LOG, JSON.stringify(args) + '\\n');",
      'process.exit(0);',
      '',
    ].join('\n'),
  );
  chmodSync(fakeTmux, 0o755);

  const fakeGlow = join(tmuxPlayHarnessBin, 'glow');
  writeFileSync(
    fakeGlow,
    ['#!/usr/bin/env node', "console.log('glow stub');", 'process.exit(0);', ''].join(
      '\n',
    ),
  );
  chmodSync(fakeGlow, 0o755);
}

function runInstalledTmuxPlay(args) {
  const result = spawnSync(join(tmuxPlayGlobalPrefix, 'bin', 'tmux-play'), args, {
    cwd: tmuxPlayWorkDirectory,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      PATH: tmuxPlayHarnessBin,
      HOME: tmuxPlayHome,
      XDG_CONFIG_HOME: tmuxPlayConfigHome,
      FAKE_TMUX_LOG: tmuxPlayLog,
      TMPDIR: tmuxPlayTmp,
    },
  });
  if (result.error) {
    fail(`installed tmux-play could not start: ${result.error.message}`);
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

/**
 * The exact repair command tmux-play printed for one package, as argv.
 *
 * The gate is only worth anything if the command the user sees is the command
 * that works, so the test executes this rather than composing its own — a
 * hand-written install can be scoped to a tree the printed one never names.
 */
function extractRepairCommand(output, packageName) {
  const line = output
    .split('\n')
    .map((candidate) => candidate.trim())
    .find(
      (candidate) =>
        candidate.startsWith('npm install ') && candidate.endsWith(packageName),
    );
  if (!line) {
    fail(
      `tmux-play printed no npm install command for ${packageName}:\n${output.trim()}`,
    );
  }
  return line.split(/\s+/);
}

function assertOutputContains(result, expected, label) {
  if (!result.output.includes(expected)) {
    fail(
      `${label}: expected output to contain ${JSON.stringify(expected)}, received:\n${result.output.trim()}`,
    );
  }
}

function tmuxPlaySessionCreated() {
  return existsSync(tmuxPlayLog) && readFileSync(tmuxPlayLog, 'utf8').includes('new-session');
}

function globalNodeModulesRoot(prefix) {
  const candidates = [
    join(prefix, 'lib', 'node_modules'),
    join(prefix, 'node_modules'),
  ];
  const found = candidates.find((candidate) =>
    existsSync(join(candidate, '@sublang', 'cligent')),
  );
  if (!found) {
    fail(`global install created no @sublang/cligent under ${prefix}`);
  }
  return found;
}

function assertSdkOwnedCodexLayout(nodeModulesRoot, label) {
  const hoisted = join(nodeModulesRoot, '@openai', 'codex');
  if (existsSync(hoisted)) {
    fail(`${label} unexpectedly placed @openai/codex at ${hoisted}`);
  }
  const sdkOwnedEntry = join(
    nodeModulesRoot,
    '@openai',
    'codex-sdk',
    'node_modules',
    '@openai',
    'codex',
    'bin',
    'codex.js',
  );
  if (!existsSync(sdkOwnedEntry)) {
    fail(`${label} did not nest @openai/codex inside the SDK (${sdkOwnedEntry})`);
  }
  return realpathSync(join(nodeModulesRoot, '@openai', 'codex-sdk'));
}

function runCodexResolutionProbe(label, options) {
  const probePath = writeCodexResolutionProbe(options.cwd);
  const probeEnv = {
    CODEX_PROBE_ADAPTER: options.adapterSpecifier,
    CODEX_PROBE_EXPECT: options.expect ?? 'sdk-owned',
    CODEX_PROBE_SDK_OWNED_PREFIX: options.sdkOwnedPrefix ?? '',
    CODEX_PROBE_REQUIRE_NO_LOADER: options.requireNoLoader ? '1' : '',
    CODEX_HOME: codexProbeHomeDirectory,
  };
  const { stdout } = options.nodeRuntimeFloor
    ? run(
        npm,
        [
          'exec',
          '--yes',
          `--package=node@${NODE_RUNTIME_VERSION}`,
          '--',
          'node',
          probePath,
        ],
        { cwd: options.cwd, env: probeEnv },
      )
    : run(process.execPath, [probePath], {
        cwd: options.cwd,
        env: probeEnv,
      });
  const expectedMarker =
    (options.expect ?? 'sdk-owned') === 'missing'
      ? 'codex resolution diagnostic verified'
      : 'codex resolution verified:';
  if (!stdout.includes(expectedMarker)) {
    fail(`${label} probe did not report "${expectedMarker}":\n${stdout.trim()}`);
  }
}

try {
  mkdirSync(packDirectory, { recursive: true });
  mkdirSync(consumerDirectory, { recursive: true });

  const repositoryManifest = readJson(join(repoRoot, 'package.json'));
  assertManifestPlacement(repositoryManifest, 'repository');

  assertAuditClean('production', [
    'audit',
    '--omit=dev',
    '--include=prod',
    '--include=optional',
    '--include=peer',
    '--json',
    '--audit-level=low',
  ]);
  assertAuditClean('full graph', [
    'audit',
    '--include=prod',
    '--include=dev',
    '--include=optional',
    '--include=peer',
    '--json',
    '--audit-level=low',
  ]);

  const conformance = run(process.execPath, [
    join(repoRoot, 'scripts', 'verify-agent-targets.mjs'),
  ]);
  if (!conformance.stdout.includes('Agent conformance targets verified.')) {
    fail('agent conformance verifier did not report success');
  }

  const packed = parsePackResult(
    run(npm, ['pack', '--json', '--pack-destination', packDirectory]).stdout,
  );
  const tarballPath = assertTarballManifest(packed, repositoryManifest);

  writeConsumerFiles();
  run(
    npm,
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      '--save-exact',
      tarballPath,
      `typescript@${TYPESCRIPT_VERSION}`,
      `@types/node@${NODE_TYPES_VERSION}`,
    ],
    { cwd: consumerDirectory },
  );

  const installedManifest = readJson(
    join(
      consumerDirectory,
      'node_modules',
      '@sublang',
      'cligent',
      'package.json',
    ),
  );
  assertManifestPlacement(installedManifest, 'installed tarball');
  assertEqual(
    installedManifest.version,
    repositoryManifest.version,
    'installed tarball version',
  );
  for (const field of ['exports', 'bin', 'main', 'types']) {
    assertDeepEqual(
      installedManifest[field],
      repositoryManifest[field],
      `installed tarball ${field}`,
    );
  }

  for (const packageName of Object.keys(EXPECTED_OPTIONAL_PEERS)) {
    if (
      existsSync(
        join(consumerDirectory, 'node_modules', ...packageName.split('/')),
      )
    ) {
      fail(
        `optional peer ${packageName} was installed in the peer-free consumer`,
      );
    }
  }
  assertRuntimeDependencyShape(
    '@agentclientprotocol/sdk',
    readJson(
      join(
        consumerDirectory,
        'node_modules',
        '@agentclientprotocol',
        'sdk',
        'package.json',
      ),
    ),
    { zod: '^3.25.0 || ^4.0.0' },
  );
  assertRuntimeDependencyShape(
    'yaml',
    readJson(join(consumerDirectory, 'node_modules', 'yaml', 'package.json')),
  );
  assertRuntimeDependencyShape(
    'zod',
    readJson(join(consumerDirectory, 'node_modules', 'zod', 'package.json')),
  );

  const installedNodeTypes = readJson(
    join(consumerDirectory, 'node_modules', '@types', 'node', 'package.json'),
  );
  assertEqual(
    installedNodeTypes.version,
    NODE_TYPES_VERSION,
    'Node declaration consumer version',
  );

  const compiler = join(
    consumerDirectory,
    'node_modules',
    'typescript',
    'bin',
    'tsc',
  );
  assertEqual(
    run(process.execPath, [compiler, '--version'], {
      cwd: consumerDirectory,
    }).stdout.trim(),
    `Version ${TYPESCRIPT_VERSION}`,
    'TypeScript compiler report',
  );
  run(
    process.execPath,
    [compiler, '--project', join(consumerDirectory, 'tsconfig.json')],
    { cwd: consumerDirectory },
  );

  run(
    npm,
    [
      'exec',
      '--yes',
      `--package=node@${NODE_RUNTIME_VERSION}`,
      '--',
      'node',
      join(consumerDirectory, 'runtime-consumer.mjs'),
    ],
    { cwd: consumerDirectory },
  );

  mkdirSync(codexProbeHomeDirectory, { recursive: true });
  mkdirSync(codexProbeWorkDirectory, { recursive: true });

  // Global-style layout: each globally installed package keeps its own
  // dependency tree, so @openai/codex exists only inside the SDK.
  mkdirSync(codexGlobalPrefix, { recursive: true });
  run(npm, [
    'install',
    '--global',
    '--prefix',
    codexGlobalPrefix,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    tarballPath,
    codexSdkInstallSpec,
  ]);
  const globalRoot = globalNodeModulesRoot(codexGlobalPrefix);
  const globalSdkRoot = assertSdkOwnedCodexLayout(globalRoot, 'global install');
  runCodexResolutionProbe('global install', {
    adapterSpecifier: pathToFileURL(
      join(globalRoot, '@sublang', 'cligent', 'dist', 'adapters', 'codex.js'),
    ).href,
    sdkOwnedPrefix: globalSdkRoot,
    cwd: codexProbeWorkDirectory,
  });

  // Non-hoisted consumer layout: nested install strategy keeps every
  // dependency inside its dependent's tree.
  mkdirSync(codexNestedConsumerDirectory, { recursive: true });
  writeFileSync(
    join(codexNestedConsumerDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: 'cligent-codex-nested-consumer',
        private: true,
        type: 'module',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  run(
    npm,
    [
      'install',
      '--install-strategy=nested',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      tarballPath,
      codexSdkInstallSpec,
    ],
    { cwd: codexNestedConsumerDirectory },
  );
  const nestedRoot = join(codexNestedConsumerDirectory, 'node_modules');
  const nestedSdkRoot = assertSdkOwnedCodexLayout(
    nestedRoot,
    'nested-strategy consumer',
  );
  runCodexResolutionProbe('nested-strategy consumer', {
    adapterSpecifier: '@sublang/cligent/adapters/codex',
    sdkOwnedPrefix: nestedSdkRoot,
    cwd: codexNestedConsumerDirectory,
  });
  // The Node runtime floor has no import.meta.resolve, so this leg proves
  // the search-path anchor alone finds the SDK-owned entry.
  runCodexResolutionProbe('nested-strategy consumer on the Node floor', {
    adapterSpecifier: '@sublang/cligent/adapters/codex',
    sdkOwnedPrefix: nestedSdkRoot,
    cwd: codexNestedConsumerDirectory,
    nodeRuntimeFloor: true,
    requireNoLoader: true,
  });

  // The peer-free consumer resolves no @openai/codex from any route, so the
  // adapter must raise the ownership diagnostic with the repair.
  runCodexResolutionProbe('peer-free consumer diagnostic', {
    adapterSpecifier: '@sublang/cligent/adapters/codex',
    expect: 'missing',
    cwd: consumerDirectory,
  });

  // tmux-play-201: the documented global install, with no agent SDK beside it.
  mkdirSync(tmuxPlayGlobalPrefix, { recursive: true });
  run(npm, [
    'install',
    '--global',
    '--prefix',
    tmuxPlayGlobalPrefix,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    tarballPath,
  ]);
  globalNodeModulesRoot(tmuxPlayGlobalPrefix);
  writeTmuxPlayHarness();

  const installedTmuxPlayBin = join(tmuxPlayGlobalPrefix, 'bin', 'tmux-play');
  if (!existsSync(installedTmuxPlayBin)) {
    fail(`global install created no tmux-play executable at ${installedTmuxPlayBin}`);
  }

  // With nothing but cligent installed, the documented command must refuse:
  // no config naming runtimes it cannot load, no session, and every repair
  // command scoped to the prefix the user actually installed into.
  const emptyLaunch = runInstalledTmuxPlay([]);
  assertEqual(emptyLaunch.status, 1, 'tmux-play launch without any agent runtime');
  assertOutputContains(
    emptyLaunch,
    'found no agent runtime installed',
    'tmux-play launch without any agent runtime',
  );
  // Every peer SDK command names its tree with --prefix; here that tree is a
  // prefix supplied out of band that a bare install would never reach. PATH
  // executables stay unpinned because they belong in whatever global prefix
  // the user's shell reads.
  for (const repair of [
    `npm install -g --prefix ${tmuxPlayGlobalPrefix} @anthropic-ai/claude-agent-sdk`,
    `npm install -g --prefix ${tmuxPlayGlobalPrefix} @openai/codex-sdk`,
    `npm install -g --prefix ${tmuxPlayGlobalPrefix} @opencode-ai/sdk`,
    'npm install -g @google/gemini-cli',
    'npm install -g @moonshot-ai/kimi-code@0.31.1',
    'npm install -g opencode-ai',
  ]) {
    assertOutputContains(emptyLaunch, repair, 'tmux-play repair commands');
  }
  if (existsSync(tmuxPlayHomeConfig)) {
    fail(
      `tmux-play wrote ${tmuxPlayHomeConfig} with no adapter runtime installed`,
    );
  }
  if (tmuxPlaySessionCreated()) {
    fail('tmux-play created a tmux session before reporting a missing runtime');
  }

  // tmux-play-201: repair by running what the user was actually shown, verbatim.
  // Substituting a hand-written install here is what let a command scoped to
  // the wrong tree pass: this prefix is supplied out of band, so a bare
  // `npm install -g` would resolve against npm's own prefix instead.
  const printedRepair = extractRepairCommand(emptyLaunch.output, '@openai/codex-sdk');
  run(npm, [
    ...printedRepair.slice(1),
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ]);
  const installedSdk = join(
    globalNodeModulesRoot(tmuxPlayGlobalPrefix),
    '@openai',
    'codex-sdk',
  );
  if (!existsSync(installedSdk)) {
    fail(
      `the printed repair command (${printedRepair.join(' ')}) did not install ` +
        `the SDK into ${installedSdk}, the tree tmux-play reported it resolves from`,
    );
  }

  // One installed runtime is enough for a first session: the generated roster
  // names only that adapter, and the launch reaches tmux.
  const readyLaunch = runInstalledTmuxPlay([]);
  assertEqual(readyLaunch.status, 0, 'tmux-play launch with the Codex SDK installed');
  assertOutputContains(
    readyLaunch,
    `Created tmux-play config at ${tmuxPlayHomeConfig} for installed adapters: codex`,
    'tmux-play first-run notice',
  );
  const generatedConfig = readFileSync(tmuxPlayHomeConfig, 'utf8');
  if (!generatedConfig.includes('adapter: codex')) {
    fail(`generated config named no codex role:\n${generatedConfig}`);
  }
  if (/adapter: (?!codex)/.test(generatedConfig)) {
    fail(
      `generated config named an adapter with no installed runtime:\n${generatedConfig}`,
    );
  }

  if (!tmuxPlaySessionCreated()) {
    fail('tmux-play created no tmux session with every configured adapter ready');
  }
} finally {
  rmSync(verificationRoot, { recursive: true, force: true });
}

process.stdout.write(
  'Distributable tarball, consumers, audits, conformance targets, Codex ' +
    'install layouts, and global tmux-play onboarding verified.\n',
);
