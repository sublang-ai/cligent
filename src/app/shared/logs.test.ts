// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  logFilePath,
  prepareLogDirectory,
  writeBossPrompt,
} from './logs.js';

describe('shared log helpers', () => {
  let workDir: string | undefined;

  afterEach(() => {
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
      workDir = undefined;
    }
  });

  it('prepares log files and marker file', () => {
    workDir = mkdtempSync(join(tmpdir(), 'cligent-logs-'));
    prepareLogDirectory(workDir, ['claude', 'codex'], '.fanout-session', 'abc123');

    expect(readFileSync(logFilePath(workDir, 'claude'), 'utf8')).toBe('');
    expect(readFileSync(logFilePath(workDir, 'codex'), 'utf8')).toBe('');
    expect(readFileSync(join(workDir, '.fanout-session'), 'utf8')).toBe('abc123');
  });

  it('writes boss prompts to all streams', () => {
    const writes: string[] = [];
    const streams = [
      { write: (value: string) => writes.push(`a:${value}`) },
      { write: (value: string) => writes.push(`b:${value}`) },
    ];

    writeBossPrompt(streams, 'hello');

    expect(writes).toEqual(['a:boss> hello\n\n', 'b:boss> hello\n\n']);
  });
});
