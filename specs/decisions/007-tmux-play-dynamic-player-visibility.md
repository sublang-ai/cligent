<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-007: tmux-play Dynamic Player Visibility

## Status

Accepted

## Context

[DR-004](004-tmux-play-captain-architecture.md) fixes the tmux-play runtime and presentation boundary.
The runtime owns persistent Captain and player `Cligent` instances, while presentation owns tmux panes and layout.

Downstream playbook Captains need multiple workflow phases with different visible player subsets.
For example, one phase may show Coder and Reviewer, while a later phase may show Architect, Tester, and Security.
All candidate players should remain available to the Captain for session continuity, but not all of their panes need to occupy the main tmux window at once.

The existing topology is static.
The launcher creates one read-only player pane per configured player, and each pane tails that player's log.
Player liveness and output durability are already independent of pane liveness: session mode writes each player's rendered output to that player's log stream, and a pane is only a `tail -f` view of that log.

This decision serves workflow-driven visible subsets without introducing a mutable runtime player registry or a pane-preservation subsystem.

## Decision

### Static Roster

The `players` config remains the full player roster for the session.
The launcher and runtime construct every configured player at session startup.
The runtime does not support creating, deleting, or reconfiguring player identities after startup.

Dynamic visibility changes only which existing players have panes in the main tmux window.
It does not change `CaptainSession.players`, `CaptainContext.players`, the runtime's player map, per-player log streams, or `Cligent` resume continuity.

### Initial Visibility

The `layout` config gains an optional `initialVisible` field containing player IDs from the configured roster.
When `layout.initialVisible` is omitted, every configured player is visible, preserving today's behavior for existing configs.
When present, it must name a non-empty, duplicate-free subset of configured player IDs.
The launcher creates startup panes for exactly the initial visible set, not the whole roster followed by a synthetic reconciliation.
When `layout.initialVisible` is present, its array order is the startup player pane order.
When `layout.initialVisible` is omitted, configured `players` order remains the startup player pane order.
The startup layout weight shape derives from the same initial visible set.

This decision does not support a zero-player visible layout.
A Captain that wants a Captain-only planning phase should leave the previous visible set in place until at least one player should be shown.

### Captain Control API

The Captain contract gains a first-class visibility method on both session-scoped and turn-scoped contexts:

```typescript
interface CaptainSession {
  setVisiblePlayers(playerIds: readonly string[]): Promise<void>;
}

interface CaptainContext {
  setVisiblePlayers(playerIds: readonly string[]): Promise<void>;
}
```

The session-scoped method is for phase setup in `init()` or between Boss turns.
The turn-scoped method is for mid-turn workflow transitions.
Both methods validate that `playerIds` is a non-empty, duplicate-free subset of the configured player IDs.
When validation fails, the returned Promise rejects before any record is emitted.
The visible set remains unchanged.
The Captain may catch that rejection and continue; an uncaught rejection follows the normal Captain failure path from [DR-004](004-tmux-play-captain-architecture.md#runtime-and-presentation).

The runtime emits one `player_view_changed` record for an accepted call:

```typescript
interface PlayerViewChangedRecord {
  readonly type: 'player_view_changed';
  readonly turnId: number | null;
  readonly timestamp: number;
  readonly visiblePlayerIds: readonly string[];
}
```

Calls from `CaptainContext` carry the active turn ID.
Calls from `CaptainSession` carry the active turn ID when a turn is active, otherwise `null`, matching the existing session-emission convention for `captain_status` and `captain_telemetry` in [DR-004](004-tmux-play-captain-architecture.md#runtime-and-presentation).

The runtime validates IDs and emits the record.
It does not inspect tmux state or mutate presentation state directly.
The runtime record taxonomy from [DR-004](004-tmux-play-captain-architecture.md#runtime-and-presentation) is extended by `player_view_changed`.

When a Captain awaits `setVisiblePlayers(next)` and then calls `callPlayer()` for a newly visible player, the layout reconciliation attempt is ordered before that player's later `player_prompt` / `player_event` records are presented.
This design relies on the ordered, awaited observer dispatch from [DR-004](004-tmux-play-captain-architecture.md#runtime-and-presentation) to provide that sequencing.
When reconciliation succeeds, the newly visible pane exists before that player's later records are presented.
When reconciliation fails and the display-only observer swallows or surfaces the failure, later player output still reaches the player's log stream, but the pane may be absent or incomplete until a later successful visibility change.
Any future asynchronous or coalesced layout reconciliation must preserve the same successful-reconciliation-before-player-output guarantee for awaited `setVisiblePlayers()` calls.

Other tmux-play observers ignore `player_view_changed` unless they explicitly participate in layout reconciliation.
The tmux presenter writes no Boss-pane content for it, the follow observer does not return any pane to its live tail for it, the timing observer does not alter timers for it, and the notification observer does not notify for it.

### Presentation Observer

Session mode registers a `LayoutObserver` with the other tmux-play record observers.
The observer consumes `player_view_changed` records and owns all tmux operations needed to reconcile the visible player panes.
It is display-only: tmux failures are swallowed or surfaced as best-effort status, and they must not abort a Boss turn.
The observer tracks the current visible player ID list.
It initializes that list from the launcher's startup visible set.
It updates that list only after reconciliation completes successfully, where success means every requested player pane was recreated and configured for the requested visible set.
An incomplete best-effort reconciliation does not advance the tracked list, even if the observer handler returns without throwing.
When a `player_view_changed` record repeats that list in the same order, the observer treats it as a no-op and issues no tmux commands.

The observer uses full player-area rebuild.
On each accepted visibility change it:

- enumerates panes in the main tmux window and kills every pane except the Boss/Captain pane
- recreates panes for `visiblePlayerIds` in that order using the same split sequence as launcher startup
- runs each recreated pane as a bounded recent log view, `tail -n 200 -f <player>.log`
- reapplies player pane titles, timer options, read-only input, mouse-selection bindings, layout hooks, and Boss-pane focus

Full rebuild is chosen over incremental pane add/remove.
It reuses the launcher topology algorithm from the same single-Boss-pane starting condition and avoids a `playerId -> paneId` registry, custom middle-column insertion logic, and pane-survivor bookkeeping.
The `200`-line replay count is fixed by this decision and is not a YAML or Captain API option.
Because rebuild is kill-first, a mid-rebuild tmux failure may leave the player area partially reconstructed.
The observer continues best-effort reconstruction for remaining panes when it can do so without throwing, surfaces a best-effort status when practical, and relies on the per-player logs as the durable output record.
A later successful visibility change is the recovery mechanism for an incomplete displayed layout.

The rebuild runs on the ordered observer dispatch path.
Mid-turn `setVisiblePlayers()` calls can therefore stall subsequent record delivery until the player area has been reconciled.
That stall is an accepted cost of keeping the successful-reconciliation-before-player-output guarantee simple.
Captains should prefer calling `setVisiblePlayers()` at deliberate workflow phase boundaries rather than in tight streaming loops.

### Layout Weights

Dynamic visibility makes visible-column shape depend on the current visible set rather than the configured roster size.
The layout schema validates weights by visible-column shape.

The multi-player visible layout uses three column weights: Boss/Captain, first player column, second player column.
The single-player visible layout uses two column weights: Boss/Captain and the single player column.
Dynamic visibility makes shape-specific presets the canonical configuration:

- `layout.singlePlayerColumnWeights` for the two-column shape, defaulting to `[1, 1]`
- `layout.multiPlayerColumnWeights` for the three-column shape, defaulting to `[1, 1, 1]`

An omitted shape-specific preset is not materialized as present.
Its default is used only after explicit values and backward-compatible aliases have been considered.

Existing `layout.columnWeights` becomes a backward-compatible alias.
A two-element `layout.columnWeights` aliases `layout.singlePlayerColumnWeights`.
A three-element `layout.columnWeights` aliases `layout.multiPlayerColumnWeights`.
Any other `layout.columnWeights` length remains invalid.
When `layout.columnWeights` and the matching shape-specific preset are both present, the loader rejects the config rather than silently choosing one.

For any visible set, weight resolution is:

1. use the matching shape-specific preset when explicitly present
2. otherwise use the matching `layout.columnWeights` alias when present
3. otherwise use the shape default

This decision amends the [TMUX-064](../user/tmux-play.md#tmux-064) length rule for dynamic visibility.
TMUX-064 currently derives `layout.columnWeights` length from the configured player count; future TMUX item updates must instead describe `layout.columnWeights` as a two- or three-element compatibility alias and describe the shape-specific canonical presets above.

The loader keeps strict positive-integer validation for every weight.
It does not relax weight validation to arbitrary arrays whose meaning changes at runtime.

### Config Migration

Legacy configs that contain only `layout.columnWeights` remain valid through the compatibility alias above.
The alias preserves behavior; the home-config migration keeps the user-editable fallback file on the canonical shape-specific vocabulary so later edits are less ambiguous.
This decision amends [TMUX-010](../user/tmux-play.md#tmux-010)'s home-config migration rule.
TMUX-010 currently describes fallback home migration as adding only missing safe defaults and preserving existing values; dynamic visibility permits this narrow key rewrite because the weight array value is preserved under its canonical field.
Future TMUX item updates must also replace TMUX-010's stale reference to "resolved `layout` defaults from TMUX-064" with the dynamic-visibility layout fields from this decision.
When tmux-play loads an existing home config through fallback discovery, it updates the home YAML to the canonical shape-specific field when that rewrite is unambiguous:

- a two-element `layout.columnWeights` becomes `layout.singlePlayerColumnWeights`
- a three-element `layout.columnWeights` becomes `layout.multiPlayerColumnWeights`

The migration transforms the config in memory and writes one final YAML form.
It must not leave an on-disk file containing both `layout.columnWeights` and the matching canonical field, because that state is rejected by validation.
When a config already contains both `layout.columnWeights` and the matching canonical field, migration does not attempt to resolve the conflict and the loader rejects the config.
It also does not rewrite explicit `--config` files or cwd project configs; those remain valid through the alias rule but are not mutated automatically.

Newly-created default home configs use the canonical shape-specific field directly.
For the shipped default roster with two visible players, [TMUX-011](../user/tmux-play.md#tmux-011)'s default layout moves from `layout.columnWeights: [1, 1, 1]` to `layout.multiPlayerColumnWeights: [1, 1, 1]`.

### Out of Scope

- creating new player identities after session start
- changing player adapter, model, instruction, permissions, or reasoning effort after session start
- preserving hidden pane tmux scrollback, copy-mode state, active selection, or exact viewport
- incremental pane add/remove that preserves surviving visible panes
- parking hidden panes in a bench window with `break-pane` / `join-pane`
- user-facing workflow maps in YAML

## Consequences

Existing configs retain the current static behavior because the default visible set is all configured players.
Playbook Captains can declare the union roster up front and drive visible subsets at workflow phase boundaries.

Hidden players remain live as runtime entities and continue to accumulate output in their per-player log files when called.
Their hidden panes do not remain live.
When a hidden player becomes visible again, tmux-play reconstructs a new read-only pane from the recent log tail.
The full backlog remains available in the log file, not in tmux pane scrollback.

This design may produce a brief visual rebuild when the visible set changes.
That is acceptable for workflow phase transitions, which are expected to be infrequent and deliberate.

The API and record shape leave room for a later presentation-only upgrade.
If hidden-pane view continuity becomes important, the `LayoutObserver` can replace full rebuild with incremental pane preservation or a bench-window `break-pane` / `join-pane` strategy behind the same `setVisiblePlayers` API and `player_view_changed` record.
Such an upgrade should introduce stable pane-ID bookkeeping then, not as a prerequisite for this simpler design.

Future implementation work must update the TMUX user and test items to specify `layout.initialVisible`, the `setVisiblePlayers` contract, the `player_view_changed` record, full-rebuild pane semantics, strict per-visible-count weight validation, the home-config migration and TMUX-010 amendment, the TMUX-011 default-config canonical layout field, and the hidden-pane scrollback limitation.
