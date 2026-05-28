#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Published entry point for `tmux-play`. Imports the compiled CLI from
// `dist/` and dispatches. Holds the +x mode bit in version control so the
// bin works without a build-time chmod on `dist/` contents.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '..', 'dist/app/tmux-play/cli.js');

if (!existsSync(cli)) {
  process.stderr.write(
    `tmux-play: ${cli} not found. The package may be incomplete; reinstall \`@sublang/cligent\`.\n`,
  );
  process.exit(1);
}

const { runTmuxPlayCli } = await import(pathToFileURL(cli).href);
process.exitCode = await runTmuxPlayCli();
