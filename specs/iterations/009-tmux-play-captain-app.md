<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-009: tmux-play Captain App

## Goal

Implement [DR-004](../decisions/004-tmux-play-captain-architecture.md): the `tmux-play` CLI, its programmatic runtime API, the record/observer boundary, and `fanout` as the first built-in Captain shipped at `@sublang/cligent/captains/fanout`.

## Status

Proposed

## Scope

In scope:

- `tmux-play` CLI (launcher + session) replacing the prior `fanout` bin.
- Config loading from `.mjs`/`.js`/`.json`, JSON snapshot to work-dir, and `captain.from` path rewriting.
- Runtime API, Captain extension contract types, and `@sublang/cligent/tmux-play` exports.
- Record set, observer dispatcher, and tmux presenter.
- `fanout` Captain at `@sublang/cligent/captains/fanout`.

Out of scope: see DR-004 §Out of Scope.

## Deliverables

- [x] `package.json` — replace `bin: fanout` with `bin: tmux-play`; retarget the `postbuild` chmod; add `./tmux-play` and `./captains/fanout` exports.
- [x] `src/app/shared/` — tmux, log, shell-quoting, and event-formatting helpers.
- [x] `src/app/tmux-play/cli.ts` — arg parsing, launcher/session dispatch.
- [x] `src/app/tmux-play/config.ts` — config loading, validation, snapshot writer, `captain.from` rewriting.
- [x] `src/app/tmux-play/roles.ts` — role resolution and per-role `Cligent` construction.
- [x] `src/app/tmux-play/contract.ts` — `Captain` (with optional `init(session)` and `dispose()`), `BossTurn`, `CaptainSession`, `CaptainContext`, `CaptainTelemetry`, `RoleHandle`, `RunStatus`, `RoleRunResult`, `CaptainRunResult`. No per-call options until a consumer needs them.
- [x] `src/app/tmux-play/records.ts` — record types (including `captain_telemetry`); session-scoped `captain_status` / `captain_telemetry` carry `turnId: number | null`; observer dispatcher with multi-observer registration, shared per-session queue, and turn-bound drain semantics.
- [x] `src/app/tmux-play/runtime.ts` — programmatic runtime API; turn loop, abort, `Captain.init(session)` and `dispose()`, `CaptainSession` (session abort, roles, `emitStatus`, `emitTelemetry`), `CaptainContext` (turn abort, roles, `callRole`, `callCaptain`), observer registration, shutdown drain order.
- [x] `src/app/tmux-play/presenter-tmux.ts` — tmux observer; consumes `captain_status`, ignores `captain_telemetry`.
- [x] `src/app/tmux-play/launcher.ts` — work-dir/logs, snapshot, tmux session, attach.
- [x] `src/app/tmux-play/session.ts` — Boss readline, runtime invocation, observer registration (tmux plus configured opt-in presenters), abort/cleanup.
- [x] `src/app/tmux-play/index.ts` — public re-exports for `@sublang/cligent/tmux-play`, including the observer-registration contract and `CaptainSession`.
- [x] `src/captains/fanout.ts` — `fanout` Captain factory and prompt logic.
- [ ] Tests: config + snapshot, role resolution, contract types, observer dispatch (multi-observer registration, status/telemetry drain, `turnId` nullable for session-scoped emissions), `init`/`dispose` lifecycle, shutdown drain order, fanout prompts and result collection, runtime causality.
- [x] Replace `src/app/fanout.acceptance.test.ts` with a tmux-play acceptance test driving the fanout Captain through the runtime API.
- [ ] README for `tmux-play`, config formats, snapshot mechanism, layout, and writing custom Captains.

## Tasks

1. Extract shared primitives (shell quoting, tmux invocation, log files, event formatting) under `src/app/shared/`.
2. Role resolution: `{ id, adapter, model, instruction }`, ID regex, reserved `captain` ID, duplicate adapters across roles; test it.
3. Config loading for `.mjs`/`.js`/`.json` with discovery and `--config <path>`. Validate the Captain and role schemas; fail fast on unknown adapters, missing fields, unsupported extensions, invalid IDs, and non-serializable values.
4. Snapshot writer: rewrite local `captain.from` paths to absolute `file://` URLs against the original config directory; pass package specifiers through unchanged; emit JSON to the work directory.
5. Define the Captain extension contract types and runtime API in `src/app/tmux-play/`: `Captain` with optional `init(session)`/`dispose()`, `CaptainSession` (session abort, roles, emit methods), `CaptainContext` (turn abort, roles, run methods); wire the `@sublang/cligent/tmux-play` sub-export to expose these plus the observer-registration contract.
6. Record types and observer dispatcher: registration-order delivery, awaited per record, no drops, multi-observer registration. Add `captain_telemetry`. Stamp `turnId: number` on turn-bound records and `turnId: null` on session-scoped `captain_status` / `captain_telemetry` emitted outside an active turn. `runtime_error` on observer failure. Both lanes share one ordered per-session queue; turn-bound emissions drain before `turn_finished`/`turn_aborted`; out-of-turn emissions dispatch in order without a turn boundary.
7. Runtime: turn serialization, persistent Captain and role `Cligent`s, `callRole`/`callCaptain` wrappers bound to `context.signal` with record emission, `CaptainSession` plumbing for `emitStatus`/`emitTelemetry`, `Captain.init(session)` (with observers attached first) and `dispose()` on shutdown. Implement the shutdown order: turn unwind → abort `session.signal` → drain accepted session emissions → `dispose()` → detach observers; reject post-abort emit calls.
8. Tmux presenter: route role records to role logs, Captain/Boss records to the Boss/Captain pane; consume `captain_status`; ignore `captain_telemetry` (it is for opt-in observers, not the Boss pane).
9. `fanout` Captain at `src/captains/fanout.ts`: factory, role prompts, concurrent role calls, bounded summary prompt, `callCaptain`.
10. Launcher: load config, run snapshot writer, build Boss-left/roles-right tmux layout, set pane titles, attach.
11. Session CLI: read snapshot, dynamic-import `captain.from`, construct factory and roles, register observers (tmux presenter plus any configured opt-in presenters), readline loop, observer dispatch, handle SIGINT/SIGTERM/EOF and `dispose()`.
12. Replace `src/app/fanout.acceptance.test.ts` with a tmux-play acceptance test driving the fanout Captain through the runtime API.
13. Document run examples, config formats, the snapshot mechanism, layout, and a sample custom Captain.

## Verification

- `npm run build` and `npm test` pass.
- `npm run test:acceptance` drives the fanout Captain end-to-end via the runtime API when credentials are present; the old `fanout.acceptance.test.ts` is removed.
- `tmux-play` (default discovery) launches a session with Boss/Captain on the left and role panes on the right.
- `tmux-play --config <path>` accepts `.mjs`, `.js`, and `.json`.
- The launcher writes a JSON snapshot to work-dir; local `captain.from` paths become absolute `file://` URLs and package specifiers are unchanged.
- The session reads the snapshot and does not re-execute user JS.
- A non-tmux observer for one Boss turn asserts causality: `turn_started` first; per role `role_prompt` → `role_event`s → one `role_finished`; per `callCaptain()` `captain_prompt` → `captain_event`s → `captain_finished`; `turn_finished` last (or `turn_aborted` on abort).
- Multiple observers can register against one runtime; each receives every record in registration order.
- `emitStatus()` and `emitTelemetry()` records deliver in emission order on the shared per-session queue. Records emitted within a turn carry `turnId: number` and drain before `turn_finished`/`turn_aborted`; records emitted from `Captain.init(session)` or between turns carry `turnId: null`. The tmux presenter consumes `captain_status` and ignores `captain_telemetry`; a test observer asserts the records are delivered with the expected `topic`/`payload` shape.
- An observer or runtime failure emits `runtime_error`, aborts the active turn, and runs cleanup.
- `Captain.init(session)` runs with observers already attached, so init-time emissions and init failures reach them. `Captain.dispose()` is invoked exactly once on session shutdown, after `session.signal` aborts and accepted session emissions drain. Post-abort `emitStatus`/`emitTelemetry` calls reject.
- For the fanout Captain: role runs execute concurrently; Captain summary appears in the Boss pane after roles settle; raw role events are not copied into the Boss pane.
- SIGINT, SIGTERM, and EOF abort active runs, close streams, remove launcher-owned work dirs, and kill the tmux session.
