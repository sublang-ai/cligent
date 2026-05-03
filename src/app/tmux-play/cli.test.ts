// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCliEntry, runTmuxPlayCli } from './cli.js';

class MemoryOutput {
  chunks: string[] = [];

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }

  text(): string {
    return this.chunks.join('');
  }
}

describe('runTmuxPlayCli', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('dispatches launcher mode with config and cwd', async () => {
    const launch = vi.fn(async () => undefined);

    const code = await runTmuxPlayCli({
      argv: ['--config', 'tmux-play.config.yaml', '--cwd', '/repo'],
      launch,
      selfBin: '/dist/app/tmux-play/cli.js',
    });

    expect(code).toBe(0);
    expect(launch).toHaveBeenCalledWith({
      configPath: 'tmux-play.config.yaml',
      cwd: '/repo',
      selfBin: '/dist/app/tmux-play/cli.js',
    });
  });

  it('dispatches session mode with a validated work dir', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-cli-'));
    const runSession = vi.fn(async () => undefined);

    const code = await runTmuxPlayCli({
      argv: ['--session', 'abc123', '--work-dir', tempDir, '--cwd', '/repo'],
      runSession,
    });

    expect(code).toBe(0);
    expect(runSession).toHaveBeenCalledWith({
      sessionId: 'abc123',
      workDir: tempDir,
      cwd: '/repo',
    });
  });

  it('rejects missing session work dir before dispatch', async () => {
    const stderr = new MemoryOutput();
    const runSession = vi.fn(async () => undefined);

    const code = await runTmuxPlayCli({
      argv: ['--session', 'abc123'],
      runSession,
      stderr,
    });

    expect(code).toBe(1);
    expect(runSession).not.toHaveBeenCalled();
    expect(stderr.text()).toContain(
      'Error: --work-dir is required in session mode',
    );
  });

  it('rejects launcher-only flags in session mode', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-cli-'));
    const stderr = new MemoryOutput();
    const runSession = vi.fn(async () => undefined);

    const code = await runTmuxPlayCli({
      argv: [
        '--session',
        'abc123',
        '--work-dir',
        tempDir,
        '--config',
        'tmux-play.config.yaml',
      ],
      runSession,
      stderr,
    });

    expect(code).toBe(1);
    expect(runSession).not.toHaveBeenCalled();
    expect(stderr.text()).toContain(
      'Error: --config is only valid in launcher mode',
    );
  });

  it('prints usage for help', async () => {
    const stdout = new MemoryOutput();

    const code = await runTmuxPlayCli({
      argv: ['--help'],
      stdout,
    });

    expect(code).toBe(0);
    expect(stdout.text()).toContain('tmux-play [--config <path>]');
  });

  it('detects symlinked bin invocations as CLI entries', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-cli-'));
    const realCli = join(tempDir, 'real-cli.js');
    const binDir = join(tempDir, 'bin');
    const symlinkedCli = join(binDir, 'tmux-play');
    writeFileSync(realCli, '');
    mkdirSync(binDir);
    symlinkSync(realCli, symlinkedCli);

    expect(isCliEntry(symlinkedCli, pathToFileURL(realCli).href)).toBe(true);
    expect(isCliEntry(realCli, pathToFileURL(symlinkedCli).href)).toBe(true);
  });
});
