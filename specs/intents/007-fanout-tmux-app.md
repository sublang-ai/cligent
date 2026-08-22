<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-007: Fanout — Multi-Agent tmux Chat App

## Status

Done

## Intent

Build `fanout`, a CLI application that uses cligent to broadcast a single prompt to multiple AI agents in parallel, displaying each agent's streaming response in its own tmux pane.

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
