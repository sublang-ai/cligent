#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiler = resolve(repoRoot, 'node_modules/typescript/bin/tsc');

if (!existsSync(compiler)) {
  process.stderr.write(
    'build: TypeScript compiler not found. Run `npm install` in the cligent repo so devDependencies are present.\n',
  );
  process.exit(1);
}

rmSync(resolve(repoRoot, 'dist'), { recursive: true, force: true });

const result = spawnSync(
  process.execPath,
  [compiler, '-p', resolve(repoRoot, 'tsconfig.json')],
  {
    stdio: 'inherit',
    cwd: repoRoot,
  },
);

if (result.error) {
  process.stderr.write(
    `build: TypeScript could not start: ${result.error.message}\n`,
  );
  process.exit(1);
}

process.exit(result.status ?? 1);
