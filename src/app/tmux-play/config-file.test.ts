// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFIG_MIGRATION_TEMP_MARKER,
  observeConfigFile,
  replaceObservedConfigFile,
} from './config-file.js';

const RETRY_ERROR = /changed.*retry|retry.*changed/i;

describe('tmux-play atomic config replacement', () => {
  let workDir: string | undefined;

  afterEach(() => {
    if (workDir !== undefined) {
      rmSync(workDir, { force: true, recursive: true });
      workDir = undefined;
    }
  });

  it('atomically replaces in the target directory and preserves mode', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-file-'));
    const configPath = join(workDir, 'config.yaml');
    const original = Buffer.from('captain:\n  reasoningEffort: high\n');
    const migrated = 'captain:\n  effort: high\n';
    writeFileSync(configPath, original);
    chmodSync(configPath, 0o640);
    const originalStats = statSync(configPath, { bigint: true });
    const observed = await observeConfigFile(configPath);
    let stagedPath: string | undefined;

    await replaceObservedConfigFile(observed, migrated, {
      beforeFinalCheck: (tempPath) => {
        stagedPath = tempPath;
        expect(dirname(tempPath)).toBe(dirname(observed.resolvedPath));
        expect(readFileSync(tempPath)).toEqual(Buffer.from(migrated));
        expect(readFileSync(configPath)).toEqual(original);
      },
    });

    const migratedStats = statSync(configPath, { bigint: true });
    expect(stagedPath).toBeDefined();
    expect(migratedStats.ino).not.toBe(originalStats.ino);
    expect(migratedStats.mode & 0o7777n).toBe(0o640n);
    expect(readFileSync(configPath)).toEqual(Buffer.from(migrated));
    expect(migrationTemps(workDir)).toEqual([]);
  });

  it('preserves a config symlink while replacing its target', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-file-'));
    const targetDir = join(workDir, 'targets');
    const targetPath = join(targetDir, 'config.yaml');
    const configPath = join(workDir, 'config.yaml');
    const original = Buffer.from('reasoningEffort: xhigh\n');
    const migrated = 'effort: xhigh\n';
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetPath, original);
    chmodSync(targetPath, 0o604);
    symlinkSync(join('targets', 'config.yaml'), configPath);
    const observed = await observeConfigFile(configPath);

    await replaceObservedConfigFile(observed, migrated, {
      beforeFinalCheck: (tempPath) => {
        expect(dirname(tempPath)).toBe(dirname(observed.resolvedPath));
      },
    });

    const targetStats = statSync(targetPath, { bigint: true });
    expect(lstatSync(configPath, { bigint: true }).isSymbolicLink()).toBe(true);
    expect(readlinkSync(configPath)).toBe(join('targets', 'config.yaml'));
    expect(readFileSync(targetPath)).toEqual(Buffer.from(migrated));
    expect(readFileSync(configPath)).toEqual(Buffer.from(migrated));
    expect(targetStats.mode & 0o7777n).toBe(0o604n);
    expect(migrationTemps(targetDir)).toEqual([]);
  });

  it('rejects a source-content change and preserves the newer bytes', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-file-'));
    const configPath = join(workDir, 'config.yaml');
    const original = Buffer.from('effort: low\n');
    const newer = Buffer.from('effort: ultracode\n');
    writeFileSync(configPath, original);
    const observed = await observeConfigFile(configPath);

    await expect(
      replaceObservedConfigFile(observed, 'effort: high\n', {
        beforeFinalCheck: () => writeFileSync(configPath, newer),
      }),
    ).rejects.toThrow(RETRY_ERROR);

    expect(readFileSync(configPath)).toEqual(newer);
    expect(migrationTemps(workDir)).toEqual([]);
  });

  it('rejects an identical-byte inode replacement and preserves it', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-file-'));
    const configPath = join(workDir, 'config.yaml');
    const replacementPath = join(workDir, 'editor-replacement.yaml');
    const source = Buffer.from('effort: high\n');
    writeFileSync(configPath, source);
    chmodSync(configPath, 0o640);
    const originalStats = statSync(configPath, { bigint: true });
    const observed = await observeConfigFile(configPath);
    let replacementInode: bigint | undefined;

    await expect(
      replaceObservedConfigFile(observed, 'effort: xhigh\n', {
        beforeFinalCheck: () => {
          writeFileSync(replacementPath, source);
          chmodSync(replacementPath, 0o640);
          replacementInode = statSync(replacementPath, { bigint: true }).ino;
          renameSync(replacementPath, configPath);
        },
      }),
    ).rejects.toThrow(RETRY_ERROR);

    const currentStats = statSync(configPath, { bigint: true });
    expect(replacementInode).toBeDefined();
    expect(currentStats.ino).toBe(replacementInode);
    expect(currentStats.ino).not.toBe(originalStats.ino);
    expect(readFileSync(configPath)).toEqual(source);
    expect(migrationTemps(workDir)).toEqual([]);
  });

  it('rejects target disappearance without recreating the target', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-file-'));
    const configPath = join(workDir, 'config.yaml');
    writeFileSync(configPath, Buffer.from('effort: medium\n'));
    const observed = await observeConfigFile(configPath);

    await expect(
      replaceObservedConfigFile(observed, 'effort: high\n', {
        beforeFinalCheck: () => unlinkSync(configPath),
      }),
    ).rejects.toThrow(RETRY_ERROR);

    expect(existsSync(configPath)).toBe(false);
    expect(migrationTemps(workDir)).toEqual([]);
  });

  it('rejects symlink retargeting and preserves the newer target', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'tmux-play-config-file-'));
    const originalTarget = join(workDir, 'original.yaml');
    const newerTarget = join(workDir, 'newer.yaml');
    const configPath = join(workDir, 'config.yaml');
    const original = Buffer.from('effort: low\n');
    const newer = Buffer.from('effort: ultra\n');
    writeFileSync(originalTarget, original);
    writeFileSync(newerTarget, newer);
    symlinkSync('original.yaml', configPath);
    const observed = await observeConfigFile(configPath);
    let retargetedInode: bigint | undefined;

    await expect(
      replaceObservedConfigFile(observed, 'effort: high\n', {
        beforeFinalCheck: () => {
          unlinkSync(configPath);
          symlinkSync('newer.yaml', configPath);
          retargetedInode = lstatSync(configPath, { bigint: true }).ino;
        },
      }),
    ).rejects.toThrow(RETRY_ERROR);

    const currentLinkStats = lstatSync(configPath, { bigint: true });
    expect(currentLinkStats.isSymbolicLink()).toBe(true);
    expect(retargetedInode).toBeDefined();
    expect(currentLinkStats.ino).toBe(retargetedInode);
    expect(readlinkSync(configPath)).toBe('newer.yaml');
    expect(readFileSync(configPath)).toEqual(newer);
    expect(readFileSync(originalTarget)).toEqual(original);
    expect(migrationTemps(workDir)).toEqual([]);
  });
});

function migrationTemps(directory: string): string[] {
  return readdirSync(directory).filter((entry) =>
    entry.includes(CONFIG_MIGRATION_TEMP_MARKER),
  );
}
