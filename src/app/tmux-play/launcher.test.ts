// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  attachTmuxSessionMock,
  isTmuxAvailableMock,
  runTmuxMock,
  isGlowAvailableMock,
} = vi.hoisted(() => ({
  attachTmuxSessionMock: vi.fn(),
  isTmuxAvailableMock: vi.fn(),
  runTmuxMock: vi.fn(),
  isGlowAvailableMock: vi.fn(),
}));

vi.mock('../shared/tmux.js', () => ({
  attachTmuxSession: attachTmuxSessionMock,
  isTmuxAvailable: isTmuxAvailableMock,
  runTmux: runTmuxMock,
}));

vi.mock('../shared/glow.js', () => ({
  GLOW_INSTALL_URL: 'https://github.com/charmbracelet/glow#installation',
  isGlowAvailable: isGlowAvailableMock,
}));

import {
  launchTmuxPlay,
  parseOsc11BackgroundFlavor,
  TMUX_PLAY_SESSION_MARKER,
  tmuxPlayThemeDiagnostics,
} from './launcher.js';
import { TMUX_PLAY_CONFIG_SNAPSHOT } from './config.js';
import {
  TMUX_PANE_TIMER_ACCENT_OPTION,
  TMUX_PANE_TIMER_RUNNING_OPTION,
  TMUX_PANE_TIMER_TEXT_OPTION,
  TMUX_STATUS_TIMER_RUNNING_OPTION,
  TMUX_STATUS_TIMER_TEXT_OPTION,
} from './timer-options.js';
import { shellQuote } from '../shared/shell.js';

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

describe('launchTmuxPlay', () => {
  let tempDir: string | undefined;

  // Save env state for restoration so tests that set terminal variables do
  // not leak into unrelated launcher assertions.
  const originalTermProgram = process.env.TERM_PROGRAM;

  beforeEach(() => {
    isTmuxAvailableMock.mockReturnValue(true);
    isGlowAvailableMock.mockReturnValue(true);
    runTmuxMock.mockReset();
    attachTmuxSessionMock.mockReset();
    delete process.env.TERM_PROGRAM;
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
    if (originalTermProgram === undefined) {
      delete process.env.TERM_PROGRAM;
    } else {
      process.env.TERM_PROGRAM = originalTermProgram;
    }
  });

  it('writes logs and snapshot, then builds the tmux layout', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['coder', 'reviewer', 'analyst']);
    const workDir = join(tempDir, 'play work');

    const result = await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'abc123',
      workDir,
      selfBin: '/tmp/tmux play/cli.js',
      attach: false,
    });

    expect(result).toEqual({
      sessionId: 'abc123',
      sessionName: 'tmux-play-abc123',
      workDir,
      snapshotPath: join(workDir, TMUX_PLAY_CONFIG_SNAPSHOT),
    });
    expect(readFileSync(join(workDir, TMUX_PLAY_SESSION_MARKER), 'utf8')).toBe(
      'abc123',
    );
    expect(existsSync(join(workDir, 'coder.log'))).toBe(true);
    expect(existsSync(join(workDir, 'reviewer.log'))).toBe(true);
    expect(existsSync(join(workDir, 'analyst.log'))).toBe(true);

    const snapshot = JSON.parse(
      readFileSync(join(workDir, TMUX_PLAY_CONFIG_SNAPSHOT), 'utf8'),
    ) as { captain: { from: string } };
    expect(snapshot.captain.from).toBe('@sublang/cligent/captains/fanout');

    expect(runTmuxMock).toHaveBeenNthCalledWith(
      1,
      'new-session',
      '-d',
      '-x',
      '240',
      '-y',
      '67',
      '-s',
      'tmux-play-abc123',
      expect.stringContaining('--session abc123'),
    );
    expect(runTmuxMock.mock.calls[0]?.at(-1)).toContain(
      "--work-dir '" + workDir + "'",
    );
    expect(runTmuxMock.mock.calls[0]?.at(-1)).toContain(
      "'/tmp/tmux play/cli.js'",
    );
    expect(runTmuxMock).toHaveBeenNthCalledWith(
      2,
      'split-window',
      '-h',
      '-l',
      '160',
      '-t',
      'tmux-play-abc123',
      tailCommand(workDir, 'coder'),
    );
    expect(runTmuxMock).toHaveBeenNthCalledWith(
      3,
      'split-window',
      '-h',
      '-l',
      '50%',
      '-t',
      'tmux-play-abc123:0.1',
      tailCommand(workDir, 'analyst'),
    );
    expect(runTmuxMock).toHaveBeenNthCalledWith(
      4,
      'split-window',
      '-v',
      '-t',
      'tmux-play-abc123:0.1',
      tailCommand(workDir, 'reviewer'),
    );
    const initialColumns = Number(
      valueAfter(runTmuxMock.mock.calls[0] ?? [], '-x'),
    );
    const playerAreaColumns = Number(
      valueAfter(runTmuxMock.mock.calls[1] ?? [], '-l'),
    );
    const secondPlayerColumnPercent = Number(
      valueAfter(runTmuxMock.mock.calls[2] ?? [], '-l').replace('%', ''),
    );
    const secondPlayerColumnColumns = Math.floor(
      (playerAreaColumns * secondPlayerColumnPercent) / 100,
    );
    expect({
      bossColumns: initialColumns - playerAreaColumns,
      firstPlayerColumnColumns: playerAreaColumns - secondPlayerColumnColumns,
      secondPlayerColumnColumns,
    }).toEqual({
      bossColumns: 80,
      firstPlayerColumnColumns: 80,
      secondPlayerColumnColumns: 80,
    });
    expect(runTmuxMock).toHaveBeenCalledWith(
      'select-pane',
      '-t',
      'tmux-play-abc123:0.0',
      '-T',
      'Captain · claude',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'select-pane',
      '-t',
      'tmux-play-abc123:0.1',
      '-T',
      'Coder · codex',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'select-pane',
      '-t',
      'tmux-play-abc123:0.3',
      '-T',
      'Reviewer · codex',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'select-pane',
      '-t',
      'tmux-play-abc123:0.2',
      '-T',
      'Analyst · codex',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'select-pane',
      '-t',
      'tmux-play-abc123:0.1',
      '-d',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'select-pane',
      '-t',
      'tmux-play-abc123:0.2',
      '-d',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'select-pane',
      '-t',
      'tmux-play-abc123:0.3',
      '-d',
    );
    expect(runTmuxMock).not.toHaveBeenCalledWith(
      'select-pane',
      '-t',
      'tmux-play-abc123:0.0',
      '-d',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'set-option',
      '-t',
      'tmux-play-abc123',
      'mouse',
      'on',
    );
    const expectedHookCmd =
      `run-shell -b "W=$(tmux display-message -t tmux-play-abc123 -p '#{window_width}')` +
      ` && tmux resize-pane -t tmux-play-abc123:0.0 -x $((W / 3 - 1))` +
      ` && tmux resize-pane -t tmux-play-abc123:0.1 -x $((W / 3 - 1))"`;
    expect(runTmuxMock).toHaveBeenCalledWith(
      'set-hook',
      '-t',
      'tmux-play-abc123',
      'client-resized',
      expectedHookCmd,
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'set-hook',
      '-t',
      'tmux-play-abc123',
      'after-resize-window',
      expectedHookCmd,
    );
    expect(runTmuxMock.mock.calls.at(-1)).toEqual([
      'select-pane',
      '-t',
      'tmux-play-abc123:0.0',
    ]);
    expect(attachTmuxSessionMock).not.toHaveBeenCalled();
  });

  it('preserves mouse selection and copies it to the system clipboard on right-click without changing clipboard policy', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['coder']);

    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'mouse-boundary',
      workDir: join(tempDir, 'work'),
      selfBin: '/tmp/cli.js',
      attach: false,
    });

    for (const table of ['copy-mode', 'copy-mode-vi']) {
      expect(runTmuxMock).toHaveBeenCalledWith(
        'bind-key',
        '-T',
        table,
        'MouseDragEnd1Pane',
        'send-keys',
        '-X',
        'stop-selection',
      );
      const rightClickCopyCall = runTmuxMock.mock.calls.find(
        (call) =>
          call[0] === 'bind-key' &&
          call[2] === table &&
          call[3] === 'MouseDown3Pane',
      );
      expect(rightClickCopyCall).toEqual([
        'bind-key',
        '-T',
        table,
        'MouseDown3Pane',
        'send-keys',
        '-X',
        'copy-pipe-and-cancel',
        expect.any(String),
      ]);
      const clipboardCommand = rightClickCopyCall?.at(-1);
      expect(clipboardCommand).toEqual(expect.stringContaining('pbcopy'));
      expect(clipboardCommand).toEqual(expect.stringContaining('wl-copy'));
      expect(clipboardCommand).toEqual(expect.stringContaining('xclip'));
      expect(clipboardCommand).toEqual(expect.stringContaining('xsel'));
      expect(clipboardCommand).toEqual(expect.stringContaining('clip.exe'));
      expect(clipboardCommand).toEqual(
        expect.stringContaining('tmux load-buffer -w -'),
      );
    }
    expect(runTmuxMock.mock.calls.some((call) => call.includes('set-clipboard')))
      .toBe(false);
    expect(
      runTmuxMock.mock.calls.some(
        (call) =>
          call[0] === 'bind-key' &&
          call.some(
            (arg) => typeof arg === 'string' && /^Wheel/.test(arg),
          ),
      ),
    ).toBe(false);
  });

  it('binds Ctrl+Left and Ctrl+Right at the root key table for direct pane switching, scoped to the launched session via if-shell', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['coder']);

    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'pane-switch',
      workDir: join(tempDir, 'work'),
      selfBin: '/tmp/cli.js',
      attach: false,
    });

    const condition = '#{==:#{session_name},tmux-play-pane-switch}';
    expect(runTmuxMock).toHaveBeenCalledWith(
      'bind-key',
      '-T',
      'root',
      'C-Left',
      'if-shell',
      '-F',
      condition,
      'select-pane -L',
      'send-keys C-Left',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'bind-key',
      '-T',
      'root',
      'C-Right',
      'if-shell',
      '-F',
      condition,
      'select-pane -R',
      'send-keys C-Right',
    );
  });

  it('applies the Catppuccin Mocha theme before content-bearing options', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['coder']);
    const workDir = join(tempDir, 'work');

    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'theme',
      workDir,
      selfBin: '/tmp/cli.js',
      attach: false,
    });

    const setCalls = runTmuxMock.mock.calls.filter(
      (call) => call[0] === 'set' && call[2] === 'tmux-play-theme',
    );
    const optionAt = (n: number): string | undefined => setCalls[n]?.[3];
    const indexOf = (option: string): number =>
      setCalls.findIndex((call) => call[3] === option);
    const commandIndexOf = (option: string): number =>
      runTmuxMock.mock.calls.findIndex((call) => call.includes(option));

    // TMUX-047 (truecolor): default-terminal scoped to this session, and
    // terminal-overrides appended on the server with the leading-comma idiom.
    expect(setCalls).toContainEqual([
      'set',
      '-t',
      'tmux-play-theme',
      'default-terminal',
      'tmux-256color',
    ]);
    expect(runTmuxMock).toHaveBeenCalledWith(
      'set',
      '-as',
      'terminal-overrides',
      ',*:RGB',
    );

    // TMUX-047: window-style / window-active-style are NOT claimed. The
    // canonical Catppuccin tmux pattern leaves the pane content area as the
    // user's terminal-native canvas; the theme paints only the status bar,
    // pane-border row, and accents. Switching flavor by host bg keeps the
    // band adaptive (Mocha on dark terminals, Latte on light) instead of
    // forcing a single canvas across all hosts.
    expect(indexOf('window-style')).toBe(-1);
    expect(indexOf('window-active-style')).toBe(-1);
    // status-style: Mocha text on mantle band when auto detection cannot
    // probe an attached terminal (attach: false).
    expect(setCalls).toContainEqual([
      'set',
      '-t',
      'tmux-play-theme',
      'status-style',
      'fg=#cdd6f4,bg=#181825',
    ]);
    expect(setCalls).toContainEqual([
      'set',
      '-t',
      'tmux-play-theme',
      'pane-active-border-style',
      'fg=#89b4fa',
    ]);
    // TMUX-048: inactive pane border dimmed to overlay0 for stronger contrast
    // with the active blue border.
    expect(setCalls).toContainEqual([
      'set',
      '-t',
      'tmux-play-theme',
      'pane-border-style',
      'fg=#6c7086',
    ]);
    // window-status-style and window-status-current-style are not claimed:
    // window-status-format / window-status-current-format are set to empty
    // strings below, so those style options have nothing to color.
    expect(indexOf('window-status-style')).toBe(-1);
    expect(indexOf('window-status-current-style')).toBe(-1);
    expect(indexOf('message-style')).toBeGreaterThanOrEqual(0);
    expect(indexOf('message-command-style')).toBeGreaterThanOrEqual(0);
    expect(indexOf('display-panes-colour')).toBeGreaterThanOrEqual(0);
    expect(indexOf('display-panes-active-colour')).toBeGreaterThanOrEqual(0);
    expect(indexOf('clock-mode-colour')).toBeGreaterThanOrEqual(0);

    // Ordering invariant: every theme option precedes the content-bearing
    // options it does NOT touch, so our pane-border-format, status-left/right,
    // and hidden window-list strings remain authoritative if a future theme
    // tries to set them.
    const themeOptions = [
      'default-terminal',
      'status-style',
      'pane-border-style',
      'pane-active-border-style',
      'message-style',
      'message-command-style',
      'display-panes-colour',
      'display-panes-active-colour',
      'clock-mode-colour',
    ];
    const lastThemeIndex = Math.max(
      ...themeOptions.map((o) => commandIndexOf(o)),
    );
    expect(commandIndexOf('pane-border-format')).toBeGreaterThan(lastThemeIndex);
    expect(commandIndexOf('status-left')).toBeGreaterThan(lastThemeIndex);
    expect(commandIndexOf('status-right')).toBeGreaterThan(lastThemeIndex);
    expect(commandIndexOf('window-status-format')).toBeGreaterThan(lastThemeIndex);
    expect(commandIndexOf('window-status-current-format')).toBeGreaterThan(
      lastThemeIndex,
    );
    expect(commandIndexOf('window-status-separator')).toBeGreaterThan(
      lastThemeIndex,
    );

    // First theme set still comes after the layout has been built.
    expect(optionAt(0)).toBe('default-terminal');
  });

  it('does not infer Latte from Apple Terminal without an OSC 11 answer', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['coder']);
    process.env.TERM_PROGRAM = 'Apple_Terminal';

    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'apple-dark',
      workDir: join(tempDir, 'work'),
      selfBin: '/tmp/cli.js',
      attach: false,
    });

    expect(setValue('tmux-play-apple-dark', 'status-style')).toBe(
      'fg=#cdd6f4,bg=#181825',
    );
  });

  it('resolves Latte from a light OSC 11 background reply', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['coder']);
    const workDir = join(tempDir, 'work');

    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'osc11',
      workDir,
      selfBin: '/tmp/cli.js',
      attach: false,
      themeProbe: async () => ({
        rawReply: '\x1b]11;rgb:eeee/eeee/eeee\x07',
      }),
      themeFlavor: 'auto',
    });

    // attach:false disables active OSC probing, even if a test probe is
    // supplied. This keeps programmatic/session-building calls deterministic.
    expect(setValue('tmux-play-osc11', 'status-style')).toBe(
      'fg=#cdd6f4,bg=#181825',
    );

    runTmuxMock.mockReset();
    const attachedWorkDir = join(tempDir, 'attached-work');
    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'osc11-attached',
      workDir: attachedWorkDir,
      selfBin: '/tmp/cli.js',
      themeProbe: async () => ({
        rawReply: '\x1b]11;rgb:eeee/eeee/eeee\x07',
      }),
    });

    expect(setValue('tmux-play-osc11-attached', 'status-style')).toBe(
      'fg=#4c4f69,bg=#e6e9ef',
    );
    expect(
      JSON.parse(
        readFileSync(
          join(attachedWorkDir, TMUX_PLAY_CONFIG_SNAPSHOT),
          'utf8',
        ),
      ).theme,
    ).toBe('latte');
  });

  it('parses OSC 11 RGB replies with BEL or ST terminators', () => {
    expect(
      parseOsc11BackgroundFlavor('\x1b]11;rgb:00/00/00\x07'),
    ).toBe('mocha');
    expect(
      parseOsc11BackgroundFlavor('\x1b]11;rgb:eeee/eeee/eeee\x1b\\'),
    ).toBe('latte');
  });

  it('reports theme diagnostics without tmux or glow availability', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['coder']);
    isTmuxAvailableMock.mockReturnValue(false);
    isGlowAvailableMock.mockReturnValue(false);

    const diagnostics = await tmuxPlayThemeDiagnostics({
      cwd: tempDir,
      configPath,
      themeProbe: async () => ({
        rawReply: '\x1b]11;rgb:eeee/eeee/eeee\x07',
      }),
    });

    expect(diagnostics).toEqual({
      selected: 'latte',
      reason: 'osc11',
      rawOsc11Reply: '\x1b]11;rgb:eeee/eeee/eeee\x07',
    });
    expect(runTmuxMock).not.toHaveBeenCalled();
  });

  it('configures timer slots on the pane borders and tmux status bar', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['coder', 'reviewer']);

    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'timers',
      workDir: join(tempDir, 'work'),
      selfBin: '/tmp/cli.js',
      attach: false,
    });

    expect(runTmuxMock).toHaveBeenCalledWith(
      'set-option',
      '-p',
      '-t',
      'tmux-play-timers:0.0',
      TMUX_PANE_TIMER_ACCENT_OPTION,
      '#cba6f7',
    );
    for (const pane of ['tmux-play-timers:0.1', 'tmux-play-timers:0.2']) {
      expect(runTmuxMock).toHaveBeenCalledWith(
        'set-option',
        '-p',
        '-t',
        pane,
        TMUX_PANE_TIMER_ACCENT_OPTION,
        '#94e2d5',
      );
    }
    for (const pane of [
      'tmux-play-timers:0.0',
      'tmux-play-timers:0.1',
      'tmux-play-timers:0.2',
    ]) {
      expect(runTmuxMock).toHaveBeenCalledWith(
        'set-option',
        '-p',
        '-t',
        pane,
        TMUX_PANE_TIMER_TEXT_OPTION,
        '0s',
      );
      expect(runTmuxMock).toHaveBeenCalledWith(
        'set-option',
        '-p',
        '-t',
        pane,
        TMUX_PANE_TIMER_RUNNING_OPTION,
        '0',
      );
    }
    expect(runTmuxMock).toHaveBeenCalledWith(
      'set-option',
      '-t',
      'tmux-play-timers',
      TMUX_STATUS_TIMER_TEXT_OPTION,
      '0s',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'set-option',
      '-t',
      'tmux-play-timers',
      TMUX_STATUS_TIMER_RUNNING_OPTION,
      '0',
    );

    expect(runTmuxMock).toHaveBeenCalledWith(
      'set-window-option',
      '-t',
      'tmux-play-timers:0',
      'pane-border-status',
      'top',
    );
    const paneBorderFormat = windowSetValue(
      'tmux-play-timers:0',
      'pane-border-format',
    );
    expect(paneBorderFormat).toContain('#{pane_title}');
    // TMUX-048: only the Captain pane (index 0) carries the blue highlight
    // block, and only while active. The else branch carries Mocha text on
    // the mantle surface — every other pane (inactive Captain, active
    // player, inactive player) reads against the theme's own surface band.
    expect(paneBorderFormat).toContain(
      '#{?#{&&:#{pane_active},#{e|==:#{pane_index},0}},#[fg=#1e1e2e]#[bg=#89b4fa]#[bold],#[fg=#cdd6f4]#[bg=#181825]}',
    );
    // After the title the row continues on Mocha mantle through the timer.
    expect(paneBorderFormat).toContain(
      ' #{pane_title} #[fg=#cdd6f4]#[bg=#181825]#[nobold] ',
    );
    expect(paneBorderFormat).toContain(`#{${TMUX_PANE_TIMER_ACCENT_OPTION}}`);
    expect(paneBorderFormat).toContain(`#{${TMUX_PANE_TIMER_TEXT_OPTION}}`);
    expect(paneBorderFormat).toContain(
      `#{==:#{${TMUX_PANE_TIMER_RUNNING_OPTION}},1}`,
    );
    // TMUX-054: frozen timer color is subtext1, picked for legibility on
    // the Mocha mantle surface the pane-border row carries.
    expect(paneBorderFormat).toContain(
      `#{?#{==:#{${TMUX_PANE_TIMER_RUNNING_OPTION}},1},#[fg=#{${TMUX_PANE_TIMER_ACCENT_OPTION}}],#[fg=#bac2de]}`,
    );
    expect(paneBorderFormat).toContain('⏳');
    expect(paneBorderFormat).toContain('⌛');
    expect(paneBorderFormat).toContain('#bac2de');
    // Symmetry: one space leads the title (' #{pane_title}') and one
    // space trails the timer text before the closing #[default] reset.
    expect(paneBorderFormat).toContain(
      `#{${TMUX_PANE_TIMER_TEXT_OPTION}} #[default]`,
    );
    expect(paneBorderFormat.indexOf('⏳')).toBeLessThan(
      paneBorderFormat.indexOf(
        `#{?#{==:#{${TMUX_PANE_TIMER_RUNNING_OPTION}},1},#[fg=`,
      ),
    );

    const statusLeft = setValue('tmux-play-timers', 'status-left');
    expect(statusLeft).toContain('tmux-play');
    // TMUX-063: status-left advertises direct pane switching and the ESC
    // stop / Ctrl+C exit shortcuts. The retired Ctrl+b prefix mentions
    // (`d=detach`, `o=switch pane`, `[=scroll`) are gone.
    expect(statusLeft).toContain('Switch pane: Ctrl+←/→');
    expect(statusLeft).toContain('Stop: ESC');
    expect(statusLeft).toContain('Exit: Ctrl+C');
    expect(statusLeft).toContain('drag=select');
    expect(statusLeft).toContain('right-click=copy');
    expect(statusLeft).not.toContain('d=detach');
    expect(statusLeft).not.toContain('o=switch pane');
    expect(statusLeft).not.toContain('[=scroll');
    expect(setValue('tmux-play-timers', 'status-left-length')).toBe('136');

    const statusRight = setValue('tmux-play-timers', 'status-right');
    expect(statusRight).toContain('⏳');
    expect(statusRight).toContain('⌛');
    expect(statusRight).toContain(
      `#{?#{==:#{${TMUX_STATUS_TIMER_RUNNING_OPTION}},1},⏳,⌛}`,
    );
    expect(statusRight).toContain(`#{${TMUX_STATUS_TIMER_TEXT_OPTION}}`);
    expect(statusRight).toContain(
      `#{==:#{${TMUX_STATUS_TIMER_RUNNING_OPTION}},1}`,
    );
    expect(statusRight).toContain(
      `#{?#{==:#{${TMUX_STATUS_TIMER_RUNNING_OPTION}},1},#[fg=#cba6f7],#[fg=#7f849c]}`,
    );
    expect(statusRight).toContain('#cba6f7');
    expect(statusRight).toContain('#7f849c');
    // The hourglass conditional precedes the color conditional.
    expect(
      statusRight.indexOf(
        `#{?#{==:#{${TMUX_STATUS_TIMER_RUNNING_OPTION}},1},⏳,⌛}`,
      ),
    ).toBeLessThan(
      statusRight.indexOf(
        `#{?#{==:#{${TMUX_STATUS_TIMER_RUNNING_OPTION}},1},#[fg=`,
      ),
    );
    expect(setValue('tmux-play-timers', 'status-right-length')).toBe('32');
    expect(setValue('tmux-play-timers', 'window-status-format')).toBe('');
    expect(setValue('tmux-play-timers', 'window-status-current-format')).toBe('');
    expect(setValue('tmux-play-timers', 'window-status-separator')).toBe('');
  });

  it('configures the resize hook for a single-player session', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['solo']);
    const workDir = join(tempDir, 'work');

    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'one',
      workDir,
      selfBin: '/tmp/cli.js',
      attach: false,
    });

    const expectedHookCmd =
      `run-shell -b "W=$(tmux display-message -t tmux-play-one -p '#{window_width}')` +
      ` && tmux resize-pane -t tmux-play-one:0.0 -x $((W / 2 - 1))"`;
    expect(runTmuxMock).toHaveBeenCalledWith(
      'set-hook',
      '-t',
      'tmux-play-one',
      'client-resized',
      expectedHookCmd,
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'set-hook',
      '-t',
      'tmux-play-one',
      'after-resize-window',
      expectedHookCmd,
    );
  });

  it.each([
    {
      count: 4,
      players: ['r1', 'r2', 'r3', 'r4'],
      expected: [
        ['split-window', '-h', '-l', '160', '-t', 'tmux-play-grid4', 'r1'],
        ['split-window', '-h', '-l', '50%', '-t', 'tmux-play-grid4:0.1', 'r3'],
        ['split-window', '-v', '-t', 'tmux-play-grid4:0.1', 'r2'],
        ['split-window', '-v', '-t', 'tmux-play-grid4:0.2', 'r4'],
      ],
    },
    {
      count: 5,
      players: ['r1', 'r2', 'r3', 'r4', 'r5'],
      expected: [
        ['split-window', '-h', '-l', '160', '-t', 'tmux-play-grid5', 'r1'],
        ['split-window', '-h', '-l', '50%', '-t', 'tmux-play-grid5:0.1', 'r4'],
        ['split-window', '-v', '-t', 'tmux-play-grid5:0.1', 'r2'],
        ['split-window', '-v', '-t', 'tmux-play-grid5:0.3', 'r3'],
        ['split-window', '-v', '-t', 'tmux-play-grid5:0.2', 'r5'],
      ],
    },
  ])(
    'creates columns before rows for $count players',
    async ({ count, players, expected }) => {
      tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
      const configPath = writeConfig(tempDir, players);
      const workDir = join(tempDir, 'work');

      await launchTmuxPlay({
        cwd: tempDir,
        configPath,
        sessionId: `grid${count}`,
        workDir,
        selfBin: '/tmp/cli.js',
        attach: false,
      });

      expect(splitWindowCalls(workDir, players)).toEqual(expected);
    },
  );

  it('attaches to the session by default', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['coder']);

    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'def456',
      workDir: join(tempDir, 'work'),
      selfBin: '/tmp/cli.js',
    });

    expect(attachTmuxSessionMock).toHaveBeenCalledWith('tmux-play-def456');
  });

  it('requests a 240x67 terminal resize before attach', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['coder']);
    const stdout = new MemoryOutput();
    let stdoutAtAttach: string | undefined;
    attachTmuxSessionMock.mockImplementation(() => {
      stdoutAtAttach = stdout.text();
    });

    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'resize',
      workDir: join(tempDir, 'work'),
      selfBin: '/tmp/cli.js',
      stdout,
    });

    expect(attachTmuxSessionMock).toHaveBeenCalledWith('tmux-play-resize');
    expect(stdout.text()).toContain('\x1b[8;67;240t');
    expect(stdoutAtAttach).toContain('\x1b[8;67;240t');
  });

  it('does not request a terminal resize when attach is disabled', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['coder']);
    const stdout = new MemoryOutput();

    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'noattach',
      workDir: join(tempDir, 'work'),
      selfBin: '/tmp/cli.js',
      stdout,
      attach: false,
    });

    expect(attachTmuxSessionMock).not.toHaveBeenCalled();
    expect(stdout.text()).not.toContain('\x1b[8;67;240t');
  });

  it('prints a notice when creating the first-run home config', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const cwd = join(tempDir, 'project');
    const configHome = join(tempDir, 'xdg');
    const workDir = join(tempDir, 'work');
    const stdout = new MemoryOutput();
    mkdirSync(cwd);

    await launchTmuxPlay({
      cwd,
      configHome,
      sessionId: 'fresh',
      workDir,
      selfBin: '/tmp/cli.js',
      stdout,
      attach: false,
    });

    expect(stdout.text()).toContain(
      `Created tmux-play config at ${join(configHome, 'tmux-play/config.yaml')}`,
    );
    expect(existsSync(join(configHome, 'tmux-play/config.yaml'))).toBe(true);
  });

  it('warns when ignoring a legacy cwd config', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const cwd = join(tempDir, 'project');
    const configHome = join(tempDir, 'xdg');
    const workDir = join(tempDir, 'work');
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    mkdirSync(cwd);
    const legacyConfig = join(cwd, 'tmux-play.config.json');
    writeFileSync(legacyConfig, '{}');

    await launchTmuxPlay({
      cwd,
      configHome,
      sessionId: 'legacy',
      workDir,
      selfBin: '/tmp/cli.js',
      stdout,
      stderr,
      attach: false,
    });

    expect(stderr.text()).toContain(
      `Found legacy tmux-play config at ${legacyConfig}; tmux-play now requires tmux-play.config.yaml. Rename or convert it.`,
    );
  });

  it('fails before config loading when tmux is unavailable', async () => {
    isTmuxAvailableMock.mockReturnValue(false);

    await expect(
      launchTmuxPlay({ configPath: '/missing/config.yaml' }),
    ).rejects.toThrow('tmux is not installed');
    expect(runTmuxMock).not.toHaveBeenCalled();
  });

  it('fails before config loading when glow is unavailable', async () => {
    isGlowAvailableMock.mockReturnValue(false);

    await expect(
      launchTmuxPlay({ configPath: '/missing/config.yaml' }),
    ).rejects.toThrow(
      'glow is not installed — see https://github.com/charmbracelet/glow#installation',
    );
    expect(runTmuxMock).not.toHaveBeenCalled();
  });
});

function writeConfig(dir: string, playerIds: readonly string[]): string {
  const configPath = join(dir, 'tmux-play.config.yaml');
  writeFileSync(
    configPath,
    [
      'captain:',
      "  from: '@sublang/cligent/captains/fanout'",
      '  adapter: claude',
      '  options: {}',
      'players:',
      ...playerIds.flatMap((id) => [
        `  - id: ${id}`,
        '    adapter: codex',
      ]),
      '',
    ].join('\n'),
  );
  return configPath;
}

function tailCommand(workDir: string, playerId: string): string {
  return ['tail', '-f', join(workDir, `${playerId}.log`)]
    .map(shellQuote)
    .join(' ');
}

function splitWindowCalls(
  workDir: string,
  playerIds: readonly string[],
): unknown[][] {
  return runTmuxMock.mock.calls
    .filter((call) => call[0] === 'split-window')
    .map((call) => {
      const playerId =
        playerIds.find((id) => call.at(-1) === tailCommand(workDir, id)) ??
        call.at(-1);
      return [...call.slice(0, -1), playerId];
    });
}

function setValue(sessionName: string, option: string): string {
  const call = runTmuxMock.mock.calls.find(
    (args) => args[0] === 'set' && args[2] === sessionName && args[3] === option,
  );
  const value = call?.[4];
  if (typeof value !== 'string') {
    throw new Error(`Missing ${option} set call for ${sessionName}`);
  }
  return value;
}

function windowSetValue(window: string, option: string): string {
  const call = runTmuxMock.mock.calls.find(
    (args) =>
      args[0] === 'set-window-option' &&
      args[2] === window &&
      args[3] === option,
  );
  const value = call?.[4];
  if (typeof value !== 'string') {
    throw new Error(`Missing ${option} window set call for ${window}`);
  }
  return value;
}

function valueAfter(args: readonly unknown[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  if (typeof value !== 'string') {
    throw new Error(`Missing ${flag} value in tmux args: ${args.join(' ')}`);
  }
  return value;
}
