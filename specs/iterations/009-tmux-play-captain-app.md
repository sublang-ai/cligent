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

- [ ] `package.json` — replace `bin: fanout` with `bin: tmux-play`; retarget the `postbuild` chmod; add `./tmux-play` and `./captains/fanout` exports.
- [ ] `src/app/shared/` — tmux, log, shell-quoting, and event-formatting helpers.
- [ ] `src/app/tmux-play/cli.ts` — arg parsing, launcher/session dispatch.
- [ ] `src/app/tmux-play/config.ts` — config loading, validation, snapshot writer, `captain.from` rewriting.
- [ ] `src/app/tmux-play/roles.ts` — role resolution and per-role `Cligent` construction.
- [ ] `src/app/tmux-play/contract.ts` — `Captain`, `BossTurn`, `CaptainContext`, `CaptainTelemetry`, `RoleHandle`, `RoleRunResult`, `CaptainRunResult`, `RoleCallOptions`, `CaptainCallOptions`.
- [ ] `src/app/tmux-play/records.ts` — record types (including `captain_telemetry`) and observer dispatcher with status/telemetry-drain semantics.
- [ ] `src/app/tmux-play/runtime.ts` — programmatic runtime API; turn loop, abort, `dispose`, `emitStatus`, `emitTelemetry`.
- [ ] `src/app/tmux-play/presenter-tmux.ts` — tmux observer.
- [ ] `src/app/tmux-play/launcher.ts` — work-dir/logs, snapshot, tmux session, attach.
- [ ] `src/app/tmux-play/session.ts` — Boss readline, runtime invocation, abort/cleanup.
- [ ] `src/app/tmux-play/index.ts` — public re-exports for `@sublang/cligent/tmux-play`.
- [ ] `src/captains/fanout.ts` — `fanout` Captain factory and prompt logic.
- [ ] Tests: config + snapshot, role resolution, contract types, observer dispatch + status drain, fanout prompts and result collection, runtime causality.
- [ ] Replace `src/app/fanout.acceptance.test.ts` with a tmux-play acceptance test driving the fanout Captain through the runtime API.
- [ ] README for `tmux-play`, config formats, snapshot mechanism, layout, and writing custom Captains.

## Tasks

1. Extract shared primitives (shell quoting, tmux invocation, log files, event formatting) under `src/app/shared/`.
2. Role resolution: `{ id, adapter, model, instruction }`, ID regex, reserved `captain` ID, duplicate adapters across roles; test it.
3. Config loading for `.mjs`/`.js`/`.json` with discovery and `--config <path>`. Validate the Captain and role schemas; fail fast on unknown adapters, missing fields, unsupported extensions, invalid IDs, and non-serializable values.
4. Snapshot writer: rewrite local `captain.from` paths to absolute `file://` URLs against the original config directory; pass package specifiers through unchanged; emit JSON to the work directory.
5. Define the Captain extension contract types and runtime API in `src/app/tmux-play/`; wire the `@sublang/cligent/tmux-play` sub-export.
6. Record types and observer dispatcher: registration-order delivery, awaited per record, no drops; `runtime_error` on observer failure; `captain_status` and `captain_telemetry` both drain before subsequent records and before `turn_finished`/`turn_aborted`.
7. Runtime: turn serialization, persistent Captain and role `Cligent`s, `callRole`/`callCaptain` wrappers bound to the abort signal with record emission, `emitStatus` and `emitTelemetry` both returning `Promise<void>`, and `dispose()` on shutdown.
8. Tmux presenter: route role records to role logs, Captain/Boss records to the Boss/Captain pane; ignore `captain_telemetry` (it is for opt-in observers, not the Boss pane).
9. `fanout` Captain at `src/captains/fanout.ts`: factory, role prompts, concurrent role calls, bounded summary prompt, `callCaptain`.
10. Launcher: load config, run snapshot writer, build Boss-left/roles-right tmux layout, set pane titles, attach.
11. Session CLI: read snapshot, dynamic-import `captain.from`, construct factory and roles, readline loop, observer dispatch, handle SIGINT/SIGTERM/EOF and `dispose()`.
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
- `emitStatus()` and `emitTelemetry()` records deliver in emission order, before any subsequent record and before `turn_finished`/`turn_aborted`. Telemetry records carry the active turn ID. The tmux presenter receives `captain_telemetry` and ignores it; a test observer asserts the records are delivered with the expected `topic`/`payload` shape.
- An observer or runtime failure emits `runtime_error`, aborts the active turn, and runs cleanup.
- `dispose()` is invoked exactly once on session shutdown.
- For the fanout Captain: role runs execute concurrently; Captain summary appears in the Boss pane after roles settle; raw role events are not copied into the Boss pane.
- SIGINT, SIGTERM, and EOF abort active runs, close streams, remove launcher-owned work dirs, and kill the tmux session.
