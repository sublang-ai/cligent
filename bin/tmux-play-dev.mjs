#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Dev counterpart to the published `tmux-play` bin: rebuilds `dist/` from
// `src/` on each launch, then dispatches to the same CLI entry point.
// `tmux-play` uses the last-built `dist/`; `tmux-play-dev` keeps `dist/` in
// sync with `src/` so edits land in the next invocation without a manual
// `npm run build`. Both bins share the same config discovery
// (`~/.config/tmux-play/config.yaml`) because they share the same CLI code.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const buildScript = resolve(repoRoot, 'scripts/build.mjs');
const cli = resolve(repoRoot, 'dist/app/tmux-play/cli.js');

// The launcher re-invokes this script for the in-tmux session subprocess via
// `--session`. Skip the rebuild on that inner call — the outer launcher call
// already produced fresh `dist/`, and rebuilding inside the boss pane would
// stall session startup and risk overlapping writes.
const isSessionMode = process.argv.slice(2).includes('--session');

if (!isSessionMode) {
  const build = spawnSync(process.execPath, [buildScript], {
    stdio: 'inherit',
    cwd: repoRoot,
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

if (!existsSync(cli)) {
  process.stderr.write(
    `tmux-play-dev: ${cli} not found. Build the package (\`npm run build\`) or rerun with devDependencies installed.\n`,
  );
  process.exit(1);
}

const { runTmuxPlayCli } = await import(pathToFileURL(cli).href);
process.exitCode = await runTmuxPlayCli();
