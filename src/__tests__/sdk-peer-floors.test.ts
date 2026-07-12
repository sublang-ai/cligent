// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

interface PackagePeerData {
  peerDependencies?: Record<string, string>;
  packages?: Record<
    string,
    { peerDependencies?: Record<string, string> }
  >;
}

function readJson(path: URL): PackagePeerData {
  return JSON.parse(readFileSync(path, 'utf8')) as PackagePeerData;
}

describe('minimum SDK peer floors', () => {
  it('pins the first Claude SDK declaration with settings.ultracode', () => {
    const manifest = readJson(new URL('../../package.json', import.meta.url));
    const lock = readJson(new URL('../../package-lock.json', import.meta.url));
    const expected = '>=0.3.154';

    expect(
      manifest.peerDependencies?.['@anthropic-ai/claude-agent-sdk'],
    ).toBe(expected);
    expect(
      lock.packages?.['']?.peerDependencies?.[
        '@anthropic-ai/claude-agent-sdk'
      ],
    ).toBe(expected);
  });
});
