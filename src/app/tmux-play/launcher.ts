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
import { captainPaneTitle, playerPaneTitle } from './pane-title.js';
import {
  captainAccent,
  playerAccent,
  type CatppuccinFlavor,
} from './player-colors.js';
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
  type CatppuccinFlavorConfig,
  type LoadedTmuxPlayConfig,
} from './config.js';
import type { PlayerConfig } from './players.js';

export const TMUX_PLAY_SESSION_MARKER = '.tmux-play-session';
const INITIAL_TMUX_COLUMNS = '240';
const INITIAL_TMUX_ROWS = '67';
// Even split: every visible column gets 1/N of the initial 240-cell window
// where N is the total column count (2 for a single player, 3 for two or
// more). Right pane after the first horizontal split absorbs everything but
// the Boss/Captain column; the resize hook below preserves the invariant at
// any window width.
const PLAYER_AREA_SIZE_SINGLE = '120'; // 240/2 — boss + 1 player evenly
const PLAYER_AREA_SIZE_MULTI = '160'; // 240×2/3 — boss + right area (two columns)
const SECOND_PLAYER_COLUMN_SIZE = '50%'; // 50% of right area = 80 cells each
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
  /**
   * Catppuccin flavor to apply. When omitted, the YAML config's `theme`
   * field decides (`'mocha' | 'latte' | 'auto'`); when the YAML value is
   * `'auto'` or unset, {@link detectCatppuccinFlavor} resolves via env.
   * An explicit `'mocha'` or `'latte'` passed here overrides the YAML
   * value; an explicit `'auto'` re-triggers env detection regardless of
   * what the YAML says.
   */
  readonly themeFlavor?: CatppuccinFlavor | 'auto';
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
  const playerIds = loaded.config.players.map((player) => player.id);

  prepareLogDirectory(
    workDir,
    playerIds,
    TMUX_PLAY_SESSION_MARKER,
    sessionId,
  );
  const flavor = resolveThemeFlavor(
    options.themeFlavor,
    loaded.config.theme,
  );
  const snapshotPath = await writeTmuxPlayConfigSnapshot(
    loaded,
    workDir,
    flavor,
  );
  buildTmuxSession({
    loaded,
    cwd: options.cwd,
    sessionId,
    sessionName,
    workDir,
    selfBin: options.selfBin ?? process.argv[1],
    palette: paletteFor(flavor),
    themeFlavor: flavor,
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
  readonly palette: CatppuccinPalette;
  readonly themeFlavor: CatppuccinFlavor;
}

function buildTmuxSession(options: BuildTmuxSessionOptions): void {
  const players = options.loaded.config.players;
  const bossCommand = buildSessionCommand(options);
  const c = options.palette;

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
  const playerPanes = createPlayerPanes(options.sessionName, options.workDir, players);
  setPaneTitles(
    options.sessionName,
    playerPanes,
    options.loaded.config.captain.adapter,
  );
  setTimerOptions(options.sessionName, playerPanes, options.themeFlavor);
  disablePlayerPaneInput(options.sessionName, playerPanes);
  configureLayoutHooks(options.sessionName, players.length);
  applyCatppuccinTheme(options.sessionName, c);
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
    paneBorderFormat(c),
  );
  runTmux(
    'set',
    '-t',
    options.sessionName,
    'status-left',
    statusLeftFormat(c),
  );
  runTmux('set', '-t', options.sessionName, 'status-left-length', '96');
  runTmux(
    'set',
    '-t',
    options.sessionName,
    'status-right',
    statusRightFormat(c),
  );
  runTmux('set', '-t', options.sessionName, 'status-right-length', '32');
  runTmux('set', '-t', options.sessionName, 'window-status-format', '');
  runTmux('set', '-t', options.sessionName, 'window-status-current-format', '');
  runTmux('set', '-t', options.sessionName, 'window-status-separator', '');
  selectBossPane(options.sessionName);
}

// Catppuccin palette family: https://catppuccin.com/palette/
// Only the roles we actually wire up are listed; both Mocha (dark) and
// Latte (light) carry the same role keys so the format/theme functions
// below are palette-agnostic.
const CATPPUCCIN_MOCHA = {
  base: '#1e1e2e',
  mantle: '#181825',
  overlay0: '#6c7086',
  overlay1: '#7f849c',
  subtext0: '#a6adc8',
  subtext1: '#bac2de',
  text: '#cdd6f4',
  blue: '#89b4fa',
  mauve: '#cba6f7',
  peach: '#fab387',
  green: '#a6e3a1',
} as const;

const CATPPUCCIN_LATTE = {
  base: '#eff1f5',
  mantle: '#e6e9ef',
  overlay0: '#9ca0b0',
  overlay1: '#8c8fa1',
  subtext0: '#6c6f85',
  subtext1: '#5c5f77',
  text: '#4c4f69',
  blue: '#1e66f5',
  mauve: '#8839ef',
  peach: '#fe640b',
  green: '#40a02b',
} as const;

type CatppuccinPalette = {
  readonly base: string;
  readonly mantle: string;
  readonly overlay0: string;
  readonly overlay1: string;
  readonly subtext0: string;
  readonly subtext1: string;
  readonly text: string;
  readonly blue: string;
  readonly mauve: string;
  readonly peach: string;
  readonly green: string;
};

function paletteFor(flavor: CatppuccinFlavor): CatppuccinPalette {
  return flavor === 'latte' ? CATPPUCCIN_LATTE : CATPPUCCIN_MOCHA;
}

// Pick the Catppuccin flavor that matches the host terminal's background.
// We don't claim `window-style` (per the canonical Catppuccin tmux pattern),
// so the user's terminal background bleeds through to pane content; the
// status bar / pane-border row sit on this flavor's `mantle`, which must
// share the host's polarity for the band to read as a subtle tonal step
// instead of an inverted block.
//
// Detection signals, in priority order:
//   1. COLORFGBG env var: many terminals (rxvt, Konsole, some configs of
//      iTerm2 / kitty) set this to "fg;bg" with bg in the 0-15 ANSI range.
//      bg >= 7 → bright canvas → Latte; bg <= 6 → dark canvas → Mocha.
//   2. TERM_PROGRAM heuristic: macOS Terminal.app's default profile is a
//      white canvas (and it does not set COLORFGBG), so default to Latte
//      there. iTerm.app's default is dark, so default to Mocha.
//   3. Default Mocha.
//
// None of these are perfect — a user with a custom Terminal.app theme on
// dark, or a COLORFGBG that lies, will still get the wrong flavor. The
// `themeVariant` option on launchTmuxPlay (and the YAML loader, once that
// lands) is the user-facing override for those cases.
/**
 * Resolve the Catppuccin flavor to apply. Priority: explicit programmatic
 * override (`launchOption`) → YAML `theme` field (`yamlOption`) → env
 * detection via {@link detectCatppuccinFlavor}. An explicit `'auto'` at any
 * level forwards to env detection; an unset value at one level falls
 * through to the next.
 */
export function resolveThemeFlavor(
  launchOption: CatppuccinFlavor | 'auto' | undefined,
  yamlOption: CatppuccinFlavorConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CatppuccinFlavor {
  if (launchOption === 'mocha' || launchOption === 'latte') {
    return launchOption;
  }
  if (launchOption === 'auto') {
    return detectCatppuccinFlavor(env);
  }
  if (yamlOption === 'mocha' || yamlOption === 'latte') {
    return yamlOption;
  }
  return detectCatppuccinFlavor(env);
}

export function detectCatppuccinFlavor(
  env: NodeJS.ProcessEnv = process.env,
): CatppuccinFlavor {
  const fgbg = env.COLORFGBG;
  if (fgbg) {
    const parts = fgbg.split(';');
    const bg = Number(parts[parts.length - 1]);
    if (Number.isFinite(bg)) {
      return bg >= 7 ? 'latte' : 'mocha';
    }
  }
  if (env.TERM_PROGRAM === 'Apple_Terminal') {
    return 'latte';
  }
  return 'mocha';
}

// TMUX-047: apply the Catppuccin flavor to the session's surface options
// (status bar, pane borders, message popups, accents). We deliberately do
// NOT claim `window-style` / `window-active-style`: the canonical Catppuccin
// tmux plugin leaves the pane content area as the user's terminal-native
// canvas, and switching flavor by host bg is what keeps the theme adaptive
// instead of forcing a dark UI onto a light terminal (or vice versa).
function applyCatppuccinTheme(
  sessionName: string,
  c: CatppuccinPalette,
): void {
  // 24-bit color enablement so the hex values below actually render. tmux
  // applies terminal-overrides at client attach, and the launcher attaches
  // strictly after this function runs, so the override negotiates correctly.
  runTmux('set', '-t', sessionName, 'default-terminal', 'tmux-256color');
  runTmux('set', '-as', 'terminal-overrides', ',*:RGB');
  runTmux(
    'set',
    '-t',
    sessionName,
    'status-style',
    `fg=${c.text},bg=${c.mantle}`,
  );
  // TMUX-048: dim inactive borders to overlay0 so the active blue border
  // stands out more strongly. window-status-style / window-status-current-
  // style are not claimed: the window-list formats below are empty strings,
  // so those style options have nothing to color.
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

function paneBorderFormat(c: CatppuccinPalette): string {
  // TMUX-048: only the Captain pane (index 0) carries the highlighted blue
  // title block, and only while it is the active pane. Player panes — even
  // when active — render on the flavor's mantle surface with no highlight
  // block (they're read-only per TMUX-027 and don't need a focus indicator).
  // The row carries an explicit mantle background end-to-end so it reads as
  // the theme's own surface, tonally distinct from the user's terminal-
  // native pane content above it. Symmetry: one leading space before
  // #{pane_title} mirrored by one trailing space after the timer text
  // before the closing #[default] reset.
  return [
    `#{?#{&&:#{pane_active},#{e|==:#{pane_index},0}},#[fg=${c.base}]#[bg=${c.blue}]#[bold],#[fg=${c.text}]#[bg=${c.mantle}]}`,
    ' #{pane_title} ',
    `#[fg=${c.text}]#[bg=${c.mantle}]#[nobold] `,
    `#{?#{==:#{${TMUX_PANE_TIMER_RUNNING_OPTION}},1},⏳,⌛} `,
    timerColorFormat(
      TMUX_PANE_TIMER_RUNNING_OPTION,
      `#{${TMUX_PANE_TIMER_ACCENT_OPTION}}`,
      c.subtext1,
    ),
    `#{${TMUX_PANE_TIMER_TEXT_OPTION}}`,
    ' #[default]',
  ].join('');
}

function statusLeftFormat(c: CatppuccinPalette): string {
  return `#[fg=${c.blue},bold]tmux-play#[default] #[fg=${c.subtext0}]${NAVIGATION_HINTS}#[default]`;
}

function statusRightFormat(c: CatppuccinPalette): string {
  // TMUX-055: the status-total timer uses the same hourglass pair as the
  // per-pane title timers (TMUX-054) — ⏳ while a Boss turn is open and ⌛
  // between turns — so the bottom-right status timer carries the same
  // flowing-vs-settled cue as the pane titles above it. The duration text
  // still carries the running/frozen Catppuccin color cue.
  return [
    `#{?#{==:#{${TMUX_STATUS_TIMER_RUNNING_OPTION}},1},⏳,⌛} `,
    timerColorFormat(TMUX_STATUS_TIMER_RUNNING_OPTION, c.mauve, c.overlay1),
    `#{${TMUX_STATUS_TIMER_TEXT_OPTION}}`,
    '#[default]',
  ].join('');
}

function timerColorFormat(
  runningOption: string,
  runningColor: string,
  frozenColor: string,
): string {
  return `#{?#{==:#{${runningOption}},1},#[fg=${runningColor}],#[fg=${frozenColor}]}`;
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

function createPlayerPanes(
  sessionName: string,
  workDir: string,
  players: readonly PlayerConfig[],
): PlayerPane[] {
  const firstColumnCount = Math.ceil(players.length / 2);
  const playerPanes: PlayerPane[] = [];
  let nextPaneIndex = 1;

  runTmux(
    'split-window',
    '-h',
    '-l',
    players.length >= 2 ? PLAYER_AREA_SIZE_MULTI : PLAYER_AREA_SIZE_SINGLE,
    '-t',
    sessionName,
    tailCommand(workDir, players[0]),
  );
  playerPanes[0] = { player: requirePlayer(players[0]), paneIndex: nextPaneIndex++ };

  if (players.length < 2) {
    return playerPanes;
  }

  runTmux(
    'split-window',
    '-h',
    '-l',
    SECOND_PLAYER_COLUMN_SIZE,
    '-t',
    paneTarget(sessionName, playerPanes[0].paneIndex),
    tailCommand(workDir, players[firstColumnCount]),
  );
  playerPanes[firstColumnCount] = {
    player: requirePlayer(players[firstColumnCount]),
    paneIndex: nextPaneIndex++,
  };

  let firstColumnLastPane = playerPanes[0].paneIndex;
  for (let i = 1; i < firstColumnCount; i++) {
    runTmux(
      'split-window',
      '-v',
      '-t',
      paneTarget(sessionName, firstColumnLastPane),
      tailCommand(workDir, players[i]),
    );
    firstColumnLastPane = nextPaneIndex++;
    playerPanes[i] = {
      player: requirePlayer(players[i]),
      paneIndex: firstColumnLastPane,
    };
  }

  let secondColumnLastPane = playerPanes[firstColumnCount].paneIndex;
  for (let i = firstColumnCount + 1; i < players.length; i++) {
    runTmux(
      'split-window',
      '-v',
      '-t',
      paneTarget(sessionName, secondColumnLastPane),
      tailCommand(workDir, players[i]),
    );
    secondColumnLastPane = nextPaneIndex++;
    playerPanes[i] = {
      player: requirePlayer(players[i]),
      paneIndex: secondColumnLastPane,
    };
  }

  return playerPanes;
}

interface PlayerPane {
  readonly player: PlayerConfig;
  readonly paneIndex: number;
}

// TMUX-048: pane titles carry `<player> · <adapter>` so each pane reveals which
// model is in it at a glance, even when the player id is generic (e.g. "Coder").
function setPaneTitles(
  sessionName: string,
  playerPanes: readonly PlayerPane[],
  captainAdapter: string,
): void {
  runTmux(
    'select-pane',
    '-t',
    paneTarget(sessionName, 0),
    '-T',
    captainPaneTitle(captainAdapter),
  );
  for (const pane of playerPanes) {
    runTmux(
      'select-pane',
      '-t',
      paneTarget(sessionName, pane.paneIndex),
      '-T',
      playerPaneTitle(pane.player.id, pane.player.adapter),
    );
  }
}

function setTimerOptions(
  sessionName: string,
  playerPanes: readonly PlayerPane[],
  flavor: CatppuccinFlavor,
): void {
  setPaneTimerOptions(paneTarget(sessionName, 0), captainAccent(flavor));
  for (const pane of playerPanes) {
    setPaneTimerOptions(
      paneTarget(sessionName, pane.paneIndex),
      playerAccent(pane.player.adapter, flavor),
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

function disablePlayerPaneInput(
  sessionName: string,
  playerPanes: readonly PlayerPane[],
): void {
  for (const pane of playerPanes) {
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

// TMUX-044: keep the even region split invariant under any window resize.
// Each visible column gets 1/N of the window where N is the total column
// count (2 for a single player, 3 for two or more). resize-pane -x does not
// accept tmux format expansion, so we compute via shell. The -1 corrections
// give region widths exactly W/N by accounting for the 1-cell tmux border on
// each non-rightmost pane.
function configureLayoutHooks(
  sessionName: string,
  playerCount: number,
): void {
  const widthCmd =
    `tmux display-message -t ${sessionName} -p '#{window_width}'`;
  const bossDivisor = playerCount >= 2 ? 3 : 2;
  const resizeBoss =
    `tmux resize-pane -t ${sessionName}:0.0 -x $((W / ${bossDivisor} - 1))`;
  const resizeFirstPlayerColumn =
    `tmux resize-pane -t ${sessionName}:0.1 -x $((W / 3 - 1))`;
  const shell =
    playerCount >= 2
      ? `W=$(${widthCmd}) && ${resizeBoss} && ${resizeFirstPlayerColumn}`
      : `W=$(${widthCmd}) && ${resizeBoss}`;
  const hookCommand = `run-shell -b "${shell}"`;
  for (const hook of ['client-resized', 'after-resize-window']) {
    runTmux('set-hook', '-t', sessionName, hook, hookCommand);
  }
}

function tailCommand(workDir: string, player: PlayerConfig | undefined): string {
  if (!player) {
    throw new Error('tmux-play requires at least one player pane');
  }
  return ['tail', '-f', logFilePath(workDir, player.id)].map(shellQuote).join(' ');
}

function requirePlayer(player: PlayerConfig | undefined): PlayerConfig {
  if (!player) {
    throw new Error('tmux-play requires at least one player pane');
  }
  return player;
}

function paneTarget(sessionName: string, paneIndex: number): string {
  return `${sessionName}:0.${paneIndex}`;
}

function windowTarget(sessionName: string): string {
  return `${sessionName}:0`;
}
