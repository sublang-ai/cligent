<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-009: tmux-play - Captain-Coordinated App

## Goal

Extend [IR-007 fanout](007-fanout-tmux-app.md) into a tmux-rendered Captain/role coordination app named `tmux-play`.

`tmux-play` has one input-enabled Boss/Captain pane and one read-only pane per role cligent.
Boss talks only to Captain.
Captain calls role cligents through the `Cligent` SDK, inspects results, and replies to Boss.

The first Captain mode is `fanout`.
It sends each Boss prompt to all roles, collects results, asks a Captain cligent to summarize, and streams the reply to Boss.
The design leaves room for later router modes that choose roles or iterate through call, think, call, and reply steps.

## Status

Proposed

## Naming

Use `tmux-play` as the public binary name.

- `tmux-play` is a tmux-rendered validation and debugging helper for cligent.
- The name makes the tmux coupling explicit.
- This IR defines no other presentation surface.
- `play` means an interactive coordinated run involving Boss, Captain, and role cligents.
- Keep `fanout` as the compatibility command and deterministic broadcast Captain mode.

## Relationship to `fanout`

This iteration shall not build a second unrelated tmux app.

Existing `src/app` already owns the needed substrate:

- tmux process management and pane titles.
- launcher/session split.
- per-agent log files tailed by read-only panes.
- Boss readline loop.
- adapter resolution.
- `Cligent.run()` event streaming.
- event-to-text formatting.
- abort and cleanup paths.

`tmux-play` shall extend or extract that code.
Existing `fanout` behavior must keep passing tests and remain available.
Fanout files may stay directly under `src/app/` to avoid bin-path churn.
Reusable code goes under `src/app/shared/`.
`tmux-play` code goes under `src/app/tmux-play/`.

## Layout

```text
+----------------------+----------------+----------------+
| Boss <-> Captain     | Role: Coder    | Role: Reviewer |
|                      | (tail -f log)  | (tail -f log)  |
| ...history...        |                |                |
|                      |                |                |
| boss> _              |                |                |
+----------------------+----------------+----------------+
```

Keep Boss/Captain as the wide left pane.
Role panes sit to the right in config order.
One role creates one column.
Two or more roles create two columns.
The first column gets `ceil(roleCount / 2)` roles top-to-bottom.
The second column gets the remaining roles.
Five roles yields `3 + 2`.

The Boss/Captain pane runs `tmux-play --session <id> --work-dir <path>`.
It writes Boss echoes, Captain status, Captain prompts, and Captain cligent events to stdout.
Role panes run `tail -f <workdir>/<role>.log`.
Role panes expose no app input.

## Design

### Single binary, two modes

`tmux-play` follows the IR-007 binary shape:

| Mode | Trigger | Responsibility |
| --- | --- | --- |
| **Launcher** | no `--session` | Load config, resolve Captain and roles, create work dir/logs, build tmux session, attach. |
| **Session** | `--session <id> --work-dir <path>` | Run Boss readline, Captain strategy, role runtime, event formatting, and cleanup. |

`fanout` remains a separate compatibility binary backed by shared primitives.
Do not add `--legacy-fanout-layout`.
The existing `fanout` command is the compatibility boundary.

### Runtime and presentation boundary

`tmux-play` is a tmux app.
The Captain runtime shall not use tmux text scraping or pane-specific control flow.

Split implementation into runtime and presentation.
Runtime owns config, role construction, Captain strategy, turn serialization, abort propagation, role/Captain `Cligent.run()` calls, and result collection.
Presentation owns tmux launch/layout, Boss/Captain stdout rendering, role log rendering, pane titles, and cleanup of launcher-owned tmux resources.

The runtime shall emit structured internal records before presentation formatting.
The first observer is the tmux presenter.
The tmux presenter turns records into Boss-pane text and role log text.
Future observers are out of scope for this IR.
Adding one later should not require changes to `Captain`, `FanoutCaptain`, role runtime, or config validation.

Minimum internal record types:

- `turn_started` accepts a Boss turn and carries turn ID, Boss prompt, and dispatched role IDs.
- `role_prompt` carries the full role prompt before role execution.
- `role_event` carries a raw role `CligentEvent` for one role and turn.
- `role_finished` carries role status, usage when available, log path, and bounded final excerpt.
- `captain_prompt` carries the full bounded summary prompt.
- `captain_event` carries a raw Captain `CligentEvent` for one turn.
- `captain_finished` carries Captain status, usage when available, and bounded final excerpt.
- `turn_finished` marks serialized turn completion.
- `turn_aborted` marks active turn abort from SIGINT, SIGTERM, or EOF.
- `runtime_error` carries a non-role/non-Captain runtime or presenter failure that prevents normal turn completion.

Records are an internal app contract.
They are not a root package export in this iteration.
Record payloads must carry stable role IDs and turn IDs.
Presentation code may format records.
Presentation code must not mutate runtime state.

Observer contract:

```ts
interface RecordObserver {
  onRecord(record: TmuxPlayRecord): void | Promise<void>;
}
```

The dispatcher supports multiple observers.
For each record, observers are called in registration order.
The dispatcher awaits any returned promise before delivering the next record.
Records must not be dropped or coalesced.
If an observer throws or rejects, the session emits `runtime_error` to remaining observers when possible.
It then aborts the active turn and runs normal cleanup.

The tmux presenter is the only observer implemented in this IR.
It maps records to current pane text.

- `turn_started` may render the Boss echo and dispatch status.
- `role_prompt`, `role_event`, and `role_finished` render to the matching role log.
- `captain_prompt`, `captain_event`, and `captain_finished` render to the Boss/Captain pane.
- `turn_finished` redraws the Boss prompt.
- `turn_aborted` and `runtime_error` render a bounded status message when output streams are writable.

### Configuration

```ts
// tmux-play.config.mjs
export default {
  captain: {
    mode: 'fanout',
    adapter: 'claude',
    model: 'claude-opus-4-7',
    instruction: 'Coordinate the role cligents and answer Boss concisely.',
    summaryExcerptChars: 4000,
  },
  roles: [
    {
      id: 'coder',
      adapter: 'claude',
      model: 'claude-opus-4-7',
      instruction: 'Implement the requested change. Report files changed and verification.',
    },
    {
      id: 'reviewer',
      adapter: 'codex',
      model: 'gpt-5.3-codex',
      instruction: 'Review the requested change. Focus on bugs, risks, and missing tests.',
    },
  ],
};
```

Supported runtime config formats are `.mjs`, `.js`, and `.json`.
JavaScript configs load via dynamic `import(pathToFileURL(path))`.
JSON configs load via `fs.readFile()` and `JSON.parse()`.
`.ts` is out of scope because the package has no runtime TypeScript loader.

Default discovery checks `tmux-play.config.mjs`, `tmux-play.config.js`, then `tmux-play.config.json` in cwd.
`--config <path>` may point to any supported extension and disables discovery.

Role IDs are runtime identities, not adapter names.
Multiple roles may share adapter/model.
Each role ID must match `^[a-z][a-z0-9_-]*$`.
Role IDs must be unique.
Role IDs must not equal `captain`.

Adapter names use the existing fanout short-name scheme: `claude`, `codex`, `gemini`, `opencode`.

### Captain interface

Captain is an app-level strategy object, not a text protocol.

```ts
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
  callRole(roleId: string, prompt: string, options?: RoleCallOptions): Promise<RoleRunResult>;
  callCaptain(prompt: string, options?: CaptainCallOptions): Promise<CaptainRunResult>;
}

type RoleCallOptions = Omit<RunOptions, 'abortSignal'>;
type CaptainCallOptions = Omit<RunOptions, 'abortSignal'>;
```

`BossTurn.id` is a session-local integer starting at `1`.
`BossTurn.prompt` is the submitted Boss line with only the surrounding newline removed.
`BossTurn.timestamp` is `Date.now()` in milliseconds when accepted.

`RunOptions` is the DR-003 per-call options type.
The runtime owns abort propagation and passes `context.signal` to underlying `Cligent.run()` calls.
Captains must not pass their own `abortSignal`.
Role identity is runtime-owned.
`roleId` identifies roles.
`captain` identifies the Captain cligent.
Call options must not override runtime-owned role identity.

`callRole()` owns role `Cligent.run()` execution.
It emits `role_prompt`, `role_event`, and `role_finished` records.
`callCaptain()` owns Captain cligent execution.
It emits `captain_prompt`, `captain_event`, and `captain_finished` records.
The tmux presenter formats those records into role logs and Boss-pane text.
Role cligent events go only to that role's records and log.
Boss sees Captain status/replies, not raw role output.

Captains should coordinate through `CaptainContext` calls.
Captains must not reach into tmux panes, log streams, or presenter internals.

### Fanout Captain mode

`FanoutCaptain` is the first Captain implementation.

For each Boss prompt:

1. Accept the Boss turn and emit `turn_started` with turn ID, Boss prompt, and configured role IDs.
2. Build one full role prompt per configured role from role instruction, turn ID, Boss prompt, and fanout guidance.
3. Call every configured role concurrently via `context.callRole()`.
4. Each role call emits `role_prompt`, zero or more `role_event` records, and `role_finished`.
5. After all role calls settle, build a Captain summary prompt from the original Boss prompt, role IDs/statuses, bounded role excerpts, and full-detail log paths.
6. Call the configured Captain cligent via `context.callCaptain()` with the summary prompt.
7. The Captain call emits `captain_prompt`, zero or more `captain_event` records, and `captain_finished`.
8. Emit `turn_finished` when the serialized turn completes.

`captain.summaryExcerptChars` defaults to `4000`.
It must be in `[500, 20000]`.
Truncate by Unicode code point count.
Keep the beginning and append `\n[truncated: kept 4000 of 12345 chars]`-style metadata.
Full role output remains in the role pane/log.

The Captain summary prompt is not emitted to role records.
It is emitted as `captain_prompt`.
The tmux presenter writes it to the Boss pane.
The prompt uses bounded excerpts, so large role output cannot flood the Boss pane.

### Future Router Captain mode

This IR prepares the `Captain` interface for router-style coordination but does not implement it.

A later `RouterCaptain` can use the same `CaptainContext` to choose roles, call roles, inspect bounded results, decide on additional calls, and reply to Boss.

Before implementation, router mode must specify max role calls per Boss turn, max Captain reasoning rounds, per-role queue semantics, and deterministic invalid-plan handling.

### Run serialization

`Cligent.run()` is single-flight per `Cligent` instance, per [DR-003](../decisions/003-role-scoped-session-management.md).

- Boss turns are processed one at a time.
- Different roles run concurrently within one Boss turn.
- Each role owns one persistent `Cligent` instance.
- The Captain cligent is one persistent `Cligent` instance.
- The Captain cligent runs only during the Captain summary phase.
- The Captain cligent uses `CligentOptions.role = 'captain'`.
- SIGINT, SIGTERM, and EOF abort the active Captain turn through `CaptainContext.signal`.
- Abort propagation includes role calls and the Captain summary run.
- Per-role FIFO queues are out of scope.
- Boss turns are serialized.
- `FanoutCaptain` calls each role at most once per turn.
- Router modes with repeated same-role calls must first define queueing.

### Event-to-text formatting

Move the fanout formatter into a shared app module.
Keep fanout output stable unless tests are intentionally updated.

For `tmux-play`:

- Role cligent events format only to the matching role log.
- Captain cligent events format only to the Boss pane.
- Boss and Captain status records are plain app text, not `CligentEvent`s.
- `tool_use` should include at least the tool name.
- `tool_use` may include pretty-printed input if that does not break existing fanout compatibility tests.
- `tool_result` should include string output as-is.
- `tool_result` should include `{stdout}` when present.
- Other `tool_result` objects should format as JSON.

## Out of scope

- Implementing `RouterCaptain`.
- Additional presentation surfaces beyond the tmux app.
- Publicly exporting the internal record/observer API.
- Persisting cross-launch history.
- Interactive permission UI beyond adapter defaults.
- Multi-Boss/shared sessions.

## Deliverables

- [ ] `package.json` - add `"tmux-play": "./dist/app/tmux-play/cli.js"` while keeping `"fanout"`.
- [ ] `src/app/shared/` - tmux, log, shell quoting, and event formatting helpers reused by fanout and tmux-play.
- [ ] `src/app/tmux-play/cli.ts` - arg parsing and launcher/session mode dispatch.
- [ ] `src/app/tmux-play/config.ts` - config loading and validation.
- [ ] `src/app/tmux-play/roles.ts` - role resolution, adapter construction, and `Cligent` creation with `role` set.
- [ ] `src/app/tmux-play/captain.ts` - `Captain`, `CaptainContext`, result types, and runtime contracts.
- [ ] `src/app/tmux-play/records.ts` - internal runtime record types and observer interface.
- [ ] `src/app/tmux-play/fanout-captain.ts` - `FanoutCaptain` implementation.
- [ ] `src/app/tmux-play/launcher.ts` - Boss-left, roles-right tmux layout.
- [ ] `src/app/tmux-play/session.ts` - Boss readline, Captain turn loop, observer dispatch, role runtime, abort, and cleanup.
- [ ] Unit tests for config validation, role resolution, prompt building, record emission, Captain result collection, and formatting.
- [ ] README docs for `tmux-play`, config, env vars, layout, and relationship to `fanout`.

## Tasks

1. **Extract shared fanout primitives** - move shell quoting, tmux invocation, and event formatting into `src/app/shared/` without changing `fanout`; update tests.
2. **Generalize agent resolution to role resolution** - support `{ id, adapter, model, instruction }`, duplicate adapters across roles, role ID validation, and `CligentOptions.role`; test it.
3. **Add tmux-play config loader** - load `tmux-play.config.mjs`, `tmux-play.config.js`, or `tmux-play.config.json`, plus `--config <path>`; validate Captain/roles; fail fast on unknown adapters, missing roles, unsupported extensions, invalid role IDs, reserved role IDs (`captain`), and invalid `summaryExcerptChars`.
4. **Define Captain runtime contracts** - add `Captain`, `BossTurn`, `CaptainContext`, `RoleRuntime`, `RoleRunResult`, `CaptainRunResult`, `RoleCallOptions`, and `CaptainCallOptions` with fake-runtime tests.
5. **Define internal record/observer boundary** - add structured record types, observer dispatch, and a tmux presenter that formats records to Boss stdout and role logs.
6. **Implement role runtime** - create one persistent `Cligent` per role, run cross-role calls concurrently, reject repeated same-role calls in one turn, emit records, and write `captain> <full prompt>` before each role run.
7. **Implement FanoutCaptain prompt building** - render full role prompts deterministically from role instruction, turn ID, and Boss prompt; add snapshot tests.
8. **Implement FanoutCaptain result collection** - run role calls concurrently, capture status/usage/final text excerpts, emit records, and keep raw role events out of the Boss pane.
9. **Implement Captain summary run** - build the summary prompt with enforced excerpt bounds, call Captain through `callCaptain()`, emit records, and stream Captain events to the Boss pane.
10. **Implement tmux-play launcher** - create work dir/logs; build Boss-left and roles-right layout; set pane titles.
11. **Implement tmux-play session CLI** - wire readline, Captain turn serialization, observer dispatch, abort/cleanup, and work-dir marker checks.
12. **Preserve fanout compatibility** - keep the `fanout` command working and passing IR-007/IR-008 tests after shared-code extraction.
13. **Document and verify manually** - add run examples, env vars, sample config, and manual tmux checks.

## Verification

- `npm run build` passes.
- `npm test` passes, including existing `src/app/*.test.ts`.
- `npm run test:acceptance` remains compatible with fanout acceptance tests when required credentials are present.
- `fanout --agent claude --agent codex` still launches the IR-007 app with existing behavior.
- `tmux-play --config tmux-play.config.mjs` launches a tmux session with Boss/Captain on the left and role panes on the right.
- One Boss prompt writes full Captain-authored role prompts and full role event streams to role panes.
- The session runtime emits structured turn, role, and Captain records before tmux formatting.
- The tmux presenter produces tmux output from those records.
- A unit test attaches a non-tmux observer and asserts causality for one Boss turn: `turn_started` first, `role_prompt` before each role's events, one `role_finished` per role, `captain_prompt` after all role finishes, `captain_finished` after Captain events, and `turn_finished` last.
- A non-role/non-Captain failure emits `runtime_error`, aborts the active turn, and runs cleanup.
- In `fanout` Captain mode, role runs execute concurrently.
- The Captain summary cligent replies in the Boss pane after role runs settle.
- Captain summary prompts enforce `summaryExcerptChars` before writing to the Boss pane or calling the Captain cligent.
- Role cligent output is not copied directly into the Boss pane.
- Ctrl-D, SIGINT, and SIGTERM abort active role runs and an active Captain summary run.
- Ctrl-D, SIGINT, and SIGTERM close streams, remove only launcher-owned work dirs, and kill the tmux session.
