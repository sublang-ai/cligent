// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import {
  mapWritablePathsPermission,
  normalizeWritablePaths,
} from '../permissions.js';

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

  it('maps non-empty writable paths to a test-observable enforcement payload', () => {
    expect(
      mapWritablePathsPermission(
        { writablePaths: ['./.git/', 'generated/./cache//'] },
        'profile',
      ),
    ).toEqual({
      paths: ['.git', 'generated/cache'],
      enforcement: 'profile',
    });
  });

  it('omits the enforcement payload when writablePaths is absent or empty', () => {
    expect(mapWritablePathsPermission(undefined, 'ambient')).toBeUndefined();
    expect(
      mapWritablePathsPermission({ writablePaths: [] }, 'ambient'),
    ).toBeUndefined();
  });

  it('rejects invalid writable paths while building the enforcement payload', () => {
    expect(() =>
      mapWritablePathsPermission({ writablePaths: ['../cache'] }, 'ambient'),
    ).toThrow("permissions.writablePaths[0] must not contain '..'");
  });
});
