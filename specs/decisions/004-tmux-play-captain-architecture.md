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
- `captain_telemetry`
- `runtime_error`

Every record carries a stable role ID where applicable.
Turn-bound records carry `turnId: number`.
Session-scoped `captain_status` / `captain_telemetry` emitted outside an active turn carry `turnId: null`.
`runtime_error` carries the active turn ID when the failure belongs to a turn and `turnId: null` for startup/init failures before any turn is active.

Per turn: `turn_started` first; each role gets `role_prompt` → `role_event`s → one `role_finished`; each `callCaptain()` gets `captain_prompt` → `captain_event`s → `captain_finished`; `turn_finished` last (or `turn_aborted` on abort).

Presenters subscribe as observers.
The dispatcher delivers each record in registration order, awaits the returned promise, and never drops or coalesces.
`captain_status` and `captain_telemetry` share that same ordered per-session queue regardless of origin (`init`, turn, between turns).
Turn-bound emissions drain before `turn_finished` / `turn_aborted`; `turnId: null` emissions dispatch in emission order without a turn boundary.
Observers bridging to external transports must enqueue and return synchronously — the dispatcher is non-blocking on network flushes.
On observer throw/reject, the runtime emits `runtime_error` to the rest, aborts the active turn if one exists, and runs normal cleanup.

The tmux presenter is the first observer; it consumes `captain_status`, renders `runtime_error` in the Boss/Captain pane, and ignores `captain_telemetry` (that lane is for opt-in observers — visualizer, metrics, third-party panels).
Coordination stays testable without tmux; new observers attach without changing the Captain or role contracts.
Runtime record types and the observer-registration contract are exported from `@sublang/cligent/tmux-play`, not the root package.

### Captain

A Captain handles one Boss turn at a time.
Turn-scoped resources (turn abort, role/captain run methods) arrive on `CaptainContext`.
Session-scoped resources (session abort, status/telemetry emission, role manifest) arrive on `CaptainSession` via the optional `init(session)` lifecycle, so emissions are not bound to a turn.
The runtime owns the persistent `Cligent` instances; how the Captain composes calls — fanout, planner/router, pass-through — is its own choice.

The Captain extension contract is exported from `@sublang/cligent/tmux-play`:

```typescript
interface Captain {
  init?(session: CaptainSession): Promise<void>;
  handleBossTurn(turn: BossTurn, context: CaptainContext): Promise<void>;
  dispose?(): Promise<void>;
}

interface BossTurn {
  id: number;
  prompt: string;
  timestamp: number;
}

interface CaptainSession {
  readonly signal: AbortSignal;            // session-scoped abort
  readonly roles: readonly RoleHandle[];
  emitStatus(message: string, data?: Record<string, unknown>): Promise<void>;
  emitTelemetry(event: CaptainTelemetry): Promise<void>;
}

interface CaptainContext {
  readonly signal: AbortSignal;            // turn-scoped abort
  readonly roles: readonly RoleHandle[];
  callRole(roleId: string, prompt: string): Promise<RoleRunResult>;
  callCaptain(prompt: string): Promise<CaptainRunResult>;
}

interface CaptainTelemetry {
  readonly topic: string;
  readonly payload: unknown;
}

interface RoleHandle {
  readonly id: string;
  readonly adapter: RoleAdapterName;
  readonly model?: string;
}

// `RoleAdapterName` is the canonical type from the tmux-play module
// (claude | codex | gemini | opencode); not redefined here.

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
```

Neither context exposes raw `Cligent`; `callRole` and `callCaptain` are the only paths to a run, so every run is recorded and bound to `context.signal`.
Per-call options are intentionally absent until a concrete consumer needs them.

`emitStatus` emits `captain_status`: free-form, human-readable; routed to the Boss/Captain pane.
`emitTelemetry` emits `captain_telemetry`: structured, topic-routed; ignored by the tmux pane and consumed by opt-in observers (visualizer, metrics).
Topics are namespaced by convention (`sketch.diagram`, `sketch.highlight`, `metrics.*`); the runtime never interprets them.

Both live on `CaptainSession`, share one ordered per-session queue, and may be called from `init`, during turns, or between turns.
Records carry the active `turnId` else `null`.
Delivery is ordered, awaited, never dropped; turn-bound emissions drain before turn completion.
For sustained streams the Captain rate-limits; the runtime never coalesces.

The split between the two methods is deliberate: status is the human-facing affordance; telemetry is the machine-readable lane.
Collapsing them into a reserved `topic: 'status'` would move the contract into payload convention rather than removing it.

Visualizer rendering and browser transport belong to a presenter/observer.
Captains may own actor-side instrumentation (inspectors, matchers) but should emit telemetry rather than serve UI.

Each Captain module's default export is a factory `(options: unknown) => Captain | Promise<Captain>`.
The launcher verifies `captain.from` resolves; the session imports and constructs it.

Lifecycle: construct → attach observers → `init(session)` → serve turns → shutdown (see Serialization and Abort) → `dispose()` → detach observers.
Observers straddle the Captain lifetime, so init-time emissions and init failures reach attached observers.

Built-in Captains use the same contract as third-party ones — no internal mode registry or special casing.
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

Inside `captain`: `adapter`, `model`, and `instruction` configure the runtime-owned Captain `Cligent` (target of `callCaptain`); `options` is opaque to the runtime and passed verbatim to the factory.

`captain.from` accepts local paths (resolved against the config file's directory) or package specifiers; both resolve through the same `import()` path.

Role IDs match `^[a-z][a-z0-9_-]*$`, are unique within a config, and may not equal `captain`.
Multiple roles may share an adapter and model — the role ID is the runtime identity.

Adapter names use the canonical short scheme: `claude`, `codex`, `gemini`, `opencode`.

### Serialization and Abort

Boss turns serialize: one at a time.
Within a turn, role calls may run concurrently at the Captain's discretion.

Each role and the Captain own one persistent `Cligent` per session.

SIGINT, SIGTERM, or EOF aborts the active turn via `context.signal`.
`CaptainSession.signal` aborts on session shutdown, not per-turn cancellation.

Session shutdown order:

1. Active turn unwinds; turn-bound emissions drain before `turn_finished` / `turn_aborted`.
2. Abort `CaptainSession.signal` so producers wired to it (matcher subscriptions, timers) detach.
3. Drain already-accepted session emissions; post-abort `emit*` calls reject.
4. `Captain.dispose()`.
5. Detach observers.

Aborting before draining detaches producers cleanly and delivers their in-flight records without racing new ones.

### Distribution and Extension

`tmux-play` ships in the `@sublang/cligent` npm package as a `bin` entry, replacing the prior `fanout` bin.
The package is ESM, Node ≥18; there is no compiled binary.

The package separates the runtime API from the CLI:

- The runtime API takes an instantiated Captain, role configs, and zero or more observers (registered via the observer-registration contract), and runs the coordination in-process — tmux-independent, suitable for embedding in other presentations.
- The CLI's launcher loads the config, snapshots it to the work directory, builds the tmux session, and exits. The session reads the snapshot, imports `captain.from`, constructs the Captain, registers the configured observers (the tmux presenter plus any opt-in sketch/metrics presenters), and calls the runtime API.

Built-in Captains live under sub-exports such as `@sublang/cligent/captains/fanout`.
They are not privileged: third-party Captains in their own packages are reached the same way and use the same contract.

The Captain extension types and runtime API are exported from `@sublang/cligent/tmux-play`.

### Out of Scope

- Additional built-in Captains beyond `fanout`.
- Additional **shipped** presentation surfaces beyond tmux (e.g., a built-in web/Electron presenter). Adding observers that consume runtime records — including `captain_telemetry` — is in scope and does not require a new DR.
- Re-exporting the runtime record or observer API from the root `@sublang/cligent` package (the `@sublang/cligent/tmux-play` sub-export carries them, per the runtime/presentation section).
- Persisting cross-launch history.
- Interactive permission UI beyond adapter defaults.
- Multi-Boss or shared sessions.

New behavior in any of these areas requires a separate decision record.

## Consequences

- `tmux-play` replaces the standalone fanout CLI; fanout becomes a regular Captain shipped as a sub-export.
- Custom Captains use the same contract as built-ins: a `captain.from` specifier in CLI config, or a Captain instance via the runtime API.
- Stateful Captains (XState actors, planners) acquire session-scoped resources in `init(session)`, hold the session reference for emissions across turns, and release in `dispose()`. They surface human-readable status through `emitStatus`/`captain_status` and structured machine-readable events through `emitTelemetry`/`captain_telemetry`. Both emit methods are session-scoped so a Captain can fire telemetry while idle between turns (e.g., an XState `after:` timer) without the per-turn binding gymnastics that an earlier draft of this DR required.
- `captain_telemetry` is a generic topic-routed lane. An XState Captain emits visualizer streams (`sketch.diagram`, `sketch.highlight` per [DR-002 §8](../../../playbook/specs/decisions/002-in-page-xstate-visualizer.md#8-cross-process-deployment)) without the runtime knowing about visualizers; a sketch presenter consumes the records and owns SSE/WebSocket transport, with internal buffering to keep the dispatcher non-blocking.
- Out-of-turn emissions carry `turnId: null`; turn-bound emissions carry the active session-local turn ID. Observers handle both deliberately rather than assuming every record is turn-scoped.
- Coordination is testable without tmux because the runtime emits records before formatting.
- The runtime record types and observer-registration contract export from `@sublang/cligent/tmux-play` (not the root package), so out-of-package observers — sketch presenters, metrics collectors — attach without depending on internal modules.
- Shared app primitives are still needed for tmux process management, shell quoting, log handling, and event formatting.
