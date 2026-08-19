// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  AGENT_RUNTIME_TARGETS,
  compareVersions,
} from '../runtime-targets.js';

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
    // package-9's two halves: `settings.ultracode` needs 0.3.154, and the
    // current model catalog needs more. Assert the surface minimum as a
    // lower bound so a model-driven raise passes while a drop below the
    // surface the adapter compiles against still fails.
    const surfaceMinimum = '0.3.154';
    const declared = AGENT_RUNTIME_TARGETS.claude[0]!.supportedFrom;
    expect(compareVersions(declared, surfaceMinimum)).toBeGreaterThanOrEqual(0);
    const expected = `>=${declared}`;

    expect(
      manifest.peerDependencies?.['@anthropic-ai/claude-agent-sdk'],
    ).toBe(expected);
    expect(
      lock.packages?.['']?.peerDependencies?.[
        '@anthropic-ai/claude-agent-sdk'
      ],
    ).toBe(expected);
  });

  it('keeps the Codex floor at or above the constructor config transport', () => {
    const manifest = readJson(new URL('../../package.json', import.meta.url));
    const lock = readJson(new URL('../../package-lock.json', import.meta.url));
    // package-9 has two halves and the floor satisfies both: the adapter's own
    // surface needs 0.138.0 (constructor config transport), and the current
    // model family needs more. Assert the surface minimum as a lower bound
    // rather than an equality, so a model-driven raise is not a failure while
    // dropping below the surface the adapter compiles against still is.
    const surfaceMinimum = '0.138.0';
    const declared = AGENT_RUNTIME_TARGETS.codex[0]!.supportedFrom;
    expect(compareVersions(declared, surfaceMinimum)).toBeGreaterThanOrEqual(0);

    const expected = `>=${declared}`;
    expect(manifest.peerDependencies?.['@openai/codex-sdk']).toBe(expected);
    expect(
      lock.packages?.['']?.peerDependencies?.['@openai/codex-sdk'],
    ).toBe(expected);
  });
});
