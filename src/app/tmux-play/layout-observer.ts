// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { runTmux } from '../shared/tmux.js';
import { buildPlayerArea, resolveVisiblePlayers } from './launcher.js';
import type { LayoutConfig } from './config.js';
import type { PlayerConfig } from './players.js';
import type { CatppuccinFlavor } from './player-colors.js';
import type { RecordObserver, TmuxPlayRecord } from './records.js';

// TMUX-083 / TMUX-084: a re-shown hidden player's pane replays a bounded recent
// view of its log; the full backlog stays in the log file, not pane scrollback.
// The replay count is fixed by DR-007 (not a YAML or Captain-API option).
const REBUILD_REPLAY_LINES = 200;

export interface LayoutObserverOptions {
  readonly sessionName: string;
  readonly workDir: string;
  /** The full configured roster; `visiblePlayerIds` are resolved against it. */
  readonly players: readonly PlayerConfig[];
  readonly layout: LayoutConfig;
  readonly captainAdapter: string;
  readonly themeFlavor: CatppuccinFlavor;
  /**
   * The launcher's startup-visible set (TMUX-080). The observer's tracked
   * visible list starts here so a `player_view_changed` repeating it is a
   * no-op.
   */
  readonly initialVisible: readonly string[];
  /**
   * Best-effort failure surfacing. The observer never throws into record
   * dispatch (display-only, TMUX-083); a tmux failure is reported here instead.
   */
  readonly onError?: (error: unknown) => void;
}

/**
 * TMUX-083: session-mode observer that reconciles the visible player panes on
 * each accepted `player_view_changed` record via a full player-area rebuild,
 * reusing the launcher's `buildPlayerArea` routine from the single-Boss-pane
 * condition. Display-only: it owns the tmux pane operations but never aborts a
 * Boss turn, and it advances its tracked visible list only after a fully
 * successful reconciliation.
 */
export class LayoutObserver implements RecordObserver {
  private readonly options: LayoutObserverOptions;
  private visible: readonly string[];

  constructor(options: LayoutObserverOptions) {
    this.options = options;
    this.visible = [...options.initialVisible];
  }

  onRecord(record: TmuxPlayRecord): void {
    if (record.type !== 'player_view_changed') {
      return;
    }
    const next = record.visiblePlayerIds;
    // TMUX-083: a record repeating the tracked list in the same order is a
    // no-op — issue no tmux commands.
    if (sameOrder(this.visible, next)) {
      return;
    }
    try {
      this.rebuild(next);
      // Advance the tracked list only after a fully successful reconciliation.
      this.visible = [...next];
    } catch (error) {
      // Display-only (TMUX-083): swallow tmux failures so a Boss turn is never
      // aborted, and leave the tracked list unchanged so a later successful
      // visibility change recovers. The per-player logs remain the durable
      // output record (TMUX-084).
      try {
        this.options.onError?.(error);
      } catch {
        // Surfacing the failure must not itself throw into record dispatch and
        // re-break the display-only / non-aborting guarantee.
      }
    }
  }

  // Full player-area rebuild: kill every main-window pane except the
  // Boss/Captain pane, recreate the requested players in order from the same
  // single-Boss-pane starting condition the launcher uses, then restore Boss
  // focus as the final command.
  private rebuild(visibleIds: readonly string[]): void {
    const visiblePlayers = resolveVisiblePlayers(
      this.options.players,
      visibleIds,
    );
    const bossPane = `${this.options.sessionName}:0.0`;
    // `kill-pane -a -t <boss>` kills every pane except the targeted one,
    // returning the main window to the single-Boss-pane condition.
    runTmux('kill-pane', '-a', '-t', bossPane);
    buildPlayerArea({
      sessionName: this.options.sessionName,
      workDir: this.options.workDir,
      visiblePlayers,
      layout: this.options.layout,
      captainAdapter: this.options.captainAdapter,
      themeFlavor: this.options.themeFlavor,
      replayLines: REBUILD_REPLAY_LINES,
    });
    runTmux('select-pane', '-t', bossPane);
  }
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function createLayoutObserver(
  options: LayoutObserverOptions,
): LayoutObserver {
  return new LayoutObserver(options);
}
