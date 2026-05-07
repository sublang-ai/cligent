<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# TTMUX: tmux-play Tests

## Intent

Verification criteria for the `tmux-play` CLI, configuration, Captain runtime, and built-in `fanout` Captain defined in [user/tmux-play.md](../user/tmux-play.md).

## Configuration and Discovery

### TTMUX-001

Verifies: [TMUX-010](../user/tmux-play.md#tmux-010), [TMUX-011](../user/tmux-play.md#tmux-011)

Given an empty home and cwd, when launching `tmux-play` without `--config`, the home YAML shall be created with the default `fanout` Captain plus `claude` and `codex` roles with identity instructions, a one-line notice naming the path shall be printed to stdout, and a second invocation shall not overwrite the file.

### TTMUX-002

Verifies: [TMUX-009](../user/tmux-play.md#tmux-009)

Given a `tmux-play.config.yaml` in cwd and a different YAML at the home location, when launching, the cwd config shall be loaded and the home file shall be left untouched.

### TTMUX-003

Verifies: [TMUX-009](../user/tmux-play.md#tmux-009)

Given `XDG_CONFIG_HOME` set to a non-empty path, when launching, the home location shall be `${XDG_CONFIG_HOME}/tmux-play/config.yaml`. Given `XDG_CONFIG_HOME` empty or unset, the home location shall be `~/.config/tmux-play/config.yaml`.

### TTMUX-004

Verifies: [TMUX-012](../user/tmux-play.md#tmux-012)

Given a `tmux-play.config.{mjs,js,json}` in cwd and no cwd YAML, when launching, a one-line stderr warning shall name the legacy file before normal execution proceeds.

### TTMUX-005

Verifies: [TMUX-005](../user/tmux-play.md#tmux-005), [TMUX-006](../user/tmux-play.md#tmux-006), [TMUX-007](../user/tmux-play.md#tmux-007), [TMUX-008](../user/tmux-play.md#tmux-008)

Given malformed YAML or a config that violates the schema (unknown adapter, unknown field, invalid role id, duplicate role id, role id `captain`, empty roles), when launching, the launcher shall fail with an error naming the offending file or path.

### TTMUX-006

Verifies: [TMUX-013](../user/tmux-play.md#tmux-013)

Given a cwd config whose `captain.from` is a relative local path, when session mode imports the Captain, resolution shall be anchored at the original config file's directory; package specifiers shall reach Node's resolver unchanged.

## Runtime Causality and Dispatch

### TTMUX-007

Verifies: [TMUX-022](../user/tmux-play.md#tmux-022)

Given a Captain that calls one role then `callCaptain`, when handling a Boss turn, observers shall receive records in this order: `turn_started`, `role_prompt`, `role_event`*, `role_finished`, `captain_prompt`, `captain_event`*, `captain_finished`, `turn_finished`. All shall carry the same `turnId`.

### TTMUX-008

Verifies: [TMUX-023](../user/tmux-play.md#tmux-023), [TMUX-024](../user/tmux-play.md#tmux-024)

Given two registered observers, when a record is emitted, both shall receive the record in registration order before the dispatcher releases the next record.

### TTMUX-009

Verifies: [TMUX-017](../user/tmux-play.md#tmux-017), [TMUX-021](../user/tmux-play.md#tmux-021)

When a Captain emits `emitStatus` from `init`, the resulting `captain_status` record shall arrive at every observer with `turnId: null` before any `turn_started`.

### TTMUX-010

Verifies: [TMUX-024](../user/tmux-play.md#tmux-024), [TMUX-026](../user/tmux-play.md#tmux-026)

When the abort signal fires during a turn, the runtime shall emit `turn_aborted` (not `turn_finished`); turn-bound emissions enqueued before the abort shall drain first.

### TTMUX-011

Verifies: [TMUX-025](../user/tmux-play.md#tmux-025)

When a registered observer rejects, the runtime shall emit `runtime_error` to remaining observers, abort the active turn if any, and complete normal cleanup. The runtime call may reject; whether it does is unconstrained by this item.

### TTMUX-012

Verifies: [TMUX-019](../user/tmux-play.md#tmux-019)

On session shutdown, `Captain.dispose()` shall run exactly once, after the active turn unwinds and after accepted session emissions drain. Post-shutdown `emitStatus`/`emitTelemetry` calls shall reject.

## CLI and Topology

### TTMUX-013

Verifies: [TMUX-001](../user/tmux-play.md#tmux-001)

Given the built bin on PATH (or invoked directly with execute permission), when launched on a POSIX runner, `tmux-play --help` shall exit 0 and print a usage banner.

### TTMUX-014

Verifies: [TMUX-027](../user/tmux-play.md#tmux-027), [TMUX-028](../user/tmux-play.md#tmux-028)

Given N configured roles, when the launcher constructs the tmux session, the layout shall be Boss/Captain on the left and N role panes on the right in config order; with N ≥ 2, the Boss/Captain pane shall occupy 4/16 of the window width, the right side shall use two 6/16 role columns, and the first role column shall hold `ceil(N / 2)` roles top-to-bottom.

### TTMUX-015

Verifies: [TMUX-003](../user/tmux-play.md#tmux-003), [TMUX-034](../user/tmux-play.md#tmux-034)

Given a snapshot file at the work directory, when session mode runs, the Captain shall be imported once from `captain.from` (a `file://` URL for local paths or a package specifier) and Boss turns shall flow through the runtime per [TTMUX-007](#ttmux-007).

## Built-in Fanout Captain (Acceptance)

### TTMUX-016

Verifies: [TMUX-030](../user/tmux-play.md#tmux-030)

Given the built-in fanout Captain and the four supported adapters as roles with valid credentials, when handling a Boss turn that requires a sentinel token in every reply, every `role_finished` shall report `status: 'ok'` with the sentinel in `finalText`, and the `captain_finished` summary shall reference each role's status and contain the sentinel. `runtime_error` and `turn_aborted` shall not appear.

### TTMUX-017

Verifies: [TMUX-030](../user/tmux-play.md#tmux-030)

Given the fanout Captain and N configured roles, when handling a Boss turn, all N `role_prompt` records shall be emitted before any `role_finished` record (concurrent dispatch), and the `captain_prompt` record shall be emitted only after every `role_finished`.

## Runtime Error Sources

### TTMUX-018

Verifies: [TMUX-025](../user/tmux-play.md#tmux-025)

When `Captain.init(session)` rejects before any turn starts, the runtime shall emit `runtime_error` with `turnId: null` to every registered observer, run shutdown, and shall not deliver any `turn_started` record.

### TTMUX-019

Verifies: [TMUX-025](../user/tmux-play.md#tmux-025)

When `handleBossTurn` rejects mid-turn, the runtime shall emit `runtime_error` carrying the active `turnId`, then `turn_aborted`, and shall complete shutdown.

### TTMUX-020

Verifies: [TMUX-034](../user/tmux-play.md#tmux-034)

Given a cwd YAML config whose `captain.from` is a relative local path and a separate config whose `captain.from` is a package specifier, when the launcher prepares each session, the work directory shall contain a JSON snapshot in which the local path is rewritten to an absolute `file://` URL and the package specifier is preserved verbatim. Mutations to the YAML after launch shall not affect the running session.

## Window Geometry and Topology

### TTMUX-021

Verifies: [TMUX-035](../user/tmux-play.md#tmux-035)

When the launcher creates the tmux session, the `new-session` invocation shall request a 240-column by 67-row grid (16:9 sized for 1920×1080).

### TTMUX-022

Verifies: [TMUX-028](../user/tmux-play.md#tmux-028)

Given two or more roles, when the launcher constructs the tmux session against a 240-column-wide grid, the Boss/Captain pane shall occupy 60 columns (4/16) and each of the two role columns shall occupy 90 columns (6/16), within tmux's nearest-cell rounding.

## Pane Titles

### TTMUX-023

Verifies: [TMUX-036](../user/tmux-play.md#tmux-036)

Given roles with ids `coder` and `reviewer`, when the launcher sets pane titles, the Boss/Captain pane title shall be `Captain` and the role pane titles shall be `Coder` and `Reviewer` respectively. No pane title shall contain the substring `Role:`.

## Presenter Output

### TTMUX-024

Verifies: [TMUX-037](../user/tmux-play.md#tmux-037)

Given session mode is running, when the user enters a Boss prompt, the captured Boss/Captain pane content shall contain the prompt text exactly once.

### TTMUX-025

Verifies: [TMUX-038](../user/tmux-play.md#tmux-038)

Given session mode handling a Boss turn, the captured Boss/Captain pane shall contain a line beginning with `boss> ` for the Boss input and a line beginning with `captain> ` for the Captain's reply; the captured role pane shall contain a line beginning with `captain> ` for the Captain's prompt and a line beginning with `<roleId>> ` for the role's reply. The strings `[from captain]` and `[captain llm prompt]` shall not appear in any pane.

### TTMUX-026

Verifies: [TMUX-039](../user/tmux-play.md#tmux-039)

Given a role and Captain that finish with `status: 'ok'`, the captured pane content shall not contain `[role <id> ok]` or `[captain ok]`. Given a role that finishes with `status: 'error'`, the role pane shall contain a single `<roleId>> [error: <message>]` line where `<message>` matches `result.error`; given a Captain run that finishes with `status: 'error'`, the Boss/Captain pane shall contain a single `captain> [error: <message>]` line where `<message>` matches `result.error`. Given a role that finishes with `status: 'aborted'`, the role pane shall contain a single `<roleId>> [aborted]` line; given a Captain run that finishes with `status: 'aborted'`, the Boss/Captain pane shall contain a single `captain> [aborted]` line.

### TTMUX-027

Verifies: [TMUX-040](../user/tmux-play.md#tmux-040)

Given the fanout Captain handling a Boss turn, the captured Boss/Captain pane shall not contain any line beginning with `=== role:<id>` and shall not contain a `=== /role:<id> ===` line — i.e., the open/close sentinel framing of the Captain's prompt body shall not leak through. Synthesized references to role content within the Captain's reply shall be permitted.

## Role Session Continuity

### TTMUX-028

Verifies: [TMUX-041](../user/tmux-play.md#tmux-041)

Given a tmux-play session and a role whose adapter supports `resumeToken`, when the runtime handles two Boss turns in sequence, the role's `Cligent` instance on the second turn shall be the same instance as on the first turn, and the second `run()` call shall pass `resume: <resumeToken>` to the adapter where the token came from the prior `done` event.

### TTMUX-029

Verifies: [TMUX-042](../user/tmux-play.md#tmux-042)

Given the fanout Captain handling a Boss turn, the prompt string passed to `callRole` shall not contain the substring `You are the` and shall not repeat the role's `id` in an identity preamble. The role's `instruction`, configured at `Cligent` construction, shall be the sole source of role identity.

## Real-tmux Acceptance

Items in this section verify behavior end-to-end against a real `tmux` server (not a mock or argv log). They live under `*.acceptance.test.ts`, run via `npm run test:acceptance`, and shall self-skip only when `tmux -V` fails. They shall not gate on adapter API keys.

### TTMUX-030

Verifies: [TMUX-035](../user/tmux-play.md#tmux-035)

Given a real tmux server, when `launchTmuxPlay({ attach: false })` returns, `tmux display-message -t <session> -p '#{window_width}x#{window_height}'` shall report `240x67`.

### TTMUX-031

Verifies: [TMUX-027](../user/tmux-play.md#tmux-027), [TMUX-028](../user/tmux-play.md#tmux-028)

Given a real tmux server with two configured roles, when `launchTmuxPlay({ attach: false })` returns, `tmux list-panes` shall report exactly three panes: a Boss/Captain pane at `pane_left=0` with effective width 60 columns (less tmux's 1-cell border), a first role column at `pane_left=60` with effective width 90 columns, and a second role column at `pane_left=150` with effective width 90 columns. Pane order in `list-panes` index space shall match config order.

### TTMUX-032

Verifies: [TMUX-036](../user/tmux-play.md#tmux-036)

Given a real tmux server with role ids `coder` and `reviewer`, when `launchTmuxPlay({ attach: false })` returns, `tmux display-message -p '#{pane_title}'` against each pane shall return `Captain` for the Boss/Captain pane, `Coder` for the first role pane, and `Reviewer` for the second role pane.

### TTMUX-033

Verifies: [TMUX-027](../user/tmux-play.md#tmux-027)

Given a real tmux server, when `launchTmuxPlay({ attach: false })` returns, every role pane shall report `#{pane_input_off}=1` (input disabled) and the Boss/Captain pane shall report `#{pane_input_off}=0`. After `tmux send-keys -t <role-pane> '<probe>'` is invoked with a unique probe string, `tmux capture-pane -p` against that role pane shall not contain the probe.
