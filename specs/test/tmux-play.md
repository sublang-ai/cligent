<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# TTMUX: tmux-play Tests

## Intent

Verification criteria for the `tmux-play` CLI, configuration, Captain runtime, and built-in `fanout` Captain defined in [user/tmux-play.md](../user/tmux-play.md).

## Configuration and Discovery

### TTMUX-001
Verifies: [TMUX-010](../user/tmux-play.md#tmux-010), [TMUX-011](../user/tmux-play.md#tmux-011)

Given an empty home and cwd, when launching `tmux-play` without `--config`, the home YAML shall be created with the default `fanout` Captain plus `claude` and `codex` roles with identity instructions, a one-line notice naming the path shall be printed to stdout, and a second invocation shall not overwrite the file.

### TTMUX-002
Verifies: [TMUX-009](../user/tmux-play.md#tmux-009)

Given a `tmux-play.config.yaml` in cwd and a different YAML at the home location, when launching, the cwd config shall be loaded and the home file shall be left untouched.

### TTMUX-003
Verifies: [TMUX-009](../user/tmux-play.md#tmux-009)

Given `XDG_CONFIG_HOME` set to a non-empty path, when launching, the home location shall be `${XDG_CONFIG_HOME}/tmux-play/config.yaml`. Given `XDG_CONFIG_HOME` empty or unset, the home location shall be `~/.config/tmux-play/config.yaml`.

### TTMUX-004
Verifies: [TMUX-012](../user/tmux-play.md#tmux-012)

Given a `tmux-play.config.{mjs,js,json}` in cwd and no cwd YAML, when launching, a one-line stderr warning shall name the legacy file before normal execution proceeds.

### TTMUX-005
Verifies: [TMUX-005](../user/tmux-play.md#tmux-005), [TMUX-006](../user/tmux-play.md#tmux-006), [TMUX-007](../user/tmux-play.md#tmux-007), [TMUX-008](../user/tmux-play.md#tmux-008)

Given malformed YAML or a config that violates the schema (unknown adapter, unknown field, invalid role id, duplicate role id, role id `captain`, empty roles), when launching, the launcher shall fail with an error naming the offending file or path.

### TTMUX-006
Verifies: [TMUX-013](../user/tmux-play.md#tmux-013)

Given a cwd config whose `captain.from` is a relative local path, when session mode imports the Captain, resolution shall be anchored at the original config file's directory; package specifiers shall reach Node's resolver unchanged.

## Runtime Causality and Dispatch

### TTMUX-007
Verifies: [TMUX-022](../user/tmux-play.md#tmux-022)

Given a Captain that calls one role then `callCaptain`, when handling a Boss turn, observers shall receive records in this order: `turn_started`, `role_prompt`, `role_event`*, `role_finished`, `captain_prompt`, `captain_event`*, `captain_finished`, `turn_finished`. All shall carry the same `turnId`.

### TTMUX-008
Verifies: [TMUX-023](../user/tmux-play.md#tmux-023), [TMUX-024](../user/tmux-play.md#tmux-024)

Given two registered observers, when a record is emitted, both shall receive the record in registration order before the dispatcher releases the next record.

### TTMUX-009
Verifies: [TMUX-017](../user/tmux-play.md#tmux-017), [TMUX-021](../user/tmux-play.md#tmux-021)

When a Captain emits `emitStatus` from `init`, the resulting `captain_status` record shall arrive at every observer with `turnId: null` before any `turn_started`.

### TTMUX-010
Verifies: [TMUX-024](../user/tmux-play.md#tmux-024), [TMUX-026](../user/tmux-play.md#tmux-026)

When the abort signal fires during a turn, the runtime shall emit `turn_aborted` (not `turn_finished`); turn-bound emissions enqueued before the abort shall drain first.

### TTMUX-011
Verifies: [TMUX-025](../user/tmux-play.md#tmux-025)

When a registered observer rejects, the runtime shall emit `runtime_error` to remaining observers, abort the active turn if any, and complete normal cleanup. The runtime call may reject; whether it does is unconstrained by this item.

### TTMUX-012
Verifies: [TMUX-019](../user/tmux-play.md#tmux-019)

On session shutdown, `Captain.dispose()` shall run exactly once, after the active turn unwinds and after accepted session emissions drain. Post-shutdown `emitStatus`/`emitTelemetry` calls shall reject.

## CLI and Topology

### TTMUX-013
Verifies: [TMUX-001](../user/tmux-play.md#tmux-001)

Given the built bin on PATH (or invoked directly with execute permission), when launched on a POSIX runner, `tmux-play --help` shall exit 0 and print a usage banner.

### TTMUX-014
Verifies: [TMUX-027](../user/tmux-play.md#tmux-027), [TMUX-028](../user/tmux-play.md#tmux-028)

Given N configured roles, when the launcher constructs the tmux session, the layout shall be Boss/Captain on the left and N role panes on the right in config order; with N ≥ 2, the Boss/Captain pane shall occupy 4/16 of the window width, the right side shall use two 6/16 role columns, and the first role column shall hold `ceil(N / 2)` roles top-to-bottom.

### TTMUX-015
Verifies: [TMUX-003](../user/tmux-play.md#tmux-003), [TMUX-034](../user/tmux-play.md#tmux-034)

Given a snapshot file at the work directory, when session mode runs, the Captain shall be imported once from `captain.from` (a `file://` URL for local paths or a package specifier) and Boss turns shall flow through the runtime per [TTMUX-007](#ttmux-007).

## Built-in Fanout Captain (Acceptance)

### TTMUX-016
Verifies: [TMUX-030](../user/tmux-play.md#tmux-030)

Given the built-in fanout Captain and the four supported adapters as roles with valid credentials, when handling a Boss turn that requires a sentinel token in every reply, every `role_finished` shall report `status: 'ok'` with the sentinel in `finalText`, and the `captain_finished` summary shall reference each role's status and contain the sentinel. `runtime_error` and `turn_aborted` shall not appear.

### TTMUX-017
Verifies: [TMUX-030](../user/tmux-play.md#tmux-030)

Given the fanout Captain and N configured roles, when handling a Boss turn, all N `role_prompt` records shall be emitted before any `role_finished` record (concurrent dispatch), and the `captain_prompt` record shall be emitted only after every `role_finished`.

## Runtime Error Sources

### TTMUX-018
Verifies: [TMUX-025](../user/tmux-play.md#tmux-025)

When `Captain.init(session)` rejects before any turn starts, the runtime shall emit `runtime_error` with `turnId: null` to every registered observer, run shutdown, and shall not deliver any `turn_started` record.

### TTMUX-019
Verifies: [TMUX-025](../user/tmux-play.md#tmux-025)

When `handleBossTurn` rejects mid-turn, the runtime shall emit `runtime_error` carrying the active `turnId`, then `turn_aborted`, and shall complete shutdown.

### TTMUX-020
Verifies: [TMUX-034](../user/tmux-play.md#tmux-034)

Given a cwd YAML config whose `captain.from` is a relative local path and a separate config whose `captain.from` is a package specifier, when the launcher prepares each session, the work directory shall contain a JSON snapshot in which the local path is rewritten to an absolute `file://` URL and the package specifier is preserved verbatim. Mutations to the YAML after launch shall not affect the running session.

## Window Geometry and Topology

### TTMUX-021
Verifies: [TMUX-035](../user/tmux-play.md#tmux-035)

When the launcher creates the tmux session, the `new-session` invocation shall request a 240-column by 67-row grid (16:9 sized for 1920×1080).

### TTMUX-022
Verifies: [TMUX-028](../user/tmux-play.md#tmux-028)

Given two or more roles, when the launcher constructs the tmux session against a 240-column-wide grid, the Boss/Captain pane shall occupy 60 columns (4/16) and each of the two role columns shall occupy 90 columns (6/16), within tmux's nearest-cell rounding.

## Pane Titles

### TTMUX-023
Verifies: [TMUX-036](../user/tmux-play.md#tmux-036)

Given roles with ids `coder` and `reviewer`, when the launcher sets pane titles, the Boss/Captain pane title shall be `Captain` and the role pane titles shall be `Coder` and `Reviewer` respectively. No pane title shall contain the substring `Role:`.

## Theme

### TTMUX-038
Verifies: [TMUX-047](../user/tmux-play.md#tmux-047)

Given the launcher building a tmux session, the `tmux set` calls issued shall include the twelve Catppuccin Mocha theme entries exactly per [TMUX-047](../user/tmux-play.md#tmux-047) — anchored by `default-terminal=tmux-256color`, `terminal-overrides` appended with `,*:RGB`, `status-style=fg=#cdd6f4,bg=#181825`, `pane-active-border-style=fg=#89b4fa`, and `pane-border-style=fg=#6c7086` — and every theme `set` shall appear before the launcher's own `pane-border-format` and `status-right` `set` calls so the launcher's content strings remain authoritative on options the theme does not claim.

### TTMUX-039
Verifies: [TMUX-047](../user/tmux-play.md#tmux-047)

Given a launched session, an attached real-tmux client's `#{client_termfeatures}` shall include `RGB` in its comma-separated feature list, confirming that the `terminal-overrides` append from TTMUX-038 negotiated through to the client. The probe shall run against an actual tmux server (no mocks) and shall self-skip when either `tmux -V` or `glow -v` fails, since the launcher gates on both per [TMUX-051](../user/tmux-play.md#tmux-051).

### TTMUX-040
Verifies: [TMUX-048](../user/tmux-play.md#tmux-048)

Given a config with captain adapter `claude` and roles `coder` (adapter `codex`) and `reviewer` (adapter `gemini`), when the launcher sets pane titles, the captain pane title shall be `Captain · claude` and the role pane titles shall be `Coder · codex` and `Reviewer · gemini` respectively. The separator shall be ` · ` (space, middle dot, space). The per-adapter accent lookup shall return `#a6e3a1` for `claude`, `#94e2d5` for `codex`, `#b4befe` for `gemini`, `#f5c2e7` for `opencode`, and for any other adapter name shall return a value drawn from the documented fallback pool, identical on repeated calls with the same input.

## Presenter Output

### TTMUX-024
Verifies: [TMUX-037](../user/tmux-play.md#tmux-037)

Given session mode is running, when the user enters a Boss prompt, the captured Boss/Captain pane content shall contain the prompt text exactly once.

### TTMUX-025
Verifies: [TMUX-038](../user/tmux-play.md#tmux-038)

Given session mode handling a Boss turn, the captured Boss/Captain pane shall contain a line beginning with `boss> ` for the Boss input and a nonblank line beginning with `captain> ` for the Captain's reply; the captured role pane shall contain a nonblank line beginning with `captain> ` for the Captain's prompt and a nonblank line beginning with `<roleId>> ` for the role's reply. Multi-line presenter output blocks shall render continuation lines with a two-space hanging indent and no repeated speaker prefix; leading blank lines shall remain blank and shall not consume the first speaker prefix. The strings `[from captain]` and `[captain llm prompt]` shall not appear in any pane.

### TTMUX-026
Verifies: [TMUX-039](../user/tmux-play.md#tmux-039)

Given a role and Captain that finish with `status: 'ok'`, the captured pane content shall not contain `[role <id> ok]` or `[captain ok]`. Given a role that finishes with `status: 'error'`, the role pane shall contain a single `<roleId>> [error: <message>]` line where `<message>` matches `result.error`; given a Captain run that finishes with `status: 'error'`, the Boss/Captain pane shall contain a single `captain> [error: <message>]` line where `<message>` matches `result.error`. Given a role that finishes with `status: 'aborted'`, the role pane shall contain a single `<roleId>> [aborted]` line; given a Captain run that finishes with `status: 'aborted'`, the Boss/Captain pane shall contain a single `captain> [aborted]` line.

### TTMUX-041
Verifies: [TMUX-038](../user/tmux-play.md#tmux-038)

Given the presenter receives a `captain` block, the writer shall capture bytes `\x1b[1;38;2;203;166;247mcaptain> \x1b[0m` immediately before the body's first nonblank line. Given a `coder` role whose adapter is `claude`, the same writer shall capture `\x1b[1;38;2;166;227;161mcoder> \x1b[0m` before the body. Given an unmapped role (no `roleAdapters` entry), the prefix shall fall back to the uncolored `<roleId>> ` form. Continuation indents in wrapped or multi-line blocks shall NOT carry any SGR escape.

### TTMUX-042
Verifies: [TMUX-039](../user/tmux-play.md#tmux-039)

Given a role error finished record on `coder` (adapter `claude`), the role pane shall capture `\x1b[1;38;2;166;227;161mcoder> \x1b[0m\x1b[1;38;2;243;139;168m[error: <message>]\x1b[0m\n`. Given a role aborted record on the same role, the pane shall capture the captain or role prefix span followed by `\x1b[1;38;2;249;226;175m[aborted]\x1b[0m\n`. Given a `turn_aborted` record on the Boss/Captain pane, the captured bytes shall include the captain mauve prefix span followed by `\x1b[1;38;2;249;226;175m[turn aborted: <reason>]\x1b[0m\n`. Given a `runtime_error` record on the Boss/Captain pane, the captured bytes shall include the captain mauve prefix span followed by `\x1b[1;38;2;243;139;168m[runtime error: <message>]\x1b[0m\n`.

### TTMUX-027
Verifies: [TMUX-040](../user/tmux-play.md#tmux-040)

Given the fanout Captain handling a Boss turn, the captured Boss/Captain pane shall not contain any line beginning with `=== role:<id>` and shall not contain a `=== /role:<id> ===` line — i.e., the open/close sentinel framing of the Captain's prompt body shall not leak through. Synthesized references to role content within the Captain's reply shall be permitted.

### TTMUX-043
Verifies: [TMUX-049](../user/tmux-play.md#tmux-049)

Given a role `tool_use` event with `toolName: 'Bash'` and `input: { command: 'npm test' }` on a role pane writer whose adapter is `claude`, the captured bytes shall be `\x1b[1;38;2;166;227;161mtool> \x1b[0mBash npm test\n` — the `tool>` prefix carries the caller's adapter accent per [TMUX-038](../user/tmux-play.md#tmux-038) (`claude` → green `#a6e3a1`), not the retired peach `#fab387` anchor. When the caller has no adapter mapping, the prefix shall be uncolored `tool> `; when the caller is the captain (a `captain_event` carrying a `tool_use`), the prefix shall be `\x1b[1;38;2;203;166;247mtool> \x1b[0m` (captain mauve `#cba6f7`).

Given a `tool_result` event with `status: 'success'`, `toolName: 'Bash'`, and `durationMs: 1234`, the captured bytes shall begin with the colored header line `\x1b[1;38;2;166;227;161mtool< ✓ \x1b[0mBash 1.2s\n`. Status symbol shall be `✓` for `success`, `✗` for `error`, `·` for `denied`; the corresponding prefix SGR shall use green / red / yellow per the [TMUX-049](../user/tmux-play.md#tmux-049) table. The duration segment shall be `<n>ms` for `durationMs < 1000`, `<n.n>s` otherwise, and absent when `durationMs` is undefined.

Given a `tool_result` event whose extracted output is non-empty, the presenter shall strip exactly one trailing line terminator from the payload before wrapping it (so a payload ending `foo\n` does not surface a phantom blank line inside the fence), while any trailing blank lines beyond that terminator shall survive into the rendered output. The body following the header line shall be enclosed in a fenced code block whose fence is a run of backticks one longer than the longest backtick run in the payload, with a minimum of three; the fenced payload shall be passed to `renderMarkdown` per [TMUX-050](../user/tmux-play.md#tmux-050) at the width specified in [TMUX-049](../user/tmux-play.md#tmux-049), and every nonblank line of the rendered output shall be prefixed with two spaces before reaching the writer. Blank lines in the rendered output (the fenced-code frame, payload edge blanks) shall remain blank with no indent so the body's structure reads as it would in a `glow` pane outside this presenter. The retired `overlay0` `#6c7086` SGR pair shall not wrap any byte of the body — `glow`'s code-block rendering supersedes it per the [TMUX-049](../user/tmux-play.md#tmux-049) amendment.

Given a `tool_result` payload that itself contains a ```` ``` ```` line, the selected wrapper fence shall be at least four backticks long so the embedded fence remains inert as literal content of the outer fence and no part of the payload escapes into Markdown rendering at the writer.

Given a `tool_result` event whose extracted output is empty or undefined, the header line shall stand alone with no body.

### TTMUX-044
Verifies: [TMUX-049](../user/tmux-play.md#tmux-049)

Given a `tool_use` event whose `input` lacks the priority keys but contains `{ count: 3, flag: true }`, the input summary shall be the compact JSON `{"count":3,"flag":true}`. Given an `input` whose first priority-key string exceeds 60 cells, the summary shall be the value's first 59 cells followed by `…`. Given an empty `input` object, the rendered header shall be `tool> <toolName>` with no trailing space. Given an `input` whose only matching priority-key string is `query` (e.g., `{ query: 'select:WebFetch', max_results: 1 }`), the input summary shall be the `query` value — `query` sits in the priority list between `pattern` and `prompt` so search/fetch tools surface their query text rather than falling through to compact JSON.

### TTMUX-045
Verifies: [TMUX-040](../user/tmux-play.md#tmux-040), [TMUX-049](../user/tmux-play.md#tmux-049)

Given a `captain_event` carrying a `tool_use` record, the Boss/Captain pane writer (not any role writer) shall receive the `tool> ` header per [TMUX-049](../user/tmux-play.md#tmux-049). Given a role-id `coder` `role_event` carrying the same `tool_use`, only the `coder` role pane writer shall receive the header; the Boss/Captain pane writer shall not.

## Role Session Continuity

### TTMUX-028
Verifies: [TMUX-041](../user/tmux-play.md#tmux-041)

Given a tmux-play session and a role whose adapter supports `resumeToken`, when the runtime handles two Boss turns in sequence, the role's `Cligent` instance on the second turn shall be the same instance as on the first turn, and the second `run()` call shall pass `resume: <resumeToken>` to the adapter where the token came from the prior `done` event.

### TTMUX-029
Verifies: [TMUX-042](../user/tmux-play.md#tmux-042)

Given the fanout Captain handling a Boss turn, the prompt string passed to `callRole` shall equal the Boss prompt verbatim — no static framing label (`The Boss asked`), no role identity preamble (`You are the`), no role-id repetition, and no inter-role trailing instructions (`Respond independently`, `other roles`). The role's `instruction`, configured at `Cligent` construction, shall be the sole source of role identity.

## Real-tmux Acceptance

Items in this section verify behavior end-to-end against a real `tmux` server (not a mock or argv log). They live under `*.acceptance.test.ts`, run via `npm run test:acceptance`, and shall self-skip when either `tmux -V` or `glow -v` fails — the launcher gates on both per [TMUX-051](../user/tmux-play.md#tmux-051), so a missing binary surfaces as a clean skip rather than a launcher throw. They shall not gate on adapter API keys.

### TTMUX-030
Verifies: [TMUX-035](../user/tmux-play.md#tmux-035)

Given a real tmux server, when `launchTmuxPlay({ attach: false })` returns, `tmux display-message -t <session> -p '#{window_width}x#{window_height}'` shall report `240x67`.

### TTMUX-031
Verifies: [TMUX-027](../user/tmux-play.md#tmux-027), [TMUX-028](../user/tmux-play.md#tmux-028)

Given a real tmux server with two configured roles, when `launchTmuxPlay({ attach: false })` returns, `tmux list-panes` shall report exactly three panes: a Boss/Captain pane at `pane_left=0` with effective width 60 columns (less tmux's 1-cell border), a first role column at `pane_left=60` with effective width 90 columns, and a second role column at `pane_left=150` with effective width 90 columns. Pane order in `list-panes` index space shall match config order.

### TTMUX-032
Verifies: [TMUX-036](../user/tmux-play.md#tmux-036)

Given a real tmux server with role ids `coder` and `reviewer`, when `launchTmuxPlay({ attach: false })` returns, `tmux display-message -p '#{pane_title}'` against each pane shall return `Captain` for the Boss/Captain pane, `Coder` for the first role pane, and `Reviewer` for the second role pane.

### TTMUX-033
Verifies: [TMUX-027](../user/tmux-play.md#tmux-027)

Given a real tmux server, when `launchTmuxPlay({ attach: false })` returns, every role pane shall report `#{pane_input_off}=1` (input disabled) and the Boss/Captain pane shall report `#{pane_input_off}=0`. After `tmux send-keys -t <role-pane> '<probe>'` is invoked with a unique probe string, `tmux capture-pane -p` against that role pane shall not contain the probe.

### TTMUX-034
Verifies: [TMUX-043](../user/tmux-play.md#tmux-043)

Given a launcher invocation with `attach: true` and stdout routed to an in-memory writer, when `launchTmuxPlay` completes, the writer's content shall contain the byte sequence `\x1b[8;67;240t`, and that sequence shall have been written before the test's `attachTmuxSession` mock is invoked.

### TTMUX-035
Verifies: [TMUX-044](../user/tmux-play.md#tmux-044)

Given a real tmux server with two configured roles, when `launchTmuxPlay({ attach: false })` returns and the test forces the window to size `W × H` via `tmux resize-window` (with `window-size manual`), `tmux list-panes` shall report the Boss/Captain pane region width equal to `floor(W × 4/16)` and the first role column region width equal to `floor(W × 6/16)`, where region width = `pane_width + 1` for each pane with a right-side border separator. The reviewer pane's region width shall equal the remainder. The invariant shall hold at multiple sample sizes (e.g., `80×24`, `160×40`, `200×50`).

### TTMUX-036
Verifies: [TMUX-045](../user/tmux-play.md#tmux-045)

Given a real tmux server with configured roles, when `launchTmuxPlay({ attach: false })` returns, `tmux list-panes` shall report `#{pane_active}=1` for the Boss/Captain pane and `#{pane_active}=0` for every role pane.

### TTMUX-037
Verifies: [TMUX-046](../user/tmux-play.md#tmux-046)

_Superseded for text-body wrapping by [TTMUX-046](#ttmux-046), [TTMUX-047](#ttmux-047), and [TTMUX-048](#ttmux-048), matching the same supersession of [TMUX-046](../user/tmux-play.md#tmux-046) by [TMUX-050](../user/tmux-play.md#tmux-050). The character-level soft-wrap and SGR close/reopen invariants asserted below are no longer implemented by the presenter; this item is retained for spec history alongside the cell-measurement table it verifies in the [TMUX-049](../user/tmux-play.md#tmux-049) tool-input truncation path._

Given a `TmuxPresenter` whose Boss writer has display width `W_b` and whose role writer has display width `W_r`, when the presenter writes a single-logical-line role event of length greater than `W_r`, the role writer's captured text shall contain `\n  ` (newline + two spaces) at the boundary that keeps every emitted row no wider than `W_r` cells, with the first row prefixed by `<roleId>> ` and every subsequent row prefixed by exactly two spaces. The same invariant shall hold for the Boss writer at width `W_b` for a Captain reply, including across `text_delta` events split before, at, and after the wrap boundary. When a writer's width source returns `Infinity`, the writer's output shall be identical to the pre-TMUX-046 behavior (no soft-wrap), and explicit `\n` continuations shall continue to be indented per [TMUX-038](../user/tmux-play.md#tmux-038).

Cell-width and escape handling: when the source text contains East Asian Wide / Fullwidth codepoints, the presenter shall treat each such codepoint as 2 cells when computing the wrap boundary (e.g., at `W_r = 12` the captured text for `<roleId>> ` plus seven Wide characters shall wrap after the second Wide character so the first row is 11 cells and the continuation row is 12 cells). Supplementary-plane emoji whose Unicode `Emoji_Presentation` property is `Yes` shall likewise count as 2 cells, including codepoints outside the hand-curated emoji ranges in the implementation (e.g., U+1F7E7 🟧 in Geometric Shapes Extended and U+1FAE0 🫠 in Symbols and Pictographs Extended-A); the same rule shall apply to BMP emoji such as U+231A ⌚, U+2615 ☕, and U+23F0 ⏰. Each block enumerated in [TMUX-046](../user/tmux-play.md#tmux-046)'s curated EAW=Wide/Fullwidth list shall also resolve to 2 cells, including at least: U+A960 (Hangul Jamo Extended-A), U+4DC0 (Yijing Hexagram Symbols), U+17000 (Tangut), U+18800 (Tangut Components), U+18B00 and U+18CFF (Khitan Small Script, including reserved tail), U+1AFF0 (Kana Extended-B), U+1B000 (Kana Supplement), U+1B100 (Kana Extended-A), U+1B150 (Small Kana Extension), U+1B170 (Nüshu), U+1D300 (Tai Xuan Jing Symbols), and U+1D360 (Counting Rod Numerals). Codepoints that Unicode reports as Neutral, and EAW=Wide/Fullwidth codepoints in blocks not enumerated by TMUX-046 (e.g., archaic scripts not in the curated subset), shall count as 1 cell — including U+1FB70 in Symbols for Legacy Computing and U+1F800 in Supplemental Arrows-C, both Neutral per Unicode. Unicode combining marks and zero-width formatting codepoints shall not advance the wrap column. ANSI escape sequences (CSI, OSC, and `ESC` + next-byte) shall be passed through verbatim without contributing to the cell count and shall never have a `\n  ` inserted in their interior, including when the sequence's bytes arrive in two or more streaming chunks: given three role `text_delta` events whose payloads are `hello`, `\x1b[31`, and `m world` with `W_r = 12`, the role writer's captured text shall be `<roleId>> hello\x1b[31m\n   world` — i.e., the CSI is reassembled into a single `\x1b[31m` token before the soft-wrap fires, and the wrap lands between the escape and the following space rather than inside the escape's parameter bytes. Pending escape state shall not leak across block boundaries: given a role `text_delta` `hello\x1b[31` followed by a `role_finished` with `status: 'ok'` and then a fresh role `text` event `next`, the role writer's captured text shall be `<roleId>> hello\x1b[31\n<roleId>> next\n` — i.e., the partial CSI is flushed verbatim into the previous block before its closing newline, and the next block's leading `n` is not consumed as the missing CSI terminator. Additionally, given a `TmuxPlaySession` whose stdout emits `'resize'`, the session's role pane width query (`queryPaneWidths`) shall be invoked again so subsequent writes use the post-resize width; after the session has shut down, further `'resize'` emissions on stdout shall not invoke the query.

### TTMUX-046
Verifies: [TMUX-050](../user/tmux-play.md#tmux-050)

Given a `TmuxPresenter` receiving one or more `text_delta` events for the same `(writer, who)` pair, the writer shall capture zero bytes until a block boundary fires. The block boundaries that trigger a flush are: a `role_finished` or `captain_finished` record on the writer's pane; a non-streaming `text` event on the same writer; a `role_prompt` on the same writer; a `tool_use` or `tool_result` event on the same writer; and any status emission (`captain_status`, `runtime_error`, `turn_aborted`) targeting the same writer. On flush, the accumulated text shall be passed once to `renderMarkdown` per [TMUX-051](../user/tmux-play.md#tmux-051), and the rendered output shall be emitted under the [TMUX-038](../user/tmux-play.md#tmux-038) prefix grammar. A subsequent `text_delta` arriving after the flush shall open a fresh block whose render call is independent of the prior one.

Given a streaming sequence interleaved with a tool event — e.g., `text_delta('partial\n')` followed by `tool_use(...)` on the same writer — the text shall flush before the `tool> ` header so the events appear in order on the pane.

### TTMUX-047
Verifies: [TMUX-050](../user/tmux-play.md#tmux-050), [TMUX-038](../user/tmux-play.md#tmux-038)

Given the rendered output of a text block, the captured bytes shall apply the [TMUX-038](../user/tmux-play.md#tmux-038) grammar to the rendered lines: the first nonblank line shall carry the colored `<who>> ` SGR prefix; every nonblank continuation line shall carry the two-space hanging indent; blank lines in the rendered output shall remain blank without the indent. The indent shall be uncolored — no SGR sequence shall span the two-space prefix bytes.

Given leading or trailing blank lines in the rendered output (introduced by `glow`'s default paragraph-margin styling), the captured bytes shall drop at most one blank line from each edge — `glow`'s outer margin — and shall preserve every other blank line verbatim, including any blank rows inside a fenced-code frame, around table rows, or between paragraphs. A blanket multi-line trim is not applied because `glow`'s fenced-code rendering emits structural blank rows that match the same shape as its outer margin and would otherwise be collapsed away (e.g., a payload that itself starts with a blank line would lose that line). Given a rendered block whose content is entirely whitespace after the outer-margin trim, the writer shall receive zero bytes — no synthesized `<who>> ` prefix and no stranded blanks — so empty content cannot surface as a bare prefix line or as padding between turns.

Given a `text_delta` sequence that ends without a trailing newline followed by a `role_prompt` or other boundary event on the same writer, the open block shall flush before the new block opens; the writer shall not interleave the two speakers' content on a single line.

### TTMUX-048
Verifies: [TMUX-050](../user/tmux-play.md#tmux-050)

Given a writer with a configured pane width source returning `W`, `renderMarkdown` shall be invoked for a text block with `width = max(1, W - prefixWidth)`, where `prefixWidth` is the cell width of the speaker's `<who>> ` first-line prefix (`6` for `boss`, `9` for `captain`, `roleId.length + 2` for a role pane). Given a writer with no configured pane width source, the default render width shall be `max(1, 80 - prefixWidth)`. Given a `tool_result` body, the render width shall be `max(1, W - 2)`, matching the two-space continuation indent the body lines carry (not the wider tool header prefix).

### TTMUX-049
Verifies: [TMUX-051](../user/tmux-play.md#tmux-051)

Given `tmux-play` invoked in launcher mode on a host where `isGlowAvailable()` returns `false`, `launchTmuxPlay` shall reject with an error whose message names `glow` and contains the install URL `https://github.com/charmbracelet/glow#installation`. The launcher shall not invoke any subsequent launcher work — no config discovery, no work-directory creation, no `tmux` session construction — so the rejection surfaces before any side effects. The `glow` check shall run after the existing `tmux` availability check so a host missing both binaries reports `tmux` first.

## Real-glow Acceptance

Items in this section verify behavior end-to-end against a real `glow` binary (not a mock). They live under `src/app/shared/glow.acceptance.test.ts` (glow-in-isolation checks) and `src/app/tmux-play/presenter-tmux.acceptance.test.ts` (presenter + glow integration), run via `npm run test:acceptance`, and shall self-skip only when `glow -v` fails. They shall not gate on `tmux` or adapter API keys.

### TTMUX-050
Verifies: [TMUX-050](../user/tmux-play.md#tmux-050), [TMUX-051](../user/tmux-play.md#tmux-051)

Given a real `glow` binary on `PATH`, `renderMarkdown('hello **world** today\n', 80)` shall return non-empty output that contains at least one ANSI escape sequence (`\x1B[…`), does not contain the literal `**` marker, and contains the visible word `world` after ANSI bytes are stripped. This confirms `glow` rendered bold styling instead of emitting raw Markdown.

Given a fenced code block whose content is a single 200-character line rendered at width 40, the captured output shall contain the 200-character content intact after ANSI bytes are stripped — `glow` shall not insert a mid-token break inside the fenced block, matching [TMUX-049](../user/tmux-play.md#tmux-049)'s "glow leaves long code lines unwrapped by design".

Given a plain paragraph rendered at width 80, the captured output shall be non-empty and shall contain each source word after ANSI bytes are stripped, guarding against silent `glow` misconfiguration (for example, a `glow` build that writes nothing under `spawnSync` because it gated its output on a TTY check).

### TTMUX-051
Verifies: [TMUX-038](../user/tmux-play.md#tmux-038), [TMUX-049](../user/tmux-play.md#tmux-049), [TMUX-050](../user/tmux-play.md#tmux-050)

Given a real `glow` binary on `PATH` and a `TmuxPresenter` wired to in-memory writers, the integration of the presenter with `glow` shall hold the spec-promised structural invariants — not just `glow`'s isolated rendering — across these scenarios. These probes cover bugs that live at the seam where the presenter consumes real `glow` output, which neither glow-in-isolation acceptance ([TTMUX-050](#ttmux-050)) nor identity-mock unit tests can catch.

Given a text-body block containing a heading and a bold span, the captured writer output shall carry exactly one `<who>> ` prefix line for the block; every nonblank line shall begin with either that prefix or the two-space hanging indent; ANSI styling shall be present and the literal `**` marker shall be absent. This pins the [TMUX-038](../user/tmux-play.md#tmux-038) prefix grammar and the [TMUX-050](../user/tmux-play.md#tmux-050) post-indent rule against real `glow` output rather than against a trivially-shaped mock.

Given a `tool_result` event whose payload ends with an intentional blank row (e.g., `output: 'foo\n\n'`), the visible writer output (ANSI stripped) shall match `/foo\s*\n\s*\n/` — the blank survives the strip-one-terminator rule, the fence wrap, real `glow`'s fenced-code rendering, the outer-margin trim, and the two-space indent, in that order. This pins the [TMUX-049](../user/tmux-play.md#tmux-049) trailing-payload-blank-preservation rule end-to-end.

Given two consecutive short text blocks emitted back-to-back on the same writer, the captured writer output shall contain no run of three or more consecutive newlines: `glow`'s per-block paragraph margins shall not stack into a parade of blank lines between turns. This directly pins the user-reported "excessive blank lines between player messages" defect that motivated the [TMUX-050](../user/tmux-play.md#tmux-050) outer-margin trim.
