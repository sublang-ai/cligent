<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# TMUX: tmux-play CLI and Captain Runtime

## Intent

The `tmux-play` CLI, its YAML configuration, notifications, Captain extension contract, record set, observer dispatch, tmux topology, programmatic runtime API, and the built-in `fanout` Captain per [DR-004](../decisions/004-tmux-play-captain-architecture.md).

## CLI Invocation

### TMUX-001

The `@sublang/cligent` package shall expose a `tmux-play` bin entry.

### TMUX-002

When `tmux-play` is invoked without `--session`, the CLI shall run launcher mode: resolve the config, construct the tmux session, attach, and exit.

### TMUX-003

When `tmux-play` is invoked with `--session <id> --work-dir <path>`, the CLI shall run session mode: instantiate the Captain and players, run a Boss readline against stdin/stdout, dispatch records to observers, and clean up on exit.

### TMUX-004

When `--config <path>` is supplied, the launcher shall load that file and skip discovery and first-run auto-create.

### TMUX-061

When `--theme-diagnostics` is supplied, the CLI shall run theme-diagnostics mode: load the same config the launcher would load, resolve the Catppuccin flavor per [TMUX-047](#tmux-047), print `selected: <flavor>` and `reason: <explicit|yaml|osc11|fallback>` to stdout, include the raw OSC 11 reply when one was received, and exit without checking for `tmux` or `glow`, creating a tmux session, or attaching. `--theme-diagnostics` is launcher-mode only; when combined with `--session`, the CLI shall reject the invocation before dispatching session mode.

## Configuration

### TMUX-005

A `tmux-play` config shall be YAML with a `captain` object and a non-empty `players` array. The top-level config may also include an optional `theme` field per [TMUX-060](#tmux-060), an optional `layout` field per [TMUX-064](#tmux-064), and an optional `notifications` field per [TMUX-076](#tmux-076).

### TMUX-006

The `captain` object shall require `from` (local path or package specifier), `adapter` (one of `claude`, `codex`, `gemini`, `opencode`), and may include `model`, `instruction`, a `permissions` object per [TMUX-052](#tmux-052), `reasoningEffort` per [TMUX-056](#tmux-056), and an opaque `options` value forwarded verbatim to the Captain factory.

### TMUX-060

The top-level `theme` field shall be one of the closed set `'mocha' | 'latte' | 'auto'` and selects the Catppuccin flavor per [TMUX-047](#tmux-047). A missing `theme` field is equivalent to `'auto'`. The loader shall reject values outside the closed set with an error that names the offending path (`theme`) per [TMUX-008](#tmux-008). The default home config shall include `theme: auto` so first-run users see the option exists.

### TMUX-064

The top-level `layout` field shall be an optional object with two optional sub-fields: `window` and `columnWeights`.
`layout.window` shall be an optional object with two optional positive-integer fields `columns` and `rows`, supplying the initial cell grid for [TMUX-035](#tmux-035) (`new-session -x/-y`) and the pre-attach CSI 8 sequence for [TMUX-043](#tmux-043).
When `layout.window` is missing entirely, the loader shall default it to `{ columns: 174, rows: 49 }`.
When `layout.window` is present but partial — only `columns` or only `rows` supplied — each missing sub-field shall default independently to its full-default value (`174` for `columns`, `49` for `rows`) and each supplied sub-field shall be preserved verbatim; a partial `layout.window` shall not fall back wholesale to the full default (e.g., `{ columns: 200 }` shall resolve to `{ columns: 200, rows: 49 }`, not to `{ columns: 174, rows: 49 }`).
`layout.columnWeights` shall be an optional array of positive integers whose length matches the visible column count derived from the configured players — `2` when one player is configured, `3` when two or more players are configured (per [TMUX-028](#tmux-028)).
Fractional ratios shall be scaled to positive integers before configuring (e.g., `[0.5, 1.5]` shall be written as `[1, 3]`); the scaling preserves the `floor(W * w_i / sum(w))` region widths exactly.
The weights govern column region widths per [TMUX-044](#tmux-044): each non-rightmost column `i` receives `floor(W * w_i / sum(w))` cells at window width `W`, and the rightmost column absorbs the remainder.
A missing `layout.columnWeights` shall be defaulted by the loader to `[1, 1]` when one player is configured and `[1, 1, 1]` when two or more players are configured, so the shipped defaults are 50/50 for the single-player layout and even thirds (`floor(W / 3)` per column, rightmost absorbing the remainder) for the multi-player layout.
The loader shall reject values outside these constraints with an error that names the offending path per [TMUX-008](#tmux-008): non-integer or non-positive `layout.window.columns` / `layout.window.rows`; `layout.columnWeights` not an array; any weight that is not a positive integer (rejects NaN, Infinity, decimals like `0.5`, zero, negatives, and non-number types); a `layout.columnWeights` length that does not match the visible column count.
The snapshot per [TMUX-034](#tmux-034) shall carry the resolved `layout.window.columns`, `layout.window.rows`, and `layout.columnWeights` values verbatim, so session mode never re-resolves defaults.

### TMUX-076

The top-level `notifications` field shall be a map from tmux-play record notification events to sinks.
The event keys shall be the closed set `player_finished`, `turn_finished`, and `turn_aborted`; `runtime_error` shall not be accepted as a notification event.
The sink values shall be the closed set `off`, `bell`, and `desktop`; the `bell` sink shall mean a best-effort native sound cue rather than terminal BEL output.
When the `notifications` block is missing, the loader shall resolve all notification events to `off`.
When an event key is missing inside a present `notifications` block, the loader shall resolve that event to `off`.
When the loader accepts a config, the snapshot per [TMUX-034](#tmux-034) shall carry a resolved notification map with all three event keys.
When the loader rejects an unknown notification key or invalid sink, the error shall name the offending path per [TMUX-008](#tmux-008).

### TMUX-007

Each entry in `players` shall require `id` and `adapter` (one of `claude`, `codex`, `gemini`, `opencode`), and may include `model`, `instruction`, a `permissions` object per [TMUX-052](#tmux-052), and `reasoningEffort` per [TMUX-056](#tmux-056). Player `id` shall match `^[a-z][a-z0-9_-]*$`, be unique within the config, and shall not equal `captain`. Multiple players may share an adapter and model.

### TMUX-052

The `captain` object and each `players` entry may include a `permissions` object whose typed shape is [ENG-021](engine.md#eng-021)'s `PermissionPolicy`: `mode` is `'auto' | 'bypass'`, `fileWrite` / `shellExecute` / `networkAccess` are each `'allow' | 'ask' | 'deny'`, and `writablePaths` is an optional array of workspace-relative path strings per [ENG-022](engine.md#eng-022).
The loader shall validate and canonicalize `permissions.writablePaths` per [ENG-022](engine.md#eng-022), then forward the accepted `permissions` value to the captain / player `Cligent` constructor as `CligentOptions.permissions` per [DR-005](../decisions/005-per-adapter-permission-configuration.md); the adapter performs the SDK-knob mapping at `run()` time per [ENG-021](engine.md#eng-021).
The loader shall reject unknown sub-fields under `permissions`, values outside the closed sets above, or invalid `writablePaths` entries with an error that names the offending path per [TMUX-008](#tmux-008).
A missing `permissions` field shall be treated as no policy override; the adapter retains its SDK default.

### TMUX-056

The `captain` object and each `players` entry may include `reasoningEffort`, whose value shall be [ENG-020](engine.md#eng-020)'s closed set: `'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`.
The loader shall forward an accepted `reasoningEffort` value to the corresponding captain or player `Cligent` constructor as `CligentOptions.reasoningEffort` per [ENG-001](engine.md#eng-001).
The loader shall reject values outside the closed set with an error that names the offending path (`captain.reasoningEffort` or `players[N].reasoningEffort`) per [TMUX-008](#tmux-008).
A missing `reasoningEffort` field shall be treated as no reasoning-effort override; the adapter retains its default for that player or captain.

### TMUX-008

When loading a config, the loader shall reject malformed YAML and unknown fields with an error that names the offending file or path.

## Discovery and First-Run

### TMUX-009

When `--config` is not supplied, the launcher shall search for `tmux-play.config.yaml` in the current directory first, then `${XDG_CONFIG_HOME:-~/.config}/tmux-play/config.yaml`. The first match shall be used. `XDG_CONFIG_HOME` shall be treated as unset when empty.

### TMUX-010

When neither location holds a config and `--config` is not supplied, the launcher shall create the home location with a default config, print a one-line notice naming the path on stdout, and continue.
When the launcher loads an existing home config through fallback discovery, it shall add only missing safe defaults to that home YAML: `theme: auto`, the resolved `layout` defaults from [TMUX-064](#tmux-064), `captain.options: {}`, and the default `notifications` entries from [TMUX-011](#tmux-011).
The migration shall preserve existing values and shall not add `model`, `instruction`, `permissions`, or `reasoningEffort` defaults to old home configs.

### TMUX-011

The default home config shall wire the built-in `fanout` Captain on the `claude` adapter and two players whose IDs match their adapters: `claude` (claude adapter) and `codex` (codex adapter). The default Captain and default `claude` player shall use `model: claude-opus-4-8` with `reasoningEffort: xhigh`; the default `codex` player shall use `model: gpt-5.5` with `reasoningEffort: xhigh`. Each default player shall include an `instruction` that identifies that player for the runtime-created `Cligent` instance. The default Captain and default players shall include `permissions: { mode: 'auto' }` per [TMUX-052](#tmux-052); for Codex this resolves to `on-request + auto_review` with the `:workspace` permission profile because [CODEX-004](adapters/codex.md#codex-004) maps `mode: 'auto'` with unset capability fields to `:workspace`. These defaults run each adapter's classifier-, sandbox-, or reviewer-protected auto-mode per [DR-005](../decisions/005-per-adapter-permission-configuration.md), reducing routine in-session permission prompts. The mode does not eliminate prompts or broaden sandbox/network permissions: per the SDK behavior tabulated in [DR-005](../decisions/005-per-adapter-permission-configuration.md), Claude's `auto` still blocks high-risk actions and falls back to prompts after consecutive/total denies, and Codex's `on-request + auto_review` with the `:workspace` permission profile routes eligible approval requests to a reviewer agent without broadening that profile's filesystem or network limits. This default lives in the example YAML only; per [DR-005](../decisions/005-per-adapter-permission-configuration.md) cligent imposes no project-wide permission posture for configs that omit `permissions`.
The default home config shall also include an explicit `layout` block per [TMUX-064](#tmux-064) — `window: { columns: 174, rows: 49 }` and `columnWeights: [1, 1, 1]` — so first-run users see the new knobs and the shipped multi-player layout default surfaces in the YAML rather than being implicit in the code.
The default home config shall also include `notifications: { player_finished: bell, turn_finished: desktop }` per [TMUX-076](#tmux-076), with omitted `turn_aborted` resolving to `off`.

### TMUX-012

When the cwd contains a legacy `tmux-play.config.mjs`, `tmux-play.config.js`, or `tmux-play.config.json` and no cwd YAML, the launcher shall print a one-line stderr warning naming the legacy file before continuing.

### TMUX-013

Local `captain.from` paths shall resolve against the directory of the originating config file. Package specifiers shall pass through to Node's module resolver.

## Captain Extension Contract

### TMUX-014

A Captain module shall default-export a factory `(options: unknown) => Captain | Promise<Captain>`. The returned `Captain` shall implement `handleBossTurn(turn, context): Promise<void>` and may implement `init(session): Promise<void>` and `dispose(): Promise<void>` lifecycle hooks.

### TMUX-015

The runtime shall own every player and Captain `Cligent` instance. Captains shall reach players only through the `context` passed to `handleBossTurn` and shall not construct adapters or `Cligent` directly.

### TMUX-016

`CaptainContext` shall expose a turn-scoped `signal: AbortSignal`, a readonly `players` manifest, and `callPlayer(playerId, prompt)` and `callCaptain(prompt, options?)` methods. The methods shall return `PlayerRunResult` and `CaptainRunResult` respectively per [TMUX-033](#tmux-033). `callCaptain`'s optional `options` is a `CallCaptainOptions` whose `visibility: 'visible' | 'hidden'` (default `'visible'`) controls Boss-pane presentation only per [TMUX-072](#tmux-072); `callPlayer` takes no such option.

### TMUX-017

`CaptainSession` shall expose a session-scoped `signal: AbortSignal`, a readonly `players` manifest, and `emitStatus(message, data?)` and `emitTelemetry({ topic, payload })` methods. Captains may retain the session reference from `init` and emit at any point during the session — within `init`, during turns, or between turns.

### TMUX-018

The runtime shall serialize Boss turns: at most one `handleBossTurn` invocation may be in flight per session.

### TMUX-019

On session shutdown the runtime shall (1) unwind the active turn, (2) abort `CaptainSession.signal`, (3) drain accepted session emissions, (4) call `Captain.dispose()` exactly once, and (5) detach observers. Post-shutdown `emitStatus`/`emitTelemetry` calls shall reject.

## Record Types and Observer Dispatch

### TMUX-020

The runtime shall emit records of these types: `turn_started`, `turn_finished`, `turn_aborted`, `player_prompt`, `player_event`, `player_finished`, `captain_prompt`, `captain_event`, `captain_finished`, `captain_status`, `captain_telemetry`, `runtime_error`. Each record shall carry a stable player ID where applicable.

### TMUX-021

Turn-bound records shall carry `turnId: number`. `captain_status` and `captain_telemetry` emitted outside an active turn shall carry `turnId: null`.

### TMUX-022

Within a turn the runtime shall emit `turn_started` first; for each player `player_prompt` → `player_event*` → `player_finished`; for each `callCaptain()` `captain_prompt` → `captain_event*` → `captain_finished`; and `turn_finished` (or `turn_aborted` on abort) last.

### TMUX-023

Observers shall be invoked in registration order. The dispatcher shall await each observer's returned Promise before dispatching the next record. Records shall not be dropped or coalesced.

### TMUX-024

Turn-bound emissions shall drain before `turn_finished`/`turn_aborted`. `turnId: null` emissions shall dispatch in emission order without a turn boundary. Multiple observers may register against one runtime; each shall receive every record.

### TMUX-025

The runtime shall emit a `runtime_error` record when a control-plane failure prevents normal record emission — startup, `Captain.init`, a `handleBossTurn` exception, or observer dispatch. The record shall carry `turnId: number` when an active turn exists at the moment of failure, else `turnId: null`. After emission, the runtime shall abort the active turn if any and run shutdown per [TMUX-019](#tmux-019). When the failure originates in an observer, the record shall additionally be delivered to the remaining observers in registration order before shutdown begins. Individual player or Captain run failures shall surface in the corresponding `player_finished` / `captain_finished` record with `status: 'error'`, not as `runtime_error`.

### TMUX-077

Where session mode is running, the session shall register a notification observer with the existing record observers.
The notification observer shall be registered before any caller-supplied observers.
When that observer handles `player_finished` with sink `bell`, it shall play one best-effort native sound cue regardless of the player result status.
When that observer handles `player_finished` with sink `bell`, it shall not write terminal BEL (`\x07`) to orchestrator stdout and shall not launch a desktop notification command, so player completion does not request terminal or desktop badging.
When that observer handles `turn_finished` with sink `desktop`, it shall send one best-effort desktop notification after the full Boss turn completes.
When that observer handles `turn_finished` with sink `desktop` on macOS, it shall write exactly one terminal BEL (`\x07`) to orchestrator stdout so tmux can forward the turn-completion bell to the outer terminal.
When that observer handles `player_finished` or `turn_aborted` with sink `desktop`, or handles `turn_finished` with sink `desktop` on a non-macOS platform, it shall not write terminal BEL (`\x07`) or terminal notification escape bytes to orchestrator stdout.
When that observer handles `turn_aborted`, it shall notify only when `turn_aborted` is configured to a non-`off` sink and the abort reason is not one of the user-cancellation reasons `ESC`, `SIGINT`, `SIGTERM`, `EOF`, or `runtime disposed`.
The sound-cue backend shall launch detached best-effort `afplay /System/Library/Sounds/Hero.aiff` on macOS, a detached best-effort freedesktop `complete` sound cue on Linux, a detached best-effort Windows generic notification sound on Windows, and no operation on other platforms.
The desktop backend shall launch a detached best-effort `osascript` notification on macOS, a detached best-effort `notify-send` notification on Linux, and no operation on other platforms.
Every desktop notification shall use the lowercase title `spex`, distinct from the status-left `Spex` heading of [TMUX-055](#tmux-055), and shall not use `Spex`.
The notification observer shall swallow all notification failures and shall never cause record dispatch, turn execution, or shutdown to throw.
The notification observer shall not notify for `runtime_error` records.

### TMUX-026

When SIGINT, SIGTERM, or stdin EOF reaches the session, the runtime shall abort the active turn, run shutdown per [TMUX-019](#tmux-019), kill the tmux session, and remove launcher-owned work directories.

## tmux Topology

### TMUX-027

The Boss/Captain pane shall occupy the left column. Player panes shall fill the right side in config order, read-only.

### TMUX-028

With two or more players, `tmux-play` shall use two player columns; with a single player, `tmux-play` shall use one player column.
The visible columns from left to right shall be the Boss/Captain pane followed by each player column, and the first player column shall hold `ceil(playerCount / 2)` players from top to bottom.
Each visible column's share of the window width shall derive from [TMUX-064](#tmux-064)'s `layout.columnWeights`, applied left-to-right: with N visible columns and weights `[w_0, w_1, ..., w_{N-1}]` (where `w_0` is the Boss/Captain column), each non-rightmost column `i < N-1` shall occupy `floor(W * w_i / sum(w))` cells at window width `W`, and the rightmost column shall absorb the remainder.
The defaults are `[1, 1]` for one player (Boss/Captain and the player each occupy 1/2 of the window width, matching the prior behavior) and `[1, 1, 1]` for two or more players (Boss/Captain and each player column each occupy 1/3 of the window width, rightmost absorbing the remainder).

## Programmatic Runtime API

### TMUX-029

The `@sublang/cligent/tmux-play` sub-export shall expose a runtime factory accepting an instantiated `captain`, a `captainConfig` with `adapter` (one of `claude`, `codex`, `gemini`, `opencode`), optional `model`, optional `instruction`, optional `permissions` per [TMUX-052](#tmux-052), and optional `reasoningEffort` per [TMUX-056](#tmux-056), a non-empty `players` array (each entry with `id`, `adapter`, optional `model`, optional `instruction`, optional `permissions`, and optional `reasoningEffort`, conforming to [TMUX-007](#tmux-007)), zero or more `observers`, an optional `cwd`, and an optional session-scoped `signal`. The factory shall return a runtime that drives Boss turns without tmux. Record types and the observer-registration contract shall export from the same sub-export.

## Built-in Fanout Captain

### TMUX-030

The `@sublang/cligent/captains/fanout` Captain shall, per Boss turn, invoke `callPlayer` for every configured player concurrently, then issue a single `callCaptain` summary referencing each player's status and final text.

### TMUX-031

The fanout Captain shall not copy raw player events into the Boss/Captain pane; only the synthesized summary shall reach the Boss via `callCaptain`.

## Public Contract Shapes

### TMUX-032

A `BossTurn` argument shall expose the turn's numeric `id`, the Boss `prompt`, and a `timestamp`. A `PlayerHandle` shall expose the player `id`, the `adapter`, and an optional `model`.

### TMUX-033

`PlayerRunResult` shall expose `playerId`, `turnId`, and `status`, and may include `resumeToken`, `finalText`, and `error`. `CaptainRunResult` shall expose `turnId` and `status`, and may include `finalText` and `error`. `status` values are `'ok' | 'aborted' | 'error'`; aborted results may carry neither `finalText` nor `error`. When an aborted player call's terminal `done` carries a `resumeToken`, `PlayerRunResult.resumeToken` shall expose it; when the terminal `done` omits `resumeToken`, `PlayerRunResult` shall omit it so captains can detect interrupted, not-resumable calls.

## Launcher → Session Protocol

### TMUX-034

The launcher shall convert the resolved YAML config into a JSON snapshot written to the session's work directory, with local `captain.from` paths normalized to absolute `file://` URLs and package specifiers passed through unchanged. Session mode shall read the snapshot rather than reloading the YAML, so config changes made between launch and session start shall not affect the running session.

### TMUX-074

Session mode is the orchestrator: it runs inside the Boss/Captain pane (pane 0) of the launched tmux session per [TMUX-027](#tmux-027), so its process environment carries that session's live tmux client handles (`TMUX`, `TMUX_PANE`), and player adapters spawn their agent CLIs from that same environment.
Before constructing the session, session mode shall isolate spawned player agents from the run's tmux server: it shall remove `TMUX` and `TMUX_PANE` from the environment player agents inherit and redirect their `TMUX_TMPDIR` to a private directory, so any `tmux` an agent runs — including `kill-server` — resolves to its own isolated server and can neither reach nor terminate the session hosting the run. (Without this, a player tasked with debugging tmux can take down its own run, surfacing to the Boss as `[server exited]` / `tmux attach-session failed`.)
The orchestrator's own tmux interactions — pane-width and pane-target queries, status-bar and per-pane timer updates, and session teardown — shall continue to target the run's session, by running with a snapshot of the real tmux environment captured before the scrub. The pane-width query gate that skips work when not attached to tmux shall consult that snapshot rather than the scrubbed `TMUX`.
When session mode is not running inside tmux (no inherited `TMUX`, e.g. tests), the isolation step shall be a no-op.

## External Dependencies

### TMUX-051

When `tmux-play` is invoked in launcher mode (per [TMUX-002](#tmux-002)), the launcher shall verify that the `glow` binary [[2]] is available on `PATH` before loading any config, and when it is not, shall fail with an error message that names `glow` and points to its installation page. The presenter's pane output pipeline delegates Markdown wrapping and styling to `glow`; running without it would silently degrade word-boundary wrapping, styled bodies, and fenced-code passthrough, so the launcher fails fast rather than letting that surface mid-session. The gate mirrors the existing `tmux` availability check and shall run after the `tmux` check so a host missing both binaries reports `tmux` first.

## Initial Window Geometry

### TMUX-035

When the launcher creates the tmux session, the session shall be created with a cell grid whose column and row counts come from [TMUX-064](#tmux-064)'s resolved `layout.window.columns` and `layout.window.rows`.
The default values are `174` columns by `49` rows — a cell grid sized for a 1920×1080 display at 18pt monospace (≈ 11×22 px cells) — when the YAML config omits `layout.window`.
When a client attaches with a different window size, tmux's normal size negotiation shall govern the displayed layout.

### TMUX-043

Before invoking `tmux attach-session`, the launcher shall write the xterm window-manipulation request `CSI 8 ; <rows> ; <columns> t` (`\x1b[8;<rows>;<columns>t`) to stdout, where `<rows>` and `<columns>` are [TMUX-064](#tmux-064)'s resolved `layout.window.rows` and `layout.window.columns`, asking the user's terminal to resize its cell grid to match the same dimensions [TMUX-035](#tmux-035) uses for `new-session -x/-y`.
The default sequence with the default `layout.window` is `\x1b[8;49;174t`.
Reading both the `new-session -x/-y` arguments and the CSI 8 payload from the same `layout.window` is required because tmux's default `window-size` negotiation would otherwise renegotiate the session to whatever cell grid the terminal accepts on attach, silently overriding any non-default `layout.window` at the very moment it should take effect.
Terminals that honor the sequence (xterm, Konsole, GNOME Terminal, iTerm2 with the "Allow programs to change/resize window" option enabled, others) shall adjust before the attach completes; terminals that ignore it (including macOS Terminal.app by default) shall be left unchanged, in which case [TMUX-035](#tmux-035)'s normal size negotiation governs.

### TMUX-044

The weighted region split required by [TMUX-028](#tmux-028) shall hold at every window size, not only at session creation.
The launcher shall configure session-scoped tmux hooks (`client-resized` and `after-resize-window`) that re-apply pane widths via `resize-pane -x` so that, at any window width `W` with N visible columns and weights `[w_0, w_1, ..., w_{N-1}]` from [TMUX-064](#tmux-064)'s resolved `layout.columnWeights`, each non-rightmost column `i < N-1` is `floor(W * w_i / sum(w))` cells and the rightmost column absorbs the remainder.
With the shipped defaults: `[1, 1]` for one player yields `floor(W / 2)` for the Boss/Captain region and the remainder for the player pane; `[1, 1, 1]` for two or more players yields `floor(W / 3)` for the Boss/Captain region, `floor(W / 3)` for the first player column, and the remainder for the second player column.
Pane content widths are one less than their region for every pane that has a right-side tmux border separator; the rightmost pane's content width equals its region.

### TMUX-045

After the launcher constructs the tmux session and before it attaches a client, the active pane shall be the Boss/Captain pane so startup cursor focus lands at the `boss> ` readline prompt.

## Mouse Interaction

### TMUX-062

When the launcher creates a tmux-play session, it shall set that session's `mouse` option to `on` so tmux intercepts mouse events before the terminal and drag selection can be scoped by tmux pane instead of by the terminal's screen rectangle.
The launcher shall bind `MouseDragEnd1Pane` in both the `copy-mode` and `copy-mode-vi` key tables to `send-keys -X stop-selection`, so releasing the primary mouse button after a drag leaves the selected text highlighted in copy mode instead of copying and cancelling immediately.
The launcher shall bind `MouseDown3Pane` in both key tables to a single `if-shell -F '#{selection_present}'` whose true branch (a selection is present) shows a copy-confirmation toast and then copies — `display-message Copied! ; send-keys -X copy-pipe <system-clipboard-command>` — and whose false branch (no selection) copies without a toast — `send-keys -X copy-pipe <system-clipboard-command>` — so right-clicking an active selection copies through tmux's normal copy path, pipes the selected text to the host system clipboard when a supported route is available, clears the active selection as visible copy-confirmation, preserves the clicked pane's current copy-mode scroll position, and surfaces a brief on-screen `Copied!` toast.
When the right-clicked pane holds an active selection (`#{selection_present}` is `1` at the moment of the click), the launcher shall display a brief toast reading `Copied!` via tmux `display-message`; when no selection is present, no toast shall appear, the binding shall not claim `Copied!`, and the copy path shall still run.
The toast shall be a status-line `display-message` (not a floating `display-popup`) so it inherits the session's `message-style` (`fg=<base>,bg=<peach>` per [TMUX-047](#tmux-047)) and renders `Copied!` as dark text on the resolved flavor's peach surface — the same status-message band tmux uses for its own messages.
The `#{selection_present}` gate is the `if-shell` condition, evaluated at the moment of the click before either branch runs, because `copy-pipe` clears the active selection and a check placed after the copy would always read `0`; the toast must therefore live in a branch alongside the copy rather than after it.
The two-command true branch shall be a single quoted command argument whose internal `;` separates the toast from the copy when `if-shell` re-parses the branch, mirroring the cancel-then-forward true branch of [TMUX-065](#tmux-065); the system-clipboard command shall be single-quoted within each branch so `copy-pipe` receives it as one argument on re-parse.
Showing the toast shall not change the clicked pane's copy-mode state or scroll position, and the toast shall auto-dismiss after the session's `display-time` like any other tmux status message.
The `copy-pipe` primitive is chosen over `copy-pipe-and-cancel` deliberately: `copy-pipe-and-cancel` exits copy-mode on the clicked pane and returns it to its live tail, which surfaces as the "right-click on a scrolled-back pane jumps to the last line" defect — the right-click analogue of the left-click defect [TMUX-068](#tmux-068) addresses for the `MouseDown1Pane` override.
`copy-pipe` clears the selection (so a stale selection cannot survive the copy gesture and the user gets a visible cue that the copy happened) but does not exit copy-mode, so a Boss reviewing historical pane content can copy without losing their place.
A user who wants to leave copy-mode after the copy may press `q` as usual; right-click copy shall not be the action that returns the pane to its live tail.
The system clipboard command shall try `pbcopy`, Wayland `wl-copy`, X11 `xclip`, X11 `xsel`, and WSL `clip.exe`, then fall back to `tmux load-buffer -w -` for OSC 52 clipboard delivery through the attached terminal.
Customizing tmux copy-mode key tables is necessarily server-global because tmux does not offer per-session copy-mode bindings, so these four bindings outlive the tmux-play session; the launcher accepts that server-level footprint because preserving selection after mouse release is the requested UX and tmux has no narrower mechanism for it.
A future cleanup hook may reduce the binding lifetime, but safe cleanup must preserve any pre-existing user bindings and account for multiple concurrent tmux-play sessions.
Under tmux's default root mouse bindings, clicking selects the pane under the cursor and the scroll wheel enters or operates pane copy mode to scroll pane history.
User `Mouse*` / `Wheel*` rebindings may alter those default consequences.
The launcher shall not configure `set-clipboard` and shall not add `WheelUpPane` or `WheelDownPane` bindings; terminal policy may still block the OSC 52 fallback.
The launcher relies on tmux's stock wheel handling, which already enters copy-mode and clamps the viewport at the oldest history line so a wheel-up cannot scroll past the top of history; the Boss/Captain pane no longer surfaces phantom rows above its first line because [TMUX-079](#tmux-079) stops the readline prompt from polluting that pane's scrollback in the first place.

### TMUX-066

_Superseded by [TMUX-067](#tmux-067)._
_Status: retired and entirely non-normative. The paragraphs below record the original requirement in past tense for spec history; no clause in this item is in effect, and no `shall` text appears here. The active normative behavior for left-click on a tmux-play pane is owned by [TMUX-068](#tmux-068)._
_Summary of supersession: cancelling copy-mode on every pane in the session before focusing the clicked pane returned each scrolled pane to its live tail, which surfaced as the user-reported "previously focused pane jumps to the last line" defect; [TMUX-067](#tmux-067) preserved scroll by keeping stock left-click behavior, and [TMUX-068](#tmux-068) is the current active requirement that also clears active selections._

Historical (non-normative) — what TMUX-066 originally required:
- While a tmux-play session was running, when the Boss pressed the primary mouse button on any pane in the launched session, the session cancelled copy-mode in every pane in the session before focusing the clicked pane, so any active selection was cleared on the next click and at most one pane in the session could hold a copy-mode selection at any time.
- The deselect behavior held whether the clicked pane was currently in copy-mode or not, so a click on the pane that held the selection cleared it just as a click on a sibling pane did.
- The launcher bound `MouseDown1Pane` in the `root`, `copy-mode`, and `copy-mode-vi` key tables, because tmux dispatches a mouse event through the clicked pane's mode-specific table when the pane is in a mode (`copy-mode` / `copy-mode-vi` both ship a default `MouseDown1Pane select-pane` that would otherwise have shadowed a `root`-only binding) and through the `root` table otherwise.
- Each binding was gated on the current `#{session_name}` matching the launched session name via `if-shell -F`. The false branch reproduced tmux's stock per-table binding verbatim — `select-pane -t= ; send-keys -M` in the `root` table and `select-pane` in `copy-mode` and `copy-mode-vi` — so that in every other tmux session on the same server left-clicking retained tmux's default behavior. The `send-keys -M` forwarding in the `root` false branch was not omitted, since mouse-aware terminal applications (e.g. vim, less, htop) depend on it to receive forwarded clicks.
- The true branch cancelled copy-mode on every pane in the session that was currently in a mode and then ran the same per-table tail as the false branch (`select-pane -t= ; send-keys -M` in `root`; `select-pane -t=` in `copy-mode` / `copy-mode-vi`), so the deselect logic did not regress mouse-event forwarding or click-to-focus in the launched session either.
- The per-pane cancel was gated by `#{pane_in_mode}` so non-mode panes were not sent `-X cancel`, which would emit tmux's "no key table" error.
- Drag-select per [TMUX-062](#tmux-062) was unaffected: `MouseDown1Pane` fired at the start of a drag and cleared any prior selection, then `MouseDrag1Pane` (tmux's stock root binding) entered `copy-mode -M` on the dragged pane and began a fresh selection.
- As with the copy-mode bindings of [TMUX-062](#tmux-062) and the keyboard bindings of [TMUX-063](#tmux-063) / [TMUX-065](#tmux-065), tmux's `root`, `copy-mode`, and `copy-mode-vi` tables are server-global because tmux does not offer per-session bindings in those tables, so these entries outlived the tmux-play session; the `if-shell` guard kept each binding inert in every other session and was the launcher's narrowest available scoping mechanism.
- A future cleanup hook to reduce the binding lifetime was contemplated, with the caveat that safe cleanup would have to preserve any pre-existing user bindings and account for multiple concurrent tmux-play sessions; under [TMUX-067](#tmux-067) this concern is moot because the launcher writes stock per-table bindings rather than session-scoped overrides.

### TMUX-067

_Superseded by [TMUX-068](#tmux-068)._
_Status: retired and entirely non-normative. The paragraphs below record the original requirement in past tense for spec history; no clause in this item is in effect, and no `shall` text appears here. The active normative behavior for left-click on a tmux-play pane is owned by [TMUX-068](#tmux-068)._
_Summary of supersession: installing only tmux's stock per-table `MouseDown1Pane` bindings preserved scroll position across focus changes but reintroduced the original "left-click does not release an active copy-mode selection" defect that [TMUX-066](#tmux-066) was written to fix. Under [TMUX-068](#tmux-068), the launcher installs a session-scoped `MouseDown1Pane` override that runs `send-keys -X clear-selection` (not the retired `-X cancel`) per pane currently in a mode, then chains the per-table stock tail; `clear-selection` drops the selection without exiting copy-mode, so both goals hold at once — a click anywhere in the session releases any active selection while every scrolled-back pane keeps its scroll position._

Historical (non-normative) — what TMUX-067 originally required:
- While a tmux-play session was running, when the Boss pressed the primary mouse button on any pane in the launched session, every pane in the session retained its current copy-mode state, scroll position, and any active selection; only pane focus changed.
- The launcher installed only tmux's stock per-table `MouseDown1Pane` bindings verbatim — `select-pane -t= ; send-keys -M` in the `root` table and `select-pane` in `copy-mode` and `copy-mode-vi` — explicitly written so a stale [TMUX-066](#tmux-066) entry on a server reused across launches would be overwritten with stock semantics.
- The launcher therefore emitted no `if-shell` gate on `#{session_name}`, no `#{pane_in_mode}` clause, and no `send-keys -X cancel` as part of the left-click handler in any of the three key tables, and a server reused across launches would have any prior session-scoped chain replaced by the stock tail.
- The retired [TMUX-066](#tmux-066) cancel-on-every-pane chain had used `send-keys -X cancel`, which exits copy-mode entirely and snaps a scrolled-back pane to its live tail; preserving scroll position across focus changes was the user-visible motivation for retiring it. TMUX-067 chose a different tradeoff than [TMUX-068](#tmux-068): rather than splitting the two effects via a different `-X` primitive, it removed the override entirely and accepted that an active selection survived clicks elsewhere in the session.
- Drag-select per [TMUX-062](#tmux-062) was unaffected: tmux's stock `MouseDrag1Pane` enters `copy-mode -M` on the dragged pane and begins a fresh selection there without touching other panes.
- The right-click copy path of [TMUX-062](#tmux-062) was unaffected: right-clicking an active selection still ran `copy-pipe-and-cancel`, which cancels copy-mode on the clicked pane and returns it to its live tail because that is the explicit user action of copying and leaving copy-mode.
- The keyboard pane-switch bindings of [TMUX-063](#tmux-063) only call `select-pane -L` / `select-pane -R`, which do not enter or cancel copy-mode, so they too preserved every pane's scroll position and selection.

### TMUX-068

While a tmux-play session is running, when the Boss presses the primary mouse button on any pane in the launched session — whether the clicked pane is the currently focused pane or a sibling, in copy-mode or not — every pane in the session whose copy-mode currently holds an active selection shall drop that selection; every pane in the session shall otherwise retain its current copy-mode state and scroll position, and pane focus shall change to the click target.
A pane that is in copy-mode without an active selection (a scrolled-back pane, for example) shall stay in copy-mode at its existing scroll position.
A pane that holds an active selection shall stay in copy-mode at the same scroll position with the selection cleared.
A pane that is not in any mode shall remain not in any mode.
The behavior shall hold for both the pane that currently holds the selection and any sibling pane in the launched session, so a stopped copy-mode selection cannot survive the next primary-button click inside that session.
The launcher shall not clear a selection by exiting copy-mode, because exiting copy-mode returns a scrolled-back pane to its live tail; selection clearing shall be scroll-preserving.
The click behavior shall be scoped to the launched tmux-play session so other tmux sessions on the same tmux server retain their stock primary-click behavior.
Drag-select per [TMUX-062](#tmux-062) is unaffected: starting a new primary-button drag shall clear any prior selection before the dragged pane begins its fresh selection.
The right-click copy path of [TMUX-062](#tmux-062) is also scroll-preserving: right-clicking an active selection runs `copy-pipe` (not `copy-pipe-and-cancel`), which clears the selection as visible copy-confirmation and leaves the clicked pane in copy-mode at its existing scroll position so a Boss reviewing historical pane content does not lose their place after copying; see [TMUX-062](#tmux-062) for the rationale.
The keyboard pane-switch bindings of [TMUX-063](#tmux-063) are unaffected and shall continue preserving every pane's scroll position and selection.

### TMUX-069

While a tmux-play session is running, when the session writes new content to a pane in the launched session — the Boss/Captain pane or a player pane, with the destination pane resolved as the pane that write routes to per [TMUX-040](#tmux-040) — that is currently in copy-mode, that pane shall return to its live tail so the newly written content is visible, overriding any prior scroll-back on that pane.
The pane shall be returned to its live tail by a copy-mode exit primitive (`send-keys -X cancel`), not by killing the pane or its feeding process, so a player pane's `tail -f` per [TMUX-027](#tmux-027) and the Boss/Captain pane's process keep running; clearing any active selection on that pane is an accepted side effect of the exit.
A pane that is not in a mode shall be left untouched, and no copy-mode exit shall be issued against it.
The trigger shall be new output only: this override of the click and right-click scroll-preservation of [TMUX-062](#tmux-062) and [TMUX-068](#tmux-068) shall occur only when content is written, so between Boss turns — when no output is produced to a pane — a scrolled-back pane shall keep its scroll position and stay in copy-mode for historical review.
Content that renders to no visible bytes shall not count as new output: when a processed event emits nothing to the pane — for example an all-blank rendered block that per [TMUX-050](#tmux-050) writes no bytes — a scrolled-back pane shall keep its scroll position and shall not be returned to its live tail, since the trigger is visible content reaching the pane, not the mere processing of an event.
A write to one pane shall not return any other pane to its tail; a pane that receives no concurrent write shall retain its copy-mode state and scroll position.
The behavior shall be scoped to the launched tmux-play session and shall not affect panes in any other tmux session on the same server.

_The retired wheel-up clamp once tracked here as TMUX-078 is removed: it chased a symptom — phantom rows appearing above the Boss/Captain pane's first line when scrolling up — that was really the readline prompt polluting the pane's scrollback. Stock tmux already clamps wheel-up at the top of history, and the true cause is fixed at the source by [TMUX-079](#tmux-079)._

## Keyboard Interaction

### TMUX-063

When the launcher creates a tmux-play session, it shall bind `C-Left`, `C-Right`, `S-Left`, and `S-Right` in the `root` key table so that, while the active client is attached to the launched session, `C-Left` and `S-Left` each run `select-pane -L` and `C-Right` and `S-Right` each run `select-pane -R`.
Shipping both `Ctrl+←/→` and `Shift+←/→` as equivalent pane-switch bindings gives an out-of-the-box default that works across macOS, Windows, and Linux terminal emulators — at least one of the two pairs reaches tmux untouched on every common host (macOS Terminal.app and iTerm2 frequently rebind `Ctrl+←/→` for shell word-movement, while many Linux desktops swallow `Shift+←/→` for window-manager workspace switching), so providing both pairs avoids forcing per-platform documentation or user keybinding tweaks.
Each binding shall be gated on the current `#{session_name}` matching the launched session name via `if-shell -F`, with a false branch of `send-keys C-Left` (resp. `C-Right`, `S-Left`, `S-Right`), so that for any other tmux session on the same server the binding is a no-op and the original `Ctrl+Left` / `Ctrl+Right` / `Shift+Left` / `Shift+Right` key is forwarded verbatim to the active pane.
This delivers the direct pane-switch UX that `status-left` advertises (`switch pane: ctrl+←/→ or shift+←/→`) without requiring the `Ctrl+b` prefix.
The launcher shall render `status-left` with hints in the form `switch pane: ctrl+←/→ or shift+←/→ | stop: esc | exit: ctrl+c | drag=select | right-click=copy`, naming the Boss-input ESC interrupt per [TMUX-057](#tmux-057) and the Ctrl+C exit lifecycle per [TMUX-026](#tmux-026); the retired `Ctrl+b, then: d=detach | o=switch pane | [=scroll (q exits)` hint fragments and the prior title-case hint fragments `Switch pane: Ctrl+←/→ or Shift+←/→`, `Stop: ESC`, and `Exit: Ctrl+C` shall not appear.
As with the copy-mode bindings of [TMUX-062](#tmux-062), tmux's root key table is server-global because tmux does not offer per-session root-table bindings, so the four entries outlive the tmux-play session; the `if-shell` guard keeps each binding inert in every other session and is the launcher's narrowest available scoping mechanism.
A future cleanup hook may reduce the binding lifetime, but safe cleanup must preserve any pre-existing user bindings and account for multiple concurrent tmux-play sessions.

### TMUX-070

When the launcher creates a tmux-play session, it shall bind `Escape` in the `root`, `copy-mode`, and `copy-mode-vi` key tables so that, while the active client is attached to the launched session, a single `Escape` pressed in any pane and in any mode forwards a bare ESC byte to the Boss/Captain pane (pane index 0).
Each binding shall be gated on the current `#{session_name}` matching the launched session name via `if-shell -F`.
Each binding's true branch shall first exit pane 0's copy-mode when pane 0 is in a mode and then deliver the ESC byte to pane 0 — `if -F -t <session>:0.0 '#{pane_in_mode}' 'send-keys -t <session>:0.0 -X cancel'` followed by `send-keys -t <session>:0.0 Escape` — because an `Escape` delivered via `send-keys` to a pane that is itself in copy-mode is consumed by copy-mode's stock `cancel` and never reaches the Boss readline, so without the prior cancel the forwarded byte is swallowed when pane 0 is the scrolled pane.
The false branch shall reproduce the per-table tmux stock binding for `Escape` verbatim so other tmux sessions on the same server retain stock behavior: `send-keys Escape` for the `root` table (tmux ships no stock root binding for `Escape`; this passes the key to the focused pane), `send-keys -X cancel` for `copy-mode` (emacs-mode stock: Escape exits copy-mode), and `send-keys -X clear-selection` for `copy-mode-vi` (vi-mode stock: Escape leaves visual selection without leaving copy-mode, because the vi-mode key for exiting copy-mode is `q`).
The asymmetric stock between `copy-mode` and `copy-mode-vi` is intentional in tmux and shall be preserved on the false branch: tmux's `root`, `copy-mode`, and `copy-mode-vi` key tables are server-global (see [TMUX-062](#tmux-062) / [TMUX-063](#tmux-063) / [TMUX-065](#tmux-065)), so collapsing the vi-mode false branch to `-X cancel` would change every unrelated vi-mode user's Escape on the same tmux server from "drop selection, keep scrollback" to "exit copy-mode, snap to live tail" — the same scroll-snapping regression class [TMUX-068](#tmux-068) enumerates for mouse events.
This mirrors the [TMUX-065](#tmux-065) `C-c` forwarding pattern so the `stop: esc` hint advertised by `status-left` per [TMUX-063](#tmux-063) is honored from every pane in the launched session.
Without this binding, an ESC pressed in a player pane is swallowed by `pane-input-off=1` per [TMUX-027](#tmux-027) and never reaches the readline keypress handler in pane 0 that [TMUX-057](#tmux-057) wires to `abortActiveTurn('ESC')`; an ESC pressed in any pane scrolled back into copy-mode is consumed by the stock copy-mode handling (`cancel` or `clear-selection`) before it could reach the root table.
The bare-vs-sequence distinction continues to be enforced inside the readline keypress handler per [TMUX-057](#tmux-057) — arrow-key sequences `\x1b[A` etc. are recognized by tmux as their own keys (not `Escape`) and never trigger this binding, and pasted ESC bytes arrive via bracketed-paste markers per [TMUX-058](#tmux-058) which tmux strips before key dispatch — so this item does not change ESC semantics beyond the pane-of-origin / copy-mode-state expansion.
As with the copy-mode bindings of [TMUX-062](#tmux-062) and the navigation bindings of [TMUX-063](#tmux-063), tmux's `root`, `copy-mode`, and `copy-mode-vi` key tables are server-global, so these entries outlive the tmux-play session; the `if-shell` guard keeps each binding inert in every other session and is the launcher's narrowest available scoping mechanism.
A future cleanup hook may reduce the binding lifetime, but safe cleanup must preserve any pre-existing user bindings and account for multiple concurrent tmux-play sessions.

### TMUX-065

When the launcher creates a tmux-play session, it shall bind `C-c` in the `root`, `copy-mode`, and `copy-mode-vi` key tables so that, while the active client is attached to the launched session, a single `C-c` pressed in any pane and in any mode triggers the [TMUX-026](#tmux-026) exit lifecycle on the Boss/Captain pane (pane index 0).
Each of the three bindings shall be gated on the current `#{session_name}` matching the launched session name via `if-shell -F`, so that for any other tmux session on the same server the binding is a no-op and the original key is forwarded verbatim through that table's stock behavior.
Each binding's true branch shall first exit pane 0's copy-mode when pane 0 is in a mode and then deliver the Ctrl+C byte to pane 0 — `if -F -t <session>:0.0 '#{pane_in_mode}' 'send-keys -t <session>:0.0 -X cancel'` followed by `send-keys -t <session>:0.0 C-c` — because a `C-c` delivered via `send-keys` to a pane that is itself in copy-mode is consumed by copy-mode's stock `cancel` and never reaches the Boss readline, so without the prior cancel the forwarded byte raises no signal when pane 0 is the scrolled pane.
Each binding's false branch shall reproduce that table's stock binding verbatim — `send-keys C-c` for `root`, and `send-keys -X cancel` for `copy-mode` and `copy-mode-vi` — so other tmux sessions on the same server retain stock `Ctrl+C` and stock copy-mode `C-c` behavior.
Binding `C-c` in the `copy-mode` and `copy-mode-vi` tables in addition to `root` is required because, while the active pane is scrolled into copy-mode, tmux dispatches `C-c` through the mode table's stock `send-keys -X cancel` rather than the `root` binding, so a `root`-only binding would merely cancel copy-mode on the first press and need a second press to quit.
Player panes are read-only per [TMUX-027](#tmux-027) — their `pane-input-off=1` would otherwise swallow `Ctrl+C` entirely; intercepting at the key table fires the binding before the pane sees the key, so the `exit: ctrl+c` hint advertised by `status-left` per [TMUX-063](#tmux-063) is honored from every pane in the launched session, not only from the Boss/Captain pane whose readline already raises the signal.
Once delivered to the Boss/Captain pane, the Captain process handles the byte per [TMUX-026](#tmux-026): the runtime aborts the active turn, runs shutdown per [TMUX-019](#tmux-019), kills the tmux session, and removes launcher-owned work directories.
As with the copy-mode bindings of [TMUX-062](#tmux-062) and the navigation bindings of [TMUX-063](#tmux-063), tmux's root, `copy-mode`, and `copy-mode-vi` key tables are server-global, so these entries outlive the tmux-play session; the `if-shell` guard keeps each binding inert in every other session and is the launcher's narrowest available scoping mechanism.
A future cleanup hook may reduce the binding lifetime, but safe cleanup must preserve any pre-existing user bindings and account for multiple concurrent tmux-play sessions.

## Pane Titles

### TMUX-036

The Boss/Captain pane title shall be `Captain`. Each player pane title shall be the player `id` rendered with the first character upper-cased and the remaining characters preserved (e.g., `coder` → `Coder`, `reviewer` → `Reviewer`). The literal `Player:` prefix shall not appear in pane titles.

## Presenter Output

### TMUX-037

While in session mode, the Boss readline shall echo the user's input line as the user types it (standard readline behavior). When the runtime emits `turn_started`, the presenter shall not write the Boss prompt to the Boss/Captain pane, so the user's input shall appear exactly once in the pane.
This as-typed echo is scoped to the ready (between-turns) `boss> ` prompt; while a Boss turn is active the live readline prompt is suspended per [TMUX-075](#tmux-075), so type-ahead the Boss enters during the turn is not echoed as a `boss> ` line until [TMUX-075](#tmux-075) restores the prompt.

### TMUX-057

Where session mode is running with TTY stdin, while a Boss turn is active, when the Boss presses a bare ESC key in the Boss/Captain pane, the session shall abort the active turn without shutting down, preserve the Boss readline's current edit-buffer contents, and return to a ready `boss> ` prompt for the next Boss turn.
The Boss/Captain pane shall render the existing `[turn aborted] ESC` status line per [TMUX-040](#tmux-040).
The preserved edit-buffer contents are surfaced on the `boss> ` prompt when it is restored at turn end per [TMUX-075](#tmux-075), since while the turn is active that prompt is suspended.
While no Boss turn is active, a bare ESC keypress shall have no observable effect.
Terminal escape sequences that are not a bare ESC keypress (for example arrow-key sequences) shall not trigger a turn abort.
Where stdin is not a TTY, the ESC keybinding shall not be installed, and the SIGINT/SIGTERM/EOF lifecycle per [TMUX-026](#tmux-026) shall remain unchanged.
The readline ESC handler is the single point of ESC interpretation regardless of which pane in the launched session the Boss pressed the key in: ESC pressed in a player pane (whose `pane-input-off=1` would otherwise swallow the byte) or in any pane scrolled back into copy-mode (where the stock copy-mode `Escape` handling — `cancel` in emacs-mode `copy-mode`, `clear-selection` in vi-mode `copy-mode-vi` per [TMUX-070](#tmux-070) — would otherwise consume the keystroke before it could reach the root table) is forwarded to pane index 0 by [TMUX-070](#tmux-070), where this item's readline handler runs unchanged.

### TMUX-058

Where session mode is running with TTY stdin and TTY stdout, when the Boss pastes multi-line text into the Boss/Captain pane and then presses Enter, the session shall submit exactly one Boss turn whose `BossTurn.prompt` preserves the pasted text's embedded newlines as `\n` characters inside that single prompt string.
Bytes typed by the Boss after the paste and before that Enter shall be included in the same submission.
Where either stdin or stdout is not a TTY, the multi-line paste behavior shall be omitted and embedded newlines in pasted text shall behave as in the underlying readline.
The session shall enable bracketed paste only for its own duration and shall emit the bracketed-paste-disable sequence on every shutdown path so tmux-play does not leave bracketed-paste mode enabled in the terminal after exit.

### TMUX-075

Where session mode is running with TTY stdin, while a Boss turn is active — between the runtime's `turn_started` and the matching `turn_finished` or `turn_aborted` — the Boss/Captain pane shall paint no fresh `boss> ` readline prompt line (the input line already echoed for the submitted prompt per [TMUX-037](#tmux-037) is unaffected), so the turn's streaming presenter output is never interleaved with or followed by a fresh `boss> ` prompt that a turn-completion consumer reading the pane would misread as an implicit turn-over signal.
When the runtime starts a Boss turn, the session shall suspend or clear the live readline prompt before the turn's first presenter output reaches the pane.
When the turn ends — by normal completion, ESC abort per [TMUX-057](#tmux-057), or a runtime error — the session shall restore the `boss> ` prompt, but shall paint a fresh ready prompt only once no submitted Boss line remains queued. When the Boss has submitted further lines that queued behind the active turn (the runtime runs them one at a time per [TMUX-018](#tmux-018)), the session shall paint no ready `boss> ` prompt between the consecutive turns — each queued turn begins under the same suspension — and shall paint exactly one ready prompt after the last queued turn ends.
An empty or whitespace-only Boss submission shall paint a fresh ready `boss> ` prompt only while no Boss turn is active or queued; submitted while a turn is active or queued, it shall paint no `boss> ` prompt amid the turn's streaming output.
While a Boss turn is active, edit-buffer bytes the Boss types — or pastes per [TMUX-058](#tmux-058) — shall be preserved per [TMUX-057](#tmux-057) and surfaced on the restored prompt, and shall not render as a `boss> `-prefixed line until the prompt is restored.
Where stdin is not a TTY, no keypress handling is installed (per [TMUX-057](#tmux-057)) and there is no live (raw-mode, echoing) editing prompt whose `boss> ` chrome a keystroke could repaint mid-turn, so this item's active-turn suspension shall be a no-op; any static `boss> ` string the underlying readline writes between turns is unchanged by this item.

### TMUX-079

Where session mode is running with TTY stdout, while the Boss/Captain pane shows the live readline prompt, when the Boss edits the prompt — typing characters and deleting them, or any edit that triggers a line refresh — the Boss/Captain pane's tmux scrollback history shall gain no prompt row, so scrolling that pane up afterward reveals no phantom intermediate prompt rows (for example `boss> abc`, `boss> ab`, `boss> a` left behind after typing `abc` and backspacing it away).
This shall hold wherever the prompt sits in the pane, including at the top of a mostly-empty pane — the condition under which Node's readline line refresh, which clears to the end of the display before repainting, would otherwise make tmux scroll the erased on-screen rows into scrollback instead of blanking them.
Turn output the presenter writes to the Boss/Captain pane shall continue to scroll into that pane's scrollback as before, so only the readline prompt's own redraws are kept out of history, not legitimate content.
Where stdout is not a TTY, the readline produces no in-place line refresh, so this item shall be a no-op.
Because stock tmux already clamps a wheel-up at the oldest history line, removing this scrollback pollution at the source is sufficient: the launcher needs no `WheelUpPane` override (see [TMUX-062](#tmux-062)) to keep the Boss from scrolling past the pane's first line.

### TMUX-038

The presenter shall tag the first nonblank textual line of each tmux-play pane output block with a `<who>> ` prefix where `<who>` is `boss`, `captain`, or the speaker's player `id`. Continuation lines within the same block shall use a two-space hanging indent without repeating the speaker prefix. Blank lines shall remain blank and shall not count as continuation lines before the first nonblank line. The Boss readline prompt shall be `boss> `; the first nonblank line of the Captain's reply rendered in the Boss/Captain pane shall be prefixed with `captain> `; the first nonblank line of the Captain's prompt rendered in a player pane shall be prefixed with `captain> `; and the first nonblank line of the player's reply rendered in the player pane shall be prefixed with `<playerId>> `. Bracket-tag notation such as `[from captain]` or `[captain llm prompt]` shall not be used.

The presenter shall color the speaker prefix by wrapping its bytes — including the trailing space — in a bold 24-bit-foreground SGR pair: `\x1b[1;38;2;<r>;<g>;<b>m<who>> \x1b[0m`. Body text following the prefix shall remain unstyled by the presenter, so any ANSI bytes inside the body come from the body itself. Continuation indents shall stay uncolored. The speaker → color mapping is:

| Speaker | Mocha role | Hex |
| --- | --- | --- |
| `boss` | `blue` | `#89b4fa` |
| `captain` | `mauve` | `#cba6f7` |
| `<playerId>` | adapter-keyed via [TMUX-048](#tmux-048) `playerAccent(player.adapter)` | varies (e.g., `claude` → `#a6e3a1`) |

The Boss readline prompt set by session mode shall carry the same colored form (`\x1b[1;38;2;137;180;250mboss> \x1b[0m`); Node's readline strips ANSI from prompts when computing the visible width, so cursor positioning still treats the prompt as 6 cells wide.

Per [TMUX-050](#tmux-050), text bodies pass through `glow` before reaching the writer; the presenter applies the prefix and two-space hanging indent to `glow`'s rendered output, and budgets the visible prefix's cell width into the render width passed to `glow` so the prefixed first line and the indented continuation lines both fit the pane. Status lines (per [TMUX-039](#tmux-039)) and tool lifecycle lines (per [TMUX-049](#tmux-049)) bypass `glow` — they are single-line operational text — and apply the speaker prefix plus the bracketed-tag grammar directly. The speaker prefix grammar now governs tool lines as well; the `tool>` / `tool<` prefix replacement is retired.

### TMUX-039

Every operational line in a tmux-play pane shall follow one unified shape: `<who>> [<tag> <optional glyph>] <optional body>`. The `<who>> ` speaker prefix follows [TMUX-038](#tmux-038); the bracketed tag is one of the kinds in the table below; the body, when present, lives outside the brackets — not after a colon inside them. Colored tags (kinds whose row in the table below assigns a tag color) carry their own bold 24-bit-foreground SGR span distinct from the surrounding speaker prefix span; uncolored tags (`[status]`, `[tool ↪]`) are emitted plain so the surrounding text style passes through. The body remains unstyled by the presenter. Lines whose body is non-empty emit `<who>> [tag] <body>`; lines with no body emit just `<who>> [tag]` — `[aborted]` always (per [TMUX-033](#tmux-033)) and `[turn aborted]` when the `turn_aborted` record carries no reason. No synthesized placeholder body shall be inserted when a source field is absent.

The glyph slot is optional and is only populated for kinds with multi-state semantics — tools today. Single-state kinds (status, error, aborted, turn-aborted, runtime-error) carry no glyph; the word in the tag names the kind and color names the outcome.

When a player or Captain run finishes with `status: 'ok'`, the presenter shall not write a trailing status line such as `[player <id> ok]` or `[captain ok]`. When a run finishes with `status: 'error'`, the presenter shall write a single `<who>> [error] <message>` line in the corresponding pane, where `<message>` is the result's `error` field. When a run finishes with `status: 'aborted'`, the presenter shall write a single `<who>> [aborted]` line; per [TMUX-033](#tmux-033) aborted results need not carry a reason, so no reason is rendered.

The kind table:

| Tag | Glyph slot | Body | Tag color | Source record / event |
| --- | --- | --- | --- | --- |
| `[status]` | — | message + optional structured-data tail | uncolored | `captain_status` |
| `[error]` | — | result `error` field | `red` (`#f38ba8`) | `player_finished` / `captain_finished` with `status: 'error'` |
| `[aborted]` | — | — | `yellow` (`#f9e2af`) | `player_finished` / `captain_finished` with `status: 'aborted'` |
| `[turn aborted]` | — | turn-abort reason when present | `yellow` (`#f9e2af`) | `turn_aborted` |
| `[runtime error]` | — | runtime-error message | `red` (`#f38ba8`) | `runtime_error` |
| `[tool ↪]` | `↪` (call) | tool name + input summary | uncolored | `tool_use` |
| `[tool ✓]` | `✓` (ok) | tool name + duration | `green` (`#a6e3a1`) | `tool_result` `status: 'success'` |
| `[tool ✗]` | `✗` (err) | tool name + duration | `red` (`#f38ba8`) | `tool_result` `status: 'error'` |
| `[tool ·]` | `·` (denied) | tool name + duration | `yellow` (`#f9e2af`) | `tool_result` `status: 'denied'` |

The result is an operational line whose speaker prefix carries the speaker color, whose bracketed tag (when colored) carries the outcome color, and whose body is unstyled — e.g., `<captain-mauve>captain> </reset><red>[runtime error]</reset> boom`.

### TMUX-040

The Boss/Captain pane shall display the Boss's input lines, the Captain's synthesized reply or terminal Captain failure line per [TMUX-039](#tmux-039), operational records intended for that pane (`captain_status`, `runtime_error`, and `turn_aborted`), and Captain-emitted `tool_use` / `tool_result` events rendered per [TMUX-049](#tmux-049). Per-player outputs and the Captain's prompt body (which references player results) shall not be written to the Boss/Captain pane; player-emitted tool events remain in their respective player panes. Records from a `callCaptain` invocation tagged `visibility: 'hidden'` are the exception per [TMUX-072](#tmux-072): the Boss/Captain pane shall display none of them.

### TMUX-049

`tool_use` and `tool_result` events shall render under the unified bracketed-tag grammar of [TMUX-039](#tmux-039) in the calling entity's pane (the player pane for player-emitted events; the Boss/Captain pane for Captain-emitted events per [TMUX-040](#tmux-040)). The speaker prefix follows [TMUX-038](#tmux-038)'s `<who>> ` grammar — `captain> ` for Captain-emitted events and `<playerId>> ` for player-emitted events — and the bracketed tag follows [TMUX-039](#tmux-039)'s kind table. The `tool>` / `tool<` prefix replacement and its caller-accent rule are retired; speaker identity is carried in the `<who>> ` prefix, not in the bracketed tag's color.

A `tool_use` event shall render as a single line `<who>> [tool ↪] <toolName> <inputSummary>` where the bracketed tag is uncolored (the speaker prefix already carries identity) and the body — tool name + input summary — is unstyled.

`<inputSummary>` is the first non-empty string value found in `input` checked in priority order `command`, `file_path`, `path`, `pattern`, `query`, `prompt`, `description`, or a compact `JSON.stringify(input)` otherwise. The `query` slot covers search/fetch tools (ToolSearch, WebFetch wrappers, etc.) so a real query surfaces in the header instead of the JSON fallback. Whitespace runs in the chosen string shall be collapsed to single spaces and the result truncated at 60 cells with a trailing `…` when longer. When no usable summary exists, the line shall be `<who>> [tool ↪] <toolName>` with no trailing space.

A `tool_result` event shall render as a header line `<who>> [tool <symbol>] <toolName>[ <duration>]` followed by the tool's output as a continuation block. The `<symbol>` and the bracketed tag's SGR derive from `status` per [TMUX-039](#tmux-039)'s kind table: `✓` green for `success`, `✗` red for `error`, `·` yellow for `denied`. The body — tool name and optional duration — is unstyled.

`<duration>` is `<n>ms` when `durationMs < 1000`, `<n.n>s` otherwise; the duration segment is omitted when `durationMs` is undefined. When the extracted output (the string itself, or `output.stdout` when present, or the pretty-printed JSON of `output` otherwise) is empty or undefined, the header line stands alone with no body.

When the extracted output is non-empty, the presenter shall strip exactly one trailing line terminator (the `\n` that closes the payload's last line) from the body before wrapping it; trailing blank lines beyond that terminator are preserved so payloads that intentionally end with a blank row (e.g., a file whose final line is empty) survive into the rendered output.
The body shall then be wrapped in a fenced code block and rendered through `renderMarkdown` per [TMUX-050](#tmux-050), including [TMUX-050](#tmux-050)'s successful-render rule that emitted lines do not retain `glow`'s trailing horizontal padding while leading whitespace remains intact; existing two-space continuation indentation remains unchanged.
Every nonblank line of the rendered output shall be prefixed with two spaces and emitted after the header, and blank lines shall remain blank (unindented) so the fenced-code frame and any payload edge blanks read as the user would see them in a `glow` pane outside this presenter.
The fence shall be a run of backticks one longer than the longest backtick run anywhere in the payload, with a minimum of three, so any embedded ```` ``` ```` in the payload stays inert as literal content instead of terminating the wrapper early and leaking the tail into Markdown rendering.
The render width shall be `max(1, paneWidth - 2)`, matching the two-space continuation indent.
Tool-result bodies keep this continuation-body budget rather than the text-block pane-width compensation because they are fenced verbatim output: edge fill is not a goal, and `glow`'s code-block rendering may intentionally leave long code lines unwrapped or overflowed.

`glow`'s code-block rendering owns the body's styling and leaves long code lines unwrapped by design; the prior `overlay0` `#6c7086` dim SGR around the body is no longer applied because `glow`'s styling supersedes it. The presenter shall trim at most one leading and at most one trailing blank line from `glow`'s rendered body output — `glow`'s outer paragraph margin — before the two-space indent is applied, matching [TMUX-050](#tmux-050)'s outer-margin trim. Any further blank lines (the fenced-code frame `glow` emits around the payload, and any blank rows inside the payload itself) shall be preserved so the body's visible structure survives the indent pass. When `renderMarkdown` raises a mid-session failure (rare given the [TMUX-051](#tmux-051) launcher gate), the presenter shall emit the raw body text under the same two-space continuation indent rather than crash the session, and shall not apply the successful-render padding strip to that raw fallback body. The outer-margin trim shall not apply on the fallback path: the raw body never passed through `glow` and so carries no outer paragraph margin to strip, and trimming would mistake a payload trailing blank row for a margin and silently lose it — directly violating this item's payload-trailing-blank-preservation rule.

### TMUX-050

While in session mode, the presenter shall buffer text from `text_delta` and `text` events per `(writer, block)` and render the buffered text through `renderMarkdown` per [TMUX-051](#tmux-051) at the next block boundary. Block boundaries are: a `player_finished` or `captain_finished` record; a `text` event (always a complete block); a `tool_use` or `tool_result` event on the same writer; a `player_prompt` on the same writer; any status emission (`captain_status`, `runtime_error`, `turn_aborted`) on the same writer.

The render width for text blocks shall be `max(1, paneWidth)`. When no pane-width source is configured for the writer, the render width shall default to `80`.
This budget compensates for `glow`'s built-in two-cell document margin in the built-in `dark` / `light` styles: after `glow` wraps ordinary prose and the presenter strips trailing right padding, a rendered continuation row that reaches `glow`'s wrap limit plus the presenter's two-space continuation indent shall reach the pane width rather than stopping short.
The presenter shall preserve `glow`'s leading document margin, so a nonblank continuation row rendered by `glow` carries the presenter's two-space continuation indent followed by `glow`'s two-space document margin.
The presenter shall then prefix-fit the first visible rendered row only: if adding the speaker's `<who>> ` first-line prefix would exceed the pane display width, the presenter shall split that first rendered row at a cell-aware word boundary, write the first segment after the colored `<who>> ` prefix, and write the remaining segment as the next two-space-indented continuation row.
The prefix-fit split shall preserve ANSI escape sequences as zero-width bytes and shall not color the continuation indent.
For breakable prose, emitted text-block rows shall remain within the pane's display width without relying on terminal-level rewrap. Glow-inherent overflow remains allowed for unbreakable long tokens, tables, and other preformatted shapes that `glow` itself does not wrap at the requested width.

After successful rendering, no line emitted by the presenter shall retain `glow`'s trailing horizontal line padding.
Trailing padding includes right-side padding cells emitted by `glow`, including padding followed only by SGR resets; leading whitespace shall be preserved, so `glow`'s left margin and the presenter's existing indentation behavior remain unchanged.
The presenter shall trim at most one leading and at most one trailing blank line from `glow`'s output — `glow`'s default outer paragraph margin — before the prefix grammar is applied.
Any further blank lines (whether between paragraphs, around a fenced-code frame, between table rows, or anywhere else `glow` emits structural blanks) shall be preserved as blank lines but shall not retain `glow`'s right-padding cells.
The presenter shall then apply the [TMUX-038](#tmux-038) prefix grammar over the preserved `glow` output: the first nonblank line after the outer-margin trim carries the colored `<who>> ` prefix; any blank lines preceding it (e.g., the inner edge of a fenced-code frame) pass through unmodified; every nonblank continuation line carries the presenter's two-space hanging indent, and rendered continuation lines also retain `glow`'s leading document margin.
An all-blank rendered block (after the outer trim) shall emit no bytes to the writer, so empty content never surfaces as a stranded `<who>> ` line or a parade of padding blanks between consecutive turns.

`glow` owns word-boundary wrapping, fenced-code preservation, table layout, and inline-style rendering inside the block; except for the first-row prefix-fit split described above, the presenter shall not reflow `glow`'s output.
`renderMarkdown` shall receive the launcher-resolved Catppuccin flavor and invoke `glow` with the matching built-in style: `dark` for Mocha, `light` for Latte.
When `renderMarkdown` raises (a rare mid-session failure given the [TMUX-051](#tmux-051) launcher gate), the presenter shall emit the buffered raw text under the same prefix grammar rather than crash the session, and shall not apply the `glow`-padding strip to that raw fallback text.

`text_delta` events accumulate until a boundary fires. Token-by-token streaming is the deliberate tradeoff: Markdown is not a streamable format — a renderer cannot tell whether subsequent bytes belong to an open fence until the closing fence arrives — so partial rendering would corrupt fenced code, tables, and lists.

Status lines (per [TMUX-039](#tmux-039)) and tool lifecycle lines (per [TMUX-049](#tmux-049)) bypass the buffer-then-render pipeline: each is a single line of operational text, not Markdown, and writes directly with the speaker prefix and the bracketed-tag grammar applied.

### TMUX-046

_Superseded for text-body wrapping by [TMUX-050](#tmux-050): `glow` owns word-boundary wrapping inside rendered blocks. The cell-measurement rules below remain authoritative for tool-input truncation per [TMUX-049](#tmux-049). The character-level soft-wrap algorithm, the escape-parser carry, and the SGR close/reopen invariant described in the remainder of this item no longer apply to text bodies and are not implemented by the presenter; they are retained here for spec history and to keep the cell-measurement table addressable from one item._

The two-space hanging indent required by [TMUX-038](#tmux-038) shall apply to every visible continuation line in a pane, whether the line break is an explicit `\n` in the source text or a soft wrap inserted by the presenter when content would otherwise exceed the pane's current display width. The presenter shall soft-wrap each prefixed block at the per-pane display width by emitting `\n` followed by the two-space indent in place of the character that would have overflowed, so terminal-level rewrap is unnecessary and every wrapped row visibly carries the indent.

Display width shall be measured in terminal cells, not code points. The following codepoints shall count as 2 cells:

- Codepoints in the curated subset of East Asian Wide and Fullwidth blocks that the implementation tracks: Hangul Jamo and Hangul Jamo Extended-A and Hangul Syllables; CJK Radicals / Kangxi / Ideographic Description Characters and CJK Symbols and Punctuation; Hiragana, Katakana, Bopomofo, CJK Strokes, Enclosed CJK Letters and Months, and CJK Compatibility blocks through U+33FF; CJK Unified Ideographs and CJK Compatibility Ideographs and CJK Unified Ideographs Extensions A–G+; Yi Syllables and Radicals; Yijing Hexagram Symbols; Vertical Forms and CJK Compatibility Forms and Small Form Variants; Fullwidth ASCII (U+FF00–U+FF60) and Fullwidth signs (U+FFE0–U+FFE6); Ideographic Symbols and Punctuation (U+16FE0–U+16FE4) and Ideographic vertical forms (U+16FF0–U+16FF1); Tangut Ideographs and Tangut Components and Khitan Small Script and Tangut Supplement; Kana Extended-B and Kana Supplement and Kana Extended-A and Small Kana Extension; Nüshu; Tai Xuan Jing Symbols and Counting Rod Numerals.
- Codepoints at `cp >= 0x2300` whose Unicode `Emoji_Presentation` property is `Yes`, including BMP emoji such as U+231A ⌚ and U+2615 ☕ and every supplementary emoji block — including blocks added in future Unicode releases — so this rule does not need a source update when Unicode adds new emoji.

The list above is a curated subset of Unicode East Asian Width = Wide/Fullwidth, not the full set. JavaScript regex does not expose the `East_Asian_Width` property, so any codepoint that is EAW=W or =F per Unicode but is neither in the enumerated blocks nor `Emoji_Presentation` — for example, archaic scripts or rare symbol blocks not yet enumerated here — shall be measured as 1 cell. Soft-wrap based on this measurement may therefore over-fill the pane for such codepoints; this is the documented limitation of the implementation's table.

Unicode combining marks (`\p{M}`) and zero-width formatting codepoints (ZWSP, ZWNJ, ZWJ, Word Joiner, BOM) count as 0 cells, and C0/C1 control bytes other than `\n` count as 0 cells. ANSI escape sequences (CSI `ESC [` … final byte `0x40`–`0x7E`; OSC `ESC ]` … terminated by BEL or ST; and the simple `ESC` + next-byte form) shall pass through with 0 cells and shall never be split across a soft-wrap boundary. The presenter shall keep its escape-parser state per writer across streaming writes (e.g., per `text_delta` event), so a CSI/OSC/`ESC` sequence whose bytes arrive in two or more chunks is reassembled into a single zero-width escape token before any subsequent visible byte is placed. At every block boundary on a writer — including the start of any non-streaming prefixed block, the start of a status line, and the close of a run regardless of `status` — the presenter shall drain its pending escape parser state, emitting any still-unterminated escape bytes verbatim to that block's writer before writing the boundary newline, so the next block parses from a clean state and cannot have its leading byte consumed as the missing terminator of an earlier escape.

The presenter shall track the last body-emitted SGR opener (a CSI sequence ending in `m` that is not a reset) per writer.
At every continuation boundary — soft-wrap, explicit newline, or any path that emits a continuation indent — the presenter shall close that SGR (emit `\x1b[0m`) before the `\n`, emit the uncolored continuation indent, and re-emit the same opener after the indent so the body's color resumes on the new row.
This historically held the [TMUX-038](#tmux-038) "continuation indents shall stay uncolored" invariant for status bodies that opened an SGR span and crossed a line break — the rule was motivated by the retired `[error: msg]` / `[runtime error: msg]` / `[turn aborted: reason]` shape in which the entire bracketed body, including the wrapping message, sat inside one SGR span. Under the current [TMUX-039](#tmux-039), status bodies sit outside the brackets and are unstyled by the presenter, so the bracketed tag's SGR span closes inside the line and no presenter-opened body SGR survives across a wrap; the rule has no live caller and is retained only as spec history alongside the rest of this item, expressly so the retired inside-brackets coloring model is not reintroduced.
Non-SGR CSI sequences (cursor movement, erase, etc., terminated by bytes other than `m`) do not change color/style and are not subject to this close/reopen rule.

Width sources: the Boss/Captain pane width shall track the captain's stdout `columns` property, which Node refreshes via SIGWINCH on terminal resize. Each player pane width shall be queried from tmux at session start; the session shall refresh player widths when its stdout emits `'resize'` (the in-pane SIGWINCH that follows the tmux resize hooks set per [TMUX-044](#tmux-044)) and again before each Boss turn as a safety net. When a width source is unavailable or the value would not leave room for the two-space indent, the writer shall fall back to no soft wrap.

## Theme

### TMUX-047

The launcher shall apply a **Catppuccin flavor** (Mocha for dark terminals, Latte for light) per [[1]] to the session's appearance options before any content-bearing option in [TMUX-036](#tmux-036), [TMUX-038](#tmux-038)–[TMUX-040](#tmux-040), or [TMUX-044](#tmux-044) is set, so the launcher's own pane-border-format and status-left/status-right strings remain authoritative for any option a future theme might also claim. Catppuccin ships both flavors with matching role keys; selecting the flavor whose `mantle` band reads as a subtle tonal step on the user's terminal canvas — rather than an inverted dark block on light or vice versa — is the canonical pattern.

The flavor shall resolve in this priority: (1) explicit `themeFlavor` on the programmatic `launchTmuxPlay` option, when present and one of `'mocha' | 'latte'`; (2) the YAML config's `theme` field per [TMUX-006](#tmux-006), when present and one of `'mocha' | 'latte'`; (3) after those concrete overrides are exhausted, an OSC 11 terminal-background query when auto-detection is active and the launcher is going to attach, or when [TMUX-061](#tmux-061) diagnostics mode is explicitly requested; (4) default Mocha.

The OSC 11 query shall write `OSC 11 ; ? BEL` (`\x1b]11;?\x07`) to the controlling terminal, read for a bounded short timeout, accept either BEL or ST termination, parse `rgb:RR/GG/BB` and `rgb:RRRR/GGGG/BBBB` replies, compute relative luminance as `0.2126 * R + 0.7152 * G + 0.0722 * B` over normalized channel values, and select Latte for luminance `>= 0.5`, otherwise Mocha. Failure to open the controlling terminal, failure to receive a parseable reply, non-interactive launcher mode (`attach: false` or non-TTY stdin/stdout), or timeout shall select Mocha with reason `fallback`. The launcher shall write the resolved (concrete) flavor into the session work-dir snapshot per [TMUX-034](#tmux-034) so the session subprocess uses the same flavor for pane-content SGR colors per [TMUX-038](#tmux-038) without re-running detection.

The `window-style` and `window-active-style` options are NOT claimed — the canonical Catppuccin tmux pattern leaves the pane content area on the user's terminal-native canvas, and switching flavor by host bg is what keeps the band tonally correct without forcing a dark UI onto a light terminal.

The theme shall set exactly these tmux options and no others (`<text>`, `<mantle>`, etc. resolve to the Mocha or Latte hex per the resolved flavor):

| Option | Value | Note |
| --- | --- | --- |
| `default-terminal` | `tmux-256color` | Truecolor enablement so the hex values below render rather than quantizing to the nearest 256-color index. Set on the session. |
| `terminal-overrides` | append `,*:RGB` | Server option; the leading-comma list-separator idiom prepends `*:RGB` without clobbering existing entries. tmux normalizes the stored value, so `show-options -gv terminal-overrides` reports the entry as `*:RGB`. |
| `status-style` | `fg=<text>,bg=<mantle>` | Catppuccin text on the mantle band. Mocha: `fg=#cdd6f4,bg=#181825`. Latte: `fg=#4c4f69,bg=#e6e9ef`. |
| `pane-border-style` | `fg=<overlay0>` | Inactive border; dimmer than the active border for at-a-glance contrast per [TMUX-048](#tmux-048). Mocha: `fg=#6c7086`. Latte: `fg=#9ca0b0`. |
| `pane-active-border-style` | `fg=<blue>` | Mocha: `fg=#89b4fa`. Latte: `fg=#1e66f5`. |
| `message-style` | `fg=<base>,bg=<peach>` | Mocha: `fg=#1e1e2e,bg=#fab387`. Latte: `fg=#eff1f5,bg=#fe640b`. |
| `message-command-style` | `fg=<base>,bg=<green>` | Mocha: `fg=#1e1e2e,bg=#a6e3a1`. Latte: `fg=#eff1f5,bg=#40a02b`. |
| `display-panes-colour` | `<overlay0>` | |
| `display-panes-active-colour` | `<mauve>` | Mocha: `#cba6f7`. Latte: `#8839ef`. |
| `clock-mode-colour` | `<mauve>` | |

`window-style` and `window-active-style` are not claimed: the canonical Catppuccin tmux pattern leaves the pane content area as the user's terminal-native canvas, and a per-host flavor choice gives the theme adaptive surface tone without overriding the terminal background. `window-status-style` and `window-status-current-style` are not claimed either: the window-list formats below ([TMUX-055](#tmux-055)) are set to empty strings, so those style options have nothing to color and any tmux default for them is inert. `pane-border-format`, `pane-border-status`, `status-left`, `status-left-length`, `status-right`, `status-right-length`, `window-status-format`, `window-status-current-format`, and `window-status-separator` are NOT claimed by the theme; they remain owned by the clauses cited above (and [TMUX-048](#tmux-048) for the format) and shall be set after the theme so a future swap is a one-place change.

### TMUX-048

The launcher shall set each pane's title to `<Display> · <adapter>` where `<Display>` is `Captain` for the Boss/Captain pane and the title-cased player id (per [TMUX-036](#tmux-036)) for each player pane, and `<adapter>` is the adapter name configured in the YAML config for the captain or the player respectively. The middle separator shall be ` · ` (space + U+00B7 middle dot + space).

The launcher shall publish a stable per-adapter accent color, surfaced to consumers (the presenter, per [TMUX-038](#tmux-038) Task 2 and the launcher's own per-pane timer accents) as a single lookup keyed by adapter name and the resolved Catppuccin flavor from [TMUX-047](#tmux-047). Each adapter maps to the same role across flavors (claude → green, codex → teal, etc.) so the session reads the matching variant. Known adapter accents:

| Adapter | Role | Mocha hex | Latte hex |
| --- | --- | --- | --- |
| `claude` | `green` | `#a6e3a1` | `#40a02b` |
| `codex` | `teal` | `#94e2d5` | `#179299` |
| `gemini` | `lavender` | `#b4befe` | `#7287fd` |
| `opencode` | `pink` | `#f5c2e7` | `#ea76cb` |

For an adapter name outside the table, the lookup shall return a stable color from a fallback pool selected deterministically from the adapter name so repeated lookups for the same name yield the same color. The Mocha pool is `sapphire #74c7ec`, `sky #89dceb`, `rosewater #f5e0dc`, `maroon #eba0ac`, `flamingo #f2cdcd`; the Latte pool is the same roles at their Latte hex (`sapphire #209fb5`, `sky #04a5e5`, `rosewater #dc8a78`, `maroon #e64553`, `flamingo #dd7878`). Neither pool shall contain any accent reserved for speaker / tool / status roles (`blue`, `mauve`, `peach`, `red`, `yellow`, `green`).
The Boss/Captain pane's timer accent shall use Catppuccin `mauve` at the flavor-resolved hex (`#cba6f7` on Mocha, `#8839ef` on Latte), so the Captain pane timer reads against the mantle band on either polarity rather than washing out under a Mocha-only lookup on a Latte session.

When the launcher sets `pane-border-format`, only the Boss/Captain pane (pane index 0) shall carry the highlighted blue title block, and only while it is the active pane. Player pane titles — even when active — shall never carry the highlight block (they are read-only per [TMUX-027](#tmux-027) and don't need a focus indicator there); the format's else branch shall render their titles on the resolved flavor's mantle surface (`fg=text,bg=mantle`).
The pane-border row shall carry an explicit Catppuccin mantle background end-to-end after the title segment, so the separator, timer glyph, and timer duration text all sit on the same theme-defined surface. The pane content area above this row stays on the user's terminal-native canvas (no `window-style` claim per [TMUX-047](#tmux-047)); the mantle band on the border row reads as a tonal step away from that canvas — darker on a dark terminal under Mocha, lighter-but-distinct on a light terminal under Latte — so the title-and-timer band always stands out from pane content without inverting the user's chosen polarity.
The launcher shall set `pane-border-status` to `top` so each pane's title-and-timer row renders above its content. The bottom edge of each pane is the tonal step between the user's terminal-native pane content and the mantle status bar below, which serves as the pane's lower visual boundary without claiming a second border row.
The format's whitespace shall be symmetric: exactly one space precedes the `#{pane_title}` substitution and exactly one space follows the timer text substitution before the trailing `#[default]` reset, so the title-and-timer band sits with equal left and right padding rather than reading flush-right against the next pane's separator.

## Run-Time Timers

### TMUX-053

While a tmux-play session is running, the session shall maintain cumulative active-time timers derived from existing record timestamps.
A player pane's timer shall add `player_finished.timestamp - player_prompt.timestamp` for each run of that player.
The Boss/Captain pane's timer shall add `captain_finished.timestamp - captain_prompt.timestamp` for each Captain run.
The session-total timer shall add `(turn_finished.timestamp | turn_aborted.timestamp) - turn_started.timestamp` for each Boss turn.
While a player, Captain, or turn occurrence is open, the corresponding displayed timer shall equal its accumulated closed duration plus `now - <open-start>.timestamp`.
The player and Captain timers shall not include gaps between that participant's runs, and the session-total timer shall not include gaps between Boss turns.

### TMUX-054

When the launcher constructs a tmux-play session, each pane border shall include that pane's cumulative active-time timer.
The Boss/Captain pane border timer shall display the Captain timer from [TMUX-053](#tmux-053), and each player pane border timer shall display that player's timer from [TMUX-053](#tmux-053).
The pane-border timer shall not replace or remove the pane title and adapter information required by [TMUX-048](#tmux-048).
While a pane's current run is open, its timer shall refresh roughly once per second and render with the running glyph `⏳` plus the bright Catppuccin accent for that pane: `mauve` (`#cba6f7`) for Captain and [TMUX-048](#tmux-048)'s adapter accent for a player.
When a pane has no open run, its timer shall render frozen with the settled glyph `⌛` plus a Catppuccin text-level neutral color such as `subtext1` (`#bac2de`), not `overlay1` (`#7f849c`), so the timer remains legible against the Mocha mantle pane-border surface required by [TMUX-048](#tmux-048).
The timer format shall budget two display cells for each emoji glyph because terminal emoji presentation is not uniformly reported by tmux.
The glyph's own color shall be left to the terminal's emoji font; the duration text shall carry the Catppuccin running/frozen cue.

### TMUX-055

When the launcher constructs a tmux-play session, the navigation hints shall be rendered in `status-left`, and the session-total timer from [TMUX-053](#tmux-053) shall be rendered in `status-right`.
The `status-left` segment shall open with the bold brand heading `Spex` rendered in the resolved Catppuccin flavor's `blue` accent per [TMUX-047](#tmux-047), followed by a single space and then the navigation hints whose shape is owned by [TMUX-063](#tmux-063); the heading text shall be `Spex` and shall not be `spex`, `Cligent`, or `tmux-play`.
The launcher shall suppress tmux's default window-list segment by setting `window-status-format`, `window-status-current-format`, and `window-status-separator` to empty strings, so the status bar does not render window text such as `0:node*`.
The status-total timer shall refresh roughly once per second while a Boss turn is open and shall freeze between Boss turns.
The status-total timer shall use the hourglass pair from [TMUX-054](#tmux-054) — the running glyph `⏳` while a Boss turn is open and the settled glyph `⌛` between turns — so the bottom-right status timer reads with the same flowing-vs-settled cue as the per-pane title timers.
While a Boss turn is open, the duration text shall use Catppuccin `mauve` (`#cba6f7`); between turns, it shall use `overlay1` (`#7f849c`).
The launcher shall set sufficient `status-left-length` and `status-right-length` values so the hints and total timer are not truncated under the 174-column initial window from [TMUX-035](#tmux-035).

### TMUX-071

The duration text for every per-pane timer of [TMUX-054](#tmux-054) and for the status-bar total timer of [TMUX-055](#tmux-055) shall be rendered in `hh:mm:ss` form, derived from the non-negative integer `s = floor(elapsedMs / 1000)` where `elapsedMs` is the timer's elapsed milliseconds from [TMUX-053](#tmux-053) clamped to zero for any negative value, with `h = floor(s / 3600)`, `m = floor(s / 60) mod 60`, and `n = s mod 60`.
The duration text shall be the literal string `<HH>:<MM>:<SS>`, where `<MM>` is `m` and `<SS>` is `n` each rendered as a decimal integer zero-padded to exactly two digits, the components are joined by a single ASCII colon (`:`), and the three components are always present at every magnitude so a session that has accumulated zero active time surfaces as `00:00:00` and a session that has accumulated exactly one hour surfaces as `01:00:00`.
The `<HH>` field shall be the decimal integer `h` zero-padded to at least two digits, expanding to additional digits when `h >= 100` so the format remains monotonic past one hundred hours (`100:00:00` shall follow `99:59:59`) rather than truncating or wrapping.
The duration text shall always carry exactly two digits per component while `h < 100`, so the rendered width stays stable from one second to the next and the Boss never loses sub-minute resolution as a session ages.

## Player Session Continuity

### TMUX-041

Within a single tmux-play session, each player's `Cligent` instance shall be created once and reused across every Boss turn. Per [ENG-005](engine.md#eng-005), the engine shall auto-inject `resume` on subsequent runs when the underlying adapter emits a `resumeToken`, so player responses on later turns may build on prior context for adapters that support session continuity.
This continuity shall include an ESC-aborted Boss turn when a player's interrupted adapter `done` carries a `resumeToken` per [ENG-009](engine.md#eng-009): the next Boss turn that calls the same player shall pass that token as `resume`. When the interrupted `done` carries no `resumeToken`, tmux-play shall expose the aborted, not-resumable result through [TMUX-033](#tmux-033) and keep the player callable normally after the aborted round without rewriting prompts at the runtime or engine layer.

### TMUX-042

The built-in fanout Captain shall convey each player's identity once, via the player's `instruction` configured at `Cligent` construction. Per Boss turn, the per-player prompt the fanout Captain passes to `callPlayer` shall be the Boss prompt verbatim, with no static framing label such as `The Boss asked:`, no player identity preamble such as `You are the "<player>" player`, and no trailing instructions that reference inter-player behavior (e.g., "Respond independently", "Do not wait for other players") — players cannot see other players, so such instructions are unactionable. Static framing labels and inter-player instructions are permitted only in prompts directed at the Captain itself (e.g., the summarization prompt passed to `callCaptain`), where they describe context for the synthesizer rather than instruct a player.
The verbatim player-prompt rule has one exception: when a player result has `status: 'aborted'` and no `resumeToken`, fanout shall retain that player's base Boss prompt as unresolved recovery context. On that player's next call, fanout shall pass a recovery prompt containing every retained base Boss prompt for that player plus the latest Boss prompt. Consecutive no-token aborts shall append only base Boss prompts, not already-composed recovery prompts, so recovery prompts do not nest or balloon. Fanout shall clear a player's retained recovery context after any non-aborted result, or after an aborted result that carries `resumeToken`, because those paths are either complete or backend-resumable.

## Captain Call Visibility

### TMUX-072

`callCaptain` shall accept an optional second argument `options: CallCaptainOptions` whose only field is `visibility: 'visible' | 'hidden'`, defaulting to `'visible'` when `options` or `visibility` is omitted.

A `'hidden'` call shall run identically to a `'visible'` call and shall return the same `CaptainRunResult` per [TMUX-033](#tmux-033) — same `status`, `turnId`, `finalText`, and `error`. The runtime shall still emit the call's `captain_prompt`, `captain_event*`, and `captain_finished` records in the order of [TMUX-022](#tmux-022), each carrying the resolved `visibility`, so non-presenter observers receive the full trace regardless of the tag.

The tmux presenter shall produce zero Boss/Captain-pane output for a `'hidden'` call: it shall skip the call's `captain_event` records (so their text never accumulates into a rendered block) and its `captain_finished` record (so no terminal reply, status, or error line is written), in addition to the Captain-prompt body already withheld per [TMUX-040](#tmux-040). For `'visible'` or omitted visibility, Boss/Captain-pane output shall be byte-for-byte identical to the behavior before this option existed.

Because a `'hidden'` call writes no bytes to the Boss/Captain pane, it shall not trigger the live-tail follow of [TMUX-069](#tmux-069): a Boss who has scrolled the Captain pane into copy-mode shall keep that scroll position across a hidden call, since a hidden call's records are no-visible-bytes activity under [TMUX-069](#tmux-069).

`callPlayer` shall not accept this option; player visibility is unchanged.

## References

[1]: https://catppuccin.com/palette/ "Catppuccin Palette"
[2]: https://github.com/charmbracelet/glow "glow — Render Markdown on the CLI"
