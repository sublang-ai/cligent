// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { prepareLogDirectory, logFilePath } from '../shared/logs.js';
import { shellQuote } from '../shared/shell.js';
import {
  attachTmuxSession,
  isTmuxAvailable,
  runTmux,
} from '../shared/tmux.js';
import {
  loadTmuxPlayConfig,
  writeTmuxPlayConfigSnapshot,
  type LoadedTmuxPlayConfig,
} from './config.js';
import type { RoleConfig } from './roles.js';

export const TMUX_PLAY_SESSION_MARKER = '.tmux-play-session';

export interface LaunchTmuxPlayOptions {
  readonly cwd?: string;
  readonly configPath?: string;
  readonly sessionId?: string;
  readonly workDir?: string;
  readonly selfBin?: string;
  readonly attach?: boolean;
}

export interface LaunchTmuxPlayResult {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly workDir: string;
  readonly snapshotPath: string;
}

export async function launchTmuxPlay(
  options: LaunchTmuxPlayOptions = {},
): Promise<LaunchTmuxPlayResult> {
  if (!isTmuxAvailable()) {
    throw new Error(
      'tmux is not installed — see https://github.com/tmux/tmux#installation',
    );
  }

  const loaded = await loadTmuxPlayConfig({
    cwd: options.cwd,
    configPath: options.configPath,
  });
  const sessionId = options.sessionId ?? randomBytes(4).toString('hex');
  const sessionName = `tmux-play-${sessionId}`;
  const workDir = options.workDir ?? mkdtempSync(join(tmpdir(), 'tmux-play-'));
  const roleIds = loaded.config.roles.map((role) => role.id);

  prepareLogDirectory(
    workDir,
    roleIds,
    TMUX_PLAY_SESSION_MARKER,
    sessionId,
  );
  const snapshotPath = await writeTmuxPlayConfigSnapshot(loaded, workDir);

  buildTmuxSession({
    loaded,
    cwd: options.cwd,
    sessionId,
    sessionName,
    workDir,
    selfBin: options.selfBin ?? process.argv[1],
  });

  if (options.attach !== false) {
    attachTmuxSession(sessionName);
  }

  return { sessionId, sessionName, workDir, snapshotPath };
}

interface BuildTmuxSessionOptions {
  readonly loaded: LoadedTmuxPlayConfig;
  readonly cwd?: string;
  readonly sessionId: string;
  readonly sessionName: string;
  readonly workDir: string;
  readonly selfBin: string;
}

function buildTmuxSession(options: BuildTmuxSessionOptions): void {
  const roles = options.loaded.config.roles;
  const bossCommand = buildSessionCommand(options);

  runTmux('new-session', '-d', '-s', options.sessionName, bossCommand);
  createRolePanes(options.sessionName, options.workDir, roles);
  setPaneTitles(options.sessionName, roles);
  runTmux('set', '-t', options.sessionName, 'pane-border-status', 'top');
  runTmux(
    'set',
    '-t',
    options.sessionName,
    'pane-border-format',
    '#{?pane_active,#[reverse],}#{pane_title}#[default]',
  );
}

function buildSessionCommand(options: BuildTmuxSessionOptions): string {
  const args = [
    process.execPath,
    options.selfBin,
    '--session',
    options.sessionId,
    '--work-dir',
    options.workDir,
  ];

  if (options.cwd) {
    args.push('--cwd', options.cwd);
  }

  return args.map(shellQuote).join(' ');
}

function createRolePanes(
  sessionName: string,
  workDir: string,
  roles: readonly RoleConfig[],
): void {
  const firstColumnCount = Math.ceil(roles.length / 2);
  runTmux(
    'split-window',
    '-h',
    '-p',
    '40',
    '-t',
    sessionName,
    tailCommand(workDir, roles[0]),
  );

  for (let i = 1; i < firstColumnCount; i++) {
    runTmux(
      'split-window',
      '-v',
      '-t',
      paneTarget(sessionName, i),
      tailCommand(workDir, roles[i]),
    );
  }

  for (let i = firstColumnCount; i < roles.length; i++) {
    const firstColumnIndex = 1 + i - firstColumnCount;
    runTmux(
      'split-window',
      '-h',
      '-t',
      paneTarget(sessionName, firstColumnIndex),
      tailCommand(workDir, roles[i]),
    );
  }
}

function setPaneTitles(
  sessionName: string,
  roles: readonly RoleConfig[],
): void {
  runTmux('select-pane', '-t', paneTarget(sessionName, 0), '-T', 'Boss/Captain');
  for (let i = 0; i < roles.length; i++) {
    runTmux(
      'select-pane',
      '-t',
      paneTarget(sessionName, i + 1),
      '-T',
      `Role: ${roles[i]?.id}`,
    );
  }
}

function tailCommand(workDir: string, role: RoleConfig | undefined): string {
  if (!role) {
    throw new Error('tmux-play requires at least one role pane');
  }
  return ['tail', '-f', logFilePath(workDir, role.id)].map(shellQuote).join(' ');
}

function paneTarget(sessionName: string, paneIndex: number): string {
  return `${sessionName}:0.${paneIndex}`;
}
