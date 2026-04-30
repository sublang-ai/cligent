// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeLogStreams,
  logFilePath,
  openAppendLogStreams,
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

  it('opens append log streams without truncating existing logs', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'cligent-logs-'));
    writeFileSync(logFilePath(workDir, 'claude'), 'existing\n');

    const streams = openAppendLogStreams(workDir, ['claude']);
    const stream = streams.get('claude');
    expect(stream).toBeDefined();

    await new Promise<void>((resolve, reject) => {
      stream?.once('error', reject);
      stream?.end('next\n', resolve);
    });

    expect(readFileSync(logFilePath(workDir, 'claude'), 'utf8')).toBe(
      'existing\nnext\n',
    );
  });

  it('passes log stream errors to the named handler', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'cligent-logs-'));
    const errors: Array<{ name: string; message: string }> = [];
    const streams = openAppendLogStreams(
      join(workDir, 'missing'),
      ['claude'],
      (name, error) => {
        errors.push({ name, message: error.message });
      },
    );
    const stream = streams.get('claude');
    expect(stream).toBeDefined();

    await new Promise<void>((resolve) => {
      stream?.once('error', () => resolve());
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]?.name).toBe('claude');
    expect(errors[0]?.message).toContain('ENOENT');
  });

  it('closes every provided log stream', () => {
    const closed: string[] = [];

    closeLogStreams([
      { end: () => closed.push('claude') },
      { end: () => closed.push('codex') },
    ]);

    expect(closed).toEqual(['claude', 'codex']);
  });
});
