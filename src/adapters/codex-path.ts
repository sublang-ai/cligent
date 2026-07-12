// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

function isWindowsDriveAbsolutePath(path: string): boolean {
  return (
    path.length >= 3 &&
    /[A-Za-z]/.test(path[0]!) &&
    path[1] === ':' &&
    (path[2] === '\\' || path[2] === '/')
  );
}

// Mirrors Codex 0.144.1's normalize_windows_device_path() so a project trust
// key uses the same identity as Codex before its active-project lookup.
export function normalizeCodexWindowsDevicePath(path: string): string {
  for (const prefix of ['\\\\?\\UNC\\', '\\\\.\\UNC\\']) {
    if (path.startsWith(prefix)) return `\\\\${path.slice(prefix.length)}`;
  }

  for (const prefix of ['\\\\?\\', '\\\\.\\']) {
    if (path.startsWith(prefix)) {
      const candidate = path.slice(prefix.length);
      if (isWindowsDriveAbsolutePath(candidate)) return candidate;
    }
  }

  return path;
}

export function trimCodexRustWhitespace(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
}
