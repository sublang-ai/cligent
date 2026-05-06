<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# TMUX: tmux-play CLI and Captain Runtime

## Intent

The `tmux-play` CLI, its YAML configuration, Captain extension contract, record set, observer dispatch, tmux topology, programmatic runtime API, and the built-in `fanout` Captain per [DR-004](../decisions/004-tmux-play-captain-architecture.md).

## CLI Invocation

### TMUX-001

The `@sublang/cligent` package shall expose a `tmux-play` bin entry.

### TMUX-002

When `tmux-play` is invoked without `--session`, the CLI shall run launcher mode: resolve the config, construct the tmux session, attach, and exit.

### TMUX-003

When `tmux-play` is invoked with `--session <id> --work-dir <path>`, the CLI shall run session mode: instantiate the Captain and roles, run a Boss readline against stdin/stdout, dispatch records to observers, and clean up on exit.

### TMUX-004

When `--config <path>` is supplied, the launcher shall load that file and skip discovery and first-run auto-create.

## Configuration

### TMUX-005

A `tmux-play` config shall be YAML with a `captain` object and a non-empty `roles` array.

### TMUX-006

The `captain` object shall require `from` (local path or package specifier), `adapter` (one of `claude`, `codex`, `gemini`, `opencode`), and may include `model`, `instruction`, and an opaque `options` value forwarded verbatim to the Captain factory.

### TMUX-007

Each entry in `roles` shall require `id` and `adapter` (one of `claude`, `codex`, `gemini`, `opencode`), and may include `model` and `instruction`. Role `id` shall match `^[a-z][a-z0-9_-]*$`, be unique within the config, and shall not equal `captain`. Multiple roles may share an adapter and model.

### TMUX-008

When loading a config, the loader shall reject malformed YAML and unknown fields with an error that names the offending file or path.

## Discovery and First-Run

### TMUX-009

When `--config` is not supplied, the launcher shall search for `tmux-play.config.yaml` in the current directory first, then `${XDG_CONFIG_HOME:-~/.config}/tmux-play/config.yaml`. The first match shall be used. `XDG_CONFIG_HOME` shall be treated as unset when empty.

### TMUX-010

When neither location holds a config and `--config` is not supplied, the launcher shall create the home location with a default config, print a one-line notice naming the path on stdout, and continue. Subsequent invocations shall preserve the existing home config without overwriting.

### TMUX-011

The default home config shall wire the built-in `fanout` Captain on the `claude` adapter and two roles whose IDs match their adapters: `claude` (claude adapter) and `codex` (codex adapter). Each default role shall include an `instruction` that identifies that role for the runtime-created `Cligent` instance.

### TMUX-012

When the cwd contains a legacy `tmux-play.config.mjs`, `tmux-play.config.js`, or `tmux-play.config.json` and no cwd YAML, the launcher shall print a one-line stderr warning naming the legacy file before continuing.

### TMUX-013

Local `captain.from` paths shall resolve against the directory of the originating config file. Package specifiers shall pass through to Node's module resolver.

## Captain Extension Contract

### TMUX-014

A Captain module shall default-export a factory `(options: unknown) => Captain | Promise<Captain>`. The returned `Captain` shall implement `handleBossTurn(turn, context): Promise<void>` and may implement `init(session): Promise<void>` and `dispose(): Promise<void>` lifecycle hooks.

### TMUX-015

The runtime shall own every role and Captain `Cligent` instance. Captains shall reach roles only through the `context` passed to `handleBossTurn` and shall not construct adapters or `Cligent` directly.

### TMUX-016

`CaptainContext` shall expose a turn-scoped `signal: AbortSignal`, a readonly `roles` manifest, and `callRole(roleId, prompt)` and `callCaptain(prompt)` methods. The methods shall return `RoleRunResult` and `CaptainRunResult` respectively per [TMUX-033](#tmux-033).

### TMUX-017

`CaptainSession` shall expose a session-scoped `signal: AbortSignal`, a readonly `roles` manifest, and `emitStatus(message, data?)` and `emitTelemetry({ topic, payload })` methods. Captains may retain the session reference from `init` and emit at any point during the session — within `init`, during turns, or between turns.

### TMUX-018

The runtime shall serialize Boss turns: at most one `handleBossTurn` invocation may be in flight per session.

### TMUX-019

On session shutdown the runtime shall (1) unwind the active turn, (2) abort `CaptainSession.signal`, (3) drain accepted session emissions, (4) call `Captain.dispose()` exactly once, and (5) detach observers. Post-shutdown `emitStatus`/`emitTelemetry` calls shall reject.

## Record Types and Observer Dispatch

### TMUX-020

The runtime shall emit records of these types: `turn_started`, `turn_finished`, `turn_aborted`, `role_prompt`, `role_event`, `role_finished`, `captain_prompt`, `captain_event`, `captain_finished`, `captain_status`, `captain_telemetry`, `runtime_error`. Each record shall carry a stable role ID where applicable.

### TMUX-021

Turn-bound records shall carry `turnId: number`. `captain_status` and `captain_telemetry` emitted outside an active turn shall carry `turnId: null`.

### TMUX-022

Within a turn the runtime shall emit `turn_started` first; for each role `role_prompt` → `role_event*` → `role_finished`; for each `callCaptain()` `captain_prompt` → `captain_event*` → `captain_finished`; and `turn_finished` (or `turn_aborted` on abort) last.

### TMUX-023

Observers shall be invoked in registration order. The dispatcher shall await each observer's returned Promise before dispatching the next record. Records shall not be dropped or coalesced.

### TMUX-024

Turn-bound emissions shall drain before `turn_finished`/`turn_aborted`. `turnId: null` emissions shall dispatch in emission order without a turn boundary. Multiple observers may register against one runtime; each shall receive every record.

### TMUX-025

The runtime shall emit a `runtime_error` record when a control-plane failure prevents normal record emission — startup, `Captain.init`, a `handleBossTurn` exception, or observer dispatch. The record shall carry `turnId: number` when an active turn exists at the moment of failure, else `turnId: null`. After emission, the runtime shall abort the active turn if any and run shutdown per [TMUX-019](#tmux-019). When the failure originates in an observer, the record shall additionally be delivered to the remaining observers in registration order before shutdown begins. Individual role or Captain run failures shall surface in the corresponding `role_finished` / `captain_finished` record with `status: 'error'`, not as `runtime_error`.

### TMUX-026

When SIGINT, SIGTERM, or stdin EOF reaches the session, the runtime shall abort the active turn, run shutdown per [TMUX-019](#tmux-019), kill the tmux session, and remove launcher-owned work directories.

## tmux Topology

### TMUX-027

The Boss/Captain pane shall occupy the left column. Role panes shall fill the right side in config order, read-only.

### TMUX-028

With two or more roles, `tmux-play` shall use two role columns. The Boss/Captain pane shall occupy 4/16 of the window width and each role column shall occupy 6/16 of the window width. The first column shall hold `ceil(roleCount / 2)` roles from top to bottom.

## Programmatic Runtime API

### TMUX-029

The `@sublang/cligent/tmux-play` sub-export shall expose a runtime factory accepting an instantiated `captain`, a `captainConfig` with `adapter` (one of `claude`, `codex`, `gemini`, `opencode`) and optional `model` and `instruction`, a non-empty `roles` array (each entry with `id`, `adapter`, optional `model`, optional `instruction`, conforming to [TMUX-007](#tmux-007)), zero or more `observers`, an optional `cwd`, and an optional session-scoped `signal`. The factory shall return a runtime that drives Boss turns without tmux. Record types and the observer-registration contract shall export from the same sub-export.

## Built-in Fanout Captain

### TMUX-030

The `@sublang/cligent/captains/fanout` Captain shall, per Boss turn, invoke `callRole` for every configured role concurrently, then issue a single `callCaptain` summary referencing each role's status and final text.

### TMUX-031

The fanout Captain shall not copy raw role events into the Boss/Captain pane; only the synthesized summary shall reach the Boss via `callCaptain`.

## Public Contract Shapes

### TMUX-032

A `BossTurn` argument shall expose the turn's numeric `id`, the Boss `prompt`, and a `timestamp`. A `RoleHandle` shall expose the role `id`, the `adapter`, and an optional `model`.

### TMUX-033

`RoleRunResult` shall expose `roleId`, `turnId`, and `status`, and may include `finalText` and `error`. `CaptainRunResult` shall expose `turnId` and `status`, and may include `finalText` and `error`. `status` values are `'ok' | 'aborted' | 'error'`; aborted results may carry neither `finalText` nor `error`.

## Launcher → Session Protocol

### TMUX-034

The launcher shall convert the resolved YAML config into a JSON snapshot written to the session's work directory, with local `captain.from` paths normalized to absolute `file://` URLs and package specifiers passed through unchanged. Session mode shall read the snapshot rather than reloading the YAML, so config changes made between launch and session start shall not affect the running session.

## Initial Window Geometry

### TMUX-035

When the launcher creates the tmux session, the session shall be created with a 16:9 cell grid sized for a 1920×1080 display, defaulting to 240 columns by 67 rows. When a client attaches with a different window size, tmux's normal size negotiation shall govern the displayed layout.

## Pane Titles

### TMUX-036

The Boss/Captain pane title shall be `Captain`. Each role pane title shall be the role `id` rendered with the first character upper-cased and the remaining characters preserved (e.g., `coder` → `Coder`, `reviewer` → `Reviewer`). The literal `Role:` prefix shall not appear in pane titles.

## Presenter Output

### TMUX-037

While in session mode, the Boss readline shall echo the user's input line as the user types it (standard readline behavior). When the runtime emits `turn_started`, the presenter shall not write the Boss prompt to the Boss/Captain pane, so the user's input shall appear exactly once in the pane.

### TMUX-038

The presenter shall tag every textual line written to a tmux-play pane with a `<who>> ` prefix where `<who>` is `boss`, `captain`, or the speaker's role `id`. The Boss readline prompt shall be `boss> `; the Captain's reply rendered in the Boss/Captain pane shall be prefixed with `captain> `; the Captain's prompt rendered in a role pane shall be prefixed with `captain> `; and the role's reply rendered in the role pane shall be prefixed with `<roleId>> `. Bracket-tag notation such as `[from captain]` or `[captain llm prompt]` shall not be used.

### TMUX-039

When a role or Captain run finishes with `status: 'ok'`, the presenter shall not write a trailing status line such as `[role <id> ok]` or `[captain ok]`. When a run finishes with `status: 'error'`, the presenter shall write a single `<who>> [error: <message>]` line in the corresponding pane, where `<message>` is the result's `error` field. When a run finishes with `status: 'aborted'`, the presenter shall write a single `<who>> [aborted]` line; per [TMUX-033](#tmux-033) aborted results need not carry a reason, so no reason is rendered.

### TMUX-040

The Boss/Captain pane shall display the Boss's input lines, the Captain's synthesized reply or terminal Captain failure line per [TMUX-039](#tmux-039), and operational records intended for that pane (`captain_status`, `runtime_error`, and `turn_aborted`). Per-role outputs and the Captain's prompt body (which references role results) shall not be written to the Boss/Captain pane.

## Role Session Continuity

### TMUX-041

Within a single tmux-play session, each role's `Cligent` instance shall be created once and reused across every Boss turn. Per [ENG-005](engine.md#eng-005), the engine shall auto-inject `resume` on subsequent runs when the underlying adapter emits a `resumeToken`, so role responses on later turns may build on prior context for adapters that support session continuity.

### TMUX-042

The built-in fanout Captain shall convey each role's identity once, via the role's `instruction` configured at `Cligent` construction. Per Boss turn, the per-role prompt the fanout Captain passes to `callRole` shall consist of the Boss prompt and turn-specific instructions only, and shall not repeat a role identity preamble such as `You are the "<role>" role`.
