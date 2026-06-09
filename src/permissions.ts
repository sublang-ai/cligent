// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const GLOB_CHARS = /[*?[\]{}]/u;
const SHELL_EXPANSION_OR_CONTROL_CHARS = /[$`'"~;&|<>()]/u;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:\//u;

export function normalizeWritablePaths(
  paths: readonly string[] | undefined,
  path = 'permissions.writablePaths',
): string[] {
  if (paths === undefined) {
    return [];
  }

  if (!Array.isArray(paths)) {
    throw new Error(`${path} must be an array`);
  }

  return paths.map((entry, index) =>
    normalizeWritablePath(entry, `${path}[${index}]`),
  );
}

export function normalizeWritablePath(value: unknown, path: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string`);
  }

  let normalized = value.replaceAll('\\', '/');
  if (normalized.length === 0) {
    throw new Error(`${path} must not be empty`);
  }

  if (CONTROL_CHARS.test(normalized)) {
    throw new Error(`${path} must not contain control characters`);
  }

  if (GLOB_CHARS.test(normalized)) {
    throw new Error(`${path} must not contain glob metacharacters`);
  }

  if (SHELL_EXPANSION_OR_CONTROL_CHARS.test(normalized)) {
    throw new Error(
      `${path} must not contain shell expansion or control characters`,
    );
  }

  if (normalized.startsWith('/') || WINDOWS_ABSOLUTE_PATH.test(normalized)) {
    throw new Error(`${path} must be workspace-relative`);
  }

  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  normalized = normalized.replace(/\/+$/u, '');

  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment === '') {
      throw new Error(`${path} must not contain empty path segments`);
    }
    if (segment === '..') {
      throw new Error(`${path} must not contain '..' path segments`);
    }
    if (segment === '.') {
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    throw new Error(`${path} must not resolve to the workspace root`);
  }

  return segments.join('/');
}
