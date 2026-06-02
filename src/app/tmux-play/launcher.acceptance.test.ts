// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEvent } from '../../events.js';
import { isGlowAvailable } from '../shared/glow.js';
import { shellQuote } from '../shared/shell.js';
import { isTmuxAvailable } from '../shared/tmux.js';
import { launchTmuxPlay } from './launcher.js';
import {
  mapAgentOptionsToClaudeQueryOptions,
  mapPermissionsToClaudeOptions,
} from '../../adapters/claude-code.js';
import {
  mapAgentOptionsToCodexOptions,
  mapPermissionsToCodexOptions,
} from '../../adapters/codex.js';
import {
  buildGeminiSettings,
  GEMINI_REASONING_EFFORT_ALIAS,
  mapAgentOptionsToGeminiCommand,
} from '../../adapters/gemini.js';
import { mapReasoningEffortToOpenCodeVariant } from '../../adapters/opencode.js';
import { loadTmuxPlayConfig } from './config.js';
import { createTmuxPlayRuntime } from './runtime.js';
import { createFollowObserver } from './follow-observer.js';
import { createTmuxPresenter } from './presenter-tmux.js';
import {
  closeLogStreams,
  logFilePath,
  openAppendLogStreams,
} from '../shared/logs.js';
import { TimingObserver, type TimingScheduler } from './timing-observer.js';
import {
  TMUX_PANE_TIMER_ACCENT_OPTION,
  TMUX_PANE_TIMER_RUNNING_OPTION,
  TMUX_PANE_TIMER_TEXT_OPTION,
  TMUX_STATUS_TIMER_RUNNING_OPTION,
  TMUX_STATUS_TIMER_TEXT_OPTION,
} from './timer-options.js';
import type { Captain } from './contract.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentOptions,
  AgentType,
} from '../../types.js';
import type { TmuxPlayRecord } from './records.js';
import type { PlayerAdapterImports } from './players.js';

interface PaneRow {
  readonly index: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly inputOff: string;
  readonly active: string;
}

// TTMUX-030..036 and TTMUX-039 all drive `launchTmuxPlay`, which gates on
// `glow` per TMUX-051 in addition to `tmux`. Skip both ways so a runner
// with one tool but not the other reports a clean skip, not a launcher
// throw masquerading as a test failure.
const TMUX_AVAILABLE = isTmuxAvailable();
const GLOW_AVAILABLE = isGlowAvailable();
const acceptanceIt = TMUX_AVAILABLE && GLOW_AVAILABLE ? it : it.skip;
const EXPECT_AVAILABLE = isCommandAvailable('expect', ['-v']);
const mouseDispatchIt =
  TMUX_AVAILABLE && GLOW_AVAILABLE && EXPECT_AVAILABLE ? it : it.skip;

const BUILT_CLI_PATH = join(
  process.cwd(),
  'dist/app/tmux-play/cli.js',
);

describe('tmux-play real-tmux acceptance', () => {
  let sessionName: string | undefined;
  let workDir: string | undefined;
  let cwd: string | undefined;

  afterEach(() => {
    if (sessionName) {
      spawnSync('tmux', ['kill-session', '-t', sessionName], {
        stdio: 'ignore',
      });
      sessionName = undefined;
    }
    for (const dir of [workDir, cwd]) {
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    workDir = undefined;
    cwd = undefined;
  });

  acceptanceIt(
    'preserves the weighted region split across forced window resizes',
    async () => {
      cwd = mkdtempSync(join(tmpdir(), 'tmux-play-accept-cwd-'));
      workDir = mkdtempSync(join(tmpdir(), 'tmux-play-accept-work-'));
      const configPath = join(cwd, 'tmux-play.config.yaml');
      writeFileSync(configPath, defaultYamlConfig());

      const result = await launchTmuxPlay({
        cwd,
        configPath,
        sessionId: `accept-${randomBytes(4).toString('hex')}`,
        workDir,
        selfBin: BUILT_CLI_PATH,
        attach: false,
      });
      sessionName = result.sessionName;

      // Lock the size so resize-window calls are honored end-to-end.
      runOrThrow('tmux', [
        'set-window-option',
        '-t',
        sessionName,
        'window-size',
        'manual',
      ]);

      for (const [width, height] of [
        [174, 49],
        [80, 24],
        [160, 40],
        [200, 50],
      ] as const) {
        runOrThrow('tmux', [
          'resize-window',
          '-t',
          sessionName,
          '-x',
          String(width),
          '-y',
          String(height),
        ]);
        // TMUX-044 / TMUX-064: shipped multi-player default weights
        // `[1, 1, 1]` (sum = 3). Each non-rightmost column gets
        // `floor(W * w_i / sum)`; the rightmost absorbs the remainder.
        const captainExpected = Math.floor(width / 3);
        const coderExpected = Math.floor(width / 3);
        const reviewerExpected = width - captainExpected - coderExpected;
        const panes = await waitForRegions(
          sessionName,
          [captainExpected, coderExpected, reviewerExpected],
          2_000,
        );
        const captain = paneByTitle(panes, 'Captain · claude');
        const coder = paneByTitle(panes, 'Coder · codex');
        const reviewer = paneByTitle(panes, 'Reviewer · claude');
        const captainRegion = coder.left - captain.left;
        const coderRegion = reviewer.left - coder.left;
        const reviewerRegion = width - reviewer.left;
        expect(
          { width, captainRegion, coderRegion, reviewerRegion },
        ).toEqual({
          width,
          captainRegion: captainExpected,
          coderRegion: coderExpected,
          reviewerRegion: reviewerExpected,
        });
      }
    },
    60_000,
  );

  acceptanceIt(
    'creates a 174x49 session with 58/58/58 panes, titled, player panes read-only, Captain active',
    async () => {
      if (!existsSync(BUILT_CLI_PATH)) {
        throw new Error(
          `Missing ${BUILT_CLI_PATH}; run \`npm run build\` before the acceptance suite.`,
        );
      }

      cwd = mkdtempSync(join(tmpdir(), 'tmux-play-accept-cwd-'));
      workDir = mkdtempSync(join(tmpdir(), 'tmux-play-accept-work-'));
      const configPath = join(cwd, 'tmux-play.config.yaml');
      writeFileSync(configPath, defaultYamlConfig());

      const result = await launchTmuxPlay({
        cwd,
        configPath,
        sessionId: `accept-${randomBytes(4).toString('hex')}`,
        workDir,
        selfBin: BUILT_CLI_PATH,
        attach: false,
      });
      sessionName = result.sessionName;

      // TTMUX-030: 174x49 grid
      expect(displayMessage(sessionName, '#{window_width}x#{window_height}'))
        .toBe('174x49');

      const panes = listPanes(sessionName);
      expect(panes).toHaveLength(3);

      const captain = paneByTitle(panes, 'Captain · claude');
      const coder = paneByTitle(panes, 'Coder · codex');
      const reviewer = paneByTitle(panes, 'Reviewer · claude');

      // TTMUX-031 / TMUX-064: shipped multi-player default weights `[1, 1, 1]`
      // (sum = 3) on the 174-cell window yield regions 58/58/58. Two 1-cell
      // right-side separators eat 1 col from captain (border with coder) and
      // 1 col from coder (border with reviewer). pane_left advances by the
      // region (pane content + 1-cell border on non-rightmost panes), so
      // coder.left = 58 and reviewer.left = 58 + 58 = 116.
      expect(captain.left).toBe(0);
      expect(captain.width).toBe(57);
      expect(coder.left).toBe(58);
      expect(coder.width).toBe(57);
      expect(reviewer.left).toBe(116);
      expect(reviewer.width).toBe(58);

      // TTMUX-032 + TTMUX-040: pane titles carry `· <adapter>`.
      expect(captain.title).toBe('Captain · claude');
      expect(coder.title).toBe('Coder · codex');
      expect(reviewer.title).toBe('Reviewer · claude');

      // TTMUX-033: player panes read-only, captain pane writable
      expect(captain.inputOff).toBe('0');
      expect(coder.inputOff).toBe('1');
      expect(reviewer.inputOff).toBe('1');

      // TTMUX-036: startup focus
      expect(captain.active).toBe('1');
      expect(coder.active).toBe('0');
      expect(reviewer.active).toBe('0');

      // TTMUX-062: pane-local mouse selection is enabled for this session.
      expect(showSessionOption(sessionName, 'mouse')).toBe('on');
      expect(keyBinding('copy-mode', 'MouseDragEnd1Pane')).toContain(
        'stop-selection',
      );
      expect(keyBinding('copy-mode-vi', 'MouseDragEnd1Pane')).toContain(
        'stop-selection',
      );
      for (const table of ['copy-mode', 'copy-mode-vi']) {
        const rightClickCopyBinding = keyBinding(table, 'MouseDown3Pane');
        // TMUX-062: `copy-pipe` (not `copy-pipe-and-cancel`) preserves
        // the clicked pane's scroll position after copy. Pin the
        // primitive precisely so a regression to the scroll-snapping
        // `copy-pipe-and-cancel` variant fails the assertion.
        expect(rightClickCopyBinding).toMatch(/\bcopy-pipe\b/);
        expect(rightClickCopyBinding).not.toContain('copy-pipe-and-cancel');
        expect(rightClickCopyBinding).toContain('pbcopy');
        expect(rightClickCopyBinding).toContain('wl-copy');
        expect(rightClickCopyBinding).toContain('xclip');
        expect(rightClickCopyBinding).toContain('xsel');
        expect(rightClickCopyBinding).toContain('clip.exe');
        expect(rightClickCopyBinding).toContain('tmux load-buffer -w -');
      }

      // TTMUX-068 (supersedes TTMUX-066 / TTMUX-067): the launcher
      // installs a session-scoped MouseDown1Pane override that
      // chains `send-keys -X clear-selection` per in-mode pane
      // before the per-table stock tail. `clear-selection` drops the
      // active selection without exiting copy-mode, so a click
      // anywhere releases any active selection while every
      // scrolled-back pane keeps its scroll position. The retired
      // `-X cancel` primitive (TMUX-066) exited copy-mode entirely
      // and snapped scrolled panes to the live tail; the retired
      // stock-only install (TMUX-067) preserved scroll but never
      // cleared selections. clear-selection is the tmux primitive
      // that splits the two effects.
      for (const table of ['root', 'copy-mode', 'copy-mode-vi']) {
        const mouseDown1 = keyBinding(table, 'MouseDown1Pane');
        expect(mouseDown1).toContain('if-shell');
        expect(mouseDown1).toContain('session_name');
        expect(mouseDown1).toContain(sessionName);
        expect(mouseDown1).toContain('pane_in_mode');
        expect(mouseDown1).toContain('clear-selection');
        expect(mouseDown1).not.toContain('-X cancel');
        expect(mouseDown1).toContain('select-pane');
      }
      // Only the root binding forwards the mouse event via
      // `send-keys -M` so mouse-aware terminal apps still receive it;
      // the copy-mode tables consume the event without forwarding.
      expect(keyBinding('root', 'MouseDown1Pane')).toContain('send-keys -M');
      for (const table of ['copy-mode', 'copy-mode-vi']) {
        // The mode-table bodies still mention `send-keys` in the
        // per-pane `send-keys -t ... -X clear-selection` clauses, so
        // assert the absence of the trailing `send-keys -M` forward
        // (which is the root-table-only behavior) rather than the
        // word `send-keys` itself.
        expect(keyBinding(table, 'MouseDown1Pane')).not.toContain(
          ' -M',
        );
      }

      // TTMUX-068 behavioral probe: pin the observable consequence,
      // not only the binding string. Asserting only the binding
      // strings is what allowed TTMUX-067 to land with the
      // click-doesn't-release-selection regression intact.
      //
      // Layout: pane 0 = Boss/Captain (not in copy-mode); pane 1 =
      // Coder (will hold a selection); pane 2 = Reviewer (in copy-mode
      // without a selection). After we execute the binding's
      // clear-selection loop, pane 1 should have no selection but still
      // be in copy-mode, pane 2 should still be in copy-mode, and pane 0
      // should remain not-in-mode. This test pins that clear-selection
      // keeps panes in copy-mode (the inverse of the retired -X cancel,
      // which exited copy-mode and snapped scrolled panes to the tail);
      // the genuine scroll-position-preservation outcome is pinned by the
      // attached-client probe below, on panes scrolled back into real
      // history.
      runOrThrow('tmux', [
        'copy-mode',
        '-t',
        `${sessionName}:0.${coder.index}`,
      ]);
      runOrThrow('tmux', [
        'send-keys',
        '-t',
        `${sessionName}:0.${coder.index}`,
        '-X',
        'begin-selection',
      ]);
      runOrThrow('tmux', [
        'send-keys',
        '-t',
        `${sessionName}:0.${coder.index}`,
        '-X',
        'cursor-right',
      ]);
      runOrThrow('tmux', [
        'send-keys',
        '-t',
        `${sessionName}:0.${coder.index}`,
        '-X',
        'cursor-right',
      ]);
      runOrThrow('tmux', [
        'copy-mode',
        '-t',
        `${sessionName}:0.${reviewer.index}`,
      ]);

      // Sanity: selection in pane 1, copy-mode-without-selection in
      // pane 2, no-mode in pane 0.
      expect(
        displayMessage(
          `${sessionName}:0.${coder.index}`,
          '#{selection_present}',
        ),
      ).toBe('1');
      expect(
        displayMessage(
          `${sessionName}:0.${coder.index}`,
          '#{pane_in_mode}',
        ),
      ).toBe('1');
      expect(
        displayMessage(
          `${sessionName}:0.${reviewer.index}`,
          '#{selection_present}',
        ),
      ).toBe('0');
      expect(
        displayMessage(
          `${sessionName}:0.${reviewer.index}`,
          '#{pane_in_mode}',
        ),
      ).toBe('1');
      expect(
        displayMessage(
          `${sessionName}:0.${captain.index}`,
          '#{pane_in_mode}',
        ),
      ).toBe('0');

      // Execute the per-pane clear-selection loop the binding would
      // run on click. This is the same primitive chain emitted into
      // the MouseDown1Pane true branch — running it directly bypasses
      // tmux's mouse-event dispatch (which requires an attached
      // client in detached/CI environments) while still exercising
      // the user-observable behavior.
      for (const pane of [captain, coder, reviewer]) {
        runOrThrow('tmux', [
          'if',
          '-F',
          '-t',
          `${sessionName}:0.${pane.index}`,
          '#{pane_in_mode}',
          `send-keys -t ${sessionName}:0.${pane.index} -X clear-selection`,
        ]);
      }

      // TTMUX-068 outcome: selection cleared on pane 1; pane 1 still in
      // copy-mode (not snapped out by clear-selection); pane 2 still in
      // copy-mode; pane 0 still not in mode.
      expect(
        displayMessage(
          `${sessionName}:0.${coder.index}`,
          '#{selection_present}',
        ),
      ).toBe('0');
      expect(
        displayMessage(
          `${sessionName}:0.${coder.index}`,
          '#{pane_in_mode}',
        ),
      ).toBe('1');
      expect(
        displayMessage(
          `${sessionName}:0.${reviewer.index}`,
          '#{pane_in_mode}',
        ),
      ).toBe('1');
      expect(
        displayMessage(
          `${sessionName}:0.${captain.index}`,
          '#{pane_in_mode}',
        ),
      ).toBe('0');

      // Clean up the copy-mode state we set on panes 1 and 2 so the
      // rest of the test runs against the live-tail captures the
      // subsequent send-keys probe expects.
      for (const pane of [coder, reviewer]) {
        runOrThrow('tmux', [
          'send-keys',
          '-t',
          `${sessionName}:0.${pane.index}`,
          '-X',
          'cancel',
        ]);
      }

      // TTMUX-063: Ctrl+Left/Right and Shift+Left/Right at the root key
      // table both switch panes directly inside this session. Each
      // binding gates on the session name via if-shell so other tmux
      // sessions on the same server forward the key unchanged.
      const ctrlLeftBinding = keyBinding('root', 'C-Left');
      expect(ctrlLeftBinding).toContain('if-shell');
      expect(ctrlLeftBinding).toContain(`session_name`);
      expect(ctrlLeftBinding).toContain(sessionName);
      expect(ctrlLeftBinding).toContain('select-pane -L');
      expect(ctrlLeftBinding).toContain('send-keys C-Left');
      const ctrlRightBinding = keyBinding('root', 'C-Right');
      expect(ctrlRightBinding).toContain('if-shell');
      expect(ctrlRightBinding).toContain(`session_name`);
      expect(ctrlRightBinding).toContain(sessionName);
      expect(ctrlRightBinding).toContain('select-pane -R');
      expect(ctrlRightBinding).toContain('send-keys C-Right');
      const shiftLeftBinding = keyBinding('root', 'S-Left');
      expect(shiftLeftBinding).toContain('if-shell');
      expect(shiftLeftBinding).toContain(`session_name`);
      expect(shiftLeftBinding).toContain(sessionName);
      expect(shiftLeftBinding).toContain('select-pane -L');
      expect(shiftLeftBinding).toContain('send-keys S-Left');
      const shiftRightBinding = keyBinding('root', 'S-Right');
      expect(shiftRightBinding).toContain('if-shell');
      expect(shiftRightBinding).toContain(`session_name`);
      expect(shiftRightBinding).toContain(sessionName);
      expect(shiftRightBinding).toContain('select-pane -R');
      expect(shiftRightBinding).toContain('send-keys S-Right');

      // TTMUX-065: Ctrl+C is bound in root, copy-mode, and copy-mode-vi
      // so a single press fires the exit lifecycle from any pane in any
      // mode. Player panes are read-only (pane-input-off=1) and would
      // otherwise swallow the key; and once a pane is scrolled back into
      // copy-mode, C-c is dispatched through the copy-mode tables (stock
      // `send-keys -X cancel`), not root, so a root-only binding needed a
      // second press. Each true branch first exits pane 0's copy-mode
      // when pane 0 is itself scrolled (otherwise the forwarded C-c is
      // consumed by copy-mode's stock cancel) and then forwards the byte
      // to pane 0. Each binding gates on the session name via if-shell so
      // other tmux sessions on the same server retain the per-table stock
      // binding (its false branch).
      for (const table of ['root', 'copy-mode', 'copy-mode-vi']) {
        const ctrlCBinding = keyBinding(table, 'C-c');
        expect(ctrlCBinding).toContain('if-shell');
        expect(ctrlCBinding).toContain('session_name');
        expect(ctrlCBinding).toContain(sessionName);
        expect(ctrlCBinding).toContain('pane_in_mode');
        expect(ctrlCBinding).toContain(
          `send-keys -t ${sessionName}:0.0 -X cancel`,
        );
        expect(ctrlCBinding).toContain(`send-keys -t ${sessionName}:0.0 C-c`);
      }
      // The root false branch is the stock `send-keys C-c`; the copy-mode
      // tables' false branch is the stock `send-keys -X cancel`.
      expect(keyBinding('root', 'C-c')).toContain('send-keys C-c');
      expect(keyBinding('copy-mode', 'C-c')).toContain('send-keys -X cancel');
      expect(keyBinding('copy-mode-vi', 'C-c')).toContain(
        'send-keys -X cancel',
      );

      const probe = `probe-${randomBytes(4).toString('hex')}`;
      const sendResult = spawnSync(
        'tmux',
        [
          'send-keys',
          '-t',
          `${sessionName}:0.${coder.index}`,
          probe,
        ],
        { stdio: 'ignore' },
      );
      expect(sendResult.status).toBe(0);

      const capture = capturePane(sessionName, coder.index);
      expect(capture).not.toContain(probe);
    },
    60_000,
  );

  acceptanceIt(
    'copies and clears a scrolled selection without leaving copy-mode (TMUX-062)',
    async () => {
      if (!existsSync(BUILT_CLI_PATH)) {
        throw new Error(
          `Missing ${BUILT_CLI_PATH}; run \`npm run build\` before the acceptance suite.`,
        );
      }

      cwd = mkdtempSync(join(tmpdir(), 'tmux-play-accept-cwd-'));
      workDir = mkdtempSync(join(tmpdir(), 'tmux-play-accept-work-'));
      const configPath = join(cwd, 'tmux-play.config.yaml');
      writeFileSync(configPath, defaultYamlConfig());

      const result = await launchTmuxPlay({
        cwd,
        configPath,
        sessionId: `accept-${randomBytes(4).toString('hex')}`,
        workDir,
        selfBin: BUILT_CLI_PATH,
        attach: false,
      });
      sessionName = result.sessionName;

      const coder = paneByTitle(listPanes(sessionName), 'Coder · codex');
      const target = `${sessionName}:0.${coder.index}`;
      runOrThrow('tmux', [
        'respawn-pane',
        '-k',
        '-t',
        target,
        'seq 1 500; sleep 600',
      ]);
      await waitForHistory(sessionName, coder.index, 100, 2_000);

      runOrThrow('tmux', ['copy-mode', '-t', target]);
      for (let i = 0; i < 6; i += 1) {
        runOrThrow('tmux', ['send-keys', '-t', target, '-X', 'scroll-up']);
      }
      const selectedLine = displayMessage(target, '#{copy_cursor_line}');
      expect(selectedLine).toMatch(/^\d+$/);
      runOrThrow('tmux', ['send-keys', '-t', target, '-X', 'select-line']);

      const scrollBefore = displayMessage(target, '#{scroll_position}');
      expect(Number(scrollBefore)).toBeGreaterThan(0);
      expect(displayMessage(target, '#{selection_present}')).toBe('1');
      expect(displayMessage(target, '#{pane_in_mode}')).toBe('1');

      const copiedPath = join(cwd, 'right-click-copy.txt');
      runOrThrow('tmux', [
        'send-keys',
        '-t',
        target,
        '-X',
        'copy-pipe',
        `cat > ${shellQuote(copiedPath)}`,
      ]);

      const copiedText = await waitForNonEmptyFile(copiedPath, 2_000);
      expect(copiedText.trim()).toBe(selectedLine);
      expect(displayMessage(target, '#{selection_present}')).toBe('0');
      expect(displayMessage(target, '#{pane_in_mode}')).toBe('1');
      expect(displayMessage(target, '#{scroll_position}')).toBe(scrollBefore);
    },
    60_000,
  );

  acceptanceIt(
    'returns a scrolled pane to its live tail when the runtime + presenter write to it, with the written content visible and a sibling pane left scrolled (TMUX-069)',
    async () => {
      if (!existsSync(BUILT_CLI_PATH)) {
        throw new Error(
          `Missing ${BUILT_CLI_PATH}; run \`npm run build\` before the acceptance suite.`,
        );
      }

      cwd = mkdtempSync(join(tmpdir(), 'tmux-play-accept-cwd-'));
      workDir = mkdtempSync(join(tmpdir(), 'tmux-play-accept-work-'));
      const configPath = join(cwd, 'tmux-play.config.yaml');
      writeFileSync(configPath, defaultYamlConfig());

      const result = await launchTmuxPlay({
        cwd,
        configPath,
        sessionId: `accept-${randomBytes(4).toString('hex')}`,
        workDir,
        selfBin: BUILT_CLI_PATH,
        attach: false,
      });
      sessionName = result.sessionName;

      const panes = listPanes(sessionName);
      const coder = paneByTitle(panes, 'Coder · codex');
      const reviewer = paneByTitle(panes, 'Reviewer · claude');
      const coderTarget = `${sessionName}:0.${coder.index}`;
      const reviewerTarget = `${sessionName}:0.${reviewer.index}`;

      // The launched player panes tail `<workDir>/<id>.log`. Respawn each to
      // print scrollback (so a scroll-up reaches a non-zero #{scroll_position})
      // and then re-tail the SAME logfile via `exec`, so a later presenter
      // write to that file still lands in the live pane.
      for (const id of ['coder', 'reviewer'] as const) {
        const target = id === 'coder' ? coderTarget : reviewerTarget;
        runOrThrow('tmux', [
          'respawn-pane',
          '-k',
          '-t',
          target,
          `seq 1 500; exec tail -f ${shellQuote(logFilePath(workDir, id))}`,
        ]);
      }
      await waitForHistory(sessionName, coder.index, 100, 2_000);
      await waitForHistory(sessionName, reviewer.index, 100, 2_000);

      const scrollBack = (target: string): void => {
        runOrThrow('tmux', ['copy-mode', '-t', target]);
        for (let i = 0; i < 6; i += 1) {
          runOrThrow('tmux', ['send-keys', '-t', target, '-X', 'scroll-up']);
        }
        // Guard: a setup that failed to scroll back would pass the
        // pane_in_mode assertions vacuously, so require real scroll-back.
        expect(Number(displayMessage(target, '#{scroll_position}'))).toBeGreaterThan(0);
        expect(displayMessage(target, '#{pane_in_mode}')).toBe('1');
      };

      // Reconstruct the exact observer wiring session.ts installs: the real
      // presenter writing player blocks to the panes' logfiles, then the real
      // follow observer, both registered on (and dispatched by) the real
      // runtime's RecordDispatcher in that order. The follow must run after the
      // presenter has put new bytes on a pane — so a captured marker proves the
      // production write path end-to-end rather than the observer in isolation.
      const playerLogStreams = openAppendLogStreams(workDir, ['coder', 'reviewer']);
      const presenter = createTmuxPresenter({
        boss: { write: () => undefined },
        players: playerLogStreams,
        playerAdapters: new Map([
          ['coder', 'codex'],
          ['reviewer', 'claude'],
        ]),
      });
      const followObserver = createFollowObserver({
        sessionName,
        captainAdapter: 'claude',
        players: [
          { id: 'coder', adapter: 'codex' },
          { id: 'reviewer', adapter: 'claude' },
        ],
        debounceMs: 0,
      });

      // The stub player streams this marker as its only output, so a
      // capture-pane that contains it proves real presenter bytes reached the
      // pane (not merely that copy-mode was exited against an empty tail).
      const marker = `FOLLOW${randomBytes(3).toString('hex').toUpperCase()}`;
      const streamMarker = (agent: AgentType): new () => AgentAdapter =>
        class implements AgentAdapter {
          readonly agent = agent;
          async *run(): AsyncGenerator<AgentEvent, void, void> {
            yield createEvent('text_delta', agent, { delta: marker });
            yield createEvent('done', agent, {
              status: 'success',
              usage: { inputTokens: 0, outputTokens: 0, toolUses: 0 },
              durationMs: 0,
            });
          }
          async isAvailable(): Promise<boolean> {
            return true;
          }
        };
      const adapterImports: PlayerAdapterImports = {
        claude: async () => streamMarker('claude'),
        codex: async () => streamMarker('codex'),
        gemini: async () => streamMarker('gemini'),
        opencode: async () => streamMarker('opencode'),
      };

      // A minimal captain: a turn whose prompt names a player calls just that
      // player; any other prompt (e.g. 'idle') drives no player write.
      const captain: Captain = {
        async handleBossTurn(turn, context): Promise<void> {
          if (turn.prompt === 'coder') {
            await context.callPlayer('coder', 'go');
          }
        },
      };

      const runtime = await createTmuxPlayRuntime({
        captain,
        captainConfig: { adapter: 'claude' },
        players: [
          { id: 'coder', adapter: 'codex' },
          { id: 'reviewer', adapter: 'claude' },
        ],
        observers: [presenter, followObserver],
        adapterImports,
      });

      try {
        // Phase 1: a real player write returns the written (coder) pane to its
        // live tail with the streamed marker visible, while the sibling
        // (reviewer) pane — no output this turn — stays scrolled in place.
        scrollBack(coderTarget);
        scrollBack(reviewerTarget);
        const reviewerScroll = displayMessage(reviewerTarget, '#{scroll_position}');

        await runtime.runBossTurn('coder');

        expect(displayMessage(coderTarget, '#{pane_in_mode}')).toBe('0');
        const coderView = await waitForPaneContains(
          sessionName,
          coder.index,
          marker,
          3_000,
        );
        expect(coderView).toContain(marker);

        expect(displayMessage(reviewerTarget, '#{pane_in_mode}')).toBe('1');
        expect(displayMessage(reviewerTarget, '#{scroll_position}')).toBe(
          reviewerScroll,
        );

        // Phase 2: a turn that writes nothing to the coder pane (no player
        // call) must leave a freshly-scrolled coder pane untouched — the follow
        // fires only on real new output, never on the no-op control records.
        scrollBack(coderTarget);
        const coderScroll = displayMessage(coderTarget, '#{scroll_position}');

        await runtime.runBossTurn('idle');

        expect(displayMessage(coderTarget, '#{pane_in_mode}')).toBe('1');
        expect(displayMessage(coderTarget, '#{scroll_position}')).toBe(coderScroll);
      } finally {
        await runtime.dispose();
        await closeLogStreams(playerLogStreams.values());
      }
    },
    60_000,
  );

  mouseDispatchIt(
    'clears a stopped selection and preserves scroll position through a real attached-client left-click (TMUX-068)',
    async () => {
      if (!existsSync(BUILT_CLI_PATH)) {
        throw new Error(
          `Missing ${BUILT_CLI_PATH}; run \`npm run build\` before the acceptance suite.`,
        );
      }

      cwd = mkdtempSync(join(tmpdir(), 'tmux-play-accept-cwd-'));
      workDir = mkdtempSync(join(tmpdir(), 'tmux-play-accept-work-'));
      const configPath = join(cwd, 'tmux-play.config.yaml');
      writeFileSync(configPath, defaultYamlConfig());

      const result = await launchTmuxPlay({
        cwd,
        configPath,
        sessionId: `mouse-${randomBytes(4).toString('hex')}`,
        workDir,
        selfBin: BUILT_CLI_PATH,
        attach: false,
      });
      sessionName = result.sessionName;

      // Keep the attached expect client at a predictable 80x24 grid so
      // the synthetic SGR mouse coordinate lands inside the reviewer pane.
      runOrThrow('tmux', [
        'set-window-option',
        '-t',
        sessionName,
        'window-size',
        'manual',
      ]);
      runOrThrow('tmux', [
        'resize-window',
        '-t',
        sessionName,
        '-x',
        '80',
        '-y',
        '24',
      ]);
      const captainExpected = Math.floor(80 / 3);
      const coderExpected = Math.floor(80 / 3);
      const reviewerExpected = 80 - captainExpected - coderExpected;
      const panes = await waitForRegions(
        sessionName,
        [captainExpected, coderExpected, reviewerExpected],
        2_000,
      );
      const captain = paneByTitle(panes, 'Captain · claude');
      const coder = paneByTitle(panes, 'Coder · codex');
      const reviewer = paneByTitle(panes, 'Reviewer · claude');

      // The player panes launch with empty scrollback (history_size 0):
      // the acceptance suite runs without adapter API keys, so the adapters
      // stream nothing and there is nothing to scroll back through. But a
      // genuinely scrolled-back pane is exactly the state TMUX-068 must
      // preserve, so seed deterministic history into the two player panes
      // with `respawn-pane`. The MouseDown1Pane binding under test is
      // session- and `pane_in_mode`-gated and independent of what each pane
      // runs, so substituting the pane contents does not weaken the probe;
      // it lets us scroll to a known, non-zero position and assert it
      // survives the click. `respawn-pane` preserves pane geometry and
      // tmux-play's pane title (so the indices captured above stay valid).
      for (const pane of [coder, reviewer]) {
        runOrThrow('tmux', [
          'respawn-pane',
          '-k',
          '-t',
          `${sessionName}:0.${pane.index}`,
          'seq 1 500; sleep 600',
        ]);
      }
      await waitForHistory(sessionName, coder.index, 100, 2_000);
      await waitForHistory(sessionName, reviewer.index, 100, 2_000);

      // Pane A (Coder): scroll back into history, then stop a selection
      // there. Covers TMUX-068's "a pane that holds an active selection
      // shall stay in copy-mode at the same scroll position with the
      // selection cleared".
      runOrThrow('tmux', [
        'select-pane',
        '-t',
        `${sessionName}:0.${coder.index}`,
      ]);
      runOrThrow('tmux', [
        'copy-mode',
        '-t',
        `${sessionName}:0.${coder.index}`,
      ]);
      for (let i = 0; i < 6; i += 1) {
        runOrThrow('tmux', [
          'send-keys',
          '-t',
          `${sessionName}:0.${coder.index}`,
          '-X',
          'scroll-up',
        ]);
      }
      for (const motion of [
        'begin-selection',
        'cursor-right',
        'stop-selection',
      ]) {
        runOrThrow('tmux', [
          'send-keys',
          '-t',
          `${sessionName}:0.${coder.index}`,
          '-X',
          motion,
        ]);
      }

      // Pane B (Reviewer): scroll back into history WITHOUT a selection.
      // Covers TMUX-068's "a pane that is in copy-mode without an active
      // selection (a scrolled-back pane) shall stay in copy-mode at its
      // existing scroll position" — the previously unverified sibling case.
      runOrThrow('tmux', [
        'copy-mode',
        '-t',
        `${sessionName}:0.${reviewer.index}`,
      ]);
      for (let i = 0; i < 9; i += 1) {
        runOrThrow('tmux', [
          'send-keys',
          '-t',
          `${sessionName}:0.${reviewer.index}`,
          '-X',
          'scroll-up',
        ]);
      }

      // Capture pre-click scroll positions. Assert both are non-zero so a
      // setup that failed to scroll back fails loudly instead of letting
      // the preservation assertions below pass vacuously at 0 == 0.
      const coderScrollBefore = displayMessage(
        `${sessionName}:0.${coder.index}`,
        '#{scroll_position}',
      );
      const reviewerScrollBefore = displayMessage(
        `${sessionName}:0.${reviewer.index}`,
        '#{scroll_position}',
      );
      expect(Number(coderScrollBefore)).toBeGreaterThan(0);
      expect(Number(reviewerScrollBefore)).toBeGreaterThan(0);
      expect(
        displayMessage(
          `${sessionName}:0.${coder.index}`,
          '#{selection_present}',
        ),
      ).toBe('1');
      expect(
        displayMessage(`${sessionName}:0.${coder.index}`, '#{pane_in_mode}'),
      ).toBe('1');
      expect(
        displayMessage(
          `${sessionName}:0.${reviewer.index}`,
          '#{selection_present}',
        ),
      ).toBe('0');
      expect(
        displayMessage(`${sessionName}:0.${reviewer.index}`, '#{pane_in_mode}'),
      ).toBe('1');
      expect(
        displayMessage(`${sessionName}:0.${captain.index}`, '#{pane_in_mode}'),
      ).toBe('0');
      // Focus is on Coder (the last select-pane), not on the click target,
      // so the post-click focus assertion proves a real focus change.
      expect(
        displayMessage(`${sessionName}:0.${captain.index}`, '#{pane_active}'),
      ).toBe('0');

      // Drive a real primary-button mouse-down through an attached client
      // inside the Captain pane (not in copy-mode), exercising tmux's actual
      // mouse-event dispatch and key-table routing — not a manual invocation
      // of the binding body.
      sendAttachedClientMouseDown(
        sessionName,
        captain.left + 2,
        captain.top + 2,
      );

      // TMUX-068 outcome through the real click path: Coder's stopped
      // selection is cleared...
      expect(
        displayMessage(
          `${sessionName}:0.${coder.index}`,
          '#{selection_present}',
        ),
      ).toBe('0');
      // ...without leaving copy-mode...
      expect(
        displayMessage(`${sessionName}:0.${coder.index}`, '#{pane_in_mode}'),
      ).toBe('1');
      // ...and at the same scroll position (the user-visible "jumps to the
      // last line" regression that -X cancel caused under TMUX-066).
      expect(
        displayMessage(`${sessionName}:0.${coder.index}`, '#{scroll_position}'),
      ).toBe(coderScrollBefore);
      // The scrolled-back, selection-free sibling keeps copy-mode and scroll.
      expect(
        displayMessage(`${sessionName}:0.${reviewer.index}`, '#{pane_in_mode}'),
      ).toBe('1');
      expect(
        displayMessage(
          `${sessionName}:0.${reviewer.index}`,
          '#{scroll_position}',
        ),
      ).toBe(reviewerScrollBefore);
      expect(
        displayMessage(
          `${sessionName}:0.${reviewer.index}`,
          '#{selection_present}',
        ),
      ).toBe('0');
      // Focus moved to the click target.
      expect(
        displayMessage(`${sessionName}:0.${captain.index}`, '#{pane_active}'),
      ).toBe('1');
    },
    60_000,
  );

  acceptanceIt(
    'honors an explicit YAML layout override end-to-end (TMUX-064)',
    async () => {
      if (!existsSync(BUILT_CLI_PATH)) {
        throw new Error(
          `Missing ${BUILT_CLI_PATH}; run \`npm run build\` before the acceptance suite.`,
        );
      }

      cwd = mkdtempSync(join(tmpdir(), 'tmux-play-accept-cwd-'));
      workDir = mkdtempSync(join(tmpdir(), 'tmux-play-accept-work-'));
      const configPath = join(cwd, 'tmux-play.config.yaml');
      // TMUX-035 / TMUX-044 / TMUX-064: window 200x50, weights [3, 5, 7]
      // (sum = 15). Boss region = floor(200 * 3 / 15) = 40; first player
      // column region = floor(200 * 5 / 15) = 66; second player column
      // absorbs the remainder = 200 - 40 - 66 = 94.
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

      const result = await launchTmuxPlay({
        cwd,
        configPath,
        sessionId: `accept-${randomBytes(4).toString('hex')}`,
        workDir,
        selfBin: BUILT_CLI_PATH,
        attach: false,
      });
      sessionName = result.sessionName;

      expect(displayMessage(sessionName, '#{window_width}x#{window_height}'))
        .toBe('200x50');

      const panes = listPanes(sessionName);
      expect(panes).toHaveLength(3);
      const captain = paneByTitle(panes, 'Captain · claude');
      const coder = paneByTitle(panes, 'Coder · codex');
      const reviewer = paneByTitle(panes, 'Reviewer · claude');
      expect(captain.left).toBe(0);
      expect(captain.width).toBe(39); // region 40 minus 1-cell right border
      expect(coder.left).toBe(40);
      expect(coder.width).toBe(65); // region 66 minus 1-cell right border
      expect(reviewer.left).toBe(106); // 40 + 66
      expect(reviewer.width).toBe(94); // rightmost: content = region
    },
    60_000,
  );

  acceptanceIt(
    'enables 24-bit color on the launched session (TTMUX-039)',
    async () => {
      if (!existsSync(BUILT_CLI_PATH)) {
        throw new Error(
          `Missing ${BUILT_CLI_PATH}; run \`npm run build\` before the acceptance suite.`,
        );
      }

      cwd = mkdtempSync(join(tmpdir(), 'tmux-play-accept-cwd-'));
      workDir = mkdtempSync(join(tmpdir(), 'tmux-play-accept-work-'));
      const configPath = join(cwd, 'tmux-play.config.yaml');
      writeFileSync(configPath, defaultYamlConfig());

      const result = await launchTmuxPlay({
        cwd,
        configPath,
        sessionId: `accept-${randomBytes(4).toString('hex')}`,
        workDir,
        selfBin: BUILT_CLI_PATH,
        attach: false,
      });
      sessionName = result.sessionName;

      // Real-server option probe: the launcher's `tmux set` calls applied
      // to an actual server (stricter than TTMUX-038's argv inspection).
      // tmux normalizes the leading-comma terminal-overrides append to the
      // stored entry `*:RGB`. Whether a real terminal client subsequently
      // negotiates the RGB capability is tmux's own contract beyond the
      // launcher's control surface and is not asserted here — see TTMUX-039.
      const defaultTerminal = showOption(sessionName, 'default-terminal');
      expect(defaultTerminal).toBe('tmux-256color');

      const overrides = showOption(sessionName, 'terminal-overrides');
      expect(overrides.split('\n')).toContain('*:RGB');
    },
    60_000,
  );

  acceptanceIt(
    'renders run-time timers on pane borders and the tmux status bar (TTMUX-056)',
    async () => {
      if (!existsSync(BUILT_CLI_PATH)) {
        throw new Error(
          `Missing ${BUILT_CLI_PATH}; run \`npm run build\` before the acceptance suite.`,
        );
      }

      cwd = mkdtempSync(join(tmpdir(), 'tmux-play-accept-cwd-'));
      workDir = mkdtempSync(join(tmpdir(), 'tmux-play-accept-work-'));
      const configPath = join(cwd, 'tmux-play.config.yaml');
      writeFileSync(configPath, defaultYamlConfig());

      const result = await launchTmuxPlay({
        cwd,
        configPath,
        sessionId: `accept-${randomBytes(4).toString('hex')}`,
        workDir,
        selfBin: BUILT_CLI_PATH,
        attach: false,
      });
      sessionName = result.sessionName;

      const panes = listPanes(sessionName);
      const captain = paneByTitle(panes, 'Captain · claude');
      const coder = paneByTitle(panes, 'Coder · codex');
      const reviewer = paneByTitle(panes, 'Reviewer · claude');

      const paneBorderFormat = showWindowOption(
        sessionName,
        'pane-border-format',
      );
      expect(paneBorderFormat).toContain('#{pane_title}');
      expect(paneBorderFormat).toContain(`#{${TMUX_PANE_TIMER_TEXT_OPTION}}`);
      expect(paneBorderFormat).toContain(
        `#{${TMUX_PANE_TIMER_ACCENT_OPTION}}`,
      );
      expect(paneBorderFormat).toContain(
        `#{==:#{${TMUX_PANE_TIMER_RUNNING_OPTION}},1}`,
      );
      expect(paneBorderFormat).toContain(
        `#{?#{==:#{${TMUX_PANE_TIMER_RUNNING_OPTION}},1},#[fg=#{${TMUX_PANE_TIMER_ACCENT_OPTION}}],#[fg=#bac2de]}`,
      );
      expect(paneBorderFormat).toContain(
        ' #{pane_title} #[fg=#cdd6f4]#[bg=#181825]#[nobold] ',
      );
      expect(paneBorderFormat).toContain('⏳');
      expect(paneBorderFormat).toContain('⌛');

      const statusLeft = showSessionOption(sessionName, 'status-left');
      // TMUX-055: status-left opens with the `Cligent` brand heading and
      // not the retired `tmux-play` label.
      expect(statusLeft).toContain('Cligent');
      expect(statusLeft).not.toContain('tmux-play');
      // TMUX-055 + TMUX-063: status-left renders the navigation hints,
      // and the hint shape is the exact substring TMUX-063 owns —
      // including the `or Shift+←/→` tail that makes pane switching
      // work out of the box on hosts where one of Ctrl+arrow or
      // Shift+arrow is intercepted before tmux sees it. Pin the full
      // substring so a regression that drops the tail fails this test
      // instead of passing on the prefix.
      expect(statusLeft).toContain('Switch pane: Ctrl+←/→ or Shift+←/→');
      expect(statusLeft).toContain('Stop: ESC');
      expect(statusLeft).toContain('Exit: Ctrl+C');
      expect(statusLeft).toContain('drag=select');
      expect(statusLeft).toContain('right-click=copy');
      expect(statusLeft).not.toContain('d=detach');
      expect(statusLeft).not.toContain('o=switch pane');

      const statusRight = showSessionOption(sessionName, 'status-right');
      expect(statusRight).toContain('⏳');
      expect(statusRight).toContain('⌛');
      expect(statusRight).toContain(`#{${TMUX_STATUS_TIMER_TEXT_OPTION}}`);
      expect(statusRight).toContain(
        `#{==:#{${TMUX_STATUS_TIMER_RUNNING_OPTION}},1}`,
      );
      expect(showSessionOption(sessionName, 'window-status-format')).toBe('');
      expect(showSessionOption(sessionName, 'window-status-current-format')).toBe(
        '',
      );
      expect(showSessionOption(sessionName, 'window-status-separator')).toBe('');

      const observer = new TimingObserver({
        sessionName,
        captainAdapter: 'claude',
        players: [
          { id: 'coder', adapter: 'codex' },
          { id: 'reviewer', adapter: 'claude' },
        ],
        scheduler: inertScheduler,
      });

      try {
        observer.onRecord(turnStarted(1_000));
        observer.onRecord(playerPrompt('coder', 2_000));
        observer.onRecord(playerFinished('coder', 5_000));
        observer.onRecord(playerPrompt('reviewer', 6_000));
        observer.onRecord(captainPrompt(7_000));
        observer.refresh(10_000);

        expectPaneTimer(sessionName, captain.index, {
          text: '3s',
          running: '1',
          accent: '#cba6f7',
        });
        expectPaneTimer(sessionName, coder.index, {
          text: '3s',
          running: '0',
          accent: '#94e2d5',
        });
        expectPaneTimer(sessionName, reviewer.index, {
          text: '4s',
          running: '1',
          accent: '#a6e3a1',
        });
        expect(showSessionOption(sessionName, TMUX_STATUS_TIMER_TEXT_OPTION)).toBe(
          '9s',
        );
        expect(
          showSessionOption(sessionName, TMUX_STATUS_TIMER_RUNNING_OPTION),
        ).toBe('1');

        expect(expandedPaneBorder(sessionName, captain.index)).toContain(
          '⏳ #[fg=#cba6f7]3s',
        );
        expect(expandedPaneBorder(sessionName, coder.index)).toContain(
          '⌛ #[fg=#bac2de]3s',
        );
        expect(expandedPaneBorder(sessionName, reviewer.index)).toContain(
          '⏳ #[fg=#a6e3a1]4s',
        );
        expect(displayMessage(sessionName, '#{E:status-right}')).toContain(
          '⏳ #[fg=#cba6f7]9s',
        );

        observer.onRecord(playerFinished('reviewer', 11_000));
        observer.onRecord(captainFinished(12_000));
        observer.onRecord(turnFinished(13_000));

        expectPaneTimer(sessionName, captain.index, {
          text: '5s',
          running: '0',
          accent: '#cba6f7',
        });
        expectPaneTimer(sessionName, coder.index, {
          text: '3s',
          running: '0',
          accent: '#94e2d5',
        });
        expectPaneTimer(sessionName, reviewer.index, {
          text: '5s',
          running: '0',
          accent: '#a6e3a1',
        });
        expect(showSessionOption(sessionName, TMUX_STATUS_TIMER_TEXT_OPTION)).toBe(
          '12s',
        );
        expect(
          showSessionOption(sessionName, TMUX_STATUS_TIMER_RUNNING_OPTION),
        ).toBe('0');

        expect(expandedPaneBorder(sessionName, captain.index)).toContain(
          '⌛ #[fg=#bac2de]5s',
        );
        expect(expandedPaneBorder(sessionName, reviewer.index)).toContain(
          '⌛ #[fg=#bac2de]5s',
        );
        expect(displayMessage(sessionName, '#{E:status-right}')).toContain(
          '⌛ #[fg=#7f849c]12s',
        );
      } finally {
        observer.dispose();
      }
    },
    60_000,
  );
});

// TTMUX-053: YAML `permissions.mode` reaches the adapter's `run()` call as
// `AgentOptions.permissions`, and the adapter's exported mapping function
// translates the mode to the spec-defined SDK knob. The probe does not
// spawn tmux (so it does not gate on tmux availability) and does not call
// the real SDK (the player adapter is a capturing stub).
describe('tmux-play YAML → adapter permission seam', () => {
  let cwd: string | undefined;

  afterEach(() => {
    if (cwd) {
      rmSync(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  it('routes YAML permissions.mode through to Claude and Codex adapter mappings', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'tmux-play-perm-'));
    const configPath = join(cwd, 'tmux-play.config.yaml');
    writeFileSync(
      configPath,
      [
        "captain:",
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  options: {}',
        '  permissions:',
        '    mode: auto',
        'players:',
        '  - id: coder',
        '    adapter: claude',
        '    permissions:',
        '      mode: auto',
        '  - id: reviewer',
        '    adapter: codex',
        '    permissions:',
        '      mode: auto',
        '',
      ].join('\n'),
    );

    const loaded = await loadTmuxPlayConfig({ cwd, configPath });
    const captured: {
      claude: AgentOptions[];
      codex: AgentOptions[];
    } = {
      claude: [],
      codex: [],
    };

    class CapturingClaudeAdapter implements AgentAdapter {
      readonly agent = 'claude-code';
      async *run(
        _prompt: string,
        options?: AgentOptions,
      ): AsyncGenerator<AgentEvent, void, void> {
        captured.claude.push(options ?? {});
      }
      async isAvailable(): Promise<boolean> {
        return true;
      }
    }

    class CapturingCodexAdapter implements AgentAdapter {
      readonly agent = 'codex';
      async *run(
        _prompt: string,
        options?: AgentOptions,
      ): AsyncGenerator<AgentEvent, void, void> {
        captured.codex.push(options ?? {});
      }
      async isAvailable(): Promise<boolean> {
        return true;
      }
    }

    const adapterImports: PlayerAdapterImports = {
      claude: async () => CapturingClaudeAdapter,
      codex: async () => CapturingCodexAdapter,
      gemini: async () => CapturingClaudeAdapter,
      opencode: async () => CapturingClaudeAdapter,
    };

    const captain: Captain = {
      async handleBossTurn(turn, context) {
        await context.callPlayer('coder', turn.prompt);
        await context.callPlayer('reviewer', turn.prompt);
      },
    };

    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: {
        adapter: loaded.config.captain.adapter,
        model: loaded.config.captain.model,
        instruction: loaded.config.captain.instruction,
        permissions: loaded.config.captain.permissions,
      },
      players: loaded.config.players.map((player) => ({
        id: player.id,
        adapter: player.adapter as 'claude' | 'codex' | 'gemini' | 'opencode',
        model: player.model,
        instruction: player.instruction,
        permissions: player.permissions,
      })),
      adapterImports,
    });

    try {
      await runtime.runBossTurn('probe');
    } finally {
      await runtime.dispose();
    }

    expect(captured.claude[0]?.permissions).toEqual({ mode: 'auto' });
    expect(
      mapPermissionsToClaudeOptions(captured.claude[0]?.permissions),
    ).toEqual({
      permissionMode: 'auto',
    });
    expect(captured.codex[0]?.permissions).toEqual({ mode: 'auto' });
    const codexPermissions = mapPermissionsToCodexOptions(
      captured.codex[0]?.permissions,
    );
    expect(codexPermissions).toEqual({
      approvalPolicy: 'on-request',
      codexOptions: {
        config: {
          default_permissions: ':workspace',
          approvals_reviewer: 'auto_review',
        },
      },
    });
  });
});

// TTMUX-057: YAML `reasoningEffort` reaches the adapter's `run()` call as
// `AgentOptions.reasoningEffort`, and each adapter's exported mapping seam
// translates it to that adapter's native control surface.
describe('tmux-play YAML → adapter reasoning-effort seam', () => {
  let cwd: string | undefined;

  afterEach(() => {
    if (cwd) {
      rmSync(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  it('routes YAML reasoningEffort through all adapter mappings (TTMUX-057)', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'tmux-play-effort-'));
    const configPath = join(cwd, 'tmux-play.config.yaml');
    writeFileSync(
      configPath,
      [
        'captain:',
        "  from: '@sublang/cligent/captains/fanout'",
        '  adapter: claude',
        '  model: claude-opus-4-7',
        '  reasoningEffort: xhigh',
        '  options: {}',
        'players:',
        '  - id: reviewer',
        '    adapter: claude',
        '    model: claude-sonnet-4-5',
        '    reasoningEffort: max',
        '  - id: coder',
        '    adapter: codex',
        '    model: gpt-5',
        '    reasoningEffort: max',
        '  - id: gemini3',
        '    adapter: gemini',
        '    model: gemini-3-flash',
        '    reasoningEffort: high',
        '  - id: gemini25',
        '    adapter: gemini',
        '    model: gemini-2.5-flash',
        '    reasoningEffort: medium',
        '  - id: geminialias',
        '    adapter: gemini',
        '    model: flash',
        '    reasoningEffort: high',
        '  - id: geminiunknown',
        '    adapter: gemini',
        '    model: gemini-4-pro',
        '    reasoningEffort: high',
        '  - id: geminiunset',
        '    adapter: gemini',
        '    reasoningEffort: high',
        '  - id: opener',
        '    adapter: opencode',
        '    model: anthropic/claude-sonnet-4-5',
        '    reasoningEffort: max',
        '  - id: openai',
        '    adapter: opencode',
        '    model: openai/gpt-5',
        '    reasoningEffort: medium',
        '  - id: openunknown',
        '    adapter: opencode',
        '    model: someprovider/somemodel',
        '    reasoningEffort: max',
        '',
      ].join('\n'),
    );

    const loaded = await loadTmuxPlayConfig({ cwd, configPath });
    const captured: Record<'claude' | 'codex' | 'gemini' | 'opencode', AgentOptions[]> = {
      claude: [],
      codex: [],
      gemini: [],
      opencode: [],
    };

    const adapterImports: PlayerAdapterImports = {
      claude: async () => makeCapturingAdapter('claude-code', captured.claude),
      codex: async () => makeCapturingAdapter('codex', captured.codex),
      gemini: async () => makeCapturingAdapter('gemini', captured.gemini),
      opencode: async () => makeCapturingAdapter('opencode', captured.opencode),
    };

    const captain: Captain = {
      async handleBossTurn(turn, context) {
        await context.callCaptain(`captain: ${turn.prompt}`);
        for (const player of context.players) {
          await context.callPlayer(player.id, turn.prompt);
        }
      },
    };

    const runtime = await createTmuxPlayRuntime({
      captain,
      captainConfig: {
        adapter: loaded.config.captain.adapter,
        model: loaded.config.captain.model,
        instruction: loaded.config.captain.instruction,
        permissions: loaded.config.captain.permissions,
        reasoningEffort: loaded.config.captain.reasoningEffort,
      },
      players: loaded.config.players.map((player) => ({
        id: player.id,
        adapter: player.adapter as 'claude' | 'codex' | 'gemini' | 'opencode',
        model: player.model,
        instruction: player.instruction,
        permissions: player.permissions,
        reasoningEffort: player.reasoningEffort,
      })),
      adapterImports,
    });

    try {
      await runtime.runBossTurn('probe');
    } finally {
      await runtime.dispose();
    }

    const captainOptions = capturedByModel(captured.claude, 'claude-opus-4-7');
    expect(captainOptions.reasoningEffort).toBe('xhigh');
    expect(
      mapAgentOptionsToClaudeQueryOptions({
        model: captainOptions.model,
        reasoningEffort: captainOptions.reasoningEffort,
      }).queryOptions.effort,
    ).toBe('xhigh');

    const claudePlayerOptions = capturedByModel(
      captured.claude,
      'claude-sonnet-4-5',
    );
    expect(claudePlayerOptions.reasoningEffort).toBe('max');
    expect(
      mapAgentOptionsToClaudeQueryOptions({
        model: claudePlayerOptions.model,
        reasoningEffort: claudePlayerOptions.reasoningEffort,
      }).queryOptions.effort,
    ).toBe('max');

    const codexOptions = capturedByModel(captured.codex, 'gpt-5');
    expect(codexOptions.reasoningEffort).toBe('max');
    expect(
      mapAgentOptionsToCodexOptions({
        model: codexOptions.model,
        reasoningEffort: codexOptions.reasoningEffort,
      }).threadOptions.modelReasoningEffort,
    ).toBe('xhigh');

    expectGeminiReasoningAlias(
      capturedByModel(captured.gemini, 'gemini-3-flash'),
      'gemini-3-flash',
      { thinkingLevel: 'HIGH' },
    );
    expectGeminiReasoningAlias(
      capturedByModel(captured.gemini, 'gemini-2.5-flash'),
      'gemini-2.5-flash',
      { thinkingBudget: 8192 },
    );
    expectGeminiReasoningSkipped(
      capturedByModel(captured.gemini, 'flash'),
      'flash',
    );
    expectGeminiReasoningSkipped(
      capturedByModel(captured.gemini, 'gemini-4-pro'),
      'gemini-4-pro',
    );
    expectGeminiReasoningSkipped(
      captured.gemini.find((entry) => entry.model === undefined),
      undefined,
    );

    const openAnthropic = capturedByModel(
      captured.opencode,
      'anthropic/claude-sonnet-4-5',
    );
    expect(openAnthropic.reasoningEffort).toBe('max');
    expect(
      mapReasoningEffortToOpenCodeVariant(
        openAnthropic.model,
        openAnthropic.reasoningEffort,
      ),
    ).toBe('max');

    const openAi = capturedByModel(captured.opencode, 'openai/gpt-5');
    expect(openAi.reasoningEffort).toBe('medium');
    expect(
      mapReasoningEffortToOpenCodeVariant(
        openAi.model,
        openAi.reasoningEffort,
      ),
    ).toBe('medium');

    const openUnknown = capturedByModel(
      captured.opencode,
      'someprovider/somemodel',
    );
    expect(openUnknown.reasoningEffort).toBe('max');
    expect(
      mapReasoningEffortToOpenCodeVariant(
        openUnknown.model,
        openUnknown.reasoningEffort,
      ),
    ).toBeUndefined();
  });
});

function makeCapturingAdapter(
  agent: AgentType,
  bucket: AgentOptions[],
): new () => AgentAdapter {
  return class CapturingAdapter implements AgentAdapter {
    readonly agent = agent;

    async *run(
      _prompt: string,
      options?: AgentOptions,
    ): AsyncGenerator<AgentEvent, void, void> {
      bucket.push(options ?? {});
      yield createEvent(
        'done',
        agent,
        {
          status: 'success',
          usage: { inputTokens: 0, outputTokens: 0, toolUses: 0 },
          durationMs: 0,
        },
        `${agent}-capture`,
      );
    }

    async isAvailable(): Promise<boolean> {
      return true;
    }
  };
}

function capturedByModel(
  captured: readonly AgentOptions[],
  model: string,
): AgentOptions {
  const found = captured.find((entry) => entry.model === model);
  if (!found) {
    throw new Error(`No captured adapter options for model ${model}`);
  }
  return found;
}

function modelArg(args: readonly string[]): string | undefined {
  const index = args.indexOf('--model');
  return index === -1 ? undefined : args[index + 1];
}

function expectGeminiReasoningAlias(
  options: AgentOptions,
  model: string,
  thinkingConfig: Record<string, unknown>,
): void {
  const mapped = mapAgentOptionsToGeminiCommand('prompt', {
    model: options.model,
    reasoningEffort: options.reasoningEffort,
  });

  expect(options.reasoningEffort).toBeDefined();
  expect(modelArg(mapped.args)).toBe(GEMINI_REASONING_EFFORT_ALIAS);
  expect(buildGeminiSettings(mapped.settingsConfig)).toEqual({
    modelConfigs: {
      customAliases: {
        [GEMINI_REASONING_EFFORT_ALIAS]: {
          modelConfig: {
            model,
            generateContentConfig: {
              thinkingConfig,
            },
          },
        },
      },
    },
  });
}

function expectGeminiReasoningSkipped(
  options: AgentOptions | undefined,
  expectedModel: string | undefined,
): void {
  expect(options).toBeDefined();
  const mapped = mapAgentOptionsToGeminiCommand('prompt', {
    model: options?.model,
    reasoningEffort: options?.reasoningEffort,
  });

  expect(options?.reasoningEffort).toBe('high');
  expect(buildGeminiSettings(mapped.settingsConfig)).toBeUndefined();
  expect(modelArg(mapped.args)).toBe(expectedModel);
  expect(mapped.args).not.toContain(GEMINI_REASONING_EFFORT_ALIAS);
  expect(mapped.args).not.toContain('--thinking-budget');
  expect(mapped.args).not.toContain('--thinking-level');
}

function defaultYamlConfig(): string {
  return [
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
  ].join('\n');
}

function displayMessage(session: string, format: string): string {
  const result = spawnSync(
    'tmux',
    ['display-message', '-t', session, '-p', format],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `tmux display-message failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function showOption(session: string, option: string): string {
  const result = spawnSync(
    'tmux',
    ['show-options', '-gv', '-t', session, option],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`tmux show-options failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trimEnd();
}

function showSessionOption(session: string, option: string): string {
  const result = spawnSync(
    'tmux',
    ['show-options', '-v', '-t', session, option],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`tmux show-options failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trimEnd();
}

function showWindowOption(session: string, option: string): string {
  const result = spawnSync(
    'tmux',
    ['show-options', '-wv', '-t', `${session}:0`, option],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`tmux show-options -w failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trimEnd();
}

function keyBinding(table: string, key: string): string {
  const result = spawnSync('tmux', ['list-keys', '-T', table, key], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`tmux list-keys failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trimEnd();
}

// tmux 3.6 substitutes tab with `_` in -F output, so use `|` as the field
// separator. Pane titles cannot contain `|` because tmux-play sets them from
// `Captain` and config player ids (validated by the schema).
const FIELD_SEP = '|';

function listPanes(session: string): readonly PaneRow[] {
  const format = [
    '#{pane_index}',
    '#{pane_left}',
    '#{pane_top}',
    '#{pane_width}',
    '#{pane_height}',
    '#{pane_title}',
    '#{pane_input_off}',
    '#{pane_active}',
  ].join(FIELD_SEP);
  const result = spawnSync(
    'tmux',
    ['list-panes', '-t', session, '-F', format],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`tmux list-panes failed: ${result.stderr.trim()}`);
  }
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line): PaneRow => {
      const [
        index,
        left,
        top,
        width,
        height,
        title,
        inputOff,
        active,
      ] = line.split(FIELD_SEP);
      return {
        index: Number(index),
        left: Number(left),
        top: Number(top),
        width: Number(width),
        height: Number(height),
        title: title ?? '',
        inputOff: inputOff ?? '',
        active: active ?? '',
      };
    });
}

function paneByTitle(panes: readonly PaneRow[], title: string): PaneRow {
  const found = panes.find((pane) => pane.title === title);
  if (!found) {
    const titles = panes.map((pane) => pane.title).join(', ');
    throw new Error(`No pane titled ${title}; saw ${titles}`);
  }
  return found;
}

function capturePane(session: string, paneIndex: number): string {
  const result = spawnSync(
    'tmux',
    ['capture-pane', '-t', `${session}:0.${paneIndex}`, '-p'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`tmux capture-pane failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function showPaneOption(
  session: string,
  paneIndex: number,
  option: string,
): string {
  const result = spawnSync(
    'tmux',
    ['show-options', '-vp', '-t', `${session}:0.${paneIndex}`, option],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`tmux show-options -p failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trimEnd();
}

function sendAttachedClientMouseDown(
  session: string,
  x: number,
  y: number,
): void {
  const script = [
    `spawn tmux attach-session -t ${session}`,
    'after 500',
    `send -- "\\033\\[<0;${x};${y}M"`,
    'after 500',
    'send -- "\\002d"',
    'expect eof',
  ].join('\n');
  const result = spawnSync('expect', ['-c', script], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.error) {
    throw new Error(`expect mouse probe failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `expect mouse probe failed: ${result.stderr.trim() || `exit ${result.status}`}`,
    );
  }
}

function expandedPaneBorder(session: string, paneIndex: number): string {
  return displayMessage(`${session}:0.${paneIndex}`, '#{E:pane-border-format}');
}

function expectPaneTimer(
  session: string,
  paneIndex: number,
  expected: {
    readonly text: string;
    readonly running: string;
    readonly accent: string;
  },
): void {
  expect(showPaneOption(session, paneIndex, TMUX_PANE_TIMER_TEXT_OPTION)).toBe(
    expected.text,
  );
  expect(showPaneOption(session, paneIndex, TMUX_PANE_TIMER_RUNNING_OPTION)).toBe(
    expected.running,
  );
  expect(showPaneOption(session, paneIndex, TMUX_PANE_TIMER_ACCENT_OPTION)).toBe(
    expected.accent,
  );
}

function runOrThrow(cmd: string, args: readonly string[]): void {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(' ')} failed: ${result.stderr.trim()}`,
    );
  }
}

function isCommandAvailable(cmd: string, args: readonly string[]): boolean {
  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  return result.error === undefined && result.status === 0;
}

async function waitForRegions(
  session: string,
  expectedRegions: readonly number[],
  timeoutMs: number,
): Promise<readonly PaneRow[]> {
  const start = Date.now();
  let lastSeen: readonly PaneRow[] = [];
  while (Date.now() - start < timeoutMs) {
    const panes = listPanes(session);
    lastSeen = panes;
    if (
      panes.length === expectedRegions.length &&
      panes.every((pane, idx) => regionWidthFor(pane, panes, idx) === expectedRegions[idx])
    ) {
      return panes;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Layout did not reach expected regions [${expectedRegions.join(',')}] within ${timeoutMs}ms; last seen: ${JSON.stringify(lastSeen)}`,
  );
}

// `respawn-pane` returns before the seeded process has written its output,
// so poll `#{history_size}` until the pane has enough scrollback for a
// scroll-up to reach a non-zero `#{scroll_position}`.
async function waitForHistory(
  session: string,
  paneIndex: number,
  minLines: number,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  let last = '0';
  while (Date.now() - start < timeoutMs) {
    last = displayMessage(`${session}:0.${paneIndex}`, '#{history_size}');
    if (Number(last) >= minLines) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `pane ${paneIndex} history_size stayed below ${minLines} (last ${last}) within ${timeoutMs}ms`,
  );
}

// The presenter writes to the logfile and `tail -f` delivers it to the pane
// asynchronously, so poll the visible pane until the streamed marker lands (or
// time out). A non-followed pane stays scrolled with the marker off-screen at
// the live tail, so this also fails fast if the follow never fired.
async function waitForPaneContains(
  session: string,
  paneIndex: number,
  needle: string,
  timeoutMs: number,
): Promise<string> {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    last = capturePane(session, paneIndex);
    if (last.includes(needle)) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `pane ${paneIndex} did not show ${needle} within ${timeoutMs}ms; last capture:\n${last}`,
  );
}

async function waitForNonEmptyFile(
  path: string,
  timeoutMs: number,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf8');
      if (content.length > 0) {
        return content;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `${path} was not written with copied text within ${timeoutMs}ms`,
  );
}

function regionWidthFor(
  pane: PaneRow,
  panes: readonly PaneRow[],
  index: number,
): number {
  if (index === panes.length - 1) {
    return pane.width;
  }
  const next = panes[index + 1];
  if (!next) {
    return pane.width;
  }
  return next.left - pane.left;
}

const inertScheduler: TimingScheduler = {
  setInterval() {
    return 'inert-timing-observer-interval';
  },
  clearInterval() {},
};

function turnStarted(timestamp: number): TmuxPlayRecord {
  return {
    type: 'turn_started',
    turnId: 1,
    timestamp,
    turn: { id: 1, prompt: 'work', timestamp },
  };
}

function turnFinished(timestamp: number): TmuxPlayRecord {
  return { type: 'turn_finished', turnId: 1, timestamp };
}

function playerPrompt(playerId: string, timestamp: number): TmuxPlayRecord {
  return {
    type: 'player_prompt',
    turnId: 1,
    timestamp,
    playerId,
    prompt: 'work',
  };
}

function playerFinished(playerId: string, timestamp: number): TmuxPlayRecord {
  return {
    type: 'player_finished',
    turnId: 1,
    timestamp,
    playerId,
    result: { playerId, turnId: 1, status: 'ok' },
  };
}

function captainPrompt(timestamp: number): TmuxPlayRecord {
  return {
    type: 'captain_prompt',
    turnId: 1,
    timestamp,
    prompt: 'summarize',
  };
}

function captainFinished(timestamp: number): TmuxPlayRecord {
  return {
    type: 'captain_finished',
    turnId: 1,
    timestamp,
    result: { turnId: 1, status: 'ok' },
  };
}
