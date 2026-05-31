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

When `tmux-play` is invoked with `--session <id> --work-dir <path>`, the CLI shall run session mode: instantiate the Captain and players, run a Boss readline against stdin/stdout, dispatch records to observers, and clean up on exit.

### TMUX-004

When `--config <path>` is supplied, the launcher shall load that file and skip discovery and first-run auto-create.

### TMUX-061

When `--theme-diagnostics` is supplied, the CLI shall run theme-diagnostics mode: load the same config the launcher would load, resolve the Catppuccin flavor per [TMUX-047](#tmux-047), print `selected: <flavor>` and `reason: <explicit|yaml|osc11|fallback>` to stdout, include the raw OSC 11 reply when one was received, and exit without checking for `tmux` or `glow`, creating a tmux session, or attaching. `--theme-diagnostics` is launcher-mode only; when combined with `--session`, the CLI shall reject the invocation before dispatching session mode.

## Configuration

### TMUX-005

A `tmux-play` config shall be YAML with a `captain` object and a non-empty `players` array. The top-level config may also include an optional `theme` field per [TMUX-060](#tmux-060) and an optional `layout` field per [TMUX-064](#tmux-064).

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

### TMUX-007

Each entry in `players` shall require `id` and `adapter` (one of `claude`, `codex`, `gemini`, `opencode`), and may include `model`, `instruction`, a `permissions` object per [TMUX-052](#tmux-052), and `reasoningEffort` per [TMUX-056](#tmux-056). Player `id` shall match `^[a-z][a-z0-9_-]*$`, be unique within the config, and shall not equal `captain`. Multiple players may share an adapter and model.

### TMUX-052

The `captain` object and each `players` entry may include a `permissions` object whose typed shape is [ENG-021](engine.md#eng-021)'s `PermissionPolicy`: `mode` is `'auto' | 'bypass'`, and `fileWrite` / `shellExecute` / `networkAccess` are each `'allow' | 'ask' | 'deny'`.
The loader shall forward an accepted `permissions` value verbatim to the captain / player `Cligent` constructor as `CligentOptions.permissions` per [DR-005](../decisions/005-per-adapter-permission-configuration.md); the adapter performs the SDK-knob mapping at `run()` time per ENG-021.
The loader shall reject unknown sub-fields under `permissions` and values outside the closed sets above with an error that names the offending path per [TMUX-008](#tmux-008).
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

When neither location holds a config and `--config` is not supplied, the launcher shall create the home location with a default config, print a one-line notice naming the path on stdout, and continue. Subsequent invocations shall preserve the existing home config without overwriting.

### TMUX-011

The default home config shall wire the built-in `fanout` Captain on the `claude` adapter and two players whose IDs match their adapters: `claude` (claude adapter) and `codex` (codex adapter). The default Captain and default `claude` player shall use `model: claude-opus-4-8` with `reasoningEffort: xhigh`; the default `codex` player shall use `model: gpt-5.5` with `reasoningEffort: xhigh`. Each default player shall include an `instruction` that identifies that player for the runtime-created `Cligent` instance. The default Captain and each default player shall include `permissions: { mode: 'auto' }` per [TMUX-052](#tmux-052) so the shipped Claude Code and Codex CLI defaults run in each adapter's classifier-, sandbox-, or reviewer-protected auto-mode per [DR-005](../decisions/005-per-adapter-permission-configuration.md), reducing routine in-session permission prompts. The mode does not eliminate prompts or broaden sandbox/network permissions: per the SDK behavior tabulated in [DR-005](../decisions/005-per-adapter-permission-configuration.md), Claude's `auto` still blocks high-risk actions and falls back to prompts after consecutive/total denies, and Codex's `on-request + auto_review` with the `:workspace` permission profile routes eligible approval requests to a reviewer agent without broadening that profile's filesystem or network limits. This default lives in the example YAML only; per [DR-005](../decisions/005-per-adapter-permission-configuration.md) cligent imposes no project-wide permission posture for configs that omit `permissions`.
The default home config shall also include an explicit `layout` block per [TMUX-064](#tmux-064) — `window: { columns: 174, rows: 49 }` and `columnWeights: [1, 1, 1]` — so first-run users see the new knobs and the shipped multi-player layout default surfaces in the YAML rather than being implicit in the code.

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

`CaptainContext` shall expose a turn-scoped `signal: AbortSignal`, a readonly `players` manifest, and `callPlayer(playerId, prompt)` and `callCaptain(prompt)` methods. The methods shall return `PlayerRunResult` and `CaptainRunResult` respectively per [TMUX-033](#tmux-033).

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

`PlayerRunResult` shall expose `playerId`, `turnId`, and `status`, and may include `finalText` and `error`. `CaptainRunResult` shall expose `turnId` and `status`, and may include `finalText` and `error`. `status` values are `'ok' | 'aborted' | 'error'`; aborted results may carry neither `finalText` nor `error`.

## Launcher → Session Protocol

### TMUX-034

The launcher shall convert the resolved YAML config into a JSON snapshot written to the session's work directory, with local `captain.from` paths normalized to absolute `file://` URLs and package specifiers passed through unchanged. Session mode shall read the snapshot rather than reloading the YAML, so config changes made between launch and session start shall not affect the running session.

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
The launcher shall bind `MouseDown3Pane` in both key tables to `send-keys -X copy-pipe-and-cancel <system-clipboard-command>`, so right-clicking an active selection copies through tmux's normal copy path, pipes the selected text to the host system clipboard when a supported route is available, and exits copy mode.
The system clipboard command shall try `pbcopy`, Wayland `wl-copy`, X11 `xclip`, X11 `xsel`, and WSL `clip.exe`, then fall back to `tmux load-buffer -w -` for OSC 52 clipboard delivery through the attached terminal.
Customizing tmux copy-mode key tables is necessarily server-global because tmux does not offer per-session copy-mode bindings, so these four bindings outlive the tmux-play session; the launcher accepts that server-level footprint because preserving selection after mouse release is the requested UX and tmux has no narrower mechanism for it.
A future cleanup hook may reduce the binding lifetime, but safe cleanup must preserve any pre-existing user bindings and account for multiple concurrent tmux-play sessions.
Under tmux's default root mouse bindings, clicking selects the pane under the cursor and the scroll wheel enters or operates pane copy mode to scroll pane history.
User `Mouse*` / `Wheel*` rebindings may alter those default consequences.
The launcher shall not configure `set-clipboard` and shall not add `Wheel*` bindings; terminal policy may still block the OSC 52 fallback.

### TMUX-066

While a tmux-play session is running, when the Boss presses the primary mouse button on any pane in the launched session, the session shall cancel copy-mode in every pane in the session before focusing the clicked pane, so any active selection is cleared on the next click and at most one pane in the session may hold a copy-mode selection at any time.
The deselect behavior shall hold whether the clicked pane is currently in copy-mode or not, so a click on the pane that holds the selection clears it just as a click on a sibling pane does.
The launcher shall bind `MouseDown1Pane` in the `root`, `copy-mode`, and `copy-mode-vi` key tables, because tmux dispatches a mouse event through the clicked pane's mode-specific table when the pane is in a mode (`copy-mode` / `copy-mode-vi` both ship a default `MouseDown1Pane select-pane` that would otherwise shadow a `root`-only binding) and through the `root` table otherwise.
Each binding shall be gated on the current `#{session_name}` matching the launched session name via `if-shell -F`. The false branch shall reproduce tmux's stock per-table binding verbatim — `select-pane -t= ; send-keys -M` in the `root` table and `select-pane` in `copy-mode` and `copy-mode-vi` — so that in every other tmux session on the same server left-clicking retains tmux's default behavior. The `send-keys -M` forwarding in the `root` false branch shall not be omitted, since mouse-aware terminal applications (e.g. vim, less, htop) depend on it to receive forwarded clicks.
The true branch shall cancel copy-mode on every pane in the session that is currently in a mode and then run the same per-table tail as the false branch (`select-pane -t= ; send-keys -M` in `root`; `select-pane -t=` in `copy-mode` / `copy-mode-vi`), so the deselect logic does not regress mouse-event forwarding or click-to-focus in the launched session either.
The per-pane cancel shall be gated by `#{pane_in_mode}` so non-mode panes are not sent `-X cancel`, which would emit tmux's "no key table" error.
Drag-select per [TMUX-062](#tmux-062) shall be unaffected: `MouseDown1Pane` fires at the start of a drag and clears any prior selection, then `MouseDrag1Pane` (tmux's stock root binding) enters `copy-mode -M` on the dragged pane and begins a fresh selection.
As with the copy-mode bindings of [TMUX-062](#tmux-062) and the keyboard bindings of [TMUX-063](#tmux-063) / [TMUX-065](#tmux-065), tmux's `root`, `copy-mode`, and `copy-mode-vi` tables are server-global because tmux does not offer per-session bindings in those tables, so these entries outlive the tmux-play session; the `if-shell` guard keeps each binding inert in every other session and is the launcher's narrowest available scoping mechanism.
A future cleanup hook may reduce the binding lifetime, but safe cleanup must preserve any pre-existing user bindings and account for multiple concurrent tmux-play sessions.

## Keyboard Interaction

### TMUX-063

When the launcher creates a tmux-play session, it shall bind `C-Left`, `C-Right`, `S-Left`, and `S-Right` in the `root` key table so that, while the active client is attached to the launched session, `C-Left` and `S-Left` each run `select-pane -L` and `C-Right` and `S-Right` each run `select-pane -R`.
Shipping both `Ctrl+←/→` and `Shift+←/→` as equivalent pane-switch bindings gives an out-of-the-box default that works across macOS, Windows, and Linux terminal emulators — at least one of the two pairs reaches tmux untouched on every common host (macOS Terminal.app and iTerm2 frequently rebind `Ctrl+←/→` for shell word-movement, while many Linux desktops swallow `Shift+←/→` for window-manager workspace switching), so providing both pairs avoids forcing per-platform documentation or user keybinding tweaks.
Each binding shall be gated on the current `#{session_name}` matching the launched session name via `if-shell -F`, with a false branch of `send-keys C-Left` (resp. `C-Right`, `S-Left`, `S-Right`), so that for any other tmux session on the same server the binding is a no-op and the original `Ctrl+Left` / `Ctrl+Right` / `Shift+Left` / `Shift+Right` key is forwarded verbatim to the active pane.
This delivers the direct pane-switch UX that `status-left` advertises (`Switch pane: Ctrl+←/→ or Shift+←/→`) without requiring the `Ctrl+b` prefix.
The launcher shall render `status-left` with hints in the form `Switch pane: Ctrl+←/→ or Shift+←/→ | Stop: ESC | Exit: Ctrl+C | drag=select | right-click=copy`, naming the Boss-input ESC interrupt per [TMUX-057](#tmux-057) and the Ctrl+C exit lifecycle per [TMUX-026](#tmux-026); the retired `Ctrl+b, then: d=detach | o=switch pane | [=scroll (q exits)` hint fragments shall not appear.
As with the copy-mode bindings of [TMUX-062](#tmux-062), tmux's root key table is server-global because tmux does not offer per-session root-table bindings, so the four entries outlive the tmux-play session; the `if-shell` guard keeps each binding inert in every other session and is the launcher's narrowest available scoping mechanism.
A future cleanup hook may reduce the binding lifetime, but safe cleanup must preserve any pre-existing user bindings and account for multiple concurrent tmux-play sessions.

### TMUX-065

When the launcher creates a tmux-play session, it shall bind `C-c` in the `root` key table so that, while the active client is attached to the launched session, `C-c` runs `send-keys -t <session>:0.0 C-c`, delivering the Ctrl+C byte to the Boss/Captain pane (pane index 0) regardless of which pane is currently active.
The binding shall be gated on the current `#{session_name}` matching the launched session name via `if-shell -F`, with a false branch of `send-keys C-c`, so that for any other tmux session on the same server the binding is a no-op and the original `Ctrl+C` key is forwarded verbatim to the active pane.
Player panes are read-only per [TMUX-027](#tmux-027) — their `pane-input-off=1` would otherwise swallow `Ctrl+C` entirely; intercepting at the `root` key table fires the binding before the pane sees the key, so the `Exit: Ctrl+C` hint advertised by `status-left` per [TMUX-063](#tmux-063) is honored from every pane in the launched session, not only from the Boss/Captain pane whose readline already raises the signal.
Once delivered to the Boss/Captain pane, the Captain process handles the byte per [TMUX-026](#tmux-026): the runtime aborts the active turn, runs shutdown per [TMUX-019](#tmux-019), kills the tmux session, and removes launcher-owned work directories.
As with the copy-mode bindings of [TMUX-062](#tmux-062) and the navigation bindings of [TMUX-063](#tmux-063), tmux's root key table is server-global, so this entry outlives the tmux-play session; the `if-shell` guard keeps the binding inert in every other session and is the launcher's narrowest available scoping mechanism.
A future cleanup hook may reduce the binding lifetime, but safe cleanup must preserve any pre-existing user bindings and account for multiple concurrent tmux-play sessions.

## Pane Titles

### TMUX-036

The Boss/Captain pane title shall be `Captain`. Each player pane title shall be the player `id` rendered with the first character upper-cased and the remaining characters preserved (e.g., `coder` → `Coder`, `reviewer` → `Reviewer`). The literal `Player:` prefix shall not appear in pane titles.

## Presenter Output

### TMUX-037

While in session mode, the Boss readline shall echo the user's input line as the user types it (standard readline behavior). When the runtime emits `turn_started`, the presenter shall not write the Boss prompt to the Boss/Captain pane, so the user's input shall appear exactly once in the pane.

### TMUX-057

Where session mode is running with TTY stdin, while a Boss turn is active, when the Boss presses a bare ESC key in the Boss/Captain pane, the session shall abort the active turn without shutting down, preserve the Boss readline's current edit-buffer contents, and return to a ready `boss> ` prompt for the next Boss turn.
The Boss/Captain pane shall render the existing `[turn aborted] ESC` status line per [TMUX-040](#tmux-040).
While no Boss turn is active, a bare ESC keypress shall have no observable effect.
Terminal escape sequences that are not a bare ESC keypress (for example arrow-key sequences) shall not trigger a turn abort.
Where stdin is not a TTY, the ESC keybinding shall not be installed, and the SIGINT/SIGTERM/EOF lifecycle per [TMUX-026](#tmux-026) shall remain unchanged.

### TMUX-058

Where session mode is running with TTY stdin and TTY stdout, when the Boss pastes multi-line text into the Boss/Captain pane and then presses Enter, the session shall submit exactly one Boss turn whose `BossTurn.prompt` preserves the pasted text's embedded newlines as `\n` characters inside that single prompt string.
Bytes typed by the Boss after the paste and before that Enter shall be included in the same submission.
Where either stdin or stdout is not a TTY, the multi-line paste behavior shall be omitted and embedded newlines in pasted text shall behave as in the underlying readline.
The session shall enable bracketed paste only for its own duration and shall emit the bracketed-paste-disable sequence on every shutdown path so tmux-play does not leave bracketed-paste mode enabled in the terminal after exit.

### TMUX-067

Where session mode renders the Boss readline to a TTY of width `W` columns, while the Boss types or edits an input line whose prompt-plus-content visible width reaches or exceeds `W`, the Boss/Captain pane scrollback shall not accumulate duplicated copies of any input row, no rendered input row shall occupy the terminal's rightmost (`W`-th) column, and the cursor shall track the edit position across wrap boundaries.
The Boss input shall still appear exactly once per [TMUX-037](#tmux-037), and the ESC interrupt of [TMUX-057](#tmux-057) and the bracketed-paste submission of [TMUX-058](#tmux-058) shall continue to hold.
Where stdout is not a TTY, the duplicate-row and rightmost-column guarantees shall not apply and the Boss input shall be echoed as in the underlying readline.

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

The Boss/Captain pane shall display the Boss's input lines, the Captain's synthesized reply or terminal Captain failure line per [TMUX-039](#tmux-039), operational records intended for that pane (`captain_status`, `runtime_error`, and `turn_aborted`), and Captain-emitted `tool_use` / `tool_result` events rendered per [TMUX-049](#tmux-049). Per-player outputs and the Captain's prompt body (which references player results) shall not be written to the Boss/Captain pane; player-emitted tool events remain in their respective player panes.

### TMUX-049

`tool_use` and `tool_result` events shall render under the unified bracketed-tag grammar of [TMUX-039](#tmux-039) in the calling entity's pane (the player pane for player-emitted events; the Boss/Captain pane for Captain-emitted events per [TMUX-040](#tmux-040)). The speaker prefix follows [TMUX-038](#tmux-038)'s `<who>> ` grammar — `captain> ` for Captain-emitted events and `<playerId>> ` for player-emitted events — and the bracketed tag follows [TMUX-039](#tmux-039)'s kind table. The `tool>` / `tool<` prefix replacement and its caller-accent rule are retired; speaker identity is carried in the `<who>> ` prefix, not in the bracketed tag's color.

A `tool_use` event shall render as a single line `<who>> [tool ↪] <toolName> <inputSummary>` where the bracketed tag is uncolored (the speaker prefix already carries identity) and the body — tool name + input summary — is unstyled.

`<inputSummary>` is the first non-empty string value found in `input` checked in priority order `command`, `file_path`, `path`, `pattern`, `query`, `prompt`, `description`, or a compact `JSON.stringify(input)` otherwise. The `query` slot covers search/fetch tools (ToolSearch, WebFetch wrappers, etc.) so a real query surfaces in the header instead of the JSON fallback. Whitespace runs in the chosen string shall be collapsed to single spaces and the result truncated at 60 cells with a trailing `…` when longer. When no usable summary exists, the line shall be `<who>> [tool ↪] <toolName>` with no trailing space.

A `tool_result` event shall render as a header line `<who>> [tool <symbol>] <toolName>[ <duration>]` followed by the tool's output as a continuation block. The `<symbol>` and the bracketed tag's SGR derive from `status` per [TMUX-039](#tmux-039)'s kind table: `✓` green for `success`, `✗` red for `error`, `·` yellow for `denied`. The body — tool name and optional duration — is unstyled.

`<duration>` is `<n>ms` when `durationMs < 1000`, `<n.n>s` otherwise; the duration segment is omitted when `durationMs` is undefined. When the extracted output (the string itself, or `output.stdout` when present, or the pretty-printed JSON of `output` otherwise) is empty or undefined, the header line stands alone with no body.

When the extracted output is non-empty, the presenter shall strip exactly one trailing line terminator (the `\n` that closes the payload's last line) from the body before wrapping it; trailing blank lines beyond that terminator are preserved so payloads that intentionally end with a blank row (e.g., a file whose final line is empty) survive into the rendered output. The body shall then be wrapped in a fenced code block and rendered through `renderMarkdown` per [TMUX-050](#tmux-050); every nonblank line of the rendered output shall be prefixed with two spaces and emitted after the header, and blank lines shall remain blank (unindented) so the fenced-code frame and any payload edge blanks read as the user would see them in a `glow` pane outside this presenter. The fence shall be a run of backticks one longer than the longest backtick run anywhere in the payload, with a minimum of three, so any embedded ```` ``` ```` in the payload stays inert as literal content instead of terminating the wrapper early and leaking the tail into Markdown rendering. The render width shall be `max(1, paneWidth - 2)`, matching the two-space continuation indent.

`glow`'s code-block rendering owns the body's styling and leaves long code lines unwrapped by design; the prior `overlay0` `#6c7086` dim SGR around the body is no longer applied because `glow`'s styling supersedes it. The presenter shall trim at most one leading and at most one trailing blank line from `glow`'s rendered body output — `glow`'s outer paragraph margin — before the two-space indent is applied, matching [TMUX-050](#tmux-050)'s outer-margin trim. Any further blank lines (the fenced-code frame `glow` emits around the payload, and any blank rows inside the payload itself) shall be preserved so the body's visible structure survives the indent pass. When `renderMarkdown` raises a mid-session failure (rare given the [TMUX-051](#tmux-051) launcher gate), the presenter shall emit the raw body text under the same two-space continuation indent rather than crash the session. The outer-margin trim shall not apply on the fallback path: the raw body never passed through `glow` and so carries no outer paragraph margin to strip, and trimming would mistake a payload trailing blank row for a margin and silently lose it — directly violating this item's payload-trailing-blank-preservation rule.

### TMUX-050

While in session mode, the presenter shall buffer text from `text_delta` and `text` events per `(writer, block)` and render the buffered text through `renderMarkdown` per [TMUX-051](#tmux-051) at the next block boundary. Block boundaries are: a `player_finished` or `captain_finished` record; a `text` event (always a complete block); a `tool_use` or `tool_result` event on the same writer; a `player_prompt` on the same writer; any status emission (`captain_status`, `runtime_error`, `turn_aborted`) on the same writer.

The render width shall be `max(1, paneWidth - prefixWidth)` where `prefixWidth` is the cell width of the speaker's `<who>> ` first-line prefix. This budget keeps the prefixed first line and the two-space-indented continuations within the pane's display width without triggering a terminal-level rewrap. When no pane-width source is configured for the writer, the render width shall default to `80 - prefixWidth`.

After rendering, the presenter shall trim at most one leading and at most one trailing blank line from `glow`'s output — `glow`'s default outer paragraph margin — before the prefix grammar is applied. Any further blank lines (whether between paragraphs, around a fenced-code frame, between table rows, or anywhere else `glow` emits structural blanks) shall be preserved verbatim. The presenter shall then apply the [TMUX-038](#tmux-038) prefix grammar: the first nonblank line after the outer-margin trim carries the colored `<who>> ` prefix; any blank lines preceding it (e.g., the inner edge of a fenced-code frame) pass through unmodified; every nonblank continuation line carries the two-space hanging indent. An all-blank rendered block (after the outer trim) shall emit no bytes to the writer, so empty content never surfaces as a stranded `<who>> ` line or a parade of padding blanks between consecutive turns.

`glow` owns word-boundary wrapping, fenced-code preservation, table layout, and inline-style rendering inside the block; the presenter shall not reflow `glow`'s output. `renderMarkdown` shall receive the launcher-resolved Catppuccin flavor and invoke `glow` with the matching built-in style: `dark` for Mocha, `light` for Latte. When `renderMarkdown` raises (a rare mid-session failure given the [TMUX-051](#tmux-051) launcher gate), the presenter shall emit the buffered raw text under the same prefix grammar rather than crash the session.

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
The `status-left` segment shall open with the bold brand heading `Cligent` rendered in the resolved Catppuccin flavor's `blue` accent per [TMUX-047](#tmux-047), followed by a single space and then the navigation hints whose shape is owned by [TMUX-063](#tmux-063); the heading text shall be `Cligent` and shall not be `tmux-play`.
The launcher shall suppress tmux's default window-list segment by setting `window-status-format`, `window-status-current-format`, and `window-status-separator` to empty strings, so the status bar does not render window text such as `0:node*`.
The status-total timer shall refresh roughly once per second while a Boss turn is open and shall freeze between Boss turns.
The status-total timer shall use the hourglass pair from [TMUX-054](#tmux-054) — the running glyph `⏳` while a Boss turn is open and the settled glyph `⌛` between turns — so the bottom-right status timer reads with the same flowing-vs-settled cue as the per-pane title timers.
While a Boss turn is open, the duration text shall use Catppuccin `mauve` (`#cba6f7`); between turns, it shall use `overlay1` (`#7f849c`).
The launcher shall set sufficient `status-left-length` and `status-right-length` values so the hints and total timer are not truncated under the 174-column initial window from [TMUX-035](#tmux-035).

## Player Session Continuity

### TMUX-041

Within a single tmux-play session, each player's `Cligent` instance shall be created once and reused across every Boss turn. Per [ENG-005](engine.md#eng-005), the engine shall auto-inject `resume` on subsequent runs when the underlying adapter emits a `resumeToken`, so player responses on later turns may build on prior context for adapters that support session continuity.

### TMUX-042

The built-in fanout Captain shall convey each player's identity once, via the player's `instruction` configured at `Cligent` construction. Per Boss turn, the per-player prompt the fanout Captain passes to `callPlayer` shall be the Boss prompt verbatim, with no static framing label such as `The Boss asked:`, no player identity preamble such as `You are the "<player>" player`, and no trailing instructions that reference inter-player behavior (e.g., "Respond independently", "Do not wait for other players") — players cannot see other players, so such instructions are unactionable. Static framing labels and inter-player instructions are permitted only in prompts directed at the Captain itself (e.g., the summarization prompt passed to `callCaptain`), where they describe context for the synthesizer rather than instruct a player.

## References

[1]: https://catppuccin.com/palette/ "Catppuccin Palette"
[2]: https://github.com/charmbracelet/glow "glow — Render Markdown on the CLI"
