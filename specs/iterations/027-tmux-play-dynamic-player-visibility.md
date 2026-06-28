<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-027: tmux-play Dynamic Player Visibility

## Goal

Implement [DR-007](../decisions/007-tmux-play-dynamic-player-visibility.md): configured `players` stays the full static session roster, but which players occupy panes in the main tmux window becomes dynamic.

- An optional `layout.initialVisible` selects the startup-visible subset (default: all configured players, today's behavior).
- A first-class `setVisiblePlayers(playerIds)` on `CaptainSession` and `CaptainContext` drives the visible subset at session setup, between turns, and mid-turn.
- The runtime emits a new `player_view_changed` record for each accepted call.
- A display-only `LayoutObserver` reconciles the visible player panes by full player-area rebuild from bounded per-player log tails.
- The layout schema moves to shape-specific weight presets (`layout.singlePlayerColumnWeights` / `layout.multiPlayerColumnWeights`) with `layout.columnWeights` retained as a two-/three-element backward-compatible alias, including home-config migration to the canonical field and the shipped default-config update.

This IR changes only which existing players have panes; it does not create, delete, or reconfigure player identities, `CaptainContext.players`, the runtime player map, per-player log streams, or `Cligent` resume continuity (per [DR-007](../decisions/007-tmux-play-dynamic-player-visibility.md) *Static Roster*).

## Status

Proposed

No task in this IR has been implemented.
This record is the decomposition of DR-007 into one-commit tasks.

## Scope

In scope:

- `layout.initialVisible` config field: optional, non-empty, duplicate-free subset of configured player IDs; array order is the startup pane order; default (omitted) is every configured player in `players` order.
- Shape-specific layout weight presets and the `columnWeights` alias:
  - `layout.singlePlayerColumnWeights` (two-column shape, default `[1, 1]`).
  - `layout.multiPlayerColumnWeights` (three-column shape, default `[1, 1, 1]`).
  - `layout.columnWeights` becomes an alias: two elements → single-player preset, three elements → multi-player preset; any other length invalid; both alias and matching canonical preset present → loader rejects.
  - Weight resolution precedence: explicit canonical preset, then matching `columnWeights` alias, then shape default.
  - Visible-column shape (and thus which preset/weight length applies) derives from the resolved initial visible set, not the configured roster size.
- Home-config migration: a fallback-discovered home config with only `layout.columnWeights` is rewritten in place to the canonical shape-specific field (two-element → `singlePlayerColumnWeights`, three-element → `multiPlayerColumnWeights`), written as one final YAML form; `--config` and cwd project configs are not mutated; a config carrying both `columnWeights` and the matching canonical field is rejected, not auto-resolved.
- Default home config uses `layout.multiPlayerColumnWeights: [1, 1, 1]` for the shipped two-visible-player roster.
- `setVisiblePlayers(playerIds: readonly string[]): Promise<void>` on `CaptainSession` (session-scoped) and `CaptainContext` (turn-scoped); both validate a non-empty, duplicate-free subset of configured IDs and reject before emitting any record, leaving the visible set unchanged on failure.
- `player_view_changed` runtime record (`type`, `turnId`, `timestamp`, `visiblePlayerIds`): one per accepted call; carries the active turn ID from `CaptainContext`, and the active turn ID or `null` from `CaptainSession` matching the existing `captain_status` / `captain_telemetry` convention. The record joins the exported record taxonomy.
- `LayoutObserver` registered in session mode: consumes `player_view_changed`; full player-area rebuild (kill every main-window pane except Boss/Captain, recreate panes for `visiblePlayerIds` in order using the launcher split sequence, run each as `tail -n 200 -f <player>.log`, reapply pane titles, timer options, read-only input, mouse-selection bindings, layout hooks, and Boss-pane focus); tracks the current visible list initialized from the startup visible set and advances it only on fully successful reconciliation; treats a repeated list as a no-op; display-only and best-effort on tmux failure (never aborts a Boss turn); relies on the ordered, awaited observer dispatch to keep successful reconciliation before that player's later records.
- Launcher: build startup player panes for the resolved initial visible set (not the whole roster), in `initialVisible` order, with a reusable player-area build routine the `LayoutObserver` reuses from the single-Boss-pane starting condition.
- Hidden-pane limitation: hidden players stay live and keep accumulating output to their per-player logs; their panes are not kept live; on re-show a new read-only pane is reconstructed from the recent `200`-line log tail; the full backlog stays in the log file, not in pane scrollback.
- Spec items: new TMUX-080..084 and TTMUX-079..085; amendments to TMUX-064, TMUX-028, TMUX-016, TMUX-017, TMUX-020, TMUX-021, TMUX-010, TMUX-011; `specs/map.md` package-summary refresh.
- `docs/tmux-play.md` Config section documents `initialVisible`, the shape-specific weights, and the `columnWeights` alias.

Out of scope (per [DR-007](../decisions/007-tmux-play-dynamic-player-visibility.md) *Out of Scope*):

- Creating new player identities or changing a player's adapter / model / instruction / permissions / reasoning effort after session start.
- A zero-player visible layout.
- Preserving hidden-pane tmux scrollback, copy-mode state, active selection, or exact viewport.
- Incremental pane add/remove that preserves surviving visible panes; parking hidden panes in a bench window via `break-pane` / `join-pane`; a `playerId -> paneId` registry.
- A configurable replay count (the `200`-line tail is fixed by DR-007) or a YAML/Captain-API knob for it.
- User-facing workflow maps in YAML.
- Any change to the `@sublang/cligent` engine (`Cligent`) package; `setVisiblePlayers` and `player_view_changed` are tmux-play runtime/Captain-contract concepts only.

## Deliverables

- [ ] `specs/user/tmux-play.md` — amend TMUX-064 (weight vocabulary), TMUX-028 (visible-column shape from the visible set), TMUX-010 (migration rewrite), TMUX-011 (default canonical weight field), TMUX-016 / TMUX-017 (`setVisiblePlayers`), TMUX-020 / TMUX-021 (`player_view_changed` enumeration + `turnId`); add TMUX-080 (`layout.initialVisible`), TMUX-081 (`setVisiblePlayers` validation / rejection / scope-`turnId`), TMUX-082 (`player_view_changed` record + non-participating-observer rule), TMUX-083 (`LayoutObserver` full-rebuild semantics), TMUX-084 (hidden-pane scrollback limitation).
- [ ] `specs/test/tmux-play.md` — add TTMUX-079 (weight vocabulary + alias + conflict + precedence), TTMUX-080 (`initialVisible` loader + shape derivation), TTMUX-081 (home-config migration rewrite + default config), TTMUX-082 (launcher startup panes for the initial visible set), TTMUX-083 (`setVisiblePlayers` accept/reject + `player_view_changed` emission), TTMUX-084 (non-participating observers ignore `player_view_changed`), TTMUX-085 (`LayoutObserver` real-tmux full rebuild + hidden-pane reconstruction).
- [ ] `specs/map.md` — IR-027 indexed (done in this authoring step); TMUX / TTMUX package summaries refreshed to mention dynamic player visibility.
- [ ] `src/app/tmux-play/config.ts` — `layout.singlePlayerColumnWeights` / `layout.multiPlayerColumnWeights`, `columnWeights` alias + conflict rejection + resolution precedence, `layout.initialVisible`, visible-shape-driven weight validation, home-config migration rewrite, default-config update, snapshot inclusion.
- [ ] `src/app/tmux-play/config.test.ts` — TTMUX-079 / TTMUX-080 / TTMUX-081 loader, migration, and default cases.
- [ ] `src/app/tmux-play/launcher.ts` — startup panes from the resolved initial visible set; extracted reusable player-area build routine.
- [ ] `src/app/tmux-play/launcher.test.ts` + `launcher.acceptance.test.ts` — TTMUX-082 startup-visibility geometry / ordering.
- [ ] `src/app/tmux-play/contract.ts` — `setVisiblePlayers` on `CaptainSession` and `CaptainContext`.
- [ ] `src/app/tmux-play/records.ts` — `PlayerViewChangedRecord` added to `TmuxPlayRecord`.
- [ ] `src/app/tmux-play/runtime.ts` — validate IDs, emit `player_view_changed`, reject-before-emit, scope-correct `turnId`; wire both contract scopes.
- [ ] `src/__tests__` / `runtime` tests — TTMUX-083 / TTMUX-084 emission, validation, and non-participating-observer coverage.
- [ ] `src/app/tmux-play/layout-observer.ts` (new) + registration in `src/app/tmux-play/session.ts` — full player-area rebuild observer.
- [ ] `src/app/tmux-play/layout-observer` tests + `launcher.acceptance.test.ts` — TTMUX-085 real-tmux rebuild + hidden-pane reconstruction.
- [ ] `docs/tmux-play.md` — Config section documents `initialVisible` and the shape-specific weights / alias.

## Tasks

Each task is one commit and keeps `npm run build`, `npm run lint`, `npm test`, and `npm run test:smoke` green at its boundary.

1. [x] **Spec — layout weights, migration, default config (docs-only).**
   Amend [TMUX-064](../user/tmux-play.md#tmux-064) so `layout.columnWeights` is a two-/three-element compatibility alias and the canonical fields are `layout.singlePlayerColumnWeights` (default `[1, 1]`) and `layout.multiPlayerColumnWeights` (default `[1, 1, 1]`), with strict positive-integer validation, the both-present-rejection rule, and the resolution precedence (explicit preset → matching alias → shape default).
   Amend [TMUX-028](../user/tmux-play.md#tmux-028) so visible-column shape derives from the current visible set rather than the configured roster size.
   Amend [TMUX-010](../user/tmux-play.md#tmux-010) for the home-config rewrite of `columnWeights` to the canonical field (two-element → single, three-element → multi), the both-present rejection, the no-rewrite of `--config` / cwd configs, and replace the stale "resolved `layout` defaults from TMUX-064" wording with the dynamic-visibility layout fields.
   Amend [TMUX-011](../user/tmux-play.md#tmux-011) so the default home config uses `layout.multiPlayerColumnWeights: [1, 1, 1]`.
   Add [TTMUX-079](../test/tmux-play.md#ttmux-079) (weight vocabulary, alias, conflict, precedence) and [TTMUX-081](../test/tmux-play.md#ttmux-081) (migration rewrite + default config), and reconcile [TTMUX-064](../test/tmux-play.md#ttmux-064) to the new snapshot shape (resolved `singlePlayerColumnWeights` / `multiPlayerColumnWeights`) and validation rules.
   Update the `specs/map.md` TMUX package summary.

2. [ ] **Spec — visibility API, record, observer (docs-only).**
   Add [TMUX-080](../user/tmux-play.md#tmux-080) (`layout.initialVisible`: optional non-empty duplicate-free subset of configured player IDs; default all players in `players` order; array order is startup pane order; weight shape derives from this set; no zero-player layout).
   Amend [TMUX-016](../user/tmux-play.md#tmux-016) and [TMUX-017](../user/tmux-play.md#tmux-017) to add `setVisiblePlayers(playerIds)`, and add [TMUX-081](../user/tmux-play.md#tmux-081) for its validation (non-empty duplicate-free subset), reject-before-any-record semantics, visible-set-unchanged-on-failure, and the session-vs-turn `turnId` convention.
   Amend [TMUX-020](../user/tmux-play.md#tmux-020) (enumerate `player_view_changed`) and [TMUX-021](../user/tmux-play.md#tmux-021) (its `turnId` carriage), and add [TMUX-082](../user/tmux-play.md#tmux-082) for the `player_view_changed` record shape, one-per-accepted-call emission, and the rule that non-participating observers (presenter, follow, timing, notification) ignore it.
   Add [TMUX-083](../user/tmux-play.md#tmux-083) (`LayoutObserver` full player-area rebuild: kill-non-Boss, recreate in order via the launcher split sequence, `tail -n 200 -f`, reapply titles / timer options / read-only input / mouse bindings / layout hooks / Boss focus; tracked list advances only on full success; repeated-list no-op; display-only best-effort failure that never aborts a turn; successful-reconciliation-before-later-player-output guarantee on the ordered dispatch path) and [TMUX-084](../user/tmux-play.md#tmux-084) (hidden-pane scrollback limitation).
   Add [TTMUX-080](../test/tmux-play.md#ttmux-080), [TTMUX-082](../test/tmux-play.md#ttmux-082), [TTMUX-083](../test/tmux-play.md#ttmux-083), [TTMUX-084](../test/tmux-play.md#ttmux-084), [TTMUX-085](../test/tmux-play.md#ttmux-085).
   Refresh the `specs/map.md` summaries for these items.

3. [ ] **Config — weight vocabulary + migration + default.**
   In `src/app/tmux-play/config.ts` add `layout.singlePlayerColumnWeights` / `layout.multiPlayerColumnWeights`, keep `layout.columnWeights` as a two-/three-element alias, reject a config carrying both an alias and its matching canonical field, and resolve weights by precedence (explicit preset → matching alias → shape default) with the existing strict positive-integer validation.
   Extend `migrateHomeConfigSafeDefaults` to rewrite a home config's `columnWeights` into the canonical field as one final YAML form (no on-disk state with both fields), leaving `--config` / cwd configs untouched.
   Update `DEFAULT_TMUX_PLAY_CONFIG` / default home YAML to `multiPlayerColumnWeights: [1, 1, 1]`.
   Cover TTMUX-079 / TTMUX-081 in `config.test.ts`.
   (Weight shape stays keyed to the configured roster in this task; Task 4 re-keys it to the visible set.)

4. [ ] **Config — `layout.initialVisible` + visible-set shape.**
   Add `layout.initialVisible` to `config.ts`: validate it is a non-empty, duplicate-free subset of configured player IDs; default to every configured player in `players` order; preserve array order; reject malformed entries per [TMUX-008](../user/tmux-play.md#tmux-008).
   Re-key the visible-column shape (and thus the weight length / preset selection) to the resolved initial visible set instead of the roster size.
   Carry `initialVisible` and the resolved visible set in the config snapshot for session mode.
   Cover TTMUX-080 in `config.test.ts`.

5. [ ] **Launcher — startup panes from the initial visible set.**
   In `src/app/tmux-play/launcher.ts` build the startup player panes for the resolved initial visible set in `initialVisible` order (not the whole roster), deriving geometry from that set, and extract the single-Boss-pane → N-player-panes build (split sequence, `tail` command, titles, timer options, read-only input, mouse bindings, layout hooks, Boss focus) into a reusable routine the `LayoutObserver` will call.
   Update `launcher.test.ts` and `launcher.acceptance.test.ts` for TTMUX-082 (startup geometry and ordering for a configured `initialVisible` subset, and the all-visible default).

6. [ ] **Contract + runtime — `setVisiblePlayers` + `player_view_changed`.**
   Add `setVisiblePlayers(playerIds): Promise<void>` to `CaptainSession` and `CaptainContext` in `contract.ts`.
   Add `PlayerViewChangedRecord` to the `TmuxPlayRecord` union in `records.ts` (and the sub-export record types).
   In `runtime.ts` validate `playerIds` is a non-empty, duplicate-free subset of configured IDs and reject before emitting any record (visible set unchanged on failure); on success emit exactly one `player_view_changed` carrying `visiblePlayerIds` and the scope-correct `turnId` (active turn ID for `CaptainContext`; active turn ID or `null` for `CaptainSession`), on the ordered, awaited dispatch path.
   Cover TTMUX-083 emission/validation and TTMUX-084 (existing presenter / follow / timing / notification observers ignore the record) in runtime/observer unit tests.

7. [ ] **Presentation — `LayoutObserver` full rebuild.**
   Add `src/app/tmux-play/layout-observer.ts`: consume `player_view_changed`; perform the full player-area rebuild reusing Task 5's routine from the single-Boss-pane condition (kill every main-window pane except Boss/Captain, recreate `visiblePlayerIds` in order, run each as `tail -n 200 -f <player>.log`, reapply titles / timer options / read-only input / mouse bindings / layout hooks / Boss focus); initialize the tracked visible list from the startup visible set and advance it only on fully successful reconciliation; treat a repeated list as a no-op issuing no tmux commands; swallow or surface tmux failures as best-effort status without aborting a turn.
   Register it among the session-mode observers in `session.ts` so its rebuild runs before the newly visible player's later records are presented.
   Add `layout-observer` unit coverage and a real-tmux TTMUX-085 acceptance probe (rebuild kills non-Boss panes, recreates the requested set in order, replays the bounded log tail, reapplies pane config, no-ops on a repeated set, reconstructs a re-shown hidden player's pane from its log tail) in `launcher.acceptance.test.ts`.
   Update `docs/tmux-play.md` Config section for `initialVisible`, the shape-specific weights, and the `columnWeights` alias.

## Acceptance criteria

- `npm run build`, `npm run lint`, `npm test`, and `npm run test:smoke` pass at every task boundary; `npm run test:acceptance` passes (with `tmux` available) after Tasks 5 and 7.
- Existing configs are unchanged in behavior: omitting `layout.initialVisible` keeps every configured player visible in `players` order, and a legacy `layout.columnWeights` still resolves through the alias.
- After Task 3, a config may set `singlePlayerColumnWeights` / `multiPlayerColumnWeights`; a two-element `columnWeights` resolves to the single-player preset and a three-element to the multi-player preset; a config with both an alias and its matching canonical field is rejected with an error naming the offending path; a fallback-discovered home config with only `columnWeights` is rewritten to the canonical field with no on-disk file ever holding both; the shipped default home config carries `multiPlayerColumnWeights: [1, 1, 1]`.
- After Task 4, `layout.initialVisible` accepts a non-empty, duplicate-free subset of configured player IDs and rejects an empty array, duplicates, or a non-subset / unknown ID with an error naming the offending path; the weight length / preset shape derives from the resolved initial visible set; the snapshot carries `initialVisible` and the resolved visible set.
- After Task 5, the launcher creates startup panes for exactly the resolved initial visible set, in `initialVisible` order, with geometry derived from that set, and the all-visible default reproduces today's startup layout.
- After Task 6, a `setVisiblePlayers` call with a valid subset emits exactly one `player_view_changed` with the requested `visiblePlayerIds` and the scope-correct `turnId`; an invalid argument rejects before any record is emitted and leaves the visible set unchanged; the presenter, follow, timing, and notification observers produce no output / side effect for `player_view_changed`.
- After Task 7, on a real tmux server an accepted visibility change kills every main-window pane except Boss/Captain, recreates the requested players in order as `tail -n 200 -f` views, reapplies pane titles / timer options / read-only input / mouse bindings / layout hooks / Boss focus, no-ops on a repeated visible set, reconstructs a re-shown hidden player's pane from its recent log tail, and never aborts the Boss turn on a tmux failure; an awaited `setVisiblePlayers(next)` followed by `callPlayer()` for a newly visible player reconciles its pane before that player's later records are presented.
