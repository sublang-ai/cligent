#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Explicit recovery only: ordinary installation still uses normal npm dependencies.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_RUNTIME_TARGETS } from '../dist/runtime-targets.js';

const owner = realpathSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..'),
);
const manifestPath = join(owner, 'package.json');
const original = readFileSync(manifestPath);
const manifest = JSON.parse(original);
if (manifest.name !== '@sublang/cligent')
  throw new Error('repair must run from the installed Cligent package');
const sdkTargets = [
  ...AGENT_RUNTIME_TARGETS.claude,
  ...AGENT_RUNTIME_TARGETS.codex,
].filter((target) => target.kind === 'peer');
for (const target of sdkTargets)
  if (!manifest.dependencies?.[target.package])
    throw new Error(`installed manifest does not own ${target.package}`);
const dependencies = { ...manifest.dependencies };
// Descriptor fields are version metadata, never shell input.
for (const target of sdkTargets) {
  const at = target.repairSpec.lastIndexOf('@');
  dependencies[target.package] = target.repairSpec.slice(at + 1);
}
const npmCandidates = [
  process.env.npm_execpath,
  join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
];
for (const directory of (process.env.PATH ?? '').split(delimiter)) {
  for (const name of ['npm', 'npm.cmd']) {
    const launcher = join(directory, name);
    if (existsSync(launcher)) {
      const physical = realpathSync(launcher);
      if (physical.endsWith('npm-cli.js')) npmCandidates.push(physical);
      npmCandidates.push(
        join(dirname(physical), 'node_modules/npm/bin/npm-cli.js'),
      );
    }
  }
}
const npmCli = npmCandidates.find(
  (path) => path && existsSync(path) && path.endsWith('npm-cli.js'),
);
if (!npmCli)
  throw new Error(
    'cannot locate npm-cli.js; restore a Node/npm installation on PATH',
  );
const stage = mkdtempSync(join(owner, '.included-runtime-repair-'));
const moduleRoot = join(owner, 'node_modules');
const backup = join(stage, 'backups');
const changes = [];
let committed = false;
try {
  writeFileSync(
    join(stage, 'package.json'),
    JSON.stringify(
      {
        name: 'cligent-runtime-repair',
        version: '0.0.0',
        private: true,
        dependencies,
        ...(manifest.overrides ? { overrides: manifest.overrides } : {}),
      },
      null,
      2,
    ),
  );
  const installed = spawnSync(
    process.execPath,
    [
      npmCli,
      'install',
      '--global=false',
      '--legacy-peer-deps=false',
      '--location=project',
      '--prefix',
      stage,
      '--omit=dev',
      '--include=optional',
      '--include=peer',
      '--no-audit',
      '--no-fund',
    ],
    { stdio: 'inherit' },
  );
  if (installed.error || installed.status !== 0)
    throw new Error(
      `production runtime install failed (${installed.status}): ${installed.error?.message ?? ''}`,
    );
  for (const target of sdkTargets) {
    const sdk = JSON.parse(
      readFileSync(
        join(stage, 'node_modules', target.package, 'package.json'),
        'utf8',
      ),
    );
    if (
      sdk.name !== target.package ||
      sdk.version !== dependencies[target.package]
    )
      throw new Error(`staged SDK identity mismatch: ${target.package}`);
  }
  const tree = spawnSync(
    process.execPath,
    [
      npmCli,
      'ls',
      '--global=false',
      '--legacy-peer-deps=false',
      '--location=project',
      '--prefix',
      stage,
      '--omit=dev',
      '--include=optional',
      '--include=peer',
      '--all',
    ],
    { stdio: 'inherit' },
  );
  if (tree.error || tree.status !== 0)
    throw new Error(
      'repaired production dependency graph has missing or invalid dependencies',
    );
  if (!readFileSync(manifestPath).equals(original))
    throw new Error(
      'installed manifest changed during repair; refusing mutation',
    );
  if (
    existsSync(moduleRoot) &&
    (!lstatSync(moduleRoot).isDirectory() ||
      lstatSync(moduleRoot).isSymbolicLink())
  )
    throw new Error(
      'installed node_modules is a foreign path; restore Cligent installation',
    );
  mkdirSync(moduleRoot, { recursive: true });
  mkdirSync(backup);
  const entries = [];
  for (const name of readdirSync(join(stage, 'node_modules'))) {
    if (name.startsWith('.')) continue;
    if (name.startsWith('@'))
      for (const child of readdirSync(join(stage, 'node_modules', name)))
        entries.push(join(name, child));
    else entries.push(name);
  }
  for (const name of entries.sort()) {
    const target = join(moduleRoot, name),
      saved = join(backup, name);
    mkdirSync(dirname(target), { recursive: true });
    mkdirSync(dirname(saved), { recursive: true });
    let prior = false;
    try {
      lstatSync(target);
      prior = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (prior) renameSync(target, saved);
    changes.push({ target, saved, prior, placed: false });
    renameSync(join(stage, 'node_modules', name), target);
    changes.at(-1).placed = true;
  }
  const probeSource = `
    import { ClaudeCodeAdapter } from ${JSON.stringify(new URL('../dist/adapters/claude-code.js', import.meta.url).href)};
    import { CodexAdapter } from ${JSON.stringify(new URL('../dist/adapters/codex.js', import.meta.url).href)};
    import { locateAgentExecutable } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
    for (const [agent, Adapter] of [['claude', ClaudeCodeAdapter], ['codex', CodexAdapter]]) {
      if (!(await new Adapter().isAvailable()) || locateAgentExecutable(agent).state !== 'present') throw new Error('repaired SDK/native remains unavailable: ' + agent);
    }
  `;
  const ready = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', probeSource],
    { stdio: 'inherit' },
  );
  if (ready.error || ready.status !== 0)
    throw new Error(
      'repaired SDK/native readiness failed; restoring prior dependency tree',
    );
  committed = true;
  console.log(
    'Included Claude and Codex SDK production trees restored; installed manifest and unrelated optional packages preserved.',
  );
} finally {
  if (!committed)
    for (const change of changes.reverse()) {
      if (change.placed)
        rmSync(change.target, { recursive: true, force: true });
      if (change.prior) renameSync(change.saved, change.target);
    }
  rmSync(stage, { recursive: true, force: true });
}
