<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-004: tmux-play Captain Architecture

## Status

Accepted

## Context

[DR-001](001-unified-cli-agent-interface-architecture.md) established the
TypeScript async-generator adapter architecture. [DR-002](002-unified-event-stream-and-adapter-interface.md)
defined the unified event stream and adapter interface. [DR-003](003-role-scoped-session-management.md)
defined `Cligent` instances for role identity, session continuity, option
merging, and single-flight execution.

The existing fanout app proves that multiple `Cligent` instances can be
rendered in tmux panes. The next coordination layer needs a Captain that can
call role cligents, inspect their results, and answer a Boss, without making
the coordination runtime depend on tmux pane scraping or terminal layout
details.

## Decision

### Product Boundary

Where the Captain-coordinated terminal workflow is exposed, the public binary
shall be named `tmux-play`.

Where deterministic broadcast compatibility is required, the existing `fanout`
command shall remain available as the compatibility boundary. `tmux-play`
shall not add a legacy fanout layout flag.

Where Boss submits input, Boss shall interact with the Captain. Boss shall not
call role cligents directly.

Where this decision defines presentation, `tmux-play` shall be a tmux-rendered
application. Additional presentation surfaces are out of scope for this
decision.

Where `tmux-play` starts without `--session`, it shall run in launcher mode:
load config, resolve Captain and roles, create the work directory and logs,
build the tmux session, and attach. Where `tmux-play` starts with
`--session <id> --work-dir <path>`, it shall run in session mode: run Boss
readline, Captain strategy, role runtime, event formatting, abort handling,
and cleanup.

### tmux Presentation Topology

Where `tmux-play` launches a session, the Boss/Captain pane shall be the wide
left pane and role panes shall be read-only panes on the right in config
order.

The following diagram illustrates the topology; the textual rules below are
the binding specification:

```text
+----------------------+----------------+----------------+
| Boss <-> Captain     | Role: Coder    | Role: Reviewer |
|                      | (tail -f log)  | (tail -f log)  |
| ...history...        |                |                |
|                      |                |                |
| boss> _              |                |                |
+----------------------+----------------+----------------+
```

Where one role is configured, the role presentation shall create one right-side
column. Where two or more roles are configured, the role presentation shall
create two right-side columns. The first column shall contain
`ceil(roleCount / 2)` roles from top to bottom, and the second column shall
contain the remaining roles.

Where the Boss/Captain pane runs, it shall execute
`tmux-play --session <id> --work-dir <path>`. Where role panes run, they shall
tail the corresponding role log file and expose no app input.

### Runtime and Presentation Boundary

Where Captain coordination executes, the runtime shall not use tmux text
scraping, pane state, or pane-specific control flow.

The runtime shall own config validation, role construction, Captain strategy
execution, Boss-turn serialization, abort propagation, role and Captain
`Cligent.run()` calls, and result collection.

The presentation shall own tmux launch/layout, Boss/Captain stdout rendering,
role log rendering, pane titles, and cleanup of launcher-owned tmux resources.

Where runtime activity is observed, the runtime shall emit structured internal
records before presentation formatting. Presentation code may format records,
but shall not mutate runtime state.

The minimum internal record types are:

- `turn_started`
- `role_prompt`
- `role_event`
- `role_finished`
- `captain_prompt`
- `captain_event`
- `captain_finished`
- `turn_finished`
- `turn_aborted`
- `runtime_error`

Record payloads shall carry stable role IDs and turn IDs. Records are an
internal app contract and shall not be exported from the root package in this
decision.

### Observer Contract

Where the runtime emits records, it shall deliver them through this observer
shape:

```typescript
interface RecordObserver {
  onRecord(record: TmuxPlayRecord): void | Promise<void>;
}
```

Where multiple observers are registered, the dispatcher shall call observers
in registration order for each record. The dispatcher shall await any returned
promise before delivering the next record. Records shall not be dropped or
coalesced.

When an observer throws or rejects, the session shall emit `runtime_error` to
remaining observers when possible. It shall then abort the active turn and run
normal cleanup.

The tmux presenter is the first observer. It shall map role records to role
logs and Captain/Boss records to the Boss/Captain pane.

### Configuration

Where runtime configuration is loaded, `tmux-play` shall support `.mjs`, `.js`,
and `.json` config files. JavaScript configs shall load through dynamic
`import(pathToFileURL(path))`. JSON configs shall load through `fs.readFile()`
and `JSON.parse()`. TypeScript config files are out of scope.

Where no `--config <path>` is provided, default discovery shall check
`tmux-play.config.mjs`, `tmux-play.config.js`, then `tmux-play.config.json` in
the current working directory. Where `--config <path>` is provided, default
discovery shall be disabled.

Role IDs are runtime identities, not adapter names. Multiple roles may share
the same adapter and model. Each role ID shall match `^[a-z][a-z0-9_-]*$`, be
unique within the config, and not equal `captain`.

Each role config shall include an ID, adapter, optional model, and optional
instruction.

Adapter names shall use the existing short-name scheme: `claude`, `codex`,
`gemini`, and `opencode`.

Captain config shall include a mode, adapter, optional model, optional
instruction, and `summaryExcerptChars`. `captain.summaryExcerptChars` shall
default to `4000`, be within `[500, 20000]`, and bound role excerpts by
Unicode code point count.

### Captain Interface

Where a Captain strategy is implemented, it shall be an app-level strategy
object instead of a text protocol.

```typescript
interface Captain {
  readonly mode: string;
  handleBossTurn(turn: BossTurn, context: CaptainContext): Promise<void>;
}

interface BossTurn {
  id: number;
  prompt: string;
  timestamp: number;
}

interface CaptainContext {
  signal: AbortSignal;
  roles: readonly RoleRuntime[];
  callRole(
    roleId: string,
    prompt: string,
    options?: RoleCallOptions,
  ): Promise<RoleRunResult>;
  callCaptain(
    prompt: string,
    options?: CaptainCallOptions,
  ): Promise<CaptainRunResult>;
}

type RoleCallOptions = Omit<RunOptions, 'abortSignal'>;
type CaptainCallOptions = Omit<RunOptions, 'abortSignal'>;
```

Where a Boss turn is accepted, `BossTurn.id` shall be a session-local integer
starting at `1`, `BossTurn.prompt` shall be the submitted Boss line with only
the surrounding newline removed, and `BossTurn.timestamp` shall be `Date.now()`
in milliseconds.

Where a Captain calls a role or the Captain cligent, the runtime shall own
abort propagation and pass `CaptainContext.signal` to underlying
`Cligent.run()` calls. Captains shall not pass their own `abortSignal`.

Where `callRole()` executes, it shall emit `role_prompt`, `role_event`, and
`role_finished` records. Where `callCaptain()` executes, it shall emit
`captain_prompt`, `captain_event`, and `captain_finished` records.

Captains shall coordinate through `CaptainContext` calls and shall not reach
into tmux panes, log streams, or presenter internals.

### Fanout Captain Mode

Where `captain.mode` is `fanout`, `FanoutCaptain` shall send each Boss prompt
to every configured role concurrently, collect role results, build a bounded
Captain summary prompt, call the configured Captain cligent, and emit
`turn_finished` when the serialized turn completes.

`FanoutCaptain` shall call each role at most once per Boss turn.

Where role prompts are built, each prompt shall include the role instruction,
turn ID, Boss prompt, and fanout guidance.

Where the Captain summary prompt is built, it shall include the original Boss
prompt, role IDs, role statuses, bounded role excerpts, and full-detail log
paths. Full role output shall remain in role logs. Role cligent output shall
not be copied directly into the Boss pane.

The Captain summary prompt shall emit as `captain_prompt` and shall not emit
to role records.

Where role output exceeds `summaryExcerptChars`, truncation shall keep the
beginning and append metadata in the form
`[truncated: kept 4000 of 12345 chars]`.

### Serialization and Abort

Where Boss submits turns, turns shall be processed one at a time. Where one
Boss turn is active in fanout mode, different roles may run concurrently.

Each configured role shall own one persistent `Cligent` instance. The Captain
shall own one persistent `Cligent` instance with `CligentOptions.role` set to
`captain`.

Where SIGINT, SIGTERM, or EOF occurs, the runtime shall abort the active
Captain turn through `CaptainContext.signal`. Abort propagation shall include
active role calls and the active Captain summary run.

Per-role FIFO queues are out of scope. Router modes with repeated same-role
calls shall first define queueing and bounded planning semantics.

### Event Formatting Boundary

Where role cligent events are formatted, they shall format only to the matching
role log. Where Captain cligent events are formatted, they shall format only to
the Boss/Captain pane.

Boss and Captain status records are app records, not `CligentEvent` values.

Where tool events are formatted, `tool_use` output shall include at least the
tool name, `tool_result` shall include string output as-is, `tool_result`
shall include `{stdout}` when present, and other `tool_result` objects shall
format as JSON.

### Out of Scope

The following topics are out of scope for this decision:

- implementing `RouterCaptain`;
- additional presentation surfaces beyond the tmux app;
- publicly exporting the internal record or observer API;
- persisting cross-launch history;
- interactive permission UI beyond adapter defaults;
- multi-Boss or shared sessions.

Where future work adds any out-of-scope topic, it shall introduce a separate
decision or iteration record that defines the new behavior explicitly.

## Consequences

- `tmux-play` extends the existing multi-agent app surface without replacing
  `fanout`.
- Runtime code can be tested without tmux because coordination emits internal
  records before presentation formatting.
- The observer boundary allows later non-tmux observers without changing
  Captain strategy or role runtime contracts.
- `FanoutCaptain` is the first Captain mode. Router-style modes remain future
  work and require explicit bounds before implementation.
- Router modes must specify max role calls per Boss turn, max Captain
  reasoning rounds, per-role queue semantics, and deterministic invalid-plan
  handling before implementation.
- Shared app primitives are needed for tmux process management, shell quoting,
  log handling, and event formatting.
