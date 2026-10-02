// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { existsSync } from 'node:fs';

/** spawn cannot execute native files inside ASAR; use the host's unpacked tree. */
export function ownedChildPath(path: string): string {
  if (!process.versions.electron || !/\.asar[\\/]/.test(path)) return path;
  const unpacked = path.replace(/\.asar([\\/])/, '.asar.unpacked$1');
  if (!existsSync(unpacked)) {
    throw new Error(
      'Packaged host runtime is not executable: unpack the owned agent and browser dependency trees outside the ASAR archive',
    );
  }
  return unpacked;
}

/** Environment overlay for owned JavaScript entrypoints, never caller tools. */
export function nodeChildEnvironment(): Record<string, string> {
  // Node ignores this variable; Electron needs it even when the parent
  // inherited an explicit zero. Keep the override local to the owned child.
  return { ELECTRON_RUN_AS_NODE: '1' };
}

/** POSIX shell argument quoting; never interpolate unquoted executable paths. */
export function quoteShellArgument(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
