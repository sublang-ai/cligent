// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const available = isExecutableAvailable();
const acceptanceIt = available || process.env.CI ? it : it.skip;

describe('OpenCode CLI contract (TADAPT-028)', () => {
  acceptanceIt('exposes the managed-server target used by the adapter', () => {
    const version = commandOutput(['--version']);
    const help = commandOutput(['serve', '--help']);
    if (!version || !help) {
      throw new Error('Missing OpenCode CLI required by acceptance CI');
    }

    expect(version.trim()).toBe('1.17.18');
    expect(help).toContain('--hostname');
    expect(help).toContain('--port');
  });
});

function commandOutput(args: readonly string[]): string | undefined {
  const result = spawnSync('opencode', [...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `opencode ${args.join(' ')} exited ${String(result.status)}: ` +
        `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function isExecutableAvailable(): boolean {
  const result = spawnSync('opencode', ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return (result.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT';
}
