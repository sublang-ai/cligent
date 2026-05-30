// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { closeSync, mkdtempSync, openSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Writable } from 'node:stream';
import { ReadStream } from 'node:tty';
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
  'Quit: Ctrl+C | Ctrl+b, then: d=detach | o=switch pane | [=scroll (q exits) | drag=select | right-click=copy';
const SYSTEM_CLIPBOARD_COPY_COMMAND =
  'if command -v pbcopy >/dev/null 2>&1; then exec pbcopy; ' +
  'elif [ -n "$WAYLAND_DISPLAY" ] && command -v wl-copy >/dev/null 2>&1; then exec wl-copy; ' +
  'elif [ -n "$DISPLAY" ] && command -v xclip >/dev/null 2>&1; then exec xclip -selection clipboard -in; ' +
  'elif [ -n "$DISPLAY" ] && command -v xsel >/dev/null 2>&1; then exec xsel --clipboard --input; ' +
  'elif command -v clip.exe >/dev/null 2>&1; then exec clip.exe; ' +
  'else exec tmux load-buffer -w -; fi';
const INITIAL_TIMER_TEXT = '0s';
const INITIAL_TIMER_RUNNING = '0';
const OSC11_QUERY = '\x1b]11;?\x07';
const OSC11_TIMEOUT_MS = 100;

type Output = Pick<Writable, 'write'>;

export type ThemeResolutionReason = 'explicit' | 'yaml' | 'osc11' | 'fallback';

export interface ThemeDiagnostics {
  readonly selected: CatppuccinFlavor;
  readonly reason: ThemeResolutionReason;
  readonly rawOsc11Reply?: string;
}

export interface Osc11ProbeResult {
  readonly rawReply?: string;
}

export type Osc11Probe = () => Promise<Osc11ProbeResult>;

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
   * `'auto'` or unset, OSC 11 probing resolves auto during attach.
   * An explicit `'mocha'` or `'latte'` passed here overrides the YAML value.
   */
  readonly themeFlavor?: CatppuccinFlavor | 'auto';
  /**
   * Internal test hook for theme auto-detection. Production callers should
   * leave this unset so the launcher queries the controlling terminal.
   */
  readonly themeProbe?: Osc11Probe;
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
  const theme = await resolveThemeDiagnostics({
    launchOption: options.themeFlavor,
    yamlOption: loaded.config.theme,
    allowOsc11: shouldAttemptOsc11(options),
    osc11Probe: options.themeProbe,
  });
  const flavor = theme.selected;
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

function shouldAttemptOsc11(options: LaunchTmuxPlayOptions): boolean {
  if (options.attach === false) return false;
  if (options.themeProbe !== undefined) return true;
  const stdout = options.stdout as
    | (Output & { readonly isTTY?: boolean })
    | undefined;
  const stdoutIsTty = stdout
    ? stdout.isTTY === true
    : process.stdout.isTTY === true;
  return process.stdin.isTTY === true && stdoutIsTty;
}

export interface TmuxPlayThemeDiagnosticsOptions {
  readonly cwd?: string;
  readonly configPath?: string;
  readonly configHome?: string;
  readonly stdout?: Output;
  readonly stderr?: Output;
  readonly themeFlavor?: CatppuccinFlavor | 'auto';
  readonly themeProbe?: Osc11Probe;
}

export async function tmuxPlayThemeDiagnostics(
  options: TmuxPlayThemeDiagnosticsOptions = {},
): Promise<ThemeDiagnostics> {
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
  return resolveThemeDiagnostics({
    launchOption: options.themeFlavor,
    yamlOption: loaded.config.theme,
    allowOsc11: true,
    osc11Probe: options.themeProbe,
  });
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
  configureMouseInteraction(options.sessionName);
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
  runTmux('set', '-t', options.sessionName, 'status-left-length', '136');
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

/**
 * Resolve the Catppuccin flavor to apply. Priority: explicit concrete
 * programmatic override (`launchOption`) → concrete YAML `theme` field
 * (`yamlOption`) → OSC 11 background-color probe when allowed → Mocha
 * fallback. `'auto'` is equivalent to "continue to the next source".
 */
export async function resolveThemeDiagnostics(options: {
  readonly launchOption?: CatppuccinFlavor | 'auto';
  readonly yamlOption?: CatppuccinFlavorConfig;
  readonly allowOsc11: boolean;
  readonly osc11Probe?: Osc11Probe;
}): Promise<ThemeDiagnostics> {
  const { launchOption, yamlOption } = options;
  if (launchOption === 'mocha' || launchOption === 'latte') {
    return { selected: launchOption, reason: 'explicit' };
  }
  if (yamlOption === 'mocha' || yamlOption === 'latte') {
    return { selected: yamlOption, reason: 'yaml' };
  }
  if (options.allowOsc11) {
    const probe = await (options.osc11Probe ?? probeOsc11Background)();
    const selected = probe.rawReply
      ? parseOsc11BackgroundFlavor(probe.rawReply)
      : undefined;
    if (selected) {
      return {
        selected,
        reason: 'osc11',
        rawOsc11Reply: probe.rawReply,
      };
    }
    return {
      selected: 'mocha',
      reason: 'fallback',
      ...(probe.rawReply ? { rawOsc11Reply: probe.rawReply } : {}),
    };
  }
  return { selected: 'mocha', reason: 'fallback' };
}

export function parseOsc11BackgroundFlavor(
  rawReply: string,
): CatppuccinFlavor | undefined {
  const reply = extractOsc11Reply(rawReply);
  if (!reply) return undefined;
  const match = reply.match(
    /(?:\x1b\]|\x9d)11;rgb:([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})\/([0-9a-fA-F]{2,4})(?:\x07|\x1b\\)/,
  );
  if (!match) return undefined;
  const r = normalizedChannel(match[1]!);
  const g = normalizedChannel(match[2]!);
  const b = normalizedChannel(match[3]!);
  if (r === undefined || g === undefined || b === undefined) {
    return undefined;
  }
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance >= 0.5 ? 'latte' : 'mocha';
}

async function probeOsc11Background(): Promise<Osc11ProbeResult> {
  let fd: number | undefined;
  try {
    fd = openSync('/dev/tty', 'r+');
  } catch {
    return {};
  }
  const ttyFd = fd;
  return new Promise((resolve) => {
    let input: ReadStream | undefined;
    let raw = '';
    let finished = false;
    let rawModeEnabled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (reply: string | undefined): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (input) {
        input.off('data', onData);
        if (rawModeEnabled) {
          try {
            input.setRawMode(false);
          } catch {
            // Best effort: the process is about to continue with a fallback
            // even if the terminal rejects raw-mode cleanup.
          }
        }
        input.pause();
        input.destroy();
        fd = undefined;
      } else if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Fallback remains safe even if the platform closed the fd first.
        }
        fd = undefined;
      }
      resolve(reply ? { rawReply: reply } : {});
    };

    const onData = (chunk: Buffer): void => {
      raw += chunk.toString('utf8');
      const reply = extractOsc11Reply(raw);
      if (reply) finish(reply);
    };

    try {
      input = new ReadStream(ttyFd);
      if (!input.isTTY) {
        finish(undefined);
        return;
      }
      // This is not preservation of a caller's prior raw-mode state:
      // the launcher owns this short-lived /dev/tty stream and probes before
      // readline/tmux attach. A future concurrent stdin reader would race the
      // OSC 11 reply and should not be introduced around this window.
      input.setRawMode(true);
      rawModeEnabled = true;
      input.on('data', onData);
      input.resume();
      writeSync(ttyFd, OSC11_QUERY);
      timer = setTimeout(() => finish(extractOsc11Reply(raw)), OSC11_TIMEOUT_MS);
    } catch {
      finish(undefined);
    }
  });
}

function extractOsc11Reply(raw: string): string | undefined {
  const escStart = raw.indexOf('\x1b]11;');
  const c1Start = raw.indexOf('\x9d11;');
  const starts = [escStart, c1Start].filter((index) => index >= 0);
  if (starts.length === 0) return undefined;
  const start = Math.min(...starts);
  const belEnd = raw.indexOf('\x07', start);
  const stEnd = raw.indexOf('\x1b\\', start);
  const ends = [
    belEnd >= 0 ? belEnd + 1 : -1,
    stEnd >= 0 ? stEnd + 2 : -1,
  ].filter((index) => index >= 0);
  if (ends.length === 0) return undefined;
  return raw.slice(start, Math.min(...ends));
}

function normalizedChannel(hex: string): number | undefined {
  if (hex.length !== 2 && hex.length !== 4) return undefined;
  const value = Number.parseInt(hex, 16);
  if (!Number.isFinite(value)) return undefined;
  return value / (hex.length === 2 ? 0xff : 0xffff);
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

function configureMouseInteraction(sessionName: string): void {
  runTmux('set-option', '-t', sessionName, 'mouse', 'on');
  for (const table of ['copy-mode', 'copy-mode-vi']) {
    runTmux(
      'bind-key',
      '-T',
      table,
      'MouseDragEnd1Pane',
      'send-keys',
      '-X',
      'stop-selection',
    );
    runTmux(
      'bind-key',
      '-T',
      table,
      'MouseDown3Pane',
      'send-keys',
      '-X',
      'copy-pipe-and-cancel',
      SYSTEM_CLIPBOARD_COPY_COMMAND,
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
