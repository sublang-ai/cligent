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
import { attachTmuxSession, isTmuxAvailable, runTmux } from '../shared/tmux.js';
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
import { formatTimerDuration } from './timing.js';
import {
  TMUX_PLAY_CONFIG_FILE,
  loadTmuxPlayConfig,
  writeTmuxPlayConfigSnapshot,
  type CatppuccinFlavorConfig,
  type LayoutConfig,
  type LoadedTmuxPlayConfig,
} from './config.js';
import type { PlayerConfig } from './players.js';

export const TMUX_PLAY_SESSION_MARKER = '.tmux-play-session';
const NAVIGATION_HINTS =
  'switch pane: ctrl+←/→ or shift+←/→ | stop: esc | exit: ctrl+c | drag=select | right-click=copy';
const SYSTEM_CLIPBOARD_COPY_COMMAND =
  'if command -v pbcopy >/dev/null 2>&1; then exec pbcopy; ' +
  'elif [ -n "$WAYLAND_DISPLAY" ] && command -v wl-copy >/dev/null 2>&1; then exec wl-copy; ' +
  'elif [ -n "$DISPLAY" ] && command -v xclip >/dev/null 2>&1; then exec xclip -selection clipboard -in; ' +
  'elif [ -n "$DISPLAY" ] && command -v xsel >/dev/null 2>&1; then exec xsel --clipboard --input; ' +
  'elif command -v clip.exe >/dev/null 2>&1; then exec clip.exe; ' +
  'else exec tmux load-buffer -w -; fi';
// TMUX-071: the initial timer text the launcher writes to every pane
// and to the status-bar option shall be the same `hh:mm:ss` rendering
// that `TimingObserver` would push for zero elapsed milliseconds, so the
// surface a Boss sees at launch (before the first turn opens) reads as
// `00:00:00` rather than as a stale literal. Deriving the constant from
// `formatTimerDuration(0)` keeps it self-correcting against any future
// change to the canonical format helper.
const INITIAL_TIMER_TEXT = formatTimerDuration(0);
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

  prepareLogDirectory(workDir, playerIds, TMUX_PLAY_SESSION_MARKER, sessionId);
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
    requestTerminalResize(
      options.stdout ?? process.stdout,
      loaded.config.layout.window,
    );
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
  const layout = options.loaded.config.layout;
  const sizes = computeLayoutSizes(layout, players.length);
  const bossCommand = buildSessionCommand(options);
  const c = options.palette;

  runTmux(
    'new-session',
    '-d',
    '-x',
    String(sizes.windowColumns),
    '-y',
    String(sizes.windowRows),
    '-s',
    options.sessionName,
    bossCommand,
  );
  const playerPanes = createPlayerPanes(
    options.sessionName,
    options.workDir,
    players,
    sizes,
  );
  setPaneTitles(
    options.sessionName,
    playerPanes,
    options.loaded.config.captain.adapter,
  );
  setTimerOptions(options.sessionName, playerPanes, options.themeFlavor);
  disablePlayerPaneInput(options.sessionName, playerPanes);
  configureMouseInteraction(options.sessionName, playerPanes.length + 1);
  configureBossPaneSwitchKeys(options.sessionName);
  configureBossPaneForwardKey(options.sessionName, 'C-c');
  configureBossPaneForwardKey(options.sessionName, 'Escape');
  configureLayoutHooks(options.sessionName, layout.columnWeights);
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
  runTmux('set', '-t', options.sessionName, 'status-left', statusLeftFormat(c));
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
      timer = setTimeout(
        () => finish(extractOsc11Reply(raw)),
        OSC11_TIMEOUT_MS,
      );
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
function applyCatppuccinTheme(sessionName: string, c: CatppuccinPalette): void {
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
  runTmux('set', '-t', sessionName, 'pane-active-border-style', `fg=${c.blue}`);
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
  return `#[fg=${c.blue},bold]Spex#[default] #[fg=${c.subtext0}]${NAVIGATION_HINTS}#[default]`;
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
  sizes: LayoutSizes,
): PlayerPane[] {
  const firstColumnCount = Math.ceil(players.length / 2);
  const playerPanes: PlayerPane[] = [];
  let nextPaneIndex = 1;

  runTmux(
    'split-window',
    '-h',
    '-l',
    String(sizes.playerAreaSize),
    '-t',
    sessionName,
    tailCommand(workDir, players[0]),
  );
  playerPanes[0] = {
    player: requirePlayer(players[0]),
    paneIndex: nextPaneIndex++,
  };

  if (players.length < 2) {
    return playerPanes;
  }

  // Second-column split sized in exact cells (not percent) so arbitrary
  // weights — e.g. `[3, 5, 7]` — land within tmux's nearest-cell rounding
  // rather than relying on a clean `50%` fraction the default `[1, 1, 1]`
  // happens to produce.
  runTmux(
    'split-window',
    '-h',
    '-l',
    String(sizes.secondColumnSize),
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
    runTmux('select-pane', '-t', paneTarget(sessionName, pane.paneIndex), '-d');
  }
}

function configureMouseInteraction(
  sessionName: string,
  paneCount: number,
): void {
  runTmux('set-option', '-t', sessionName, 'mouse', 'on');
  const condition = `#{==:#{session_name},${sessionName}}`;
  // The launcher binds no `WheelUpPane` override (see TMUX-062): tmux's stock
  // root and copy-mode wheel-up handling already clamps the viewport at the
  // oldest history line, so a wheel-up cannot scroll past the top. The earlier
  // overscroll/phantom-line reports came from the Boss pane's scrollback being
  // polluted by readline redraws, fixed at the source by TMUX-079.
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
    // TMUX-062: right-click copy uses `copy-pipe` (not
    // `copy-pipe-and-cancel`) so the clicked pane keeps its current
    // copy-mode scroll position after the copy. `copy-pipe-and-cancel`
    // exits copy-mode entirely, which snaps a scrolled-back pane back
    // to its live tail — the "right-click on a scrolled-back pane
    // jumps to the last line" defect, the right-click analogue of the
    // left-click defect TMUX-068 fixes for the `MouseDown1Pane`
    // override below. `copy-pipe` still clears the active selection
    // (matching the left-click `clear-selection` story so the copy
    // surfaces a visible cue and a stale selection cannot survive the
    // copy gesture), but leaves the pane in copy-mode at the same
    // scroll position. Users who want to leave copy-mode after the
    // copy can press `q` as usual.
    //
    // TMUX-062 copy-confirmation toast: right-click also surfaces a
    // brief `Copied!` toast when a selection is present. The toast is a
    // status-line `display-message` (not a floating `display-popup`) so
    // it inherits the session's `message-style` (`fg=base,bg=peach` per
    // TMUX-047) and renders `Copied!` in the flavor's base-on-peach
    // styling — the same band tmux uses for its own status messages,
    // which is the requested look (dark text on Mocha's light peach,
    // light text on Latte's vivid peach).
    //
    // The binding is a single `if-shell -F '#{selection_present}'` so
    // the gate is read at click time, BEFORE `copy-pipe` clears the
    // selection (a check placed after the copy would always read `0`).
    // Both branches copy; only the selection-present branch toasts, so a
    // right-click over nothing selected copies silently and never
    // falsely claims "Copied!". The two-command true branch is passed as
    // ONE quoted argv token — its internal ` ; ` separates the toast
    // from the copy when if-shell re-parses the branch, exactly like the
    // TMUX-065 `C-c` true branch. A standalone `;` argv element would
    // instead split the bind-key call itself into two top-level tmux
    // commands (binding only the toast and running a bare `copy-pipe`
    // against a not-in-mode pane), so the sequence MUST live inside the
    // branch token. The clipboard command is wrapped in single quotes
    // inside the branch so tmux passes it to `copy-pipe` as one argument
    // when re-parsing (it contains spaces, `;`, and double quotes but no
    // single quotes). `display-message` (no `-d`) auto-dismisses after
    // the session's `display-time` and touches neither copy-mode state
    // nor scroll position.
    const copyCommand = `send-keys -X copy-pipe '${SYSTEM_CLIPBOARD_COPY_COMMAND}'`;
    const toastThenCopy = `display-message Copied! ; ${copyCommand}`;
    runTmux(
      'bind-key',
      '-T',
      table,
      'MouseDown3Pane',
      'if-shell',
      '-F',
      '#{selection_present}',
      toastThenCopy,
      copyCommand,
    );
  }
  // TMUX-068 (supersedes TMUX-066 and TMUX-067): a left-click in any
  // pane in the launched session shall clear any active copy-mode
  // selection on every pane in the session while preserving each
  // pane's copy-mode state and scroll position. The retired TMUX-066
  // chain used `send-keys -X cancel`, which exits copy-mode entirely
  // and snaps a scrolled-back pane to its live tail (the
  // "previously focused pane jumps to the last line" defect).
  // TMUX-067 then dropped the override altogether, which restored
  // scroll preservation but reintroduced the original
  // "click doesn't release selection" defect that TMUX-066 was
  // written to fix. `send-keys -X clear-selection` (in place of
  // `cancel`) is the tmux primitive that splits the two effects: it
  // clears the active selection but does NOT exit copy-mode, so a
  // pane scrolled back without a selection stays scrolled, and a
  // pane holding a selection drops the selection but keeps its
  // copy-mode position. The binding is gated per pane with
  // `if -F -t <pane> '#{pane_in_mode}' ...` because tmux's `-X`
  // commands raise "no key table" when targeted at a pane not in a
  // mode, and the gate also avoids spurious work on panes that have
  // nothing to clear.
  //
  // The binding is installed in `root`, `copy-mode`, and
  // `copy-mode-vi` because tmux dispatches `MouseDown1Pane` through
  // the clicked pane's *current* key table — the click on a pane
  // already in copy-mode would otherwise miss the root binding
  // entirely (both mode tables ship a default `MouseDown1Pane
  // select-pane` that shadows it). Each binding's true branch chains
  // the per-pane `clear-selection` then runs the per-table stock
  // tail — `select-pane -t= ; send-keys -M` for `root` (the
  // `send-keys -M` forwards the mouse event to mouse-aware terminal
  // applications like vim, less, htop) and `select-pane` for the
  // mode tables (mode tables consume mouse events without
  // forwarding). The `if-shell -F` gate on `#{==:#{session_name},...}`
  // scopes the override to this tmux-play session so other tmux
  // sessions on the same server retain stock per-table behavior; the
  // false branch is the verbatim stock tail so a tmux server reused
  // across launches has any prior session-scoped override overwritten
  // by the new binding (tmux key tables are server-global per
  // TMUX-062 / TMUX-063 / TMUX-065).
  //
  // Drag-select per TMUX-062 is unaffected: `MouseDown1Pane` fires
  // first and clears any prior selection, then `MouseDrag1Pane`
  // (tmux's stock binding) enters `copy-mode -M` on the dragged pane
  // and begins a fresh selection.
  const clearCmds: string[] = [];
  for (let i = 0; i < paneCount; i++) {
    const target = paneTarget(sessionName, i);
    clearCmds.push(
      `if -F -t ${target} '#{pane_in_mode}' 'send-keys -t ${target} -X clear-selection'`,
    );
  }
  const clearAll = clearCmds.join(' ; ');
  runTmux(
    'bind-key',
    '-T',
    'root',
    'MouseDown1Pane',
    'if-shell',
    '-F',
    condition,
    `${clearAll} ; select-pane -t= ; send-keys -M`,
    'select-pane -t= ; send-keys -M',
  );
  for (const table of ['copy-mode', 'copy-mode-vi']) {
    runTmux(
      'bind-key',
      '-T',
      table,
      'MouseDown1Pane',
      'if-shell',
      '-F',
      condition,
      `${clearAll} ; select-pane`,
      'select-pane',
    );
  }
}

// TMUX-063: bind Ctrl+Left / Ctrl+Right and Shift+Left / Shift+Right at
// the root key table so the Boss can switch panes directly without the
// Ctrl+b prefix the navigation hints in `status-left` advertise. Both
// pairs map to the same `select-pane -L` / `select-pane -R` actions so
// pane switching works out of the box on macOS, Windows, and Linux: at
// least one of `Ctrl+arrow` and `Shift+arrow` reaches tmux untouched on
// every common host — macOS Terminal.app and iTerm2 frequently rebind
// `Ctrl+←/→` for shell word-movement, while many Linux desktops swallow
// `Shift+←/→` for window-manager workspace switching. Shipping both
// avoids forcing per-platform documentation or user keybinding tweaks.
// Like the copy-mode bindings in TMUX-062, the root key table is
// server-global — tmux does not offer per-session root bindings — so the
// launcher scopes each binding with `if-shell -F` against the current
// session name. Inside the launcher's own tmux-play session the binding
// selects the adjacent pane; in every other tmux session on the same
// server the false branch forwards the key verbatim via `send-keys`,
// leaving the user's word-movement, workspace-switch, or other consumer
// intact. The bindings outlive the tmux-play session but remain no-ops
// once the session is killed.
function configureBossPaneSwitchKeys(sessionName: string): void {
  const condition = `#{==:#{session_name},${sessionName}}`;
  const bindings: ReadonlyArray<{ key: string; action: string }> = [
    { key: 'C-Left', action: 'select-pane -L' },
    { key: 'C-Right', action: 'select-pane -R' },
    { key: 'S-Left', action: 'select-pane -L' },
    { key: 'S-Right', action: 'select-pane -R' },
  ];
  for (const { key, action } of bindings) {
    runTmux(
      'bind-key',
      '-T',
      'root',
      key,
      'if-shell',
      '-F',
      condition,
      action,
      `send-keys ${key}`,
    );
  }
}

// TMUX-065 (C-c, amended by IR-024) and TMUX-070 (Escape): forward the
// key to the Boss/Captain pane (pane index 0) from any pane in the
// launched session, in any mode, with a single press. The two keys share
// the same forwarding pattern because they share the same dispatch
// hazards:
//
//   1. Player panes are read-only per TMUX-027 (`pane-input-off=1`) and
//      would otherwise swallow the key entirely — fixed for C-c by the
//      original TMUX-065 root binding and for Escape by TMUX-070.
//   2. A pane scrolled back into copy-mode dispatches its keys through
//      tmux's `copy-mode` / `copy-mode-vi` key tables, where the stock
//      C-c and Escape bindings run `-X cancel` (and, in `copy-mode-vi`,
//      stock `Escape` runs `-X clear-selection`). With a root-only binding
//      the first keypress on a scrolled pane is consumed by that stock
//      binding and only the second press reaches the forwarding logic —
//      the user-reported "Ctrl+C requires two presses to quit when a pane
//      is scrolled" defect, mirrored on Escape. Installing the same
//      binding in `copy-mode` and `copy-mode-vi` makes single-press exit /
//      abort hold even when the focused pane is in copy-mode.
//
// Every true branch is the same cancel-then-forward pair: it first exits
// pane 0's copy-mode when pane 0 is itself scrolled
// (`if -F -t <s>:0.0 '#{pane_in_mode}' 'send-keys -t <s>:0.0 -X cancel'`)
// and then forwards the byte (`send-keys -t <s>:0.0 <key>`). The cancel
// step is required because a key delivered via `send-keys` to a pane that
// is itself in copy-mode is consumed by copy-mode's stock `cancel` and
// never reaches the Boss readline — so without it the forwarded key would
// be swallowed whenever pane 0 is the scrolled pane. Once pane 0 is out of
// copy-mode the forwarded byte reaches the Captain process exactly as if
// pressed there: readline raises SIGINT on C-c per TMUX-026 (shutdown) and
// the keypress listener calls `abortActiveTurn('ESC')` on bare ESC per
// TMUX-057.
//
// Each binding is scoped to the launched session via `if-shell -F`
// against `#{session_name}`. The false branch reproduces the per-(key,
// table) tmux stock binding verbatim so other tmux sessions on the same
// server retain stock semantics (and any prior session-scoped override on
// a reused server is overwritten). Because tmux key tables are
// server-global (see TMUX-062 / TMUX-063 / TMUX-065), a single false
// branch that did not match the exact stock would silently downgrade the
// corresponding key in every other tmux session on the host.
//
// The stock binding is NOT uniform across (key, table) — see the
// `STOCK_FALSE_BRANCH` table below. In particular `copy-mode-vi`'s stock
// `Escape` is `send-keys -X clear-selection`, not `-X cancel`: the vi
// convention is that Escape leaves visual selection without leaving
// copy-mode (the `q` key is the vi-mode exit). Collapsing `(Escape,
// copy-mode-vi)` to `-X cancel` would change every unrelated vi-mode
// user's Escape from "drop selection, keep scrollback" to "exit copy-mode,
// snap to live tail" — the same scroll-snapping regression class TMUX-068
// spelled out for mouse events.
const FORWARD_KEY_TABLES = ['root', 'copy-mode', 'copy-mode-vi'] as const;
type ForwardKey = 'C-c' | 'Escape';
type ForwardTable = (typeof FORWARD_KEY_TABLES)[number];

// Stock per-(key, table) tmux bindings, verified via `tmux list-keys`
// on a fresh server:
//   - root: neither key is bound; the focused pane receives the byte,
//     which `send-keys <key>` (without `-t`) reproduces.
//   - copy-mode (emacs-style mode-keys): both keys → `-X cancel`.
//   - copy-mode-vi: `C-c` → `-X cancel`, `Escape` → `-X clear-selection`
//     (vi convention).
const STOCK_FALSE_BRANCH: Record<ForwardKey, Record<ForwardTable, string>> = {
  'C-c': {
    root: 'send-keys C-c',
    'copy-mode': 'send-keys -X cancel',
    'copy-mode-vi': 'send-keys -X cancel',
  },
  Escape: {
    root: 'send-keys Escape',
    'copy-mode': 'send-keys -X cancel',
    'copy-mode-vi': 'send-keys -X clear-selection',
  },
};
function configureBossPaneForwardKey(
  sessionName: string,
  key: ForwardKey,
): void {
  const condition = `#{==:#{session_name},${sessionName}}`;
  const pane0 = paneTarget(sessionName, 0);
  const trueBranch =
    `if -F -t ${pane0} '#{pane_in_mode}' ` +
    `'send-keys -t ${pane0} -X cancel' ; send-keys -t ${pane0} ${key}`;
  for (const table of FORWARD_KEY_TABLES) {
    runTmux(
      'bind-key',
      '-T',
      table,
      key,
      'if-shell',
      '-F',
      condition,
      trueBranch,
      STOCK_FALSE_BRANCH[key][table],
    );
  }
}

function selectBossPane(sessionName: string): void {
  runTmux('select-pane', '-t', paneTarget(sessionName, 0));
}

// TMUX-043: emit `\x1b[8;<rows>;<columns>t` from the resolved layout.window,
// so the pre-attach terminal-size request matches `new-session -x/-y` for
// either the default 174x49 grid or an explicit YAML override. Reading both
// from the same source prevents tmux's default `window-size` negotiation
// from silently overriding a non-default `layout.window` on attach.
function requestTerminalResize(
  stream: Output,
  window: LayoutConfig['window'],
): void {
  stream.write(`\x1b[8;${window.rows};${window.columns}t`);
}

interface LayoutSizes {
  readonly windowColumns: number;
  readonly windowRows: number;
  /** First-split `-l`: cell width of the player area (= W - boss region). */
  readonly playerAreaSize: number;
  /** Second-split `-l` (multi only): cell width of the second player column. */
  readonly secondColumnSize: number;
}

// TMUX-028 / TMUX-044: derive the initial `split-window -l` cell counts so
// they match the resize-hook formula at session creation. Non-rightmost
// regions take `floor(W * w_i / sum(w))` cells; the rightmost column
// absorbs the remainder. The initial second-column `-l` is the remainder,
// not `floor(W * w_2 / sum)`, so first-column region = total - boss -
// second equals `floor(W * w_1 / sum)` exactly.
function computeLayoutSizes(
  layout: LayoutConfig,
  playerCount: number,
): LayoutSizes {
  const W = layout.window.columns;
  const weights = layout.columnWeights;
  const sum = weights.reduce((acc, value) => acc + value, 0);
  const bossColumnSize = Math.floor((W * (weights[0] ?? 1)) / sum);
  const playerAreaSize = W - bossColumnSize;
  if (playerCount < 2) {
    // Single-player layout has no second column; the second-split branch is
    // unused, but emitting a sentinel keeps the type total.
    return {
      windowColumns: W,
      windowRows: layout.window.rows,
      playerAreaSize,
      secondColumnSize: 0,
    };
  }
  const firstColumnSize = Math.floor((W * (weights[1] ?? 1)) / sum);
  const secondColumnSize = playerAreaSize - firstColumnSize;
  return {
    windowColumns: W,
    windowRows: layout.window.rows,
    playerAreaSize,
    secondColumnSize,
  };
}

// TMUX-044: keep the weighted region split invariant under any window
// resize. Each non-rightmost column receives `floor(W * w_i / sum(w)) - 1`
// cells of content (`resize-pane -x` sets content width; the `-1` accounts
// for the 1-cell right-side tmux border). The rightmost column absorbs the
// remainder and needs no explicit resize. `resize-pane -x` does not accept
// tmux format expansion, so the arithmetic is shell-evaluated at hook fire.
function configureLayoutHooks(
  sessionName: string,
  weights: readonly number[],
): void {
  const sum = weights.reduce((acc, value) => acc + value, 0);
  const widthCmd = `tmux display-message -t ${sessionName} -p '#{window_width}'`;
  const resizes: string[] = [];
  for (let i = 0; i < weights.length - 1; i++) {
    resizes.push(
      `tmux resize-pane -t ${sessionName}:0.${i} -x $((W * ${weights[i]} / ${sum} - 1))`,
    );
  }
  const shell = [`W=$(${widthCmd})`, ...resizes].join(' && ');
  const hookCommand = `run-shell -b "${shell}"`;
  for (const hook of ['client-resized', 'after-resize-window']) {
    runTmux('set-hook', '-t', sessionName, hook, hookCommand);
  }
}

function tailCommand(
  workDir: string,
  player: PlayerConfig | undefined,
): string {
  if (!player) {
    throw new Error('tmux-play requires at least one player pane');
  }
  return ['tail', '-f', logFilePath(workDir, player.id)]
    .map(shellQuote)
    .join(' ');
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
