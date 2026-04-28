<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-009: tmux-play Captain App

## Goal

Implement the first `tmux-play` Captain/role app defined by
[DR-004](../decisions/004-tmux-play-captain-architecture.md).

This iteration extends the existing fanout tmux substrate into a
Captain-coordinated app with:

- a `tmux-play` binary;
- file-based `tmux-play` config loading;
- one persistent Captain `Cligent`;
- one persistent role `Cligent` per configured role;
- the first `fanout` Captain mode;
- structured internal runtime records;
- a tmux presenter observer;
- shared app primitives that keep the existing `fanout` command working.

## Status

Proposed

## Scope

This iteration shall implement the tmux presenter and `FanoutCaptain` mode
from [DR-004](../decisions/004-tmux-play-captain-architecture.md).

This iteration shall keep `fanout` as a compatibility command and shall not
build a second unrelated tmux app. Reusable fanout code shall move under
`src/app/shared/`. New `tmux-play` code shall live under
`src/app/tmux-play/`.

This iteration shall not implement router Captain modes, non-tmux
presentations, public exports for the internal record API, cross-launch
history, interactive permission UI beyond adapter defaults, or
multi-Boss/shared sessions.

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
- [ ] Unit tests for config validation, role resolution, prompt building, record emission, Captain result collection, observer dispatch, and formatting.
- [ ] README docs for `tmux-play`, config, env vars, layout, and relationship to `fanout`.

## Tasks

1. **Extract shared fanout primitives** - move shell quoting, tmux invocation, log file handling, and event formatting into `src/app/shared/` without changing `fanout`; update tests.
2. **Generalize agent resolution to role resolution** - support `{ id, adapter, model, instruction }`, duplicate adapters across roles, role ID validation, and `CligentOptions.role`; test it.
3. **Add tmux-play config loader** - load `tmux-play.config.mjs`, `tmux-play.config.js`, or `tmux-play.config.json`, plus `--config <path>`; validate Captain/roles; fail fast on unknown adapters, missing roles, unsupported extensions, invalid role IDs, reserved role IDs, and invalid `summaryExcerptChars`.
4. **Define Captain runtime contracts** - add `Captain`, `BossTurn`, `CaptainContext`, `RoleRuntime`, `RoleRunResult`, `CaptainRunResult`, `RoleCallOptions`, and `CaptainCallOptions` with fake-runtime tests.
5. **Define internal record/observer boundary** - add structured record types, observer dispatch, and a tmux presenter that formats records to Boss stdout and role logs.
6. **Implement role runtime** - create one persistent `Cligent` per role, run cross-role calls concurrently for `FanoutCaptain`, reject repeated same-role calls in one turn, emit records, and write full role prompts before each role run.
7. **Implement FanoutCaptain prompt building** - render full role prompts deterministically from role instruction, turn ID, Boss prompt, and fanout guidance; add snapshot tests.
8. **Implement FanoutCaptain result collection** - run role calls concurrently, capture status/usage/final text excerpts, emit records, and keep raw role events out of the Boss pane.
9. **Implement Captain summary run** - build the summary prompt with enforced excerpt bounds, call Captain through `callCaptain()`, emit records, and stream Captain events to the Boss pane.
10. **Implement tmux-play launcher** - create work dir/logs; build Boss-left and roles-right layout; set pane titles.
11. **Implement tmux-play session CLI** - wire readline, Captain turn serialization, observer dispatch, abort/cleanup, and work-dir marker checks.
12. **Preserve fanout compatibility** - keep the `fanout` command working and passing existing app and acceptance tests after shared-code extraction.
13. **Document and verify manually** - add run examples, env vars, sample config, and manual tmux checks.

## Verification

- `npm run build` passes.
- `npm test` passes, including existing `src/app/*.test.ts`.
- `npm run test:acceptance` remains compatible with fanout acceptance tests when required credentials are present.
- `fanout --agent claude --agent codex` still launches the existing fanout tmux app with existing behavior.
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
