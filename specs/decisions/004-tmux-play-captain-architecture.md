<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-004: tmux-play Captain Architecture

## Status

Accepted

## Context

[DR-001](001-unified-cli-agent-interface-architecture.md) established the TypeScript async-generator adapter architecture.
[DR-002](002-unified-event-stream-and-adapter-interface.md) defined the unified event stream and adapter interface.
[DR-003](003-role-scoped-session-management.md) defined `Cligent` instances for role identity, session continuity, option merging, and single-flight execution.

The prior fanout app proved multiple `Cligent` instances render across tmux panes.
The next layer needs a Captain that drives role cligents and answers a Boss, without coupling the runtime to tmux pane scraping or terminal layout.

## Decision

### Product

`tmux-play` is the public CLI.
There is no separate fanout CLI; fanout becomes a regular Captain shipped under the same package.

Boss talks to the Captain.
The Captain coordinates roles.
Boss never addresses roles directly, and roles are not part of the public app API.

A user always invokes `tmux-play` with no internal flags; that is launcher mode.
The launcher builds the tmux session and exits.
Inside tmux, the Boss/Captain pane runs `tmux-play --session <id> --work-dir <path>`; that is session mode and owns the runtime until the session closes.
One CLI keeps distribution simple; the split keeps the launcher short-lived and makes the runtime independently addressable for testing.

- Launcher mode (no `--session`): load config, resolve Captain and roles, create work directory and logs, build the tmux session, attach.
- Session mode (`--session <id> --work-dir <path>`): run Boss readline, the Captain, the role runtime, event formatting, abort handling, and cleanup.

### tmux Topology

Boss/Captain occupies the wide left pane.
Role panes are read-only on the right, in config order:

```text
+----------------------+----------------+----------------+
| Boss <-> Captain     | Role: Coder    | Role: Reviewer |
|                      | (tail -f log)  | (tail -f log)  |
| ...history...        |                |                |
|                      |                |                |
| boss> _              |                |                |
+----------------------+----------------+----------------+
```

One role uses one right column.
Two or more roles use two columns, with `ceil(roleCount / 2)` roles in the first column from top to bottom.

The Boss/Captain pane runs `tmux-play --session <id> --work-dir <path>`.
Role panes tail their log and accept no input.

### Runtime and Presentation

Coordination and presentation are separate.

The runtime owns config validation, role and Captain construction, turn serialization, Captain execution, `Cligent.run()` calls, abort propagation, and result collection.
It does not read tmux pane state.

The presentation owns tmux launch and layout, pane rendering and titles, and cleanup of launcher-owned resources.
It does not mutate runtime state.

The runtime emits structured records before any formatting.
The minimum record set is:

- `turn_started`, `turn_finished`, `turn_aborted`
- `role_prompt`, `role_event`, `role_finished`
- `captain_prompt`, `captain_event`, `captain_finished`
- `captain_status`
- `runtime_error`

Every record carries a stable role ID (where applicable) and a session-local turn ID.
Per turn: `turn_started` first; each role gets `role_prompt` → `role_event`s → one `role_finished`; each `callCaptain()` gets `captain_prompt` → `captain_event`s → `captain_finished`; `turn_finished` last (or `turn_aborted` on abort).

Presenters subscribe as observers.
The dispatcher delivers each record in registration order, awaits any returned promise before the next, and never drops or coalesces.
`captain_status` records from `emitStatus()` queue in emission order; each fully dispatches before the next runtime record, and all drain before `turn_finished`/`turn_aborted`.
If an observer throws or rejects, the runtime emits `runtime_error` to the rest where possible, aborts the active turn, and runs normal cleanup.

The tmux presenter is the first observer.
Coordination stays testable without tmux, and new presenters attach without changing Captain or role contracts.
Records are an internal contract, not exported from the root package.

### Captain

A Captain handles one Boss turn at a time.
The runtime hands it the turn, an abort signal, and a context that mediates access to the configured roles and the Captain `Cligent`.
The runtime owns the persistent `Cligent` instances; how the Captain composes context calls — fanout, planner/router, pass-through — is its own choice.

The Captain extension contract is exported from `@sublang/cligent/tmux-play`:

```typescript
interface Captain {
  handleBossTurn(turn: BossTurn, context: CaptainContext): Promise<void>;
  dispose?(): Promise<void>;
}

interface BossTurn {
  id: number;
  prompt: string;
  timestamp: number;
}

interface CaptainContext {
  readonly signal: AbortSignal;
  readonly roles: readonly RoleHandle[];
  callRole(roleId: string, prompt: string, options?: RoleCallOptions): Promise<RoleRunResult>;
  callCaptain(prompt: string, options?: CaptainCallOptions): Promise<CaptainRunResult>;
  emitStatus(message: string, data?: Record<string, unknown>): Promise<void>;
}

interface RoleHandle {
  readonly id: string;
  readonly adapter: RoleAdapterName;
  readonly model?: string;
}

type RoleAdapterName = 'claude' | 'codex' | 'gemini' | 'opencode';

type RunStatus = 'ok' | 'aborted' | 'error';

interface RoleRunResult {
  readonly status: RunStatus;
  readonly roleId: string;
  readonly turnId: number;
  readonly finalText?: string;
  readonly error?: string;
}

interface CaptainRunResult {
  readonly status: RunStatus;
  readonly turnId: number;
  readonly finalText?: string;
  readonly error?: string;
}

interface RoleCallOptions {
  readonly metadata?: Record<string, unknown>;
}

type CaptainCallOptions = RoleCallOptions;
```

The context never exposes raw `Cligent` instances; `callRole()` and `callCaptain()` are the only paths to a run, so every run is recorded and bound to `context.signal`.

`emitStatus()` emits `captain_status` records — free-form Captain messages (inspector URLs, state transitions) routed to the Boss/Captain pane.
The returned promise resolves on full dispatch; fire-and-forget is safe because the runtime preserves emission order.
This keeps stateful Captains (e.g., XState coordinators) inside the runtime/presentation boundary instead of writing raw stdout.

Each Captain module's default export is a factory `(options: unknown) => Captain | Promise<Captain>`.
The launcher only verifies `captain.from` resolves; the session imports and constructs it, surfacing factory failures in the Boss/Captain pane.
On session shutdown the runtime invokes `dispose()` (if present) to release long-lived resources — actors, inspector servers, subscriptions.

Built-in Captains use the same contract a third-party Captain does — there is no internal mode registry or special casing.
`fanout` is the first such Captain and reproduces the original fanout chat coordination.

### Configuration

`tmux-play` loads config from `.mjs`, `.js`, or `.json`.
JavaScript configs load through `import(pathToFileURL(path))`; JSON configs load through `fs.readFile()` and `JSON.parse()`.
These formats use Node's built-in loaders, keeping the package zero-runtime-dependency per [PKG-003](../dev/package.md).

Default discovery checks `tmux-play.config.mjs`, `tmux-play.config.js`, then `tmux-play.config.json` in the current directory.
`--config <path>` overrides discovery.

CLI configs must be JSON-serializable.
The launcher resolves the config and writes a snapshot to the work directory; the session reads the snapshot rather than re-running user code.
JS configs may use imports and `defineConfig`, but the resolved object must serialize cleanly.
Captains are referenced by specifier, never as a constructed instance — instances are accepted only by the programmatic runtime API.

Example (`.js` and `.json` carry the same shape):

```js
import { defineConfig } from '@sublang/cligent/tmux-play';

export default defineConfig({
  captain: {
    from: '@sublang/cligent/captains/fanout',
    adapter: 'claude',
    model: 'claude-opus-4-7',
    instruction: 'You are the Captain. Coordinate roles and answer the Boss.',
    options: {},
  },
  roles: [
    { id: 'coder', adapter: 'codex', instruction: 'Implement code changes.' },
    { id: 'reviewer', adapter: 'claude', instruction: 'Review proposed changes.' },
  ],
});
```

Inside `captain`: `adapter`, `model`, and `instruction` configure the runtime-owned Captain `Cligent` (target of `callCaptain()`); `options` is opaque to the runtime and passed verbatim to the factory.

The launcher rewrites `captain.from` before snapshotting: local paths (e.g. `./captains/foo.js`) resolve against the original config file's directory and become absolute `file://` URLs; package specifiers (`@sublang/cligent/captains/fanout`, `my-captain-pkg`) pass through unchanged.
The session hands `captain.from` to `import()` and applies the factory to `captain.options`.
Built-in and third-party Captains use the same mechanism.

Role IDs match `^[a-z][a-z0-9_-]*$`, are unique within a config, and may not equal `captain`.
Role ID is the runtime identity; multiple roles may share an adapter and model.

Adapter names use the existing short scheme: `claude`, `codex`, `gemini`, `opencode`.

### Serialization and Abort

Boss turns serialize: one at a time.
Within a turn, role calls may run concurrently at the Captain's discretion.

Each role and the Captain own one persistent `Cligent` per session.

SIGINT, SIGTERM, or EOF aborts the active turn.
Abort propagates through the Captain's abort signal to active runs.
Once the active turn unwinds, the runtime invokes the Captain's `dispose()` if present, then completes session cleanup.

### Distribution and Extension

`tmux-play` ships in the `@sublang/cligent` npm package as a `bin` entry, replacing the prior `fanout` bin.
The package is ESM, Node ≥18; there is no compiled binary.

The package separates the runtime API from the CLI:

- The runtime API takes an instantiated Captain, role configs, and an observer, and runs the coordination in-process — tmux-independent, suitable for embedding in other presentations.
- The CLI's launcher loads the config, snapshots it to the work directory, builds the tmux session, and exits. The session reads the snapshot, imports `captain.from`, constructs the Captain, and calls the runtime API with the tmux presenter attached.

Built-in Captains live under sub-exports such as `@sublang/cligent/captains/fanout`.
They are not privileged: third-party Captains in their own packages are reached the same way and use the same contract.

The Captain extension types and runtime API are exported from `@sublang/cligent/tmux-play`.

### Out of Scope

- Additional built-in Captains beyond `fanout`.
- Presentation surfaces other than tmux.
- Publicly exporting the runtime record or observer API.
- Persisting cross-launch history.
- Interactive permission UI beyond adapter defaults.
- Multi-Boss or shared sessions.

New behavior in any of these areas requires a separate decision record.

## Consequences

- `tmux-play` replaces the standalone fanout CLI; fanout becomes a regular Captain shipped as a sub-export.
- Custom Captains use the same contract as built-ins: a `captain.from` specifier in CLI config, or a Captain instance via the runtime API.
- Stateful Captains (XState actors, planners) hold session-scoped resources via `dispose()` and surface status through `captain_status` records.
- Coordination is testable without tmux because the runtime emits records before formatting.
- Non-tmux presenters attach as additional observers without touching Captain or roles.
- Shared app primitives are still needed for tmux process management, shell quoting, log handling, and event formatting.
