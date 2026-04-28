<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-009: cligent-play - Captain-Coordinated tmux App

## Goal

Extend [IR-007 fanout](007-fanout-tmux-app.md) into a reusable Captain/role coordination app named `cligent-play`.

`cligent-play` has one input-enabled Boss/Captain pane and one read-only pane per role cligent. Boss talks only to Captain. Captain is an app-level coordinator that calls role cligents through the `Cligent` SDK, inspects results, and replies to Boss.

The first Captain mode is `fanout`: send each Boss prompt to all roles, collect results, ask a Captain cligent to summarize, and stream the reply to Boss. The architecture also leaves room for later router modes that choose roles or iterate: call role, think, call another role, reply.

## Status

Proposed

## Naming

Use `cligent-play` as the public binary name.

- `play` means a coordinated run involving Boss, Captain, and role cligents.
- `cligent-play` avoids colliding with generic `play` commands.
- Avoid `tmux-play`; tmux is the first surface, not the long-term identity.
- Keep `fanout` as a compatibility command and as the name of the deterministic broadcast Captain mode.

## Relationship to `fanout`

This iteration shall not build a second unrelated tmux app.

Existing `src/app` already owns the needed substrate:

- tmux process management and pane titles;
- launcher/session split;
- per-agent log files tailed by read-only panes;
- Boss readline loop;
- adapter resolution;
- `Cligent.run()` event streaming;
- event-to-text formatting;
- abort and cleanup paths.

`cligent-play` shall extend or extract that code. Existing `fanout` behavior must keep passing tests and remain available. Fanout files may stay directly under `src/app/` to avoid bin-path churn; reusable code goes under `src/app/shared/`, and play-specific code under `src/app/play/`.

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

Layout rule: keep Boss/Captain as the wide left pane. Role panes sit to the right in config order. One role creates one column. Two or more roles create two columns: first `ceil(roleCount / 2)` roles top-to-bottom in column one, remaining roles in column two. Five roles yields `3 + 2`.

The Boss/Captain pane runs `cligent-play --session <id> --work-dir <path>` and writes Boss echoes, Captain status, Captain prompts, and Captain cligent events to stdout. Role panes run `tail -f <workdir>/<role>.log` and expose no app input.

## Design

### Single binary, two modes

`cligent-play` follows the IR-007 binary shape:

| Mode | Trigger | Responsibility |
| --- | --- | --- |
| **Launcher** | no `--session` | Load config, resolve Captain + roles, create work dir/logs, build tmux session, attach. |
| **Session** | `--session <id> --work-dir <path>` | Run Boss readline, Captain strategy, role runtime, event formatting, cleanup. |

`fanout` remains a separate compatibility binary backed by shared primitives. Do not add `--legacy-fanout-layout`; the existing `fanout` command is the compatibility boundary.

### Configuration

```ts
// play.config.mjs
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

Supported runtime config formats: `.mjs`, `.js`, `.json`. JavaScript configs load via dynamic `import(pathToFileURL(path))`; JSON loads via `fs.readFile()` and `JSON.parse()`. `.ts` is out of scope because the package has no runtime TypeScript loader.

Default discovery checks `play.config.mjs`, `play.config.js`, then `play.config.json` in cwd. `--config <path>` may point to any supported extension and disables discovery.

Role IDs are runtime identities, not adapter names. Multiple roles may share adapter/model. Each role ID must match `^[a-z][a-z0-9_-]*$`, be unique, and not equal `captain`.

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
  writeBoss(text: string): void;
  callRole(roleId: string, prompt: string, options?: RoleCallOptions): Promise<RoleRunResult>;
  callCaptain(prompt: string, options?: CaptainCallOptions): Promise<CaptainRunResult>;
}

type RoleCallOptions = Omit<RunOptions, 'abortSignal'>;
type CaptainCallOptions = Omit<RunOptions, 'abortSignal'>;
```

`BossTurn.id` is a session-local integer starting at `1`. `BossTurn.prompt` is the submitted Boss line with only the surrounding newline removed. `BossTurn.timestamp` is `Date.now()` in milliseconds when accepted.

`RunOptions` is the DR-003 per-call options type. The runtime owns abort propagation and passes `context.signal` to underlying `Cligent.run()` calls; Captains must not pass their own `abortSignal`. Role identity is runtime-owned (`roleId` for roles, `captain` for the Captain cligent) and not overrideable through call options.

`callRole()` owns role log writing and role `Cligent.run()`. `callCaptain()` owns Captain cligent execution and Boss-pane event formatting. Role cligent events go only to that role log. Boss sees Captain status/replies, not raw role output.

### Fanout Captain mode

`FanoutCaptain` is the first Captain implementation.

For each Boss prompt:

1. Echo `boss> <prompt>` in the Boss pane.
2. Write a dispatch record in the Boss pane, for example `captain> dispatching turn 7 to coder, reviewer`.
3. Build one full role prompt per configured role from:
   - role instruction;
   - turn id;
   - Boss prompt;
   - fanout guidance needed to keep role output useful.
4. Call every configured role concurrently via `context.callRole()`.
5. Each role pane starts the turn with `captain> <full role prompt>`, then streams that role cligent's full event stream.
6. After all role calls settle, build a Captain summary prompt containing:
   - original Boss prompt;
   - role IDs and statuses;
   - final text/result excerpts from each role, truncated to `captain.summaryExcerptChars` characters per role;
   - log paths for full details.
7. Write the full Captain summary prompt to the Boss pane as a clearly marked Captain prompt record.
8. Run the configured Captain cligent with the summary prompt and stream its formatted events into the Boss pane.
9. Redraw the Boss prompt when the Captain turn completes.

`captain.summaryExcerptChars` defaults to `4000` and must be in `[500, 20000]`. Truncate by Unicode code point count, keep the beginning, and append a marker such as `\n[truncated: kept 4000 of 12345 chars]`. Full role output remains in the role pane/log.

The Captain summary prompt is not written to role panes. It is written to the Boss pane, which owns the Boss/Captain conversation: Captain prompts, replies, tool calls, tool results, and status. The Boss-pane prompt uses the same bounded excerpts, so large role output cannot flood it.

### Future Router Captain mode

This IR prepares the `Captain` interface for router-style coordination but does not implement it.

A later `RouterCaptain` can use the same `CaptainContext` to:

- ask a Captain cligent to choose which role to call;
- call one or more roles;
- inspect bounded role results;
- decide whether to call additional roles;
- eventually reply to Boss.

Before implementation, router mode must specify max role calls per Boss turn, max Captain reasoning rounds, per-role queue semantics, and deterministic invalid-plan handling.

### Run serialization

`Cligent.run()` is single-flight per `Cligent` instance, per [DR-003](../decisions/003-role-scoped-session-management.md).

- Boss turns are processed one at a time.
- Within a Boss turn, different roles run concurrently.
- Each role owns one persistent `Cligent` instance.
- The Captain cligent is one persistent `Cligent` instance and runs only during the Captain summary phase.
- The Captain cligent is created with `CligentOptions.role = 'captain'`.
- SIGINT, SIGTERM, and EOF abort the active Captain turn through `CaptainContext.signal`, including role calls and the Captain summary run.
- Per-role FIFO queues are out of scope: Boss turns are serialized, and `FanoutCaptain` calls each role at most once per turn. Router modes with repeated same-role calls must first define queueing.

### Event-to-text formatting

Move the fanout formatter into a shared app module. Keep fanout output stable unless intentionally updating tests.

For `cligent-play`:

- role cligent events format only to the matching role log;
- Captain cligent events format only to the Boss pane;
- Boss and Captain status records are plain app text, not `CligentEvent`s;
- `tool_use` should include at least the tool name, and may include pretty-printed input if doing so does not break existing fanout compatibility tests;
- `tool_result` should include string output as-is, `{stdout}` if present, else JSON.

## Out of scope

- Browser/WebSocket presentation.
- Implementing `RouterCaptain`.
- Persisting cross-launch history.
- Interactive permission UI beyond adapter defaults.
- Multi-Boss/shared sessions.

## Deliverables

- [ ] `package.json` - add `"cligent-play": "./dist/app/play/cli.js"` while keeping `"fanout"`.
- [ ] `src/app/shared/` - tmux, log, shell quoting, and event formatting helpers reused by fanout and play.
- [ ] `src/app/play/cli.ts` - arg parsing and launcher/session mode dispatch.
- [ ] `src/app/play/config.ts` - config loading and validation.
- [ ] `src/app/play/roles.ts` - role resolution, adapter construction, `Cligent` creation with `role` set.
- [ ] `src/app/play/captain.ts` - `Captain`, `CaptainContext`, result types, and runtime contracts.
- [ ] `src/app/play/fanout-captain.ts` - `FanoutCaptain` implementation.
- [ ] `src/app/play/launcher.ts` - Boss-left, roles-right tmux layout.
- [ ] `src/app/play/session.ts` - Boss readline, Captain turn loop, role runtime, abort/cleanup.
- [ ] Unit tests for config validation, role resolution, prompt building, Captain result collection, and formatting.
- [ ] README docs for `cligent-play`, config, env vars, layout, and relationship to `fanout`.

## Tasks

1. **Extract shared fanout primitives** - move shell quoting, tmux invocation, and event formatting into `src/app/shared/` without changing `fanout`; update tests.
2. **Generalize agent resolution to role resolution** - support `{ id, adapter, model, instruction }`, duplicate adapters across roles, role ID validation, and `CligentOptions.role`; test it.
3. **Add play config loader** - load `play.config.mjs`, `play.config.js`, or `play.config.json`, plus `--config <path>` for those extensions; validate Captain/roles; fail fast on unknown adapters, missing roles, unsupported extensions, invalid role IDs, reserved role IDs (`captain`), and invalid `summaryExcerptChars`.
4. **Define Captain runtime contracts** - add `Captain`, `BossTurn`, `CaptainContext`, `RoleRuntime`, `RoleRunResult`, `CaptainRunResult`, `RoleCallOptions`, and `CaptainCallOptions` with fake-runtime tests.
5. **Implement role runtime** - create one persistent `Cligent` per role, run cross-role calls concurrently, reject repeated same-role calls in one turn, and write `captain> <full prompt>` before each role run.
6. **Implement FanoutCaptain prompt building** - render full role prompts deterministically from role instruction, turn id, and Boss prompt; add snapshot tests.
7. **Implement FanoutCaptain result collection** - run role calls concurrently, capture status/usage/final text excerpts, and keep raw role events out of the Boss pane.
8. **Implement Captain summary run** - build the summary prompt with enforced excerpt bounds, call Captain through `callCaptain()`, and stream Captain events to the Boss pane.
9. **Implement cligent-play tmux launcher** - create work dir/logs; build Boss-left and roles-right layout: one role column for one role, two columns for two or more, stacked per Layout rule; set pane titles.
10. **Implement cligent-play session CLI** - wire readline, Captain turn serialization, abort/cleanup, and work-dir marker checks.
11. **Preserve fanout compatibility** - keep the `fanout` command working and passing IR-007/IR-008 tests after shared-code extraction.
12. **Document and verify manually** - add run examples, env vars, sample config, and manual tmux checks.

## Verification

- `npm run build` passes.
- `npm test` passes, including existing `src/app/*.test.ts`.
- `npm run test:acceptance` remains compatible with fanout acceptance tests when required credentials are present.
- `fanout --agent claude --agent codex` still launches the IR-007 app with existing behavior.
- `cligent-play --config play.config.mjs` launches a tmux session with Boss/Captain on the left and role panes on the right.
- One Boss prompt writes full Captain-authored role prompts and full role event streams to role panes.
- In `fanout` Captain mode, role runs execute concurrently; the Captain summary cligent replies in the Boss pane after they settle.
- Captain summary prompts enforce `summaryExcerptChars` before writing to the Boss pane or calling the Captain cligent.
- Role cligent output is not copied directly into the Boss pane.
- Ctrl-D, SIGINT, and SIGTERM abort active role runs and an active Captain summary run, close streams, remove only launcher-owned work dirs, and kill the tmux session.
