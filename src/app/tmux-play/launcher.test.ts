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
      '174',
      '-y',
      '49',
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
    // TMUX-028 / TMUX-064: with the shipped multi-player default
    // `columnWeights: [1, 1, 1]` on the 174-cell window, the player area is
    // 116 cells (174 - floor(174 * 1 / 3)) and the second player column is
    // 58 cells (the remainder after subtracting the 58-cell first column).
    expect(runTmuxMock).toHaveBeenNthCalledWith(
      2,
      'split-window',
      '-h',
      '-l',
      '116',
      '-t',
      'tmux-play-abc123',
      tailCommand(workDir, 'coder'),
    );
    expect(runTmuxMock).toHaveBeenNthCalledWith(
      3,
      'split-window',
      '-h',
      '-l',
      '58',
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
    const secondPlayerColumnColumns = Number(
      valueAfter(runTmuxMock.mock.calls[2] ?? [], '-l'),
    );
    expect({
      bossColumns: initialColumns - playerAreaColumns,
      firstPlayerColumnColumns: playerAreaColumns - secondPlayerColumnColumns,
      secondPlayerColumnColumns,
    }).toEqual({
      bossColumns: 58,
      firstPlayerColumnColumns: 58,
      secondPlayerColumnColumns: 58,
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
    // TMUX-044: shell-evaluated `W * w_i / sum(w)` per non-rightmost column.
    // sum([1, 1, 1]) = 3; rightmost column absorbs the remainder.
    const expectedHookCmd =
      `run-shell -b "W=$(tmux display-message -t tmux-play-abc123 -p '#{window_width}')` +
      ` && tmux resize-pane -t tmux-play-abc123:0.0 -x $((W * 1 / 3 - 1))` +
      ` && tmux resize-pane -t tmux-play-abc123:0.1 -x $((W * 1 / 3 - 1))"`;
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
        'copy-pipe',
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
    expect(
      runTmuxMock.mock.calls.some((call) => call.includes('set-clipboard')),
    ).toBe(false);
    const clampedWheelUp = Array.from(
      { length: 5 },
      () =>
        "if -F -t= '#{e|<|:#{scroll_position},#{history_size}}' " +
        "'send-keys -t= -X scroll-up'",
    ).join(' ; ');
    for (const table of ['copy-mode', 'copy-mode-vi']) {
      expect(runTmuxMock).toHaveBeenCalledWith(
        'bind-key',
        '-T',
        table,
        'WheelUpPane',
        'if-shell',
        '-F',
        '#{==:#{session_name},tmux-play-mouse-boundary}',
        clampedWheelUp,
        'send-keys -X -N 5 scroll-up',
      );
    }
    expect(
      runTmuxMock.mock.calls.some(
        (call) =>
          call[0] === 'bind-key' && call.some((arg) => arg === 'WheelDownPane'),
      ),
    ).toBe(false);
    expect(
      runTmuxMock.mock.calls.some(
        (call) =>
          call[0] === 'bind-key' &&
          call[2] === 'root' &&
          call.some((arg) => arg === 'WheelUpPane'),
      ),
    ).toBe(false);
  });

  it('binds MouseDown1Pane in all three key tables to clear any active selection per in-mode pane while preserving copy-mode state and scroll position, per TMUX-068 (supersedes TMUX-066 and TMUX-067)', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    // Two players → Boss/Captain at pane 0, players at panes 1..2.
    // paneCount = 3 so the per-pane iteration covers indices 0, 1, 2.
    const configPath = writeConfig(tempDir, ['coder', 'reviewer']);
    const sessionName = 'tmux-play-click-clears';

    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'click-clears',
      workDir: join(tempDir, 'work'),
      selfBin: '/tmp/cli.js',
      attach: false,
    });

    // TMUX-068: each in-mode pane gets `send-keys -X clear-selection`
    // (not the retired `-X cancel`). clear-selection drops the active
    // selection without exiting copy-mode, so a scrolled-back pane
    // keeps its scroll position while a selection-bearing pane drops
    // only the selection. The per-pane `#{pane_in_mode}` gate avoids
    // tmux's "no key table" error on panes that are not in any mode.
    const condition = `#{==:#{session_name},${sessionName}}`;
    const clearAll = [0, 1, 2]
      .map(
        (i) =>
          `if -F -t ${sessionName}:0.${i} '#{pane_in_mode}' 'send-keys -t ${sessionName}:0.${i} -X clear-selection'`,
      )
      .join(' ; ');

    // root table: true branch chains clear-selection per pane then
    // runs the stock tail `select-pane -t= ; send-keys -M`; false
    // branch is the stock tail verbatim (mouse-aware terminal apps
    // in unrelated sessions on the same server still receive the
    // forwarded click via `send-keys -M`).
    expect(runTmuxMock).toHaveBeenCalledWith(
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
    // copy-mode and copy-mode-vi tables: mode tables consume mouse
    // events without forwarding (no `send-keys -M`); stock tail is
    // bare `select-pane`. The cross-table install is required because
    // tmux dispatches a mouse event through the clicked pane's
    // current key table — a click on a pane already in copy-mode
    // would otherwise miss the root binding.
    for (const table of ['copy-mode', 'copy-mode-vi']) {
      expect(runTmuxMock).toHaveBeenCalledWith(
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

    // Exactly one MouseDown1Pane binding per table — no leftover
    // stale chain alongside the new one. Each iteration installs one
    // bind-key for that table.
    for (const table of ['root', 'copy-mode', 'copy-mode-vi']) {
      const bindings = runTmuxMock.mock.calls.filter(
        (call) =>
          call[0] === 'bind-key' &&
          call[2] === table &&
          call[3] === 'MouseDown1Pane',
      );
      expect(bindings).toHaveLength(1);
    }

    // The TMUX-068 supersession is in part *negative*: no
    // MouseDown1Pane body shall reference `-X cancel`, the retired
    // [TMUX-066] primitive that exits copy-mode entirely and snaps a
    // scrolled-back pane to its live tail. The negative assertion is
    // the static counterpart to the behavioral probe in TTMUX-068.
    for (const call of runTmuxMock.mock.calls) {
      if (
        call[0] !== 'bind-key' ||
        !call.some((arg) => typeof arg === 'string' && arg === 'MouseDown1Pane')
      ) {
        continue;
      }
      for (const arg of call) {
        if (typeof arg !== 'string') continue;
        expect(arg).not.toContain('-X cancel');
      }
    }

    // The per-pane iteration must scale with paneCount: a regression
    // that hard-coded `paneCount = 1` would fail this check on a
    // multi-player session, while a regression that omitted the
    // iteration entirely (the retired TMUX-067 stock-only shape)
    // would also fail. Pin both the per-pane gate and the per-pane
    // send-keys target so neither degrades silently.
    const rootBinding = runTmuxMock.mock.calls.find(
      (call) =>
        call[0] === 'bind-key' &&
        call[2] === 'root' &&
        call[3] === 'MouseDown1Pane',
    );
    expect(rootBinding).toBeDefined();
    const rootTrueBranch = rootBinding?.[7];
    expect(typeof rootTrueBranch).toBe('string');
    for (const i of [0, 1, 2]) {
      expect(rootTrueBranch).toContain(`-t ${sessionName}:0.${i}`);
      expect(rootTrueBranch).toContain(
        `'send-keys -t ${sessionName}:0.${i} -X clear-selection'`,
      );
    }
  });

  it('binds Ctrl+Left/Right and Shift+Left/Right at the root key table for direct pane switching, scoped to the launched session via if-shell', async () => {
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
    // TMUX-063: ship both Ctrl+←/→ and Shift+←/→ so pane switching works
    // out of the box across macOS, Windows, and Linux terminals that may
    // intercept one pair or the other for shell word-movement,
    // workspace switching, etc.
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
    expect(runTmuxMock).toHaveBeenCalledWith(
      'bind-key',
      '-T',
      'root',
      'S-Left',
      'if-shell',
      '-F',
      condition,
      'select-pane -L',
      'send-keys S-Left',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'bind-key',
      '-T',
      'root',
      'S-Right',
      'if-shell',
      '-F',
      condition,
      'select-pane -R',
      'send-keys S-Right',
    );
  });

  it('binds Ctrl+C in root, copy-mode, and copy-mode-vi with a cancel-then-forward true branch and per-table stock false branch, scoped via if-shell to the launched session', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['coder']);

    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'exit-key',
      workDir: join(tempDir, 'work'),
      selfBin: '/tmp/cli.js',
      attach: false,
    });

    // TTMUX-065: player panes have pane-input-off=1, so a press of Ctrl+C
    // in a player pane is normally swallowed; and once any pane is
    // scrolled back into copy-mode, C-c is dispatched through the
    // copy-mode / copy-mode-vi key table (stock `send-keys -X cancel`),
    // not root. The binding is installed in all three tables so a single
    // press quits from any pane in any mode. Each true branch first exits
    // pane 0's copy-mode when pane 0 is itself scrolled (otherwise the
    // forwarded C-c is consumed by copy-mode's stock cancel) and then
    // forwards the byte to pane 0, where the Captain process runs the
    // existing SIGINT lifecycle from TMUX-026. Each false branch
    // reproduces that table's stock binding verbatim so other tmux
    // sessions on the same server are unaffected.
    const condition = '#{==:#{session_name},tmux-play-exit-key}';
    const trueBranch =
      "if -F -t tmux-play-exit-key:0.0 '#{pane_in_mode}' " +
      "'send-keys -t tmux-play-exit-key:0.0 -X cancel' ; " +
      'send-keys -t tmux-play-exit-key:0.0 C-c';
    expect(runTmuxMock).toHaveBeenCalledWith(
      'bind-key',
      '-T',
      'root',
      'C-c',
      'if-shell',
      '-F',
      condition,
      trueBranch,
      'send-keys C-c',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'bind-key',
      '-T',
      'copy-mode',
      'C-c',
      'if-shell',
      '-F',
      condition,
      trueBranch,
      'send-keys -X cancel',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'bind-key',
      '-T',
      'copy-mode-vi',
      'C-c',
      'if-shell',
      '-F',
      condition,
      trueBranch,
      'send-keys -X cancel',
    );
  });

  it('binds Escape in root, copy-mode, and copy-mode-vi with a cancel-then-forward true branch and per-table stock false branch, mirroring the Ctrl+C pattern (TMUX-070)', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = writeConfig(tempDir, ['coder']);

    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'esc-key',
      workDir: join(tempDir, 'work'),
      selfBin: '/tmp/cli.js',
      attach: false,
    });

    // TTMUX-070: ESC pressed on a player pane is swallowed by
    // pane-input-off=1; ESC pressed on any pane scrolled back into
    // copy-mode hits the stock `Escape` binding first (emacs-mode
    // `-X cancel`, vi-mode `-X clear-selection`). The binding is installed
    // in all three tables so a bare ESC reaches pane 0 from any pane in any
    // mode. Each true branch first exits pane 0's copy-mode when pane 0 is
    // itself scrolled (otherwise the forwarded Escape is consumed by
    // copy-mode's stock cancel) and then forwards the byte to pane 0, where
    // the existing TMUX-057 readline keypress handler calls
    // `abortActiveTurn('ESC')`.
    //
    // Each false branch reproduces that table's *exact* stock binding
    // verbatim, and the stocks differ between `copy-mode` and
    // `copy-mode-vi` for Escape specifically: emacs-mode `Escape` →
    // `-X cancel` (exit copy-mode), vi-mode `Escape` → `-X clear-selection`
    // (leave visual selection without leaving copy-mode; vi users press `q`
    // to exit). Because tmux key tables are server-global, collapsing the
    // vi-mode false branch to `-X cancel` would silently snap every
    // unrelated vi-mode user's scrolled pane back to its live tail on
    // Escape — the same scroll-snapping regression class TMUX-068
    // enumerated for mouse events.
    const condition = '#{==:#{session_name},tmux-play-esc-key}';
    const trueBranch =
      "if -F -t tmux-play-esc-key:0.0 '#{pane_in_mode}' " +
      "'send-keys -t tmux-play-esc-key:0.0 -X cancel' ; " +
      'send-keys -t tmux-play-esc-key:0.0 Escape';
    expect(runTmuxMock).toHaveBeenCalledWith(
      'bind-key',
      '-T',
      'root',
      'Escape',
      'if-shell',
      '-F',
      condition,
      trueBranch,
      'send-keys Escape',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'bind-key',
      '-T',
      'copy-mode',
      'Escape',
      'if-shell',
      '-F',
      condition,
      trueBranch,
      'send-keys -X cancel',
    );
    expect(runTmuxMock).toHaveBeenCalledWith(
      'bind-key',
      '-T',
      'copy-mode-vi',
      'Escape',
      'if-shell',
      '-F',
      condition,
      trueBranch,
      'send-keys -X clear-selection',
    );

    // Exactly one Escape binding per table — no stale leftover chain
    // alongside the new one.
    for (const table of ['root', 'copy-mode', 'copy-mode-vi']) {
      const bindings = runTmuxMock.mock.calls.filter(
        (call) =>
          call[0] === 'bind-key' && call[2] === table && call[3] === 'Escape',
      );
      expect(bindings).toHaveLength(1);
    }
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
    expect(commandIndexOf('pane-border-format')).toBeGreaterThan(
      lastThemeIndex,
    );
    expect(commandIndexOf('status-left')).toBeGreaterThan(lastThemeIndex);
    expect(commandIndexOf('status-right')).toBeGreaterThan(lastThemeIndex);
    expect(commandIndexOf('window-status-format')).toBeGreaterThan(
      lastThemeIndex,
    );
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
        readFileSync(join(attachedWorkDir, TMUX_PLAY_CONFIG_SNAPSHOT), 'utf8'),
      ).theme,
    ).toBe('latte');
  });

  it('parses OSC 11 RGB replies with BEL or ST terminators', () => {
    expect(parseOsc11BackgroundFlavor('\x1b]11;rgb:00/00/00\x07')).toBe(
      'mocha',
    );
    expect(parseOsc11BackgroundFlavor('\x1b]11;rgb:eeee/eeee/eeee\x1b\\')).toBe(
      'latte',
    );
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
      // TMUX-071: launcher seeds every per-pane timer with the
      // canonical zero rendering `00:00:00`, not the retired `0s`
      // literal, so the surface a Boss sees at launch matches the
      // hh:mm:ss form before any `TimingObserver` record arrives.
      expect(runTmuxMock).toHaveBeenCalledWith(
        'set-option',
        '-p',
        '-t',
        pane,
        TMUX_PANE_TIMER_TEXT_OPTION,
        '00:00:00',
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
    // TMUX-071: same zero rendering for the status-bar total timer.
    expect(runTmuxMock).toHaveBeenCalledWith(
      'set-option',
      '-t',
      'tmux-play-timers',
      TMUX_STATUS_TIMER_TEXT_OPTION,
      '00:00:00',
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
    // TMUX-055: status-left opens with the bold-blue `Cligent` brand heading.
    expect(statusLeft).toContain('Cligent');
    // TMUX-063: status-left advertises direct pane switching and the ESC
    // stop / Ctrl+C exit shortcuts. The retired Ctrl+b prefix mentions
    // (`d=detach`, `o=switch pane`, `[=scroll`) are gone.
    expect(statusLeft).toContain('Switch pane: Ctrl+←/→ or Shift+←/→');
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
    expect(setValue('tmux-play-timers', 'window-status-current-format')).toBe(
      '',
    );
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

    // TMUX-044: single-player default weights `[1, 1]` (sum = 2). The rightmost
    // player pane absorbs the remainder; only pane 0 needs an explicit resize.
    const expectedHookCmd =
      `run-shell -b "W=$(tmux display-message -t tmux-play-one -p '#{window_width}')` +
      ` && tmux resize-pane -t tmux-play-one:0.0 -x $((W * 1 / 2 - 1))"`;
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

  it('rejects decimal layout.columnWeights before emitting any tmux call', async () => {
    // TMUX-064: decimal weights would interpolate raw into the TMUX-044
    // POSIX shell-arithmetic hook (`$((W * 0.5 / 1.5 - 1))`), which is a
    // syntax error in /bin/sh and dash. Loader-time rejection is the only
    // safeguard — if it ever regressed, the launcher would emit a broken
    // hook silently and the post-creation resize invariant would die after
    // the first window resize. This test pins the launcher path: the
    // failure must surface before any `runTmux` call, so the broken hook
    // can't reach a real shell.
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = join(tempDir, 'tmux-play.config.yaml');
    writeFileSync(
      configPath,
      [
        'layout:',
        '  columnWeights:',
        '    - 4',
        '    - 0.5',
        '    - 6',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '  - id: reviewer',
        '    adapter: claude',
        '',
      ].join('\n'),
    );

    await expect(
      launchTmuxPlay({
        cwd: tempDir,
        configPath,
        sessionId: 'decimal-weight',
        workDir: join(tempDir, 'work'),
        selfBin: '/tmp/cli.js',
        attach: false,
      }),
    ).rejects.toThrow('layout.columnWeights[1] must be a positive integer');
    expect(runTmuxMock).not.toHaveBeenCalled();
  });

  it('threads an explicit layout override into new-session, splits, hook, and CSI 8', async () => {
    // TMUX-035 / TMUX-043 / TMUX-044 / TMUX-064: a YAML override of
    // layout.window and layout.columnWeights must reach every launcher
    // surface (new-session -x/-y, split-window -l sizes, the resize hook
    // formula, and the pre-attach CSI 8 payload) from the same source of
    // truth. Concretely: window 200x50 with weights [3, 5, 7] (sum = 15).
    //
    // Boss region   = floor(200 * 3 / 15) = 40
    // Player area   = 200 - 40 = 160
    // First column  = floor(200 * 5 / 15) = 66
    // Second column = 160 - 66 = 94  (rightmost, absorbs remainder)
    tempDir = mkdtempSync(join(tmpdir(), 'cligent-launcher-'));
    const configPath = join(tempDir, 'tmux-play.config.yaml');
    writeFileSync(
      configPath,
      [
        'layout:',
        '  window:',
        '    columns: 200',
        '    rows: 50',
        '  columnWeights:',
        '    - 3',
        '    - 5',
        '    - 7',
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        'players:',
        '  - id: coder',
        '    adapter: codex',
        '  - id: reviewer',
        '    adapter: claude',
        '',
      ].join('\n'),
    );
    const workDir = join(tempDir, 'work');
    const stdout = new MemoryOutput();
    let stdoutAtAttach: string | undefined;
    attachTmuxSessionMock.mockImplementation(() => {
      stdoutAtAttach = stdout.text();
    });

    await launchTmuxPlay({
      cwd: tempDir,
      configPath,
      sessionId: 'override',
      workDir,
      selfBin: '/tmp/cli.js',
      stdout,
    });

    const newSessionCall = runTmuxMock.mock.calls.find(
      (call) => call[0] === 'new-session',
    );
    expect(valueAfter(newSessionCall ?? [], '-x')).toBe('200');
    expect(valueAfter(newSessionCall ?? [], '-y')).toBe('50');

    const splits = runTmuxMock.mock.calls.filter(
      (call) => call[0] === 'split-window' && call[1] === '-h',
    );
    expect(valueAfter(splits[0] ?? [], '-l')).toBe('160'); // player area
    expect(valueAfter(splits[1] ?? [], '-l')).toBe('94'); // second column (remainder)

    const expectedHookCmd =
      `run-shell -b "W=$(tmux display-message -t tmux-play-override -p '#{window_width}')` +
      ` && tmux resize-pane -t tmux-play-override:0.0 -x $((W * 3 / 15 - 1))` +
      ` && tmux resize-pane -t tmux-play-override:0.1 -x $((W * 5 / 15 - 1))"`;
    expect(runTmuxMock).toHaveBeenCalledWith(
      'set-hook',
      '-t',
      'tmux-play-override',
      'client-resized',
      expectedHookCmd,
    );

    // TMUX-043: pre-attach CSI 8 payload reads the same layout.window, so an
    // override of `columns: 200, rows: 50` writes `\x1b[8;50;200t` rather
    // than the default 174x49 sequence — preventing tmux's `window-size`
    // negotiation from silently overriding the override on attach.
    expect(stdout.text()).toContain('\x1b[8;50;200t');
    expect(stdout.text()).not.toContain('\x1b[8;49;174t');
    expect(stdoutAtAttach).toContain('\x1b[8;50;200t');
  });

  it.each([
    {
      count: 4,
      players: ['r1', 'r2', 'r3', 'r4'],
      expected: [
        // `[1, 1, 1]` multi default on a 174-cell window: player area = 116,
        // second-column = 58 (remainder of the player area).
        ['split-window', '-h', '-l', '116', '-t', 'tmux-play-grid4', 'r1'],
        ['split-window', '-h', '-l', '58', '-t', 'tmux-play-grid4:0.1', 'r3'],
        ['split-window', '-v', '-t', 'tmux-play-grid4:0.1', 'r2'],
        ['split-window', '-v', '-t', 'tmux-play-grid4:0.2', 'r4'],
      ],
    },
    {
      count: 5,
      players: ['r1', 'r2', 'r3', 'r4', 'r5'],
      expected: [
        ['split-window', '-h', '-l', '116', '-t', 'tmux-play-grid5', 'r1'],
        ['split-window', '-h', '-l', '58', '-t', 'tmux-play-grid5:0.1', 'r4'],
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

  it('requests a 174x49 terminal resize before attach', async () => {
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
    expect(stdout.text()).toContain('\x1b[8;49;174t');
    expect(stdoutAtAttach).toContain('\x1b[8;49;174t');
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
    expect(stdout.text()).not.toContain('\x1b[8;49;174t');
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
      ...playerIds.flatMap((id) => [`  - id: ${id}`, '    adapter: codex']),
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
    (args) =>
      args[0] === 'set' && args[2] === sessionName && args[3] === option,
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
