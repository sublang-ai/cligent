#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_PROTOCOL_VERSIONS,
  EXPECTED_SDK_VERSIONS,
} from './verify-agent-targets.mjs';

const PACKAGE_NAME = '@sublang/cligent';
const NODE_RUNTIME_VERSION = '18.3.0';
const TYPESCRIPT_VERSION = '5.4.5';
const NODE_TYPES_VERSION = '18.19.24';
const EXPECTED_RUNTIME_DEPENDENCIES = Object.freeze({
  '@agentclientprotocol/sdk': '0.23.0',
  yaml: '^2.8.4',
  zod: '4.4.3',
});
const EXPECTED_OPTIONAL_PEERS = Object.freeze({
  '@anthropic-ai/claude-agent-sdk': '>=0.3.154',
  '@openai/codex-sdk': '>=0.138.0',
  '@opencode-ai/sdk': '>=1.14.41',
});

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const verificationRoot = mkdtempSync(join(tmpdir(), 'cligent-distributable-'));
const npmCache = join(verificationRoot, 'npm-cache');
const packDirectory = join(verificationRoot, 'pack');
const consumerDirectory = join(verificationRoot, 'consumer');

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
} finally {
  rmSync(verificationRoot, { recursive: true, force: true });
}

process.stdout.write(
  'Distributable tarball, consumers, audits, and conformance targets verified.\n',
);
