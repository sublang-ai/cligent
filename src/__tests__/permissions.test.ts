// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { normalizeWritablePaths } from '../permissions.js';

describe('writable path permissions', () => {
  it('canonicalizes workspace-relative writable paths', () => {
    expect(
      normalizeWritablePaths([
        './.git/',
        '.git/objects',
        'generated/./cache//',
        'dist\\assets',
      ]),
    ).toEqual(['.git', '.git/objects', 'generated/cache', 'dist/assets']);
  });

  it('rejects root-equivalent writable paths', () => {
    for (const value of ['', '.', './', '././']) {
      expect(() => normalizeWritablePaths([value])).toThrow(
        'permissions.writablePaths[0] must not',
      );
    }
  });

  it('rejects paths outside the workspace', () => {
    for (const value of [
      '/tmp/cache',
      'C:\\tmp\\cache',
      '../cache',
      'a/../b',
    ]) {
      expect(() => normalizeWritablePaths([value])).toThrow();
    }
  });

  it('rejects glob, shell-expansion, control, and empty-segment syntax', () => {
    for (const value of [
      '.git/**',
      'generated/{cache,tmp}',
      '$HOME/cache',
      '~/cache',
      'cache;rm',
      'foo//bar',
      'foo\nbar',
    ]) {
      expect(() => normalizeWritablePaths([value])).toThrow();
    }
  });
});
