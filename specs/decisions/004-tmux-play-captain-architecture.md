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
That prototype used one `fanout` binary in launcher and `--session` modes: the launcher resolved available adapters, created owned log files, built and attached a tmux session, and the session ran Boss readline, parallel `Cligent` calls, event-to-log rendering, abort, and marker-guarded cleanup.
Its topology put one live-tailed pane per selected adapter across the upper region and a full-width Boss prompt below, with no config, persistent history, custom theme, or cross-launch resume.
Its acceptance harness established a real prompt-to-response-to-done oracle with a unique workspace sentinel and a separate secrets-bearing CI job.
The architecture below replaces that standalone CLI and topology while retaining the proven launcher/session boundary, log-backed presentation, multi-agent execution, and end-to-end oracle.
The next layer needs a Captain that drives player cligents and answers a Boss, without coupling the runtime to tmux pane scraping or terminal layout.

## Decision

### Product

`tmux-play` is the public CLI.
There is no separate fanout CLI; fanout becomes a regular Captain shipped under the same package.

Boss talks to the Captain.
The Captain coordinates players.
Boss never addresses players directly, and players are not part of the public app API.

After recognized CLI flags are parsed, `tmux-play` selects one control path in this order ([[tmux-play-204](../packages/tmux-play.md#tmux-play-204)]):

1. `--help` prints usage and exits before mode-specific validation or work.
2. Without help, `--theme-diagnostics` selects launcher-only diagnostics;
   combining it with a non-empty `--session` is invalid and dispatches neither flow.
3. Without help or diagnostics, a non-empty `--session` selects session-mode admission.
4. Without any applicable selector above, the CLI selects ordinary launcher admission.

The ordinary launcher builds the tmux session and exits.
Inside tmux, the Boss/Captain pane runs `tmux-play --session <id> --work-dir <path>`; that is session mode and owns the runtime until the session closes.
The diagnostic flow resolves and reports the theme without first-run creation, runtime readiness, tmux or Glow checks, session construction, or attachment.
One CLI keeps distribution simple; the split keeps the launcher short-lived and makes the runtime independently addressable for testing.

- Ordinary launcher mode (no selector flag): load config, resolve Captain and players, create work directory and logs, build the tmux session, attach.
- Launcher-only diagnostics (`--theme-diagnostics`): resolve and report the theme without constructing or attaching a session.
- Session mode (`--session <id> --work-dir <path>`): run Boss readline, the Captain, the player runtime, event formatting, abort handling, and cleanup.

### tmux Topology

Boss/Captain occupies the left pane.
Player panes are read-only on the right, in config order:

```text
+--------------+------------------------+------------------------+
| Boss/Captain | Coder                  | Reviewer               |
|              | (tail -f log)          | (tail -f log)          |
| ...history.. |                        |                        |
|              |                        |                        |
| boss> _      |                        |                        |
+--------------+------------------------+------------------------+
```

One player uses one right column.
Two or more players use two columns, with `ceil(playerCount / 2)` players in the first column from top to bottom.
An empty roster uses only the full-width Boss/Captain pane.

Pane display-name stems are single tokens — `Captain` for the Boss/Captain pane and the title-cased player `id` for each player pane (no `Player:` prefix).
[[tmux-play-48](../packages/tmux-play.md#tmux-play-48)] composes each stem with its adapter into the displayed pane title, while [DR-016](016-tmux-pane-logical-identity.md) keeps that title presentation-only.
Width split is even: each visible column gets 1/N of the window where N is the column count (1 for an empty roster, 2 for a single player, 3 for two or more); the spec items in [packages/tmux-play.md](../packages/tmux-play.md) carry the normative ratios.

The Boss/Captain pane runs `tmux-play --session <id> --work-dir <path>`.
Player panes tail their log and accept no input.

### Runtime and Presentation

Coordination and presentation are separate.

The runtime owns config validation, player and Captain construction, turn serialization, Captain execution, `Cligent.run()` calls, abort propagation, and result collection.
It does not read tmux pane state.

The presentation owns tmux launch and layout, pane rendering and titles, and cleanup of launcher-owned resources.
It does not mutate runtime state.

The runtime emits structured records before any formatting.
The minimum record set is:

- `turn_started`, `turn_finished`, `turn_aborted`
- `player_prompt`, `player_event`, `player_finished`
- `captain_prompt`, `captain_event`, `captain_finished`
- `captain_reply`
- `captain_status`
- `captain_telemetry`
- `player_view_changed`
- `runtime_error`

Every record carries a stable player ID where applicable.
Turn-bound records carry `turnId: number`.
Session-scoped `captain_status` / `captain_telemetry` emitted outside an active turn carry `turnId: null`.
`runtime_error` carries the active turn ID when the failure belongs to a turn and `turnId: null` for startup/init failures before any turn is active.

Per turn: `turn_started` first; each player gets `player_prompt` → `player_event`s → one `player_finished`; each `callCaptain()` gets `captain_prompt` → `captain_event`s → `captain_finished`; `turn_finished` last (or `turn_aborted` on abort).
The three `captain_*` records carry an optional `visibility` (default `'visible'`) copied from the `callCaptain` options; observers other than the tmux presenter receive every record regardless of the tag.

Presenters subscribe as observers.
The dispatcher delivers each record in registration order, awaits the returned promise, and never drops or coalesces.
`captain_status` and `captain_telemetry` share that same ordered per-session queue regardless of origin (`init`, turn, between turns).
Turn-bound emissions drain before `turn_finished` / `turn_aborted`; `turnId: null` emissions dispatch in emission order without a turn boundary.
Observers bridging to external transports must enqueue and return synchronously — the dispatcher is non-blocking on network flushes.
On observer throw/reject, the runtime emits `runtime_error` to the rest, aborts the active turn if one exists, and runs normal cleanup.

The tmux presenter is the first observer; it consumes `captain_status`, renders `runtime_error` in the Boss/Captain pane, ignores `captain_telemetry` (that lane is for opt-in observers — visualizer, metrics, third-party panels), and skips `captain_event` / `captain_finished` tagged `visibility: 'hidden'` so those calls produce zero Boss-pane output.
Coordination stays testable without tmux; new observers attach without changing the Captain or player contracts.
Runtime record types and the observer-registration contract are exported from `@sublang/cligent/tmux-play`, not the root package.

#### Operational Line Grammar

The tmux presenter gives operational lines one bracketed family whose tag identifies the kind and whose color identifies its outcome class.
Single-state members—status, error, aborted, turn-aborted, and runtime-error—need no glyph because the word and color already encode their state.
Tools alone have a two-dimensional state space, phase (call or result) by outcome (ok, error, or denied), so the common grammar leaves a glyph slot optional and fills it only for tool lines.

Bodies sit outside the brackets.
That choice replaces the historical `[error: message]` shape with a fixed-width colored tag followed by an unstyled body, matching status lines and making operational tags align at one scan position.
A non-empty body renders as `[tag] <body>` and an empty body as `[tag]`.

The tool-call glyph is `↪` (U+21AA, Rightwards Arrow With Hook): it reads as entering the invocation and contrasts with the `✓`, `✗`, and `·` result marks without reusing a generic progression arrow or a heavier branch symbol.
It occupies one terminal cell under [[tmux-play-46](../packages/tmux-play.md#tmux-play-46)]'s measurement rule.
Tool-result bodies retain the two-cell continuation indent and therefore render at `max(1, paneWidth - 2)`; the header wraps under [[tmux-play-38](../packages/tmux-play.md#tmux-play-38)] after subtracting only the `<who>> ` prefix width, with the bracketed tag participating in ordinary body wrapping.

This grammar is presenter-only.
The runtime records and non-tmux observers are unchanged, so an observer that asserts record types rather than rendered bytes needs no corresponding presentation rule.

#### Pane Chrome

The pane-border title opens an active or inactive Catppuccin style, but resetting to the terminal default immediately after the title creates a hard background cut before the separator and timer.
The presenter instead carries the resolved `mantle` surface from the post-title separator through the timer; the active Captain title keeps its distinct `blue` background.
The idle timer uses the resolved Catppuccin `subtext1` (Mocha `#bac2de`, Latte `#5c5f77`) rather than the lower-contrast `overlay1` (Mocha `#7f849c`, Latte `#8c8fa1`), keeping it subdued relative to an active accent while legible on that surface [[3]].

#### Copy-Mode Follow and Session Exit

The copy-mode design was verified against tmux 3.6b and follows tmux's key-table, copy-mode, and `send-keys -X` semantics [[4]].
Player panes are fed by a live log tail and the Boss/Captain pane by session output; scrolling either pane enters copy-mode and freezes its viewport while the underlying grid continues to grow.
`send-keys -X cancel` leaves copy-mode and returns the pane to its live tail, but requires a pane already in a mode, so follow is gated by `#{pane_in_mode}` and leaves an unscrolled pane untouched.

Stock `copy-mode` and `copy-mode-vi` consume `C-c` as `send-keys -X cancel` rather than delivering it to the pane's program.
The session-wide exit binding therefore cancels pane 0's copy-mode before forwarding `C-c`, in all three key tables; a root-table binding alone is insufficient when pane 0 itself is scrolled.
Its session-gated shape is:

```text
true  := if -F -t <s>:0.0 '#{pane_in_mode}' 'send-keys -t <s>:0.0 -X cancel' ; send-keys -t <s>:0.0 C-c
root  false := send-keys C-c
copy* false := send-keys -X cancel
```

Live follow is an observer on the record stream.
It maps player records to the matching player pane and Captain, turn-aborted, and runtime-error output to pane 0, then issues the gated copy-mode cancel through the tmux command boundary.
It follows only records and events that actually make the presenter write: block-boundary flushes, complete text and tool events, player-prompt echoes, `captain_status`, `turn_aborted`, `runtime_error`, `player_finished`, and visible `captain_finished` records.
It ignores control-only records including `turn_finished`, buffered deltas before their flush, and suppressed adapter `error` and `done` events, so it never exits copy-mode without new visible content.
The original mechanism proposed a short per-pane debounce of approximately 250 ms to avoid spawning a tmux process for each block.
Any coalescing remains subordinate to visible-output follow: a no-op while a pane is outside copy-mode cannot suppress a later required exit after that pane re-enters copy-mode.
Because leaving copy-mode drops an active selection, an implementation may additionally require `#{selection_present}` to be false; preserving a drag selection is permitted but not required.

### Captain

A Captain handles one Boss turn at a time.
Turn-scoped resources (turn abort, player/captain run methods) arrive on `CaptainContext`.
Session-scoped resources (session abort, status/telemetry emission, player manifest) arrive on `CaptainSession` via the optional `init(session)` lifecycle, so emissions are not bound to a turn.
The runtime owns the persistent `Cligent` instances; how the Captain composes calls — fanout, planner/router, pass-through — is its own choice.

The Captain extension contract is exported from `@sublang/cligent/tmux-play`:

```typescript
interface Captain {
  init?(session: CaptainSession): Promise<void>;
  handleBossTurn(turn: BossTurn, context: CaptainContext): Promise<void>;
  prepareDispose?(): Promise<void>;
  dispose?(): Promise<void>;
}

interface BossTurn {
  id: number;
  prompt: string;
  timestamp: number;
}

interface CaptainSession {
  readonly signal: AbortSignal; // session-scoped abort
  readonly players: readonly PlayerHandle[];
  emitStatus(message: string, data?: Record<string, unknown>): Promise<void>;
  emitTelemetry(event: CaptainTelemetry): Promise<void>;
  setVisiblePlayers(playerIds: readonly string[]): Promise<void>;
}

type RecordVisibility = 'visible' | 'hidden';

interface CallCaptainOptions {
  readonly visibility?: RecordVisibility; // default 'visible'
  readonly resume?: string | false; // omit for auto-resume
  readonly allowedTools?: readonly string[];
}

interface CallPlayerOptions {
  readonly resume?: string | false; // omit for auto-resume
}

interface CaptainContext {
  readonly signal: AbortSignal; // turn-scoped abort
  readonly players: readonly PlayerHandle[];
  callPlayer(
    playerId: string,
    prompt: string,
    options?: CallPlayerOptions,
  ): Promise<PlayerRunResult>;
  callCaptain(
    prompt: string,
    options?: CallCaptainOptions,
  ): Promise<CaptainRunResult>;
  emitReply(text: string): Promise<void>;
  setVisiblePlayers(playerIds: readonly string[]): Promise<void>;
}

interface CaptainTelemetry {
  readonly topic: string;
  readonly payload: unknown;
}

interface PlayerHandle {
  readonly id: string;
  readonly adapter: PlayerAdapterName;
  readonly model?: string;
}

// `PlayerAdapterName` is the canonical type from the tmux-play module
// (claude | codex | gemini | kimi | opencode); not redefined here.

type RunStatus = 'ok' | 'aborted' | 'error';

interface PlayerRunResult {
  readonly status: RunStatus;
  readonly playerId: string;
  readonly turnId: number;
  readonly resumeToken?: string;
  readonly finalText?: string;
  readonly error?: string;
}

interface CaptainRunResult {
  readonly status: RunStatus;
  readonly turnId: number;
  readonly resumeToken?: string;
  readonly finalText?: string;
  readonly error?: string;
}
```

Neither context exposes raw `Cligent`; `callPlayer` and `callCaptain` are the only paths to a run, so every run is recorded and bound to `context.signal`.
`callPlayer` accepts an optional `CallPlayerOptions` whose `resume` selects the persistent player's backend session for that call: a string overrides the `Cligent`'s stored token, `false` forces a fresh session, and omission retains automatic resume continuity.
The continuation handles are the opaque `PlayerRunResult.resumeToken` and `CaptainRunResult.resumeToken`, not an event's transport-level `sessionId`.
`callCaptain` accepts an optional `CallCaptainOptions` whose `visibility` (default `'visible'`) controls only presentation, whose `resume` selects the Captain backend session, and whose `allowedTools` restricts that call's tools: a `'hidden'` call runs and returns identically, but the runtime tags its `captain_prompt` / `captain_event` / `captain_finished` records so the tmux presenter skips them while non-presenter observers keep the full trace.
`emitReply` emits one turn-bound `captain_reply` that the presenter renders as ordinary Captain prose; `setVisiblePlayers` changes the visible pane subset without changing the configured roster.
All four `CaptainContext` surfaces close admission when the runtime resumes from `handleBossTurn`. Calls admitted before that boundary remain abortable and are joined and drained before the turn's terminal record.

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

Lifecycle: construct → attach observers → `init(session)` → serve turns → `prepareDispose()` → close the session → `dispose()` → detach observers, as amended by [DR-008](008-captain-pre-close-lifecycle.md).
Observers straddle the Captain lifetime, so init-time emissions and init failures reach attached observers.

Built-in Captains use the same contract as third-party ones — no internal mode registry or special casing.
`fanout` is the first such Captain and reproduces the original fanout chat coordination.

### Configuration

`tmux-play` configs are YAML.
Parsing uses the `yaml` package, a single-purpose runtime dep permitted under [[package-3](../packages/package.md#package-3)].

Discovery checks `tmux-play.config.yaml` in the current directory first, then `${XDG_CONFIG_HOME:-~/.config}/tmux-play/config.yaml` as a home fallback.
`--config <path>` overrides discovery.

If neither location holds a file and `--config` was not given, the launcher writes a default to the home path, prints a one-line notice naming the path, and continues.
The default wires the built-in `fanout` Captain plus two stub players; the user edits it.

YAML must serialize cleanly to JSON: the launcher writes a JSON snapshot of the resolved config to the work directory, and the session reads the snapshot rather than re-parsing YAML.
Captains are referenced by specifier, never as a constructed instance — instances are accepted only by the programmatic runtime API.

Example:

```yaml
captain:
  from: '@sublang/cligent/captains/fanout'
  adapter: claude
  model: claude-opus-4-8
  instruction: Coordinate players and answer the Boss.
  options: {}
players:
  - id: claude
    adapter: claude
  - id: codex
    adapter: codex
```

Inside `captain`: `adapter`, `model`, and `instruction` configure the runtime-owned Captain `Cligent` (target of `callCaptain`); `options` is opaque to the runtime and passed verbatim to the factory.
The built-in fanout captain accepts no options; its factory ignores any value at `captain.options`, so YAML keys there are forwarded but inert for fanout.

The built-in fanout captain stitches each player's full `finalText` (or `error`) into the summary prompt verbatim — no per-player truncation.
When a player call aborts without `resumeToken`, fanout retains that player's base Boss prompt and includes unresolved retained Boss prompt(s) with the latest Boss prompt on the player's next call. This recovery policy lives in fanout, not in `Cligent`, because fanout owns prompt composition while `Cligent` owns only opaque resume-token continuity.
Fanout stores the unresolved base prompts rather than already-composed recovery prompts, so consecutive no-token aborts grow as a flat list instead of nesting prior recovery text.
The Captain's built-in instruction ("Players answered independently. Synthesize a final answer for the Boss. Preserve useful disagreements, call out failed or aborted players, and do not copy raw player logs wholesale.") is the only soft check; cligent imposes no hard cap on player output length.
Workloads that need a hard cap should write a thin Captain wrapper or use a different Captain implementation.

`captain.from` accepts local paths (resolved against the config file's directory) or package specifiers; both resolve through `import()` at session startup.

Player IDs match `^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$`, are unique within a config, and may not equal `captain`.
Multiple players may share an adapter and model — the player ID is the runtime identity.

Adapter names use the canonical short scheme: `claude`, `codex`, `gemini`, `kimi`, `opencode`.

### Serialization and Abort

Boss turns serialize: one at a time.
Within a turn, player calls may run concurrently at the Captain's discretion.

Each player and the Captain own one persistent `Cligent` per session.

SIGINT, SIGTERM, or EOF aborts the active turn via `context.signal`.
`CaptainSession.signal` aborts on session shutdown, not per-turn cancellation.

Session shutdown order:

1. Active turn unwinds; turn-bound emissions drain before `turn_finished` / `turn_aborted`.
2. Invoke optional `Captain.prepareDispose()` while session emissions remain live, per [DR-008](008-captain-pre-close-lifecycle.md).
3. Abort `CaptainSession.signal` so producers wired to it (matcher subscriptions, timers) detach.
4. Drain already-accepted session emissions; post-abort `emit*` calls reject.
5. `Captain.dispose()`.
6. Detach observers.

Aborting before draining detaches producers cleanly and delivers their in-flight records without racing new ones.

#### Boss Input and Prompt Lifecycle

Boss input keeps Node's readline editor rather than replacing it with a raw-mode editor.
An explicit `escapeCodeTimeout` of 100 ms avoids the default 500 ms bare-ESC delay while leaving more margin for escape sequences on sluggish pipes than a 50–75 ms timeout; the fixed value also gives timer-driven verification one deterministic boundary.
The abort guard requires both `key.name === 'escape'` and `key.sequence === '\x1b'`, so Alt-ESC and other multi-byte escape combinations do not masquerade as a bare ESC.

Bracketed paste uses the `paste-start` and `paste-end` keypress names emitted by Node's `emitKeypressEvents` [[2]] for xterm's `\x1b[200~` and `\x1b[201~` markers [[1]], not a second byte-level parser.
Because readline still emits a `line` event for each pasted newline, the session accumulates those lines while paste is active and flushes them on the first line after `paste-end`.
The submitted prompt is the buffered lines joined with `\n`, followed by `\n` and a non-empty post-paste line when present; an empty post-paste line acts only as the explicit Enter and adds no trailing newline.
Bracketed-paste mode is enabled only for the session and disabled on every exit path, otherwise the user's later shell receives the raw wrapper markers.

During an active Boss turn the readline prompt is suspended—no fresh `boss> ` prompt is painted—and restored once when the turn completes or aborts.
This scopes ready-prompt input echo to the between-turn state while preserving the edit buffer required by [[tmux-play-57](../packages/tmux-play.md#tmux-play-57)].
The accepted tradeoff is that type-ahead remains captured but is not visibly echoed until restoration; a separate active-turn input affordance was rejected as a distinct, more invasive UX convention.

`readline.pause()` is not a valid suspension mechanism because it would also stop keypress delivery and break both ESC abort and type-ahead capture.
The readline remains live while prompt chrome is suppressed: an implementation may clear the displayed line and temporarily use an empty prompt, or buffer active-turn keystrokes without echo and restore them to readline afterward.
Whichever mechanism is used, its boundary is the active Boss turn and therefore covers normal completion, ESC abort, runtime error, and observer-dispatch failure, while preserving bracketed-paste type-ahead through the same path.

### Distribution and Extension

`tmux-play` ships in the `@sublang/cligent` npm package as a `bin` entry, replacing the prior `fanout` bin.
The package is ESM, Node ≥18.3 per
[[package-2](../packages/package.md#package-2)]; there is no compiled binary.

The package separates the runtime API from the CLI:

- The runtime API takes an instantiated Captain, player configs, and zero or more observers (registered via the observer-registration contract), and runs the coordination in-process — tmux-independent, suitable for embedding in other presentations.
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

## References

[1]: https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Bracketed-Paste-Mode "xterm Control Sequences — Bracketed Paste Mode"
[2]: https://nodejs.org/api/readline.html#readlineemitkeypresseventsstream-interface "Node.js — readline.emitKeypressEvents()"
[3]: https://catppuccin.com/palette/ "Catppuccin Palette"
[4]: https://man.openbsd.org/tmux.1 "tmux manual — key tables, copy-mode, send-keys -X"
