<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# TMUX: tmux-play CLI and Captain Runtime

## Intent

The `tmux-play` CLI, its YAML configuration, Captain extension contract, record set, observer dispatch, tmux topology, programmatic runtime API, and the built-in `fanout` Captain per [DR-004](../decisions/004-tmux-play-captain-architecture.md).

## CLI Invocation

### TMUX-001

The `@sublang/cligent` package shall expose a `tmux-play` bin entry.

### TMUX-002

When `tmux-play` is invoked without `--session`, the CLI shall run launcher mode: resolve the config, construct the tmux session, attach, and exit.

### TMUX-003

When `tmux-play` is invoked with `--session <id> --work-dir <path>`, the CLI shall run session mode: instantiate the Captain and roles, run a Boss readline against stdin/stdout, dispatch records to observers, and clean up on exit.

### TMUX-004

When `--config <path>` is supplied, the launcher shall load that file and skip discovery and first-run auto-create.

## Configuration

### TMUX-005

A `tmux-play` config shall be YAML with a `captain` object and a non-empty `roles` array.

### TMUX-006

The `captain` object shall require `from` (local path or package specifier), `adapter` (one of `claude`, `codex`, `gemini`, `opencode`), and may include `model`, `instruction`, and an opaque `options` value forwarded verbatim to the Captain factory.

### TMUX-007

Each entry in `roles` shall require `id` and `adapter` (one of `claude`, `codex`, `gemini`, `opencode`), and may include `model` and `instruction`. Role `id` shall match `^[a-z][a-z0-9_-]*$`, be unique within the config, and shall not equal `captain`. Multiple roles may share an adapter and model.

### TMUX-008

When loading a config, the loader shall reject malformed YAML and unknown fields with an error that names the offending file or path.

## Discovery and First-Run

### TMUX-009

When `--config` is not supplied, the launcher shall search for `tmux-play.config.yaml` in the current directory first, then `${XDG_CONFIG_HOME:-~/.config}/tmux-play/config.yaml`. The first match shall be used. `XDG_CONFIG_HOME` shall be treated as unset when empty.

### TMUX-010

When neither location holds a config and `--config` is not supplied, the launcher shall create the home location with a default config, print a one-line notice naming the path on stdout, and continue. Subsequent invocations shall preserve the existing home config without overwriting.

### TMUX-011

The default home config shall wire the built-in `fanout` Captain on the `claude` adapter and two roles whose IDs match their adapters: `claude` (claude adapter) and `codex` (codex adapter). Each default role shall include an `instruction` that identifies that role for the runtime-created `Cligent` instance.

### TMUX-012

When the cwd contains a legacy `tmux-play.config.mjs`, `tmux-play.config.js`, or `tmux-play.config.json` and no cwd YAML, the launcher shall print a one-line stderr warning naming the legacy file before continuing.

### TMUX-013

Local `captain.from` paths shall resolve against the directory of the originating config file. Package specifiers shall pass through to Node's module resolver.

## Captain Extension Contract

### TMUX-014

A Captain module shall default-export a factory `(options: unknown) => Captain | Promise<Captain>`. The returned `Captain` shall implement `handleBossTurn(turn, context): Promise<void>` and may implement `init(session): Promise<void>` and `dispose(): Promise<void>` lifecycle hooks.

### TMUX-015

The runtime shall own every role and Captain `Cligent` instance. Captains shall reach roles only through the `context` passed to `handleBossTurn` and shall not construct adapters or `Cligent` directly.

### TMUX-016

`CaptainContext` shall expose a turn-scoped `signal: AbortSignal`, a readonly `roles` manifest, and `callRole(roleId, prompt)` and `callCaptain(prompt)` methods. The methods shall return `RoleRunResult` and `CaptainRunResult` respectively per [TMUX-033](#tmux-033).

### TMUX-017

`CaptainSession` shall expose a session-scoped `signal: AbortSignal`, a readonly `roles` manifest, and `emitStatus(message, data?)` and `emitTelemetry({ topic, payload })` methods. Captains may retain the session reference from `init` and emit at any point during the session — within `init`, during turns, or between turns.

### TMUX-018

The runtime shall serialize Boss turns: at most one `handleBossTurn` invocation may be in flight per session.

### TMUX-019

On session shutdown the runtime shall (1) unwind the active turn, (2) abort `CaptainSession.signal`, (3) drain accepted session emissions, (4) call `Captain.dispose()` exactly once, and (5) detach observers. Post-shutdown `emitStatus`/`emitTelemetry` calls shall reject.

## Record Types and Observer Dispatch

### TMUX-020

The runtime shall emit records of these types: `turn_started`, `turn_finished`, `turn_aborted`, `role_prompt`, `role_event`, `role_finished`, `captain_prompt`, `captain_event`, `captain_finished`, `captain_status`, `captain_telemetry`, `runtime_error`. Each record shall carry a stable role ID where applicable.

### TMUX-021

Turn-bound records shall carry `turnId: number`. `captain_status` and `captain_telemetry` emitted outside an active turn shall carry `turnId: null`.

### TMUX-022

Within a turn the runtime shall emit `turn_started` first; for each role `role_prompt` → `role_event*` → `role_finished`; for each `callCaptain()` `captain_prompt` → `captain_event*` → `captain_finished`; and `turn_finished` (or `turn_aborted` on abort) last.

### TMUX-023

Observers shall be invoked in registration order. The dispatcher shall await each observer's returned Promise before dispatching the next record. Records shall not be dropped or coalesced.

### TMUX-024

Turn-bound emissions shall drain before `turn_finished`/`turn_aborted`. `turnId: null` emissions shall dispatch in emission order without a turn boundary. Multiple observers may register against one runtime; each shall receive every record.

### TMUX-025

The runtime shall emit a `runtime_error` record when a control-plane failure prevents normal record emission — startup, `Captain.init`, a `handleBossTurn` exception, or observer dispatch. The record shall carry `turnId: number` when an active turn exists at the moment of failure, else `turnId: null`. After emission, the runtime shall abort the active turn if any and run shutdown per [TMUX-019](#tmux-019). When the failure originates in an observer, the record shall additionally be delivered to the remaining observers in registration order before shutdown begins. Individual role or Captain run failures shall surface in the corresponding `role_finished` / `captain_finished` record with `status: 'error'`, not as `runtime_error`.

### TMUX-026

When SIGINT, SIGTERM, or stdin EOF reaches the session, the runtime shall abort the active turn, run shutdown per [TMUX-019](#tmux-019), kill the tmux session, and remove launcher-owned work directories.

## tmux Topology

### TMUX-027

The Boss/Captain pane shall occupy the left column. Role panes shall fill the right side in config order, read-only.

### TMUX-028

With two or more roles, `tmux-play` shall use two role columns. The Boss/Captain pane shall occupy 4/16 of the window width and each role column shall occupy 6/16 of the window width. The first column shall hold `ceil(roleCount / 2)` roles from top to bottom.

## Programmatic Runtime API

### TMUX-029

The `@sublang/cligent/tmux-play` sub-export shall expose a runtime factory accepting an instantiated `captain`, a `captainConfig` with `adapter` (one of `claude`, `codex`, `gemini`, `opencode`) and optional `model` and `instruction`, a non-empty `roles` array (each entry with `id`, `adapter`, optional `model`, optional `instruction`, conforming to [TMUX-007](#tmux-007)), zero or more `observers`, an optional `cwd`, and an optional session-scoped `signal`. The factory shall return a runtime that drives Boss turns without tmux. Record types and the observer-registration contract shall export from the same sub-export.

## Built-in Fanout Captain

### TMUX-030

The `@sublang/cligent/captains/fanout` Captain shall, per Boss turn, invoke `callRole` for every configured role concurrently, then issue a single `callCaptain` summary referencing each role's status and final text.

### TMUX-031

The fanout Captain shall not copy raw role events into the Boss/Captain pane; only the synthesized summary shall reach the Boss via `callCaptain`.

## Public Contract Shapes

### TMUX-032

A `BossTurn` argument shall expose the turn's numeric `id`, the Boss `prompt`, and a `timestamp`. A `RoleHandle` shall expose the role `id`, the `adapter`, and an optional `model`.

### TMUX-033

`RoleRunResult` shall expose `roleId`, `turnId`, and `status`, and may include `finalText` and `error`. `CaptainRunResult` shall expose `turnId` and `status`, and may include `finalText` and `error`. `status` values are `'ok' | 'aborted' | 'error'`; aborted results may carry neither `finalText` nor `error`.

## Launcher → Session Protocol

### TMUX-034

The launcher shall convert the resolved YAML config into a JSON snapshot written to the session's work directory, with local `captain.from` paths normalized to absolute `file://` URLs and package specifiers passed through unchanged. Session mode shall read the snapshot rather than reloading the YAML, so config changes made between launch and session start shall not affect the running session.

## Initial Window Geometry

### TMUX-035

When the launcher creates the tmux session, the session shall be created with a 16:9 cell grid sized for a 1920×1080 display, defaulting to 240 columns by 67 rows. When a client attaches with a different window size, tmux's normal size negotiation shall govern the displayed layout.

### TMUX-043

Before invoking `tmux attach-session`, the launcher shall write the xterm window-manipulation request `CSI 8 ; 67 ; 240 t` (`\x1b[8;67;240t`) to stdout, asking the user's terminal to resize its cell grid to 240×67 to match TMUX-035. Terminals that honor the sequence (xterm, Konsole, GNOME Terminal, iTerm2 with the "Allow programs to change/resize window" option enabled, others) shall adjust before the attach completes; terminals that ignore it (including macOS Terminal.app by default) shall be left unchanged, in which case TMUX-035's normal size negotiation governs.

### TMUX-044

The 4/6/6 region split required by [TMUX-028](#tmux-028) shall hold at every window size, not only at session creation. The launcher shall configure session-scoped tmux hooks (`client-resized` and `after-resize-window`) that re-apply pane widths via `resize-pane -x` so that, at any window width `W`, the Boss/Captain region is `W × 4/16` cells, the first role column region is `W × 6/16` cells, and the second role column region (if present) absorbs the remainder. Pane content widths are one less than their region for every pane that has a right-side tmux border separator; the rightmost pane's content width equals its region. With a single role, only the Boss/Captain pane is re-sized and the role pane absorbs the remainder.

### TMUX-045

After the launcher constructs the tmux session and before it attaches a client, the active pane shall be the Boss/Captain pane so startup cursor focus lands at the `boss> ` readline prompt.

## Pane Titles

### TMUX-036

The Boss/Captain pane title shall be `Captain`. Each role pane title shall be the role `id` rendered with the first character upper-cased and the remaining characters preserved (e.g., `coder` → `Coder`, `reviewer` → `Reviewer`). The literal `Role:` prefix shall not appear in pane titles.

## Presenter Output

### TMUX-037

While in session mode, the Boss readline shall echo the user's input line as the user types it (standard readline behavior). When the runtime emits `turn_started`, the presenter shall not write the Boss prompt to the Boss/Captain pane, so the user's input shall appear exactly once in the pane.

### TMUX-038

The presenter shall tag the first nonblank textual line of each tmux-play pane output block with a `<who>> ` prefix where `<who>` is `boss`, `captain`, or the speaker's role `id`. Continuation lines within the same block shall use a two-space hanging indent without repeating the speaker prefix. Blank lines shall remain blank and shall not count as continuation lines before the first nonblank line. The Boss readline prompt shall be `boss> `; the first nonblank line of the Captain's reply rendered in the Boss/Captain pane shall be prefixed with `captain> `; the first nonblank line of the Captain's prompt rendered in a role pane shall be prefixed with `captain> `; and the first nonblank line of the role's reply rendered in the role pane shall be prefixed with `<roleId>> `. Bracket-tag notation such as `[from captain]` or `[captain llm prompt]` shall not be used.

The presenter shall color the speaker prefix by wrapping its bytes — including the trailing space — in a bold 24-bit-foreground SGR pair: `\x1b[1;38;2;<r>;<g>;<b>m<who>> \x1b[0m`. Body text following the prefix shall remain unstyled by the presenter, so any ANSI bytes inside the body come from the body itself. Continuation indents shall stay uncolored. The speaker → color mapping is:

| Speaker | Mocha role | Hex |
| --- | --- | --- |
| `boss` | `blue` | `#89b4fa` |
| `captain` | `mauve` | `#cba6f7` |
| `<roleId>` | adapter-keyed via [TMUX-048](#tmux-048) `roleAccent(role.adapter)` | varies (e.g., `claude` → `#a6e3a1`) |

The Boss readline prompt set by session mode shall carry the same colored form (`\x1b[1;38;2;137;180;250mboss> \x1b[0m`); Node's readline strips ANSI from prompts when computing the visible width, so cursor positioning still treats the prompt as 6 cells wide.

### TMUX-039

When a role or Captain run finishes with `status: 'ok'`, the presenter shall not write a trailing status line such as `[role <id> ok]` or `[captain ok]`. When a run finishes with `status: 'error'`, the presenter shall write a single `<who>> [error: <message>]` line in the corresponding pane, where `<message>` is the result's `error` field. When a run finishes with `status: 'aborted'`, the presenter shall write a single `<who>> [aborted]` line; per [TMUX-033](#tmux-033) aborted results need not carry a reason, so no reason is rendered.

The bracketed status body on these lines shall additionally be wrapped in its own bold 24-bit-foreground SGR pair, distinct from the surrounding speaker prefix span:

| Status kind | Mocha role | Hex |
| --- | --- | --- |
| `[error: …]` (role or Captain) | `red` | `#f38ba8` |
| `[runtime error: …]` (Boss/Captain pane) | `red` | `#f38ba8` |
| `[aborted]` (role or Captain) | `yellow` | `#f9e2af` |
| `[turn aborted: …]` (Boss/Captain pane) | `yellow` | `#f9e2af` |

The result is a status line whose prefix carries the speaker color and whose body carries the status color, e.g., `<captain-mauve>captain> </reset><red>[runtime error: boom]</reset>`.

### TMUX-040

The Boss/Captain pane shall display the Boss's input lines, the Captain's synthesized reply or terminal Captain failure line per [TMUX-039](#tmux-039), operational records intended for that pane (`captain_status`, `runtime_error`, and `turn_aborted`), and Captain-emitted `tool_use` / `tool_result` events rendered per [TMUX-049](#tmux-049). Per-role outputs and the Captain's prompt body (which references role results) shall not be written to the Boss/Captain pane; role-emitted tool events remain in their respective role panes.

### TMUX-049

`tool_use` and `tool_result` events shall render with a dedicated `tool>` / `tool<` prefix grammar in the calling entity's pane (the role pane for role-emitted events; the Boss/Captain pane for Captain-emitted events per [TMUX-040](#tmux-040)), replacing the `<who>> ` speaker prefix for those events.

A `tool_use` event shall render as a single line `tool> <toolName> <inputSummary>` where the prefix bytes `tool> ` are wrapped in the bold 24-bit-foreground peach `#fab387` SGR pair and the body remains unstyled. `<inputSummary>` is the first non-empty string value found in `input` checked in priority order `command`, `file_path`, `path`, `pattern`, `prompt`, `description`, or a compact `JSON.stringify(input)` otherwise. Whitespace runs in the chosen string shall be collapsed to single spaces and the result truncated at 60 cells with a trailing `…` when longer. When no usable summary exists, the line shall be `tool> <toolName>` with no trailing space.

A `tool_result` event shall render as a header line followed by the tool's output as a continuation block. The header is `tool< <symbol> <toolName>[ <duration>]` where `<symbol>` and the prefix SGR derive from `status`:

| `status` | Symbol | Mocha role | Hex |
| --- | --- | --- | --- |
| `success` | `✓` | `green` | `#a6e3a1` |
| `error` | `✗` | `red` | `#f38ba8` |
| `denied` | `·` | `yellow` | `#f9e2af` |

`<duration>` is `<n>ms` when `durationMs < 1000`, `<n.n>s` otherwise; the duration segment is omitted when `durationMs` is undefined. The tool's output body (extracted as the string itself, or `output.stdout` when present, or the pretty-printed JSON of `output` otherwise) follows on continuation lines wrapped in the plain 24-bit-foreground `overlay0` `#6c7086` SGR pair (no bold), so large stdout reads as a dim aside rather than competing with agent prose. When the extracted output is empty or undefined, the header line stands alone with no body.

### TMUX-046

The two-space hanging indent required by [TMUX-038](#tmux-038) shall apply to every visible continuation line in a pane, whether the line break is an explicit `\n` in the source text or a soft wrap inserted by the presenter when content would otherwise exceed the pane's current display width. The presenter shall soft-wrap each prefixed block at the per-pane display width by emitting `\n` followed by the two-space indent in place of the character that would have overflowed, so terminal-level rewrap is unnecessary and every wrapped row visibly carries the indent.

Display width shall be measured in terminal cells, not code points. The following codepoints shall count as 2 cells:

- Codepoints in the curated subset of East Asian Wide and Fullwidth blocks that the implementation tracks: Hangul Jamo and Hangul Jamo Extended-A and Hangul Syllables; CJK Radicals / Kangxi / Ideographic Description Characters and CJK Symbols and Punctuation; Hiragana, Katakana, Bopomofo, CJK Strokes, Enclosed CJK Letters and Months, and CJK Compatibility blocks through U+33FF; CJK Unified Ideographs and CJK Compatibility Ideographs and CJK Unified Ideographs Extensions A–G+; Yi Syllables and Radicals; Yijing Hexagram Symbols; Vertical Forms and CJK Compatibility Forms and Small Form Variants; Fullwidth ASCII (U+FF00–U+FF60) and Fullwidth signs (U+FFE0–U+FFE6); Ideographic Symbols and Punctuation (U+16FE0–U+16FE4) and Ideographic vertical forms (U+16FF0–U+16FF1); Tangut Ideographs and Tangut Components and Khitan Small Script and Tangut Supplement; Kana Extended-B and Kana Supplement and Kana Extended-A and Small Kana Extension; Nüshu; Tai Xuan Jing Symbols and Counting Rod Numerals.
- Codepoints at `cp >= 0x2300` whose Unicode `Emoji_Presentation` property is `Yes`, including BMP emoji such as U+231A ⌚ and U+2615 ☕ and every supplementary emoji block — including blocks added in future Unicode releases — so this rule does not need a source update when Unicode adds new emoji.

The list above is a curated subset of Unicode East Asian Width = Wide/Fullwidth, not the full set. JavaScript regex does not expose the `East_Asian_Width` property, so any codepoint that is EAW=W or =F per Unicode but is neither in the enumerated blocks nor `Emoji_Presentation` — for example, archaic scripts or rare symbol blocks not yet enumerated here — shall be measured as 1 cell. Soft-wrap based on this measurement may therefore over-fill the pane for such codepoints; this is the documented limitation of the implementation's table.

Unicode combining marks (`\p{M}`) and zero-width formatting codepoints (ZWSP, ZWNJ, ZWJ, Word Joiner, BOM) count as 0 cells, and C0/C1 control bytes other than `\n` count as 0 cells. ANSI escape sequences (CSI `ESC [` … final byte `0x40`–`0x7E`; OSC `ESC ]` … terminated by BEL or ST; and the simple `ESC` + next-byte form) shall pass through with 0 cells and shall never be split across a soft-wrap boundary. The presenter shall keep its escape-parser state per writer across streaming writes (e.g., per `text_delta` event), so a CSI/OSC/`ESC` sequence whose bytes arrive in two or more chunks is reassembled into a single zero-width escape token before any subsequent visible byte is placed. At every block boundary on a writer — including the start of any non-streaming prefixed block, the start of a status line, and the close of a run regardless of `status` — the presenter shall drain its pending escape parser state, emitting any still-unterminated escape bytes verbatim to that block's writer before writing the boundary newline, so the next block parses from a clean state and cannot have its leading byte consumed as the missing terminator of an earlier escape.

The presenter shall track the last body-emitted SGR opener (a CSI sequence ending in `m` that is not a reset) per writer.
At every continuation boundary — soft-wrap, explicit newline, or any path that emits a continuation indent — the presenter shall close that SGR (emit `\x1b[0m`) before the `\n`, emit the uncolored continuation indent, and re-emit the same opener after the indent so the body's color resumes on the new row.
This is what makes the [TMUX-038](#tmux-038) "continuation indents shall stay uncolored" invariant hold for status bodies wrapped by [TMUX-039](#tmux-039) and for any other body that opens an SGR span and then crosses a line break.
Non-SGR CSI sequences (cursor movement, erase, etc., terminated by bytes other than `m`) do not change color/style and are not subject to this close/reopen rule.

Width sources: the Boss/Captain pane width shall track the captain's stdout `columns` property, which Node refreshes via SIGWINCH on terminal resize. Each role pane width shall be queried from tmux at session start; the session shall refresh role widths when its stdout emits `'resize'` (the in-pane SIGWINCH that follows the tmux resize hooks set per [TMUX-044](#tmux-044)) and again before each Boss turn as a safety net. When a width source is unavailable or the value would not leave room for the two-space indent, the writer shall fall back to no soft wrap.

## Theme

### TMUX-047

The launcher shall apply the **Catppuccin Mocha** palette per [[1]] to the session's appearance options before any content-bearing option in [TMUX-036](#tmux-036), [TMUX-038](#tmux-038)–[TMUX-040](#tmux-040), or [TMUX-044](#tmux-044) is set, so the launcher's own pane-border-format and status-right strings remain authoritative for any option a future theme might also claim.

The theme shall set exactly these tmux options and no others:

| Option | Value | Note |
| --- | --- | --- |
| `default-terminal` | `tmux-256color` | Truecolor enablement so the hex values below render rather than quantizing to the nearest 256-color index. Set on the session. |
| `terminal-overrides` | append `,*:RGB` | Server option; the leading-comma list-separator idiom prepends `*:RGB` without clobbering existing entries. tmux normalizes the stored value, so `show-options -gv terminal-overrides` reports the entry as `*:RGB`. |
| `status-style` | `fg=text,bg=mantle` (`fg=#cdd6f4,bg=#181825`) | |
| `window-status-style` | `fg=subtext0,bg=mantle` (`fg=#a6adc8,bg=#181825`) | |
| `window-status-current-style` | `fg=mauve,bg=mantle` (`fg=#cba6f7,bg=#181825`) | |
| `pane-border-style` | `fg=overlay0` (`fg=#6c7086`) | Inactive border; dimmer than the active border for at-a-glance contrast per [TMUX-048](#tmux-048). |
| `pane-active-border-style` | `fg=blue` (`fg=#89b4fa`) | |
| `message-style` | `fg=base,bg=peach` (`fg=#1e1e2e,bg=#fab387`) | |
| `message-command-style` | `fg=base,bg=green` (`fg=#1e1e2e,bg=#a6e3a1`) | |
| `display-panes-colour` | `overlay0` (`#6c7086`) | |
| `display-panes-active-colour` | `mauve` (`#cba6f7`) | |
| `clock-mode-colour` | `mauve` (`#cba6f7`) | |

`pane-border-format`, `pane-border-status`, `status-right`, and `status-right-length` are NOT claimed by the theme; they remain owned by the clauses cited above (and [TMUX-048](#tmux-048) for the format) and shall be set after the theme so a future swap is a one-place change.

### TMUX-048

The launcher shall set each pane's title to `<Display> · <adapter>` where `<Display>` is `Captain` for the Boss/Captain pane and the title-cased role id (per [TMUX-036](#tmux-036)) for each role pane, and `<adapter>` is the adapter name configured in the YAML config for the captain or the role respectively. The middle separator shall be ` · ` (space + U+00B7 middle dot + space).

The launcher shall publish a stable per-adapter accent color, surfaced to consumers (the presenter, per [TMUX-038](#tmux-038) Task 2 and future role-keyed coloring) as a single lookup keyed by adapter name. Known adapter accents:

| Adapter | Mocha role | Hex |
| --- | --- | --- |
| `claude` | `green` | `#a6e3a1` |
| `codex` | `teal` | `#94e2d5` |
| `gemini` | `lavender` | `#b4befe` |
| `opencode` | `pink` | `#f5c2e7` |

For an adapter name outside the table, the lookup shall return a stable color from a fallback pool of `sapphire #74c7ec`, `sky #89dceb`, `rosewater #f5e0dc`, `maroon #eba0ac`, `flamingo #f2cdcd`, selected deterministically from the adapter name so repeated lookups for the same name yield the same color. The fallback pool shall not contain any accent reserved for speaker / tool / status roles (`blue`, `mauve`, `peach`, `red`, `yellow`, `green`).

## Role Session Continuity

### TMUX-041

Within a single tmux-play session, each role's `Cligent` instance shall be created once and reused across every Boss turn. Per [ENG-005](engine.md#eng-005), the engine shall auto-inject `resume` on subsequent runs when the underlying adapter emits a `resumeToken`, so role responses on later turns may build on prior context for adapters that support session continuity.

### TMUX-042

The built-in fanout Captain shall convey each role's identity once, via the role's `instruction` configured at `Cligent` construction. Per Boss turn, the per-role prompt the fanout Captain passes to `callRole` shall be the Boss prompt verbatim, with no static framing label such as `The Boss asked:`, no role identity preamble such as `You are the "<role>" role`, and no trailing instructions that reference inter-role behavior (e.g., "Respond independently", "Do not wait for other roles") — roles cannot see other roles, so such instructions are unactionable. Static framing labels and inter-role instructions are permitted only in prompts directed at the Captain itself (e.g., the summarization prompt passed to `callCaptain`), where they describe context for the synthesizer rather than instruct a role.

## References

[1]: https://catppuccin.com/palette/ "Catppuccin Palette"
