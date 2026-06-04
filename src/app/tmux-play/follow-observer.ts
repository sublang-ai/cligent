// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { CligentEvent } from '../../types.js';
import { formatCligentEvent } from '../shared/events.js';
import { queryPaneTargetsByTitle, runTmux } from '../shared/tmux.js';
import { captainPaneTitle, playerPaneTitle } from './pane-title.js';
import type { PlayerConfig } from './players.js';
import type { RecordObserver, TmuxPlayRecord } from './records.js';

// TMUX-069: when the session writes new content to a pane that is currently
// scrolled back into copy-mode, return that pane to its live tail so the new
// content is visible. The follow observer mirrors `TimingObserver`: it is a
// `RecordObserver` registered in `session.ts`'s `observers` array, resolves a
// destination pane per record, and drives tmux through `runTmux`. It never
// writes pane content — it only exits copy-mode on a pane that already has new
// output, via the `#{pane_in_mode}`-gated copy-mode exit primitive
// (`send-keys -X cancel`).
//
// The observer keys on the records and events that drive a *presenter pane
// write* (TMUX-050): the presenter buffers `text_delta` into a per-pane open
// block and only emits via `writer.write` at a block boundary, so a follow
// must not fire on a buffered delta in isolation but must fire when the block
// is flushed (by a later non-text event, a tool line, or the pane's
// `*_finished` record). It must not fire on the no-op control records, on the
// `done` / `error` events the presenter suppresses, or on events that render
// to nothing — none of those put new bytes on a pane, so exiting copy-mode
// then would discard a scroll position with no compensating content.

const DEFAULT_DEBOUNCE_MS = 250;

export interface FollowTmuxClient {
  queryPaneTargetsByTitle(sessionName: string): ReadonlyMap<string, string>;
  /**
   * Return `paneTarget` to its live tail when it is in copy-mode. The
   * implementation gates on `#{pane_in_mode}` so a pane that is not in a mode
   * is left untouched (an error-free no-op), per TMUX-069.
   */
  followPane(paneTarget: string): void;
}

export interface CreateFollowObserverOptions {
  readonly sessionName: string;
  readonly captainAdapter: string;
  readonly players: readonly Pick<PlayerConfig, 'id' | 'adapter'>[];
  readonly now?: () => number;
  readonly debounceMs?: number;
  readonly tmux?: FollowTmuxClient;
}

interface PaneClassification {
  /** Destination pane title (the key `queryPaneTargetsByTitle` returns). */
  readonly title: string;
  /** Whether this record drives a presenter write to that pane. */
  readonly writes: boolean;
}

export class FollowObserver implements RecordObserver {
  private readonly sessionName: string;
  private readonly captainTitle: string;
  private readonly playerTitles = new Map<string, string>();
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly tmux: FollowTmuxClient;
  // Pane titles whose presenter block currently holds buffered, not-yet-flushed
  // text. A flush of such a block puts new bytes on the pane, so the record
  // that triggers the flush must drive a follow even when its own payload is
  // empty (e.g. a `captain_finished` that only flushes accumulated deltas).
  private readonly pending = new Set<string>();
  // Per-pane leading-edge throttle: the timestamp of the last issued follow.
  // A burst of block writes within `debounceMs` issues a single `tmux` call —
  // the first exit already snapped the pane to its tail, so writes that land
  // while the pane is no longer in a mode need no further follow.
  private readonly lastIssued = new Map<string, number>();

  constructor(options: CreateFollowObserverOptions) {
    this.sessionName = options.sessionName;
    this.captainTitle = captainPaneTitle(options.captainAdapter);
    for (const player of options.players) {
      this.playerTitles.set(
        player.id,
        playerPaneTitle(player.id, player.adapter),
      );
    }
    this.now = options.now ?? Date.now;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.tmux = options.tmux ?? spawnFollowClient;
  }

  onRecord(record: TmuxPlayRecord): void {
    // `classify` mutates the per-pane buffered-text state and must run for
    // every record (even non-writing ones) to track it; the follow itself is
    // display-only, so a transient tmux failure is swallowed rather than
    // aborting the active Boss turn.
    const classification = this.classify(record);
    if (!classification || !classification.writes) {
      return;
    }
    try {
      this.follow(classification.title);
    } catch {
      // Display-only: ignore tmux failures (e.g. the pane or session is gone).
    }
  }

  private follow(title: string): void {
    const now = this.now();
    const last = this.lastIssued.get(title);
    if (last !== undefined && now - last < this.debounceMs) {
      return;
    }
    const target = this.tmux.queryPaneTargetsByTitle(this.sessionName).get(title);
    if (!target) {
      return;
    }
    this.lastIssued.set(title, now);
    this.tmux.followPane(target);
  }

  // Decide, for one record, which pane it targets and whether it drives a
  // presenter write — mirroring `presenter-tmux.ts`'s `onRecord` so the follow
  // tracks exactly the writes the presenter performs. Returns `undefined` for
  // records that target no pane (the no-op control records).
  private classify(record: TmuxPlayRecord): PaneClassification | undefined {
    switch (record.type) {
      case 'turn_started':
      case 'turn_finished':
      case 'captain_prompt':
      case 'captain_telemetry':
        // No-op control records: the presenter writes nothing.
        return undefined;
      case 'turn_aborted':
      case 'captain_status':
      case 'runtime_error':
        // The presenter flushes the boss block then writes a bracketed line.
        return this.flushedWrite(this.captainTitle);
      case 'captain_finished':
        // TMUX-072: a hidden Captain call puts zero bytes on the pane
        // (presenter-tmux.ts skips its captain_event / captain_finished), so it
        // must drive no follow. Mirror the presenter's skip exactly — report no
        // write and leave the pending-block state untouched, since a hidden
        // event never accumulated into the presenter's open block.
        if (record.visibility === 'hidden') {
          return { title: this.captainTitle, writes: false };
        }
        return this.finishedWrite(this.captainTitle, record.result.status);
      case 'captain_event':
        if (record.visibility === 'hidden') {
          return { title: this.captainTitle, writes: false };
        }
        return this.classifyEvent(this.captainTitle, record.event);
      case 'player_prompt': {
        const title = this.playerTitles.get(record.playerId);
        // `writeBlock` flushes then writes the prompt — always a write.
        return title ? this.flushedWrite(title) : undefined;
      }
      case 'player_event': {
        const title = this.playerTitles.get(record.playerId);
        return title ? this.classifyEvent(title, record.event) : undefined;
      }
      case 'player_finished': {
        const title = this.playerTitles.get(record.playerId);
        return title
          ? this.finishedWrite(title, record.result.status)
          : undefined;
      }
    }
  }

  // A record that flushes the open block and unconditionally writes its own
  // line: clears any buffered text and reports a write.
  private flushedWrite(title: string): PaneClassification {
    this.pending.delete(title);
    return { title, writes: true };
  }

  // A `*_finished` record: the presenter flushes the open block (a write iff
  // text was buffered) and then writes a status line only for a non-`ok`
  // result. So it writes iff there was pending text or the run did not succeed.
  private finishedWrite(
    title: string,
    status: 'ok' | 'aborted' | 'error',
  ): PaneClassification {
    const hadPending = this.pending.delete(title);
    return { title, writes: hadPending || status !== 'ok' };
  }

  // Mirror `presenter-tmux.ts`'s `writeFormatted`: `done` / `error` are
  // suppressed; `tool_use` / `tool_result` flush then write; a `text_delta`
  // only accumulates into the open block (no write); any other event writes
  // iff it renders to non-null text.
  private classifyEvent(
    title: string,
    event: CligentEvent,
  ): PaneClassification {
    if (event.type === 'done' || event.type === 'error') {
      return { title, writes: false };
    }
    if (event.type === 'tool_use' || event.type === 'tool_result') {
      return this.flushedWrite(title);
    }
    const formatted = formatCligentEvent(event);
    if (formatted === null) {
      return { title, writes: false };
    }
    if (event.type === 'text_delta') {
      // Buffered into the open block; flushed (and followed) later. Track the
      // block as pending only once a delta carries *visible* text. The
      // presenter renders the accumulated block through glow and emits nothing
      // for an all-blank result (`applyPrefix` returns '' for whitespace-only
      // rendered text — presenter-tmux.ts), so an all-whitespace stream puts no
      // bytes on the pane and must not provoke a follow on the terminal
      // `*_finished` flush. Visibility is monotonic under accumulation: if any
      // delta carries a non-whitespace character the whole block does too.
      if (hasVisibleText(formatted)) {
        this.pending.add(title);
      }
      return { title, writes: false };
    }
    // A non-streaming `text` event: the presenter flushes the open block, then
    // renders this content as its own block (`writeBlock`). Both flushes write
    // iff their text is visible, so follow iff there was buffered visible text
    // or this content is itself visible — an all-whitespace `text` event with
    // no pending block writes nothing, mirroring the presenter.
    const hadPending = this.pending.delete(title);
    return { title, writes: hadPending || hasVisibleText(formatted) };
  }
}

// Mirror the presenter's all-blank suppression. The presenter renders each
// text block through glow and `applyPrefix` returns '' — no bytes — when the
// result holds no visible content (`trimOuterMargin` + `visibleNonblank` in
// presenter-tmux.ts). glow can't be run here, but the case the TMUX-069 rule
// must honor is a whitespace-only stream: text whose only characters are
// spaces/newlines renders to nothing, so it must not count as output that
// justifies snapping a deliberately scrolled pane back to its tail. A string
// carries visible text iff it holds any non-whitespace character.
function hasVisibleText(text: string): boolean {
  return /\S/.test(text);
}

export function createFollowObserver(
  options: CreateFollowObserverOptions,
): FollowObserver {
  return new FollowObserver(options);
}

const spawnFollowClient: FollowTmuxClient = {
  queryPaneTargetsByTitle,
  followPane(paneTarget) {
    // `-X cancel` raises "not in a mode" when the pane is not in copy-mode, so
    // gate it with tmux's own `if -F` against `#{pane_in_mode}`: a single tmux
    // invocation that is an error-free no-op for an un-scrolled pane and exits
    // copy-mode (snapping to the live tail) for a scrolled one.
    runTmux(
      'if-shell',
      '-F',
      '-t',
      paneTarget,
      '#{pane_in_mode}',
      `send-keys -t ${paneTarget} -X cancel`,
    );
  },
};
