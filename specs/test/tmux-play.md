<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# TMUX: tmux-play Tests

## Intent

Verification criteria for the `tmux-play` CLI, configuration, Captain runtime, and built-in `fanout` Captain defined in [user/tmux-play.md](../user/tmux-play.md).

## Configuration and Discovery

### TMUX-035

Verifies: [TMUX-010](../user/tmux-play.md#tmux-010), [TMUX-011](../user/tmux-play.md#tmux-011)

Given an empty home and cwd, when launching `tmux-play` without `--config`, the home YAML shall be created with the default `fanout` Captain plus `claude` and `codex` roles, a one-line notice naming the path shall be printed to stdout, and a second invocation shall not overwrite the file.

### TMUX-036

Verifies: [TMUX-009](../user/tmux-play.md#tmux-009)

Given a `tmux-play.config.yaml` in cwd and a different YAML at the home location, when launching, the cwd config shall be loaded and the home file shall be left untouched.

### TMUX-037

Verifies: [TMUX-009](../user/tmux-play.md#tmux-009)

Given `XDG_CONFIG_HOME` set to a non-empty path, when launching, the home location shall be `${XDG_CONFIG_HOME}/tmux-play/config.yaml`. Given `XDG_CONFIG_HOME` empty or unset, the home location shall be `~/.config/tmux-play/config.yaml`.

### TMUX-038

Verifies: [TMUX-012](../user/tmux-play.md#tmux-012)

Given a `tmux-play.config.{mjs,js,json}` in cwd and no cwd YAML, when launching, a one-line stderr warning shall name the legacy file before normal execution proceeds.

### TMUX-039

Verifies: [TMUX-005](../user/tmux-play.md#tmux-005), [TMUX-006](../user/tmux-play.md#tmux-006), [TMUX-007](../user/tmux-play.md#tmux-007), [TMUX-008](../user/tmux-play.md#tmux-008)

Given malformed YAML or a config that violates the schema (unknown adapter, unknown field, invalid role id, duplicate role id, role id `captain`, empty roles), when launching, the launcher shall fail with an error naming the offending file or path.

### TMUX-040

Verifies: [TMUX-013](../user/tmux-play.md#tmux-013)

Given a cwd config whose `captain.from` is a relative local path, when session mode imports the Captain, resolution shall be anchored at the original config file's directory; package specifiers shall reach Node's resolver unchanged.

## Runtime Causality and Dispatch

### TMUX-041

Verifies: [TMUX-022](../user/tmux-play.md#tmux-022)

Given a Captain that calls one role then `callCaptain`, when handling a Boss turn, observers shall receive records in this order: `turn_started`, `role_prompt`, `role_event`*, `role_finished`, `captain_prompt`, `captain_event`*, `captain_finished`, `turn_finished`. All shall carry the same `turnId`.

### TMUX-042

Verifies: [TMUX-023](../user/tmux-play.md#tmux-023), [TMUX-024](../user/tmux-play.md#tmux-024)

Given two registered observers, when a record is emitted, both shall receive the record in registration order before the dispatcher releases the next record.

### TMUX-043

Verifies: [TMUX-017](../user/tmux-play.md#tmux-017), [TMUX-021](../user/tmux-play.md#tmux-021)

When a Captain emits `emitStatus` from `init`, the resulting `captain_status` record shall arrive at every observer with `turnId: null` before any `turn_started`.

### TMUX-044

Verifies: [TMUX-024](../user/tmux-play.md#tmux-024), [TMUX-026](../user/tmux-play.md#tmux-026)

When the abort signal fires during a turn, the runtime shall emit `turn_aborted` (not `turn_finished`); turn-bound emissions enqueued before the abort shall drain first.

### TMUX-045

Verifies: [TMUX-025](../user/tmux-play.md#tmux-025)

When a registered observer rejects, the runtime shall emit `runtime_error` to remaining observers, abort the active turn if any, and complete normal cleanup. The runtime call may reject; whether it does is unconstrained by this item.

### TMUX-046

Verifies: [TMUX-019](../user/tmux-play.md#tmux-019)

On session shutdown, `Captain.dispose()` shall run exactly once, after the active turn unwinds and after accepted session emissions drain. Post-shutdown `emitStatus`/`emitTelemetry` calls shall reject.

## CLI and Topology

### TMUX-047

Verifies: [TMUX-001](../user/tmux-play.md#tmux-001)

Given the built bin on PATH (or invoked directly with execute permission), when launched on a POSIX runner, `tmux-play --help` shall exit 0 and print a usage banner.

### TMUX-048

Verifies: [TMUX-027](../user/tmux-play.md#tmux-027), [TMUX-028](../user/tmux-play.md#tmux-028)

Given N configured roles, when the launcher constructs the tmux session, the layout shall be Boss/Captain on the left and N role panes on the right in config order; with N ≥ 2, the right side shall use two columns and the first column shall hold `ceil(N / 2)` roles top-to-bottom.

### TMUX-049

Verifies: [TMUX-003](../user/tmux-play.md#tmux-003), [TMUX-034](../user/tmux-play.md#tmux-034)

Given a snapshot file at the work directory, when session mode runs, the Captain shall be imported once from `captain.from` (a `file://` URL for local paths or a package specifier) and Boss turns shall flow through the runtime per [TMUX-041](#tmux-041).

## Built-in Fanout Captain (Acceptance)

### TMUX-050

Verifies: [TMUX-030](../user/tmux-play.md#tmux-030)

Given the built-in fanout Captain and the four supported adapters as roles with valid credentials, when handling a Boss turn that requires a sentinel token in every reply, every `role_finished` shall report `status: 'ok'` with the sentinel in `finalText`, and the `captain_finished` summary shall reference each role's status and contain the sentinel. `runtime_error` and `turn_aborted` shall not appear.

### TMUX-051

Verifies: [TMUX-030](../user/tmux-play.md#tmux-030)

Given the fanout Captain and N configured roles, when handling a Boss turn, all N `role_prompt` records shall be emitted before any `role_finished` record (concurrent dispatch), and the `captain_prompt` record shall be emitted only after every `role_finished`.

## Runtime Error Sources

### TMUX-052

Verifies: [TMUX-025](../user/tmux-play.md#tmux-025)

When `Captain.init(session)` rejects before any turn starts, the runtime shall emit `runtime_error` with `turnId: null` to every registered observer, run shutdown, and shall not deliver any `turn_started` record.

### TMUX-053

Verifies: [TMUX-025](../user/tmux-play.md#tmux-025)

When `handleBossTurn` rejects mid-turn, the runtime shall emit `runtime_error` carrying the active `turnId`, then `turn_aborted`, and shall complete shutdown.

### TMUX-054

Verifies: [TMUX-034](../user/tmux-play.md#tmux-034)

Given a cwd YAML config whose `captain.from` is a relative local path and a separate config whose `captain.from` is a package specifier, when the launcher prepares each session, the work directory shall contain a JSON snapshot in which the local path is rewritten to an absolute `file://` URL and the package specifier is preserved verbatim. Mutations to the YAML after launch shall not affect the running session.
