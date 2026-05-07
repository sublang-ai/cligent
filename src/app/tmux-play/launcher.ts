// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Writable } from 'node:stream';
import { prepareLogDirectory, logFilePath } from '../shared/logs.js';
import { shellQuote } from '../shared/shell.js';
import {
  attachTmuxSession,
  isTmuxAvailable,
  runTmux,
} from '../shared/tmux.js';
import {
  TMUX_PLAY_CONFIG_FILE,
  loadTmuxPlayConfig,
  writeTmuxPlayConfigSnapshot,
  type LoadedTmuxPlayConfig,
} from './config.js';
import type { RoleConfig } from './roles.js';

export const TMUX_PLAY_SESSION_MARKER = '.tmux-play-session';
const INITIAL_TMUX_COLUMNS = '240';
const INITIAL_TMUX_ROWS = '67';
const ROLE_AREA_SIZE = '75%';
const SECOND_ROLE_COLUMN_SIZE = '50%';

type Output = Pick<Writable, 'write'>;

export interface LaunchTmuxPlayOptions {
  readonly cwd?: string;
  readonly configPath?: string;
  readonly configHome?: string;
  readonly sessionId?: string;
  readonly workDir?: string;
  readonly selfBin?: string;
  readonly stdout?: Output;
  readonly stderr?: Output;
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
    configHome: options.configHome,
    onDefaultConfigCreated: (path) => {
      (options.stdout ?? process.stdout).write(
        `Created tmux-play config at ${path}\n`,
      );
    },
    onLegacyConfigIgnored: (path) => {
      (options.stderr ?? process.stderr).write(
        `Found legacy tmux-play config at ${path}; tmux-play now requires ${TMUX_PLAY_CONFIG_FILE}. Rename or convert it.\n`,
      );
    },
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
    requestTerminalResize(options.stdout ?? process.stdout);
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

  runTmux(
    'new-session',
    '-d',
    '-x',
    INITIAL_TMUX_COLUMNS,
    '-y',
    INITIAL_TMUX_ROWS,
    '-s',
    options.sessionName,
    bossCommand,
  );
  const rolePanes = createRolePanes(options.sessionName, options.workDir, roles);
  setPaneTitles(options.sessionName, rolePanes);
  disableRolePaneInput(options.sessionName, rolePanes);
  configureLayoutHooks(options.sessionName, roles.length);
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
): RolePane[] {
  const firstColumnCount = Math.ceil(roles.length / 2);
  const rolePanes: RolePane[] = [];
  let nextPaneIndex = 1;

  runTmux(
    'split-window',
    '-h',
    '-l',
    ROLE_AREA_SIZE,
    '-t',
    sessionName,
    tailCommand(workDir, roles[0]),
  );
  rolePanes[0] = { role: requireRole(roles[0]), paneIndex: nextPaneIndex++ };

  if (roles.length < 2) {
    return rolePanes;
  }

  runTmux(
    'split-window',
    '-h',
    '-l',
    SECOND_ROLE_COLUMN_SIZE,
    '-t',
    paneTarget(sessionName, rolePanes[0].paneIndex),
    tailCommand(workDir, roles[firstColumnCount]),
  );
  rolePanes[firstColumnCount] = {
    role: requireRole(roles[firstColumnCount]),
    paneIndex: nextPaneIndex++,
  };

  let firstColumnLastPane = rolePanes[0].paneIndex;
  for (let i = 1; i < firstColumnCount; i++) {
    runTmux(
      'split-window',
      '-v',
      '-t',
      paneTarget(sessionName, firstColumnLastPane),
      tailCommand(workDir, roles[i]),
    );
    firstColumnLastPane = nextPaneIndex++;
    rolePanes[i] = {
      role: requireRole(roles[i]),
      paneIndex: firstColumnLastPane,
    };
  }

  let secondColumnLastPane = rolePanes[firstColumnCount].paneIndex;
  for (let i = firstColumnCount + 1; i < roles.length; i++) {
    runTmux(
      'split-window',
      '-v',
      '-t',
      paneTarget(sessionName, secondColumnLastPane),
      tailCommand(workDir, roles[i]),
    );
    secondColumnLastPane = nextPaneIndex++;
    rolePanes[i] = {
      role: requireRole(roles[i]),
      paneIndex: secondColumnLastPane,
    };
  }

  return rolePanes;
}

interface RolePane {
  readonly role: RoleConfig;
  readonly paneIndex: number;
}

function setPaneTitles(sessionName: string, rolePanes: readonly RolePane[]): void {
  runTmux('select-pane', '-t', paneTarget(sessionName, 0), '-T', 'Captain');
  for (const pane of rolePanes) {
    runTmux(
      'select-pane',
      '-t',
      paneTarget(sessionName, pane.paneIndex),
      '-T',
      titleCaseRoleId(pane.role.id),
    );
  }
}

function titleCaseRoleId(roleId: string): string {
  return roleId.charAt(0).toUpperCase() + roleId.slice(1);
}

function disableRolePaneInput(
  sessionName: string,
  rolePanes: readonly RolePane[],
): void {
  for (const pane of rolePanes) {
    runTmux(
      'select-pane',
      '-t',
      paneTarget(sessionName, pane.paneIndex),
      '-d',
    );
  }
}

function requestTerminalResize(stream: Output): void {
  stream.write(`\x1b[8;${INITIAL_TMUX_ROWS};${INITIAL_TMUX_COLUMNS}t`);
}

// TMUX-044: keep the 4/6/6 region split invariant under any window resize.
// resize-pane -x does not accept tmux format expansion, so we compute via
// shell. The -1 corrections give region widths exactly W*4/16 and W*6/16 by
// accounting for the 1-cell tmux border on each non-rightmost pane.
function configureLayoutHooks(
  sessionName: string,
  roleCount: number,
): void {
  const widthCmd =
    `tmux display-message -t ${sessionName} -p '#{window_width}'`;
  const resizeBoss =
    `tmux resize-pane -t ${sessionName}:0.0 -x $((W * 4 / 16 - 1))`;
  const resizeFirstRoleColumn =
    `tmux resize-pane -t ${sessionName}:0.1 -x $((W * 6 / 16 - 1))`;
  const shell =
    roleCount >= 2
      ? `W=$(${widthCmd}) && ${resizeBoss} && ${resizeFirstRoleColumn}`
      : `W=$(${widthCmd}) && ${resizeBoss}`;
  const hookCommand = `run-shell -b "${shell}"`;
  for (const hook of ['client-resized', 'after-resize-window']) {
    runTmux('set-hook', '-t', sessionName, hook, hookCommand);
  }
}

function tailCommand(workDir: string, role: RoleConfig | undefined): string {
  if (!role) {
    throw new Error('tmux-play requires at least one role pane');
  }
  return ['tail', '-f', logFilePath(workDir, role.id)].map(shellQuote).join(' ');
}

function requireRole(role: RoleConfig | undefined): RoleConfig {
  if (!role) {
    throw new Error('tmux-play requires at least one role pane');
  }
  return role;
}

function paneTarget(sessionName: string, paneIndex: number): string {
  return `${sessionName}:0.${paneIndex}`;
}
