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
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const verificationDirectory = mkdtempSync(
  join(tmpdir(), 'cligent-package-output-'),
);
const staleArtifacts = [
  'dist/deleted-package-fixture.js',
  'dist/deleted-package-fixture.d.ts',
  'dist/deleted-package-fixture.d.ts.map',
  'dist/orphaned-package-fixture/index.js',
];

function fail(message) {
  throw new Error(`package output verification: ${message}`);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      npm_config_cache: join(verificationDirectory, 'npm-cache'),
      npm_config_loglevel: 'silent',
    },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

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

  return output;
}

function seedStaleArtifacts() {
  for (const relativePath of staleArtifacts) {
    const path = resolve(repoRoot, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '// output from a source file that no longer exists\n');
  }
}

function removeStaleArtifacts() {
  for (const relativePath of staleArtifacts) {
    rmSync(resolve(repoRoot, relativePath), { force: true });
  }
  rmSync(resolve(repoRoot, 'dist/orphaned-package-fixture'), {
    recursive: true,
    force: true,
  });
}

function assertStaleArtifactsRemoved(label) {
  const surviving = staleArtifacts.filter((relativePath) =>
    existsSync(resolve(repoRoot, relativePath)),
  );
  if (surviving.length > 0) {
    fail(`${label} retained stale files: ${surviving.join(', ')}`);
  }
}

function assertCurrentBuild(label) {
  for (const relativePath of [
    'dist/index.js',
    'dist/index.d.ts',
    'dist/app/tmux-play/cli.js',
  ]) {
    if (!existsSync(resolve(repoRoot, relativePath))) {
      fail(`${label} did not emit ${relativePath}`);
    }
  }
}

function parsePackResult(output) {
  const start = output.search(/\[\s*\{/);
  const end = output.lastIndexOf(']');
  if (start < 0 || end < start) {
    fail(`npm pack did not return JSON metadata:\n${output.trim()}`);
  }

  let result;
  try {
    result = JSON.parse(output.slice(start, end + 1));
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

try {
  const manifest = JSON.parse(
    readFileSync(resolve(repoRoot, 'package.json'), 'utf8'),
  );
  if (manifest.engines?.node !== '>=18.3.0') {
    fail('package.json must declare engines.node as >=18.3.0');
  }

  const readme = readFileSync(resolve(repoRoot, 'README.md'), 'utf8');
  if (!readme.includes('TypeScript 5.4 or newer')) {
    fail('README.md must document the TypeScript 5.4 declaration floor');
  }

  seedStaleArtifacts();
  run(npm, ['run', 'build']);
  assertStaleArtifactsRemoved('npm run build');
  assertCurrentBuild('npm run build');

  seedStaleArtifacts();
  const help = run(process.execPath, [
    resolve(repoRoot, 'bin/tmux-play-dev.mjs'),
    '--help',
  ]);
  assertStaleArtifactsRemoved('tmux-play-dev --help');
  assertCurrentBuild('tmux-play-dev --help');
  if (!help.includes('Usage:\n  tmux-play')) {
    fail('tmux-play-dev --help did not print launcher help');
  }

  const packDirectory = join(verificationDirectory, 'pack');
  mkdirSync(packDirectory, { recursive: true });
  try {
    seedStaleArtifacts();
    const packed = parsePackResult(
      run(npm, ['pack', '--json', '--pack-destination', packDirectory]),
    );
    assertStaleArtifactsRemoved('npm pack');
    assertCurrentBuild('npm pack');

    if (!packed || typeof packed.filename !== 'string') {
      fail('npm pack metadata did not include a tarball filename');
    }
    if (!existsSync(join(packDirectory, packed.filename))) {
      fail(`npm pack did not create ${packed.filename}`);
    }

    const packedPaths = new Set(
      Array.isArray(packed.files)
        ? packed.files.map((file) => file?.path).filter(Boolean)
        : [],
    );
    for (const relativePath of staleArtifacts) {
      if (packedPaths.has(relativePath)) {
        fail(`tarball retained stale file ${relativePath}`);
      }
    }
    for (const relativePath of [
      'package.json',
      'bin/tmux-play.mjs',
      'dist/index.js',
      'dist/index.d.ts',
    ]) {
      if (!packedPaths.has(relativePath)) {
        fail(`tarball omitted current file ${relativePath}`);
      }
    }
  } finally {
    rmSync(packDirectory, { recursive: true, force: true });
  }
} finally {
  removeStaleArtifacts();
  rmSync(verificationDirectory, { recursive: true, force: true });
}

process.stdout.write('Package output paths are clean and current.\n');
