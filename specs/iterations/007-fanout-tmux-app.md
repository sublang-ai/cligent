<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-007: Fanout — Multi-Agent tmux Chat App

## Goal

Build `fanout`, a CLI application that uses cligent to broadcast a single prompt to multiple AI agents in parallel, displaying each agent's streaming response in its own tmux pane.

## Status

Done

## Layout

```
┌───────────┬───────────┬───────────┐
│  claude   │   codex   │  gemini   │
│           │           │           │
│  (agent   │  (agent   │  (agent   │
│   output) │   output) │   output) │
│           │           │           │
├───────────┴───────────┴───────────┤
│ boss$  _                          │
└───────────────────────────────────┘
```

The upper region is split into _n_ vertical panes (one per agent). The bottom pane is the boss prompt where the user types. Prompt text is sent to all agents simultaneously; streaming responses appear in real time in the corresponding panes.

## Design

### Single binary, two modes

`fanout` is one Node.js CLI entry point with two modes selected by the presence of `--session`:

| Mode | Trigger | Responsibility |
| --- | --- | --- |
| **Launcher** | no `--session` flag | Resolve agents, create temp dir & log files, build tmux session with layout, attach |
| **Session** | `--session <id>` | Run boss readline loop, fan out prompts via cligent, write streaming output to log files. Requires `--work-dir` for log path. |

### Launcher mode

1. Validate agents — from `--agent` flags or auto-detect via `adapter.isAvailable()`. Reject unknown agent names with an error listing valid names. Reject duplicate agent names (each agent name may appear at most once). If auto-detect yields zero available agents, exit with a clear message (e.g., "No agents available — install at least one agent SDK").
2. Create temp directory with `node:fs.mkdtempSync` (e.g., `/tmp/fanout-XXXXXX/`) and one empty `<agent>.log` per agent. The resulting absolute path is the **work dir**.
3. Write a marker file `.fanout-session` into the work dir (used by session mode to confirm launcher ownership before cleanup).
4. Build a tmux session named `fanout-<id>` in this exact order:
   a. `tmux new-session -d -s <name>` with the first agent pane running `tail -f <workdir>/<agent>.log`.
   b. `tmux split-window -h -t <name>` for each additional agent pane, each running `tail -f`.
   c. `tmux select-layout -t <name> even-horizontal` to tile the agent panes evenly **before** creating the boss pane.
   d. `tmux split-window -v -f -t <name>` for the boss pane (full-width bottom) running `fanout --session <id> --agent <agent[=model]> [--agent ...] --work-dir <workdir> [passthrough flags]`.
   e. Set pane titles via `select-pane -T <agent>` and enable `pane-border-format` to show titles.
4. Attach to the tmux session (replaces current terminal).

### Session mode (boss pane)

1. Instantiate one `Cligent` per agent (with the corresponding adapter), using shared `cwd` and per-agent `model` if provided via `--agent name=model`. Permissions default to `ask` (interactive agent defaults).
2. Display `boss$ ` prompt via `node:readline`.
3. On each line of input:
   - Echo the prompt to each log file as `boss> <prompt text>` followed by a blank line, so each pane shows what was asked.
   - Run all agents in parallel (individual `cligent.run()` calls driven by `Promise.allSettled` on helper drain functions, or `Cligent.parallel()`).
   - Route events to the corresponding agent's log file by appending:
     - `text_delta` — append `payload.delta`
     - `text` — append `payload.content` + newline
     - `tool_use` — append `[tool: <toolName>]` + newline
     - `error` — append `[error: <message>]` + newline
     - `done` — append newline + status line (status, token counts)
     - All other events — silently drop
   - When all agents complete, re-display the `boss$ ` prompt.
4. On `SIGINT` / `SIGTERM` or EOF:
   - Abort any in-flight agent runs via `AbortController`.
   - Remove the work dir **only if** the `.fanout-session` marker file is present (confirms launcher ownership; prevents accidental deletion of arbitrary directories passed via `--work-dir`).
   - Kill the tmux session (`tmux kill-session`).

### Agent resolution

Adapter classes are imported from cligent sub-path exports. Accepted agent names and their mappings:

| CLI name | Adapter import |
| --- | --- |
| `claude` | `@sublang/cligent/adapters/claude-code` → `ClaudeCodeAdapter` |
| `codex` | `@sublang/cligent/adapters/codex` → `CodexAdapter` |
| `gemini` | `@sublang/cligent/adapters/gemini` → `GeminiAdapter` |
| `opencode` | `@sublang/cligent/adapters/opencode` → `OpenCodeAdapter` |

Auto-detect (no `--agent` flags): import all four, call `isAvailable()`, keep those that return `true` (with default models).

### CLI syntax

`--agent` is repeatable. Each value is `<name>` or `<name>=<model>`:

```
fanout --agent claude --agent gemini                              # default models
fanout --agent claude=claude-opus-4-6 --agent gemini              # per-agent model
fanout --agent claude=claude-opus-4-6 --agent gemini=gemini-2.5-pro
fanout                                                            # auto-detect all available
```

### No frills

This iteration targets the simplest useful version:

- No config files, no persistent history, no custom themes.
- No scrollback management (tmux native scroll applies).
- No resume across `fanout` restarts.

## Deliverables

- [ ] `package.json` — `"bin": { "fanout": "./dist/app/cli.js" }`
- [ ] `tsconfig.json` — includes `src/app`
- [ ] `src/app/cli.ts` — entry point with arg parsing, mode dispatch
- [ ] `src/app/launcher.ts` — tmux session setup (temp dir, pane layout, attach)
- [ ] `src/app/session.ts` — boss readline loop, agent orchestration, log file routing
- [ ] `src/app/agents.ts` — adapter import, resolution, availability check
- [ ] Unit tests for agent resolution and event-to-log formatting

## Tasks

1. **Add `src/app/` to root package**
   - `bin` field in root `package.json` pointing to `./dist/app/cli.js`
   - App source uses relative imports to cligent core (no separate package)

2. **Implement CLI entry point** (`src/app/cli.ts`)
   - Parse args: `--agent <name[=model]>` (repeatable), `--session <id>`, `--work-dir <dir>`, `--cwd <dir>`
   - Minimal arg parsing (hand-rolled or `node:util.parseArgs`)
   - **Fail-fast validation for session mode:** if `--session` is present, require `--work-dir`; exit with a usage error if it is missing, does not exist, or is not writable — before any agent or tmux actions
   - Dispatch to launcher or session mode based on `--session` presence
   - Shebang line: `#!/usr/bin/env node`

3. **Implement launcher** (`src/app/launcher.ts`)
   - Generate session ID (short random hex)
   - Create temp dir with `node:fs.mkdtempSync`
   - Create empty `<agent>.log` files
   - Write `.fanout-session` marker into work dir
   - Build tmux commands **in this order**:
     - `tmux new-session -d -s <name>` with first pane running `tail -f`
     - `tmux split-window -h -t <name>` for each additional agent pane
     - `tmux select-layout -t <name> even-horizontal` to tile the agent panes
     - `tmux split-window -v -f -t <name>` for the boss pane (full-width bottom, **after** layout)
     - `tmux select-pane -T <agent>` for titles
     - `tmux set pane-border-status top` to show titles
   - Run `tmux attach-session -t <name>` via `execSync` (replaces process)

4. **Implement agent resolution** (`src/app/agents.ts`)
   - Map CLI names → adapter constructors
   - `resolveAgents(entries?: Array<{ name: string, model?: string }>)`: if entries provided, validate names against known agent map (throw on unknown names), reject duplicate agent names, then import and instantiate adapters with per-entry model; if omitted, import all, filter by `isAvailable()` (default models); throw if result is empty
   - Return array of `{ name: string, cligent: Cligent }`

5. **Implement session mode** (`src/app/session.ts`)
   - Accept session ID, agent entries (name + optional model), work dir, cwd from parsed args
   - Call `resolveAgents()` to get Cligent instances
   - Open write streams (`node:fs.createWriteStream` in append mode) for each agent's log file under work dir
   - readline loop:
     - On line: write separator to all logs, run all agents in parallel, route events to log streams
     - On close / SIGINT: abort agents, remove work dir only if `.fanout-session` marker is present, kill tmux session
   - Event routing function: switch on `event.type`, format and write to the correct stream

6. **Write tests**
   - Agent resolution: mock adapter imports, verify filtering by availability
   - Event formatting: verify each event type produces expected log output
   - No integration tests requiring tmux (tmux tests are manual)

## Verification

- `tsc --noEmit` passes
- `vitest run` passes unit tests (including `src/app/*.test.ts`)
- Manual: `fanout --agent claude --agent gemini` launches tmux with correct layout, prompts fan out, responses stream into panes
- Manual: Ctrl+C cleanly kills session and removes temp files
