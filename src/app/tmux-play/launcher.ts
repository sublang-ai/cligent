// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Writable } from 'node:stream';
import { prepareLogDirectory, logFilePath } from '../shared/logs.js';
import { shellQuote } from '../shared/shell.js';
import { GLOW_INSTALL_URL, isGlowAvailable } from '../shared/glow.js';
import {
  attachTmuxSession,
  isTmuxAvailable,
  runTmux,
} from '../shared/tmux.js';
import { captainPaneTitle, rolePaneTitle } from './pane-title.js';
import { roleAccent, SPEAKER_CAPTAIN } from './role-colors.js';
import {
  TMUX_PANE_TIMER_ACCENT_OPTION,
  TMUX_PANE_TIMER_RUNNING_OPTION,
  TMUX_PANE_TIMER_TEXT_OPTION,
  TMUX_STATUS_TIMER_RUNNING_OPTION,
  TMUX_STATUS_TIMER_TEXT_OPTION,
} from './timer-options.js';
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
const NAVIGATION_HINTS =
  'Quit: Ctrl+C | Ctrl+b, then: d=detach | o=switch pane | [=scroll (q exits)';
const INITIAL_TIMER_TEXT = '0s';
const INITIAL_TIMER_RUNNING = '0';

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
  // TMUX-051: glow is the Markdown renderer the presenter delegates wrapping
  // and styling to. Gate launch on its availability before any other work so
  // a missing binary surfaces as an install pointer rather than a runtime
  // render failure deep inside session mode.
  if (!isGlowAvailable()) {
    throw new Error(`glow is not installed — see ${GLOW_INSTALL_URL}`);
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
  setPaneTitles(
    options.sessionName,
    rolePanes,
    options.loaded.config.captain.adapter,
  );
  setTimerOptions(options.sessionName, rolePanes);
  disableRolePaneInput(options.sessionName, rolePanes);
  configureLayoutHooks(options.sessionName, roles.length);
  applyCatppuccinMochaTheme(options.sessionName);
  runTmux(
    'set-window-option',
    '-t',
    windowTarget(options.sessionName),
    'pane-border-status',
    'top',
  );
  runTmux(
    'set-window-option',
    '-t',
    windowTarget(options.sessionName),
    'pane-border-format',
    paneBorderFormat(),
  );
  runTmux(
    'set',
    '-t',
    options.sessionName,
    'status-left',
    statusLeftFormat(),
  );
  runTmux('set', '-t', options.sessionName, 'status-left-length', '96');
  runTmux(
    'set',
    '-t',
    options.sessionName,
    'status-right',
    statusRightFormat(),
  );
  runTmux('set', '-t', options.sessionName, 'status-right-length', '32');
  selectBossPane(options.sessionName);
}

// Catppuccin Mocha palette: https://catppuccin.com/palette/
// Only the colors we actually wire up are listed.
const CATPPUCCIN_MOCHA = {
  base: '#1e1e2e',
  mantle: '#181825',
  overlay0: '#6c7086',
  overlay1: '#7f849c',
  subtext0: '#a6adc8',
  text: '#cdd6f4',
  blue: '#89b4fa',
  mauve: '#cba6f7',
  peach: '#fab387',
  green: '#a6e3a1',
} as const;

// TMUX-047: claim the visual options we color from Catppuccin Mocha.
// pane-border-format, status-left/right, and the 4:6:6 layout are NOT touched here —
// they remain owned by their existing clauses, so the order in buildTmuxSession
// (theme first, content second) keeps our format strings authoritative.
function applyCatppuccinMochaTheme(sessionName: string): void {
  const c = CATPPUCCIN_MOCHA;
  // 24-bit color enablement so the hex values below actually render. tmux
  // applies terminal-overrides at client attach, and the launcher attaches
  // strictly after this function runs, so the override negotiates correctly.
  runTmux('set', '-t', sessionName, 'default-terminal', 'tmux-256color');
  runTmux('set', '-as', 'terminal-overrides', ',*:RGB');
  runTmux('set', '-t', sessionName, 'status-style', `fg=${c.text},bg=${c.mantle}`);
  runTmux(
    'set',
    '-t',
    sessionName,
    'window-status-style',
    `fg=${c.subtext0},bg=${c.mantle}`,
  );
  runTmux(
    'set',
    '-t',
    sessionName,
    'window-status-current-style',
    `fg=${c.mauve},bg=${c.mantle}`,
  );
  // TMUX-048: dim inactive borders to overlay0 (was surface1) so the active
  // blue border stands out more strongly.
  runTmux('set', '-t', sessionName, 'pane-border-style', `fg=${c.overlay0}`);
  runTmux(
    'set',
    '-t',
    sessionName,
    'pane-active-border-style',
    `fg=${c.blue}`,
  );
  runTmux(
    'set',
    '-t',
    sessionName,
    'message-style',
    `fg=${c.base},bg=${c.peach}`,
  );
  runTmux(
    'set',
    '-t',
    sessionName,
    'message-command-style',
    `fg=${c.base},bg=${c.green}`,
  );
  runTmux('set', '-t', sessionName, 'display-panes-colour', c.overlay0);
  runTmux('set', '-t', sessionName, 'display-panes-active-colour', c.mauve);
  runTmux('set', '-t', sessionName, 'clock-mode-colour', c.mauve);
}

function paneBorderFormat(): string {
  const c = CATPPUCCIN_MOCHA;
  return [
    `#{?pane_active,#[fg=${c.base}]#[bg=${c.blue}]#[bold],#[fg=${c.text}]#[bg=${c.mantle}]}`,
    ' #{pane_title} ',
    '#[default]',
    ' ',
    `#{?#{==:#{${TMUX_PANE_TIMER_RUNNING_OPTION}},1},⏳,⌛} `,
    timerColorFormat(
      TMUX_PANE_TIMER_RUNNING_OPTION,
      `#{${TMUX_PANE_TIMER_ACCENT_OPTION}}`,
    ),
    `#{${TMUX_PANE_TIMER_TEXT_OPTION}}`,
    '#[default]',
  ].join('');
}

function statusLeftFormat(): string {
  const c = CATPPUCCIN_MOCHA;
  return `#[fg=${c.blue},bold]tmux-play#[default] #[fg=${c.subtext0}]${NAVIGATION_HINTS}#[default]`;
}

function statusRightFormat(): string {
  return [
    '⏰ ',
    timerColorFormat(TMUX_STATUS_TIMER_RUNNING_OPTION, CATPPUCCIN_MOCHA.mauve),
    `#{${TMUX_STATUS_TIMER_TEXT_OPTION}}`,
    '#[default]',
  ].join('');
}

function timerColorFormat(runningOption: string, runningColor: string): string {
  return `#{?#{==:#{${runningOption}},1},#[fg=${runningColor}],#[fg=${CATPPUCCIN_MOCHA.overlay1}]}`;
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

// TMUX-048: pane titles carry `<role> · <adapter>` so each pane reveals which
// model is in it at a glance, even when the role id is generic (e.g. "Coder").
function setPaneTitles(
  sessionName: string,
  rolePanes: readonly RolePane[],
  captainAdapter: string,
): void {
  runTmux(
    'select-pane',
    '-t',
    paneTarget(sessionName, 0),
    '-T',
    captainPaneTitle(captainAdapter),
  );
  for (const pane of rolePanes) {
    runTmux(
      'select-pane',
      '-t',
      paneTarget(sessionName, pane.paneIndex),
      '-T',
      rolePaneTitle(pane.role.id, pane.role.adapter),
    );
  }
}

function setTimerOptions(
  sessionName: string,
  rolePanes: readonly RolePane[],
): void {
  setPaneTimerOptions(paneTarget(sessionName, 0), SPEAKER_CAPTAIN);
  for (const pane of rolePanes) {
    setPaneTimerOptions(
      paneTarget(sessionName, pane.paneIndex),
      roleAccent(pane.role.adapter),
    );
  }
  runTmux(
    'set-option',
    '-t',
    sessionName,
    TMUX_STATUS_TIMER_TEXT_OPTION,
    INITIAL_TIMER_TEXT,
  );
  runTmux(
    'set-option',
    '-t',
    sessionName,
    TMUX_STATUS_TIMER_RUNNING_OPTION,
    INITIAL_TIMER_RUNNING,
  );
}

function setPaneTimerOptions(pane: string, accent: string): void {
  runTmux(
    'set-option',
    '-p',
    '-t',
    pane,
    TMUX_PANE_TIMER_ACCENT_OPTION,
    accent,
  );
  runTmux(
    'set-option',
    '-p',
    '-t',
    pane,
    TMUX_PANE_TIMER_TEXT_OPTION,
    INITIAL_TIMER_TEXT,
  );
  runTmux(
    'set-option',
    '-p',
    '-t',
    pane,
    TMUX_PANE_TIMER_RUNNING_OPTION,
    INITIAL_TIMER_RUNNING,
  );
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

function selectBossPane(sessionName: string): void {
  runTmux('select-pane', '-t', paneTarget(sessionName, 0));
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

function windowTarget(sessionName: string): string {
  return `${sessionName}:0`;
}
