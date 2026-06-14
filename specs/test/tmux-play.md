<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# TTMUX: tmux-play Tests

## Intent

Verification criteria for the `tmux-play` CLI, configuration, Captain runtime, and built-in `fanout` Captain defined in [user/tmux-play.md](../user/tmux-play.md).

## Configuration and Discovery

### TTMUX-001
Verifies: [TMUX-010](../user/tmux-play.md#tmux-010), [TMUX-011](../user/tmux-play.md#tmux-011), [TMUX-076](../user/tmux-play.md#tmux-076)

Given an empty home and cwd, when launching `tmux-play` without `--config`, the home YAML shall be created with the default `fanout` Captain plus `claude` and `codex` players with identity instructions, the default Captain and `claude` player shall use `model: claude-opus-4-8` with `reasoningEffort: xhigh`, the default `codex` player shall use `model: gpt-5.5` with `reasoningEffort: xhigh`, and the default Captain and both default players shall carry `permissions: { mode: 'auto' }` per [TMUX-011](../user/tmux-play.md#tmux-011). The created YAML shall also carry an explicit `layout` block with `window: { columns: 174, rows: 49 }` and `columnWeights: [1, 1, 1]` per [TMUX-011](../user/tmux-play.md#tmux-011), plus `notifications: { player_finished: bell, turn_finished: desktop }` per [TMUX-076](../user/tmux-play.md#tmux-076). A one-line notice naming the path shall be printed to stdout, and a second invocation against that freshly-created home YAML shall leave the file unchanged.

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

Given malformed YAML or a config that violates the schema (unknown adapter, unknown field, invalid player id, duplicate player id, player id `captain`, empty players), when launching, the launcher shall fail with an error naming the offending file or path.

### TTMUX-006
Verifies: [TMUX-013](../user/tmux-play.md#tmux-013)

Given a cwd config whose `captain.from` is a relative local path, when session mode imports the Captain, resolution shall be anchored at the original config file's directory; package specifiers shall reach Node's resolver unchanged.

## Runtime Causality and Dispatch

### TTMUX-007
Verifies: [TMUX-022](../user/tmux-play.md#tmux-022)

Given a Captain that calls one player then `callCaptain`, when handling a Boss turn, observers shall receive records in this order: `turn_started`, `player_prompt`, `player_event`*, `player_finished`, `captain_prompt`, `captain_event`*, `captain_finished`, `turn_finished`. All shall carry the same `turnId`.

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

### TTMUX-061
Verifies: [TMUX-061](../user/tmux-play.md#tmux-061), [TMUX-047](../user/tmux-play.md#tmux-047)

Given `tmux-play --theme-diagnostics` is invoked with a YAML config, the CLI shall load the config, resolve the theme using the same explicit / YAML / OSC 11 / fallback rule as launcher mode, print `selected: <flavor>` and `reason: <reason>`, and exit 0 without invoking `tmux` or requiring `glow`. Given the OSC 11 probe receives a parseable light-background reply such as `rgb:eeee/eeee/eeee`, diagnostics shall report `selected: latte` and `reason: osc11`. Given no parseable OSC 11 reply is available and no explicit or YAML concrete flavor is set, diagnostics shall report `selected: mocha` and `reason: fallback`. Given `--theme-diagnostics` is combined with `--session`, the CLI shall reject the invocation before dispatching session mode.

### TTMUX-014
Verifies: [TMUX-027](../user/tmux-play.md#tmux-027), [TMUX-028](../user/tmux-play.md#tmux-028), [TMUX-064](../user/tmux-play.md#tmux-064)

Given N configured players, when the launcher constructs the tmux session, the layout shall be Boss/Captain on the left and N player panes on the right in config order; with N ≥ 2 the first player column shall hold `ceil(N / 2)` players top-to-bottom.
Given a YAML config that omits `layout.columnWeights`, each visible column shall occupy its share of the window width per the shipped defaults of [TMUX-064](../user/tmux-play.md#tmux-064): with N = 1 the weights are `[1, 1]` (Boss/Captain and player each 1/2); with N ≥ 2 the weights are `[1, 1, 1]` (Boss/Captain and each player column each 1/3, rightmost absorbing the remainder).
Given a YAML config that supplies an explicit `layout.columnWeights`, the resolved region widths shall follow that ratio at the resolved `layout.window.columns` per [TMUX-028](../user/tmux-play.md#tmux-028) and [TMUX-044](../user/tmux-play.md#tmux-044).

### TTMUX-015
Verifies: [TMUX-003](../user/tmux-play.md#tmux-003), [TMUX-034](../user/tmux-play.md#tmux-034)

Given a snapshot file at the work directory, when session mode runs, the Captain shall be imported once from `captain.from` (a `file://` URL for local paths or a package specifier) and Boss turns shall flow through the runtime per [TTMUX-007](#ttmux-007).

### TTMUX-075
Verifies: [TMUX-076](../user/tmux-play.md#tmux-076), [TMUX-010](../user/tmux-play.md#tmux-010), [TMUX-011](../user/tmux-play.md#tmux-011), [TMUX-034](../user/tmux-play.md#tmux-034)

Given a YAML config with `notifications: { player_finished: bell, turn_finished: desktop }`, when `loadTmuxPlayConfig` returns, the loaded config shall carry `notifications: { player_finished: bell, turn_finished: desktop, turn_aborted: off }`.
Given a YAML config that omits `notifications`, when `loadTmuxPlayConfig` returns and the launcher writes a snapshot, both the loaded config and snapshot shall carry `off` for all three notification events.
Given a YAML config with an unknown notification key such as `runtime_error` or a sink outside `off | bell | desktop`, the loader shall reject with an error that names the offending `notifications.<key>` path.
Given an old home YAML loaded through fallback discovery that lacks safe defaults, the loader shall update that home YAML with only missing `theme: auto`, resolved layout defaults, `captain.options: {}`, and notification defaults; it shall preserve existing values and shall not add `model`, `instruction`, `permissions`, or `reasoningEffort`.

### TTMUX-076
Verifies: [TMUX-077](../user/tmux-play.md#tmux-077), [TMUX-023](../user/tmux-play.md#tmux-023)

Given a `NotificationObserver` configured with `player_finished: bell`, when it receives `player_finished` records with `status: ok`, `status: error`, and `status: aborted` on macOS, it shall launch one detached best-effort `afplay /System/Library/Sounds/Hero.aiff` sound command for each record, shall write no terminal BEL (`\x07`) or other bytes to orchestrator stdout, and shall launch no desktop notification command.
Given a `NotificationObserver` configured with `player_finished: bell`, when it receives a `player_finished` record on Linux or Windows, it shall launch one detached best-effort native completion sound command (`complete` through the freedesktop sound stack on Linux; the Windows generic notification sound on Windows); on other platforms it shall launch no command.
Given a `NotificationObserver` configured with `turn_finished: desktop`, when it receives one `turn_finished` record on macOS, it shall launch exactly one detached best-effort `osascript` notification command with lowercase title `spex`, shall write exactly one terminal BEL (`\x07`) to orchestrator stdout, and shall not launch an `afplay` sound command.
Given a `NotificationObserver` configured with `player_finished: desktop` or `turn_aborted: desktop`, when it receives the matching record on macOS, it shall launch exactly one detached best-effort `osascript` notification command with lowercase title `spex` and shall write no terminal BEL (`\x07`) or terminal notification escape bytes to orchestrator stdout.
Given a `NotificationObserver` configured with `turn_finished: desktop`, when it receives one `turn_finished` record on Linux, it shall launch exactly one detached best-effort `notify-send` OS notification command with lowercase title `spex` and shall write no terminal BEL (`\x07`) or terminal notification escape; on other platforms it shall launch no command and write no terminal BEL.
Given a built `TmuxPlaySession` running in pane 0 on macOS with `turn_finished: desktop` and an attached real tmux client, when a Boss turn finishes, tmux shall raise an `alert-bell` for the raw terminal BEL emitted from pane 0.
Given a `NotificationObserver` configured with `turn_aborted: bell`, when it receives `turn_aborted` records whose reason is `ESC`, `SIGINT`, `SIGTERM`, `EOF`, or `runtime disposed`, it shall launch no sound command; when it receives a non-user-cancellation reason, it shall notify through the configured sink.
Given notification sinks throw, spawn fails, or a `runtime_error` record arrives, `NotificationObserver.onRecord` shall not throw.
Given a `TmuxPlaySession` starts, the runtime observer array shall contain the notification observer registered with the existing presenter, follow, and timing observers before any opt-in test/user observers.

### TTMUX-073
Verifies: [TMUX-074](../user/tmux-play.md#tmux-074)

Given session mode whose inherited environment carries a `TMUX` handle, when it performs the [TMUX-074](../user/tmux-play.md#tmux-074) isolation step, `TMUX` and `TMUX_PANE` shall be absent from the environment subsequently inherited by spawned player agents and `TMUX_TMPDIR` shall point to a private directory other than the run's tmux socket directory, so an agent's `tmux` resolves to an isolated server. The orchestrator shall still report itself attached to tmux so pane-width queries run, and its own tmux commands shall execute with the pinned pre-scrub environment carrying the original `TMUX` handle so they target the run's session rather than the agents' sandbox. Given no inherited `TMUX` handle, the isolation step shall be a no-op that leaves `TMUX_TMPDIR` unset.

## Built-in Fanout Captain (Acceptance)

### TTMUX-016
Verifies: [TMUX-030](../user/tmux-play.md#tmux-030)

Given the built-in fanout Captain and the four supported adapters as players with valid credentials, when handling a Boss turn that requires a sentinel token in every reply, every `player_finished` shall report `status: 'ok'` with the sentinel in `finalText`, and the `captain_finished` summary shall reference each player's status and contain the sentinel. `runtime_error` and `turn_aborted` shall not appear.

### TTMUX-017
Verifies: [TMUX-030](../user/tmux-play.md#tmux-030)

Given the fanout Captain and N configured players, when handling a Boss turn, all N `player_prompt` records shall be emitted before any `player_finished` record (concurrent dispatch), and the `captain_prompt` record shall be emitted only after every `player_finished`.

### TTMUX-055
Verifies: [TMUX-030](../user/tmux-play.md#tmux-030), [TMUX-052](../user/tmux-play.md#tmux-052)

Given the built-in fanout Captain and a `claude` player configured with `permissions: { mode: 'auto' }`, when the runtime (constructed per [TMUX-029](../user/tmux-play.md#tmux-029)) handles a Boss turn instructing the player to create a file in the working directory and a second turn instructing it to delete that file, the file shall exist on disk after the create turn and be absent after the delete turn, each turn's `claude` `player_finished` shall report `status: 'ok'`, and neither `runtime_error` nor `turn_aborted` shall appear. This is a real-run end-to-end probe — Boss turn → fanout Captain → player → Claude adapter → live SDK → filesystem — exercising the path a no-`permissions` player cannot complete (its headless `permissionMode: 'default'` blocks every file tool). It lives under `*.acceptance.test.ts`, runs via `npm run test:acceptance`, and self-skips when `ANTHROPIC_API_KEY` is absent, hard-failing under `CI`.

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
Verifies: [TMUX-035](../user/tmux-play.md#tmux-035), [TMUX-064](../user/tmux-play.md#tmux-064)

Given a YAML config that omits `layout.window`, when the launcher creates the tmux session, the `new-session` invocation shall request a 174-column by 49-row grid (sized for 1920×1080 at 18pt monospace).
Given a YAML config that supplies an explicit `layout.window` (for example `columns: 200, rows: 50`), the `new-session` invocation shall request `-x 200 -y 50` and shall not fall back to the default 174×49.

### TTMUX-022
Verifies: [TMUX-028](../user/tmux-play.md#tmux-028), [TMUX-064](../user/tmux-play.md#tmux-064)

Given two or more players and a YAML config that omits `layout.columnWeights`, when the launcher constructs the tmux session against a 174-column-wide grid, the Boss/Captain pane shall occupy 58 columns, the first player column shall occupy 58 columns, and the second player column shall occupy 58 columns — matching the shipped `[1, 1, 1]` multi-player default, within tmux's nearest-cell rounding.

## Mouse Interaction

### TTMUX-062
Verifies: [TMUX-062](../user/tmux-play.md#tmux-062)

Given the launcher constructing a tmux-play session, the tmux command stream shall include `set-option -t <session> mouse on`, shall include `bind-key -T copy-mode MouseDragEnd1Pane send-keys -X stop-selection`, `bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X stop-selection`, a `bind-key -T copy-mode MouseDown3Pane refresh-client` plus a `bind-key -T copy-mode-vi MouseDown3Pane refresh-client` consuming-no-op press binding, and a `bind-key -T copy-mode MouseUp3Pane` plus a `bind-key -T copy-mode-vi MouseUp3Pane` binding whose bound command is a single `if-shell -F '#{selection_present}'` with a true branch `display-message Copied! ; send-keys -X copy-pipe '<system-clipboard-command>'` and a false branch `send-keys -X copy-pipe '<system-clipboard-command>'`, shall not include a `set-clipboard` option write, and shall not include any `WheelDownPane` binding.
The copy and toast shall be bound to the release event `MouseUp3Pane`, not the press event `MouseDown3Pane`: tmux clears a status-line message on the next key event, and a right-click is a press immediately followed by a release, so a `Copied!` toast painted on the press is wiped by the release before it can be seen ("the toast disappears as the right-click releases"); the `MouseDown3Pane` press binding shall carry the focus-neutral no-op `refresh-client` and neither `copy-pipe`, `Copied!`, nor `select-pane`, so a regression that moves the copy or toast back onto the press, or that switches the press to a focus-changing `select-pane`, fails.
The right-click binding argv shall be exactly `copy-pipe`, not `copy-pipe-and-cancel`: `copy-pipe-and-cancel` exits copy-mode and snaps a scrolled-back pane to its live tail, which is the "right-click on a scrolled-back pane jumps to the last line" defect [TMUX-062](../user/tmux-play.md#tmux-062) requires not to occur.
The release binding's true branch shall pair a `display-message Copied!` copy-confirmation toast with the `copy-pipe`, gated on the `if-shell` condition `#{selection_present}`, so the bound command contains `if-shell`, `display-message`, the literal `Copied!`, and `selection_present`, with the toast inside the `if-shell` true branch so it fires only when a selection is present.
The literal `Copied!` shall appear exactly once in each `MouseUp3Pane` binding body — only in the selection-present true branch — so a toast leaking into the no-selection false branch (a false `Copied!` on an empty right-click) is caught.
The `<system-clipboard-command>` shall contain `pbcopy`, `wl-copy`, `xclip`, `xsel`, `clip.exe`, and `tmux load-buffer -w -`.
Given a real tmux server, when `launchTmuxPlay({ attach: false })` returns, `tmux show-options -v -t <session> mouse` shall report `on`, and `tmux list-keys -T copy-mode` plus `tmux list-keys -T copy-mode-vi` shall report the preserve-selection bindings above, each table's `MouseDown3Pane` binding being the `refresh-client` no-op carrying neither `copy-pipe`, `Copied!`, nor `select-pane`, and each table's `MouseUp3Pane` body containing `if-shell`, `display-message`, `selection_present`, and exactly one `Copied!`; neither table's `MouseUp3Pane` binding shall reference `copy-pipe-and-cancel`.
Given a real tmux server with a launched pane scrolled back into history holding a stopped active selection, when the release binding's selection-present `if-shell` branch — its `display-message Copied! ; send-keys -X copy-pipe <command>` shape with the system-clipboard command swapped for a test pipe — is run against the pane, the pipe shall receive the expected selected text (so the branch is proven to reparse and execute, not merely match a string), `#{selection_present}` shall become `0`, `#{pane_in_mode}` shall remain `1`, and `#{scroll_position}` shall equal its pre-copy value; and when the no-selection false branch is then run against the same pane (now `#{selection_present}` is `0`), the pipe shall receive no selected text, confirming a right-click over nothing selected copies silently.
Given a real tmux server with an attached client and a launched pane scrolled back into history holding a stopped active selection, when a real right-click press-then-release (SGR right-button `M` then `m`) is dispatched through the attached client inside that pane, the live release binding shall run end-to-end: `#{selection_present}` shall become `0` (the `copy-pipe` cleared the selection as visible copy-confirmation), `#{pane_in_mode}` shall remain `1`, and `#{scroll_position}` shall equal its pre-click value. This proves the release is actually delivered and the copy runs over real tmux mouse routing: a binding that dropped the release — by removing the `MouseDown3Pane` press no-op that consumes the press, or by leaving `MouseUp3Pane` unbound — would never run the copy and would leave `#{selection_present}` at `1`. This signal does not by itself prove the copy lives on the release rather than the press, because a copy moved onto the press would also clear the selection to `0`; that the copy and toast live on the release and not the press is fixed instead by the static binding checks above (the `MouseDown3Pane` press binding is `refresh-client`, carrying no `copy-pipe` or `Copied!`) and by the toast-persistence probe below (a toast painted on the press is wiped by the release). This probe shall run under `*.acceptance.test.ts`, shall not require adapter API keys, and shall self-skip when `tmux -V`, `glow -v`, or an attached-client mouse driver is unavailable or cannot attach a client (e.g. a headless CI runner).
Given a real tmux server whose launched session has a generous `display-time` and a pane holding a stopped active selection, when a real right-click press-then-release is dispatched through an attached client rendered inside an outer tmux pane (so the inner client's status line is capturable), the captured status line shall show the `Copied!` toast after the release has been processed, proving the toast survives the release rather than being wiped by it; a binding that painted the toast on the press would leave the captured status line with no `Copied!`. This probe shall run under `*.acceptance.test.ts`, shall not require adapter API keys, and shall self-skip when `tmux -V`, `glow -v`, or an attached-client mouse driver is unavailable or cannot attach a client (e.g. a headless CI runner).
The toast is asserted on the rendered status line by the persistence probe above; together with the binding-body, branch-execution, and real-right-click checks, these are the test's verification surface for the toast's presence, persistence, and selection gating.

### TTMUX-066
Verifies: [TMUX-066](../user/tmux-play.md#tmux-066)

_Superseded by [TTMUX-067](#ttmux-067)._
_Status: retired and entirely non-normative. The paragraphs below record the original verification criteria in past tense for spec history; no clause in this item is in effect, and no `shall` text appears here. The active verification of left-click behavior in a tmux-play session is owned by [TTMUX-068](#ttmux-068)._

Historical (non-normative) — what TTMUX-066 originally verified:
- Given the launcher constructing a tmux-play session whose `sessionName` was `<session>` and which carried `paneCount` panes indexed `0..paneCount-1`, the tmux command stream included exactly one `bind-key -T <table> MouseDown1Pane if-shell -F #{==:#{session_name},<session>} '<trueBranch>' '<falseBranch>'` invocation for each `<table>` in `root`, `copy-mode`, `copy-mode-vi`. With one Boss/Captain pane plus N players, `paneCount` equalled `N + 1`.
- `<trueBranch>` chained, for every pane index `i` in `0..paneCount-1`, an `if -F -t <session>:0.<i> '#{pane_in_mode}' 'send-keys -t <session>:0.<i> -X cancel'` clause separated by ` ; `, followed by the per-table tail: ` ; select-pane -t= ; send-keys -M` for the `root` table and ` ; select-pane -t=` for `copy-mode` and `copy-mode-vi`.
- `<falseBranch>` was the per-table tmux stock binding verbatim: `select-pane -t= ; send-keys -M` for `root` and `select-pane` for `copy-mode` and `copy-mode-vi`; the `send-keys -M` byte in the `root` false branch was not omitted so mouse-aware applications in unrelated sessions continued to receive forwarded clicks.
- Given a real tmux server, when `launchTmuxPlay({ attach: false })` returned, `tmux list-keys -T root MouseDown1Pane` reported a binding whose body contained `if-shell`, `session_name`, the launched session name, `pane_in_mode`, `send-keys` with `-X cancel`, `select-pane -t=`, and `send-keys -M`; and `tmux list-keys -T copy-mode MouseDown1Pane` together with `tmux list-keys -T copy-mode-vi MouseDown1Pane` each reported a binding whose body contained `if-shell`, `session_name`, the launched session name, `pane_in_mode`, `send-keys` with `-X cancel`, and `select-pane`.
- The acceptance probe ran under `*.acceptance.test.ts`, did not require adapter API keys, and self-skipped when either `tmux -V` or `glow -v` failed.

### TTMUX-067
Verifies: [TMUX-067](../user/tmux-play.md#tmux-067)

_Superseded by [TTMUX-068](#ttmux-068)._
_Status: retired and entirely non-normative. The paragraphs below record the original verification criteria in past tense for spec history; no clause in this item is in effect, and no `shall` text appears here. The active verification of left-click behavior in a tmux-play session is owned by [TTMUX-068](#ttmux-068), which pins the joint contract: a click clears any active selection in every pane while preserving each pane's copy-mode state and scroll position, via `send-keys -X clear-selection` (not the retired `-X cancel`) gated per pane by `#{pane_in_mode}`._

Historical (non-normative) — what TTMUX-067 originally verified:
- Given the launcher constructing a tmux-play session whose `sessionName` was `<session>`, the tmux command stream included exactly one `bind-key -T root MouseDown1Pane 'select-pane -t= ; send-keys -M'` invocation and exactly one `bind-key -T <table> MouseDown1Pane 'select-pane'` invocation for each `<table>` in `copy-mode`, `copy-mode-vi` — the stock per-table tmux defaults verbatim — and did not include any `MouseDown1Pane` argv that referenced `if-shell`, the launched session name, `#{pane_in_mode}`, or `send-keys -X cancel`.
- The `mouse` option was still set to `on`, and the `MouseDragEnd1Pane` stop-selection and `MouseDown3Pane` system-clipboard right-click-copy bindings of [TTMUX-062](#ttmux-062) were installed unchanged.
- Given a real tmux server, `tmux list-keys -T root MouseDown1Pane`, `tmux list-keys -T copy-mode MouseDown1Pane`, and `tmux list-keys -T copy-mode-vi MouseDown1Pane` each reported a binding whose body matched the corresponding stock per-table tail.
- This verification was retired because it pinned an implementation (stock bindings) that turned out to lose the click-releases-selection behavior of the prior [TMUX-066](../user/tmux-play.md#tmux-066) intent. Asserting only the binding strings — not the user-observable selection / scroll behavior — was the gap that let the regression land. [TTMUX-068](#ttmux-068) corrects this by combining a static binding assertion with a real-tmux behavioral probe.
- The acceptance probe ran under `*.acceptance.test.ts`, did not require adapter API keys, and self-skipped when either `tmux -V` or `glow -v` failed.

### TTMUX-068
Verifies: [TMUX-068](../user/tmux-play.md#tmux-068)

Given the launcher constructing a tmux-play session whose `sessionName` is `<session>` and which carries `paneCount` panes indexed `0..paneCount-1`, the tmux command stream shall include exactly one `bind-key -T <table> MouseDown1Pane if-shell -F #{==:#{session_name},<session>} '<trueBranch>' '<falseBranch>'` invocation for each `<table>` in `root`, `copy-mode`, `copy-mode-vi`. With one Boss/Captain pane plus N players, `paneCount` shall equal `N + 1`.
`<trueBranch>` shall chain, for every pane index `i` in `0..paneCount-1`, an `if -F -t <session>:0.<i> '#{pane_in_mode}' 'send-keys -t <session>:0.<i> -X clear-selection'` clause separated by ` ; `, followed by the per-table tail: ` ; select-pane -t= ; send-keys -M` for the `root` table and ` ; select-pane` for `copy-mode` and `copy-mode-vi`.
`<falseBranch>` shall be the per-table tmux stock binding verbatim: `select-pane -t= ; send-keys -M` for `root` and `select-pane` for `copy-mode` and `copy-mode-vi`. The `send-keys -M` byte in the `root` false branch shall not be omitted so mouse-aware applications in unrelated sessions continue to receive forwarded clicks.
No `MouseDown1Pane` argv shall reference `-X cancel`: that primitive exits copy-mode entirely and was the root of the retired [TTMUX-066](#ttmux-066) "previously focused pane jumps to the last line" defect; [TMUX-068](../user/tmux-play.md#tmux-068) requires `clear-selection` instead.
The `mouse` option shall still be set to `on`, and the `MouseDragEnd1Pane` stop-selection binding, the `MouseDown3Pane` `refresh-client` press no-op, and the `MouseUp3Pane` system-clipboard right-click-copy binding of [TTMUX-062](#ttmux-062) shall still be installed unchanged.

Given a real tmux server, when `launchTmuxPlay({ attach: false })` returns, `tmux list-keys -T root MouseDown1Pane`, `tmux list-keys -T copy-mode MouseDown1Pane`, and `tmux list-keys -T copy-mode-vi MouseDown1Pane` shall each report a binding whose body contains `if-shell`, the launched session name, `pane_in_mode`, `send-keys`, `-X clear-selection`, and the table's stock tail (`select-pane -t=` and `send-keys -M` for `root`; `select-pane` for `copy-mode` / `copy-mode-vi`), and shall not contain `-X cancel`.
The acceptance probe shall additionally pin the observable consequence required by [TMUX-068](../user/tmux-play.md#tmux-068) (not only the binding string or a direct invocation of the binding body): on a real tmux server, given pane A in the launched session holds a stopped active selection while scrolled back into its history, pane B in the launched session is scrolled back into its history without a selection, and pane C in the launched session is not in any mode, when an attached tmux client sends a primary-button mouse-down event inside pane C, then `#{selection_present}` on pane A shall be `0` (selection cleared); `#{pane_in_mode}` on pane A shall remain `1` and `#{scroll_position}` on pane A shall equal its pre-click value (still in copy-mode at the same scroll position); `#{pane_in_mode}` on pane B shall remain `1` and `#{scroll_position}` on pane B shall equal its pre-click value (a scrolled-back sibling that holds no selection keeps its scroll, the case [TMUX-068](../user/tmux-play.md#tmux-068) also requires); and `#{pane_active}` on pane C shall be `1` (focus moved to the click target).
The probe shall assert that pane A's and pane B's pre-click `#{scroll_position}` is greater than `0`, so a setup that failed to scroll back fails loudly rather than letting the scroll-preservation assertions pass vacuously at `0 == 0`. Asserting `#{pane_in_mode}` alone would not pin scroll preservation — it only distinguishes `clear-selection` from the retired `-X cancel`, which exits copy-mode — so the `#{scroll_position}` equality on genuinely scrolled panes is the assertion that pins the user-visible "previously focused pane jumps to the last line" contract.
Because the launched player panes carry no scrollback when the suite runs without adapter API keys, the probe may seed deterministic history into those panes (for example via `respawn-pane`) before scrolling; the binding under test is session- and `pane_in_mode`-gated and independent of pane contents, so substituting pane contents does not weaken the probe. Pinning the attached-client click outcome — selection cleared, scroll preserved — directly catches regressions where the clear-selection primitive works when called manually but the real click path does not dispatch it.
The acceptance probe shall run under `*.acceptance.test.ts`, shall not require adapter API keys, and shall self-skip when either `tmux -V`, `glow -v`, or an attached-client mouse driver is unavailable or cannot attach a client (e.g. a headless CI runner).

### TTMUX-069
Verifies: [TMUX-069](../user/tmux-play.md#tmux-069)

Given a real tmux server hosting a launched tmux-play session, where a pane is seeded with scrollback and scrolled back so that `#{scroll_position}` is greater than `0` and `#{pane_in_mode}` is `1`, when the session runtime writes new output to that pane — a flushed text block, a `tool_use` / `tool_result` lifecycle line, a player-prompt echo, or a `[status]` / `[turn aborted]` / `[runtime error]` bracketed line — the pane shall return to its live tail with `#{pane_in_mode}` reporting `0` and the newly written content visible.
A pane in the same session that receives no concurrent output shall keep its `#{scroll_position}` and remain at `#{pane_in_mode}` `1`, so a scrolled pane is returned to its tail only by output written to that pane, not by output written to a sibling pane nor by between-turn idle activity.
Activity that renders no pane output shall not return a scrolled pane to its tail: the `turn_started` / `turn_finished` / `captain_prompt` / `captain_telemetry` control records, the `done` and `error` events the presenter suppresses, any event the presenter renders to no visible text, and a buffered `text_delta` that only accumulates into the open block before a flush.
The probe shall assert the pane's pre-output `#{scroll_position}` is greater than `0` so a setup that failed to scroll back fails loudly rather than passing vacuously at `0 == 0`, and shall not require adapter API keys — it may drive the session runtime with deterministic synthetic records and seed pane history via `respawn-pane`, since the follow is `#{pane_in_mode}`-gated and independent of pane contents.
The acceptance probe shall run under `*.acceptance.test.ts` and shall self-skip when either `tmux -V` or `glow -v` fails.

_The retired TTMUX-077 wheel-up clamp probe is removed together with its requirement TMUX-078; the Boss/Captain phantom-scrollback behavior it tried to assert through wheel events is now owned at the source by [TTMUX-078](#ttmux-078) / [TMUX-079](../user/tmux-play.md#tmux-079)._

## Keyboard Interaction

### TTMUX-063
Verifies: [TMUX-063](../user/tmux-play.md#tmux-063)

Given the launcher constructing a tmux-play session whose `sessionName` is `<session>`, the tmux command stream shall include `bind-key -T root C-Left if-shell -F #{==:#{session_name},<session>} 'select-pane -L' 'send-keys C-Left'`, `bind-key -T root C-Right if-shell -F #{==:#{session_name},<session>} 'select-pane -R' 'send-keys C-Right'`, `bind-key -T root S-Left if-shell -F #{==:#{session_name},<session>} 'select-pane -L' 'send-keys S-Left'`, and `bind-key -T root S-Right if-shell -F #{==:#{session_name},<session>} 'select-pane -R' 'send-keys S-Right'`, so the binding's true branch switches panes inside this session while the false branch forwards the original key for every other tmux session on the same server.
The launcher shall render `status-left` with `switch pane: ctrl+←/→ or shift+←/→`, `stop: esc`, and `exit: ctrl+c` substrings and shall not include the retired `d=detach`, `o=switch pane`, `[=scroll`, or `Stop: ESC` fragments; `drag=select` and `right-click=copy` shall remain so the mouse interaction surface from [TMUX-062](../user/tmux-play.md#tmux-062) stays discoverable.
Given a real tmux server, when `launchTmuxPlay({ attach: false })` returns, `tmux list-keys -T root C-Left` shall report a binding whose body contains `if-shell`, `session_name`, the launched session name, `select-pane -L`, and `send-keys C-Left`; `tmux list-keys -T root C-Right` shall report the symmetric binding with `select-pane -R` and `send-keys C-Right`; `tmux list-keys -T root S-Left` shall report a binding whose body contains `if-shell`, `session_name`, the launched session name, `select-pane -L`, and `send-keys S-Left`; and `tmux list-keys -T root S-Right` shall report the symmetric binding with `select-pane -R` and `send-keys S-Right`.
The acceptance probe shall run under `*.acceptance.test.ts`, shall not require adapter API keys, and shall self-skip when either `tmux -V` or `glow -v` fails.

### TTMUX-065
Verifies: [TMUX-065](../user/tmux-play.md#tmux-065), [TMUX-026](../user/tmux-play.md#tmux-026)

Given the launcher constructing a tmux-play session whose `sessionName` is `<session>`, the tmux command stream shall include a `bind-key -T root C-c`, a `bind-key -T copy-mode C-c`, and a `bind-key -T copy-mode-vi C-c`, each gated `if-shell -F #{==:#{session_name},<session>}` whose true branch is the same cancel-then-forward pair — `if -F -t <session>:0.0 '#{pane_in_mode}' 'send-keys -t <session>:0.0 -X cancel'` followed by `send-keys -t <session>:0.0 C-c` — so pane 0's copy-mode is exited (when pane 0 is in a mode) before the `Ctrl+C` byte reaches the Boss/Captain pane (pane index 0).
Each binding's false branch shall reproduce that table's stock binding verbatim: `send-keys C-c` for `root`, and `send-keys -X cancel` for `copy-mode` and `copy-mode-vi`, so other tmux sessions on the same server retain stock `Ctrl+C` and stock copy-mode `C-c` behavior.
Given a real tmux server, when `launchTmuxPlay({ attach: false })` returns, `tmux list-keys -T root C-c`, `tmux list-keys -T copy-mode C-c`, and `tmux list-keys -T copy-mode-vi C-c` shall each report a binding whose body contains `if-shell`, `session_name`, the launched session name, the `pane_in_mode`-gated `send-keys -t <session>:0.0 -X cancel`, and `send-keys -t <session>:0.0 C-c`; the `root` body shall additionally contain its `send-keys C-c` false branch, and the `copy-mode` and `copy-mode-vi` bodies shall additionally contain their `send-keys -X cancel` false branch.
The acceptance probe shall additionally drive real attached-client keypresses, not only `list-keys`: given pane 0 is running a raw byte logger, when an attached client presses `C-c` from a player pane scrolled into copy-mode with a stopped selection, pane 0 shall receive byte `0x03` after one press; and given pane 0 itself is scrolled into copy-mode while a different player pane is active in root mode, when the attached client presses `C-c`, pane 0 shall first leave copy-mode and shall receive byte `0x03` after one press.
The acceptance probe shall run under `*.acceptance.test.ts`, shall not require adapter API keys, and shall self-skip when either `tmux -V`, `glow -v`, or an attached-client key driver is unavailable or cannot attach a client (e.g. a headless CI runner).

### TTMUX-070
Verifies: [TMUX-070](../user/tmux-play.md#tmux-070), [TMUX-057](../user/tmux-play.md#tmux-057)

Given the launcher constructing a tmux-play session whose `sessionName` is `<session>`, the tmux command stream shall include a `bind-key -T root Escape`, a `bind-key -T copy-mode Escape`, and a `bind-key -T copy-mode-vi Escape`, each gated `if-shell -F #{==:#{session_name},<session>}` whose true branch is the same cancel-then-forward pair — `if -F -t <session>:0.0 '#{pane_in_mode}' 'send-keys -t <session>:0.0 -X cancel'` followed by `send-keys -t <session>:0.0 Escape` — so pane 0's copy-mode is exited (when pane 0 is in a mode) before the bare ESC byte reaches the Boss/Captain pane (pane index 0), mirroring the [TTMUX-065](#ttmux-065) `C-c` pattern.
Each binding's false branch shall reproduce that table's stock binding verbatim — `send-keys Escape` for `root`, `send-keys -X cancel` for `copy-mode`, and `send-keys -X clear-selection` for `copy-mode-vi` — so other tmux sessions on the same server retain stock `Escape` behavior.
The asymmetry between `copy-mode` (`-X cancel`) and `copy-mode-vi` (`-X clear-selection`) shall be pinned by the test, not absorbed into a single `-X cancel` expectation: tmux's `copy-mode-vi` stock `Escape` is `clear-selection` (vi convention — Escape leaves visual selection without exiting copy-mode; `q` is the vi exit key), so writing `-X cancel` instead would degrade every unrelated vi-mode user's Escape on the same server from "drop selection, keep scrollback" to "exit copy-mode, snap to live tail" — the same scroll-snapping regression class [TTMUX-068](#ttmux-068) enumerates for mouse events. A regression that collapsed both mode tables' Escape false branches to one string shall fail this item statically.
The cross-table install is the ESC analogue of [TTMUX-065](#ttmux-065)'s "Ctrl+C requires two presses to quit when a pane is scrolled" fix: a binding only at `root` would leave the "ESC pressed on a player pane is swallowed by `pane-input-off=1`" path fixed but reintroduce the "ESC on a scrolled-back pane cancels copy-mode instead of aborting the turn" defect.
Given a real tmux server, when `launchTmuxPlay({ attach: false })` returns, `tmux list-keys -T root Escape`, `tmux list-keys -T copy-mode Escape`, and `tmux list-keys -T copy-mode-vi Escape` shall each report a binding whose body contains `if-shell`, `session_name`, the launched session name, the `pane_in_mode`-gated `send-keys -t <session>:0.0 -X cancel`, and `send-keys -t <session>:0.0 Escape`; the `root` body shall additionally contain its `send-keys Escape` false branch, the `copy-mode` body shall additionally contain its `-X cancel` false branch, and the `copy-mode-vi` body shall additionally contain its `send-keys -X clear-selection` false branch and shall not contain a bare `send-keys -X cancel` false branch (its `pane_in_mode`-gated `send-keys -t <session>:0.0 -X cancel` true-branch step is the only `-X cancel` the body carries).
Once the byte reaches pane 0, the existing [TMUX-057](../user/tmux-play.md#tmux-057) keypress handler shall raise the bare-ESC abort path covered by [TTMUX-059](#ttmux-059); this item does not duplicate that verification.
The acceptance probe shall additionally drive real attached-client keypresses, not only `list-keys`: given pane 0 is running a raw byte logger, when an attached client presses `Escape` from a player pane scrolled into copy-mode with a stopped selection, pane 0 shall receive byte `0x1b` after one press; and given pane 0 itself is scrolled into copy-mode while a different player pane is active in root mode, when the attached client presses `Escape`, pane 0 shall first leave copy-mode and shall receive byte `0x1b` after one press.
The acceptance probe shall run under `*.acceptance.test.ts`, shall not require adapter API keys, and shall self-skip when either `tmux -V`, `glow -v`, or an attached-client key driver is unavailable or cannot attach a client (e.g. a headless CI runner).

## Pane Titles

### TTMUX-023
Verifies: [TMUX-036](../user/tmux-play.md#tmux-036)

Given players with ids `coder` and `reviewer`, when the launcher sets pane titles, the Boss/Captain pane title shall be `Captain` and the player pane titles shall be `Coder` and `Reviewer` respectively. No pane title shall contain the substring `Player:`.

## Theme

### TTMUX-038
Verifies: [TMUX-047](../user/tmux-play.md#tmux-047)

Given the launcher building a tmux session with the Mocha flavor resolved per [TMUX-047](../user/tmux-play.md#tmux-047) (no explicit flavor, no YAML concrete flavor, and no parseable OSC 11 answer), the `tmux set` calls issued shall include the Mocha theme entries enumerated by [TMUX-047](../user/tmux-play.md#tmux-047) — anchored by `default-terminal=tmux-256color`, `terminal-overrides` appended with `,*:RGB`, `status-style=fg=#cdd6f4,bg=#181825`, `pane-active-border-style=fg=#89b4fa`, and `pane-border-style=fg=#6c7086` — and shall not include `window-style`, `window-active-style`, `window-status-style`, or `window-status-current-style` since the canonical Catppuccin tmux pattern leaves the pane content area on the user's terminal-native canvas and the window-list formats are empty strings. Every theme `set` shall appear before the launcher's own `pane-border-format`, `status-left`, and `status-right` option calls so the launcher's content strings remain authoritative on options the theme does not claim. Given the same launcher invocation with `themeFlavor: 'latte'` or a parseable light-background OSC 11 reply, the same option keys shall be set with their Latte hex values per [TMUX-047](../user/tmux-play.md#tmux-047)'s palette table — e.g., `status-style=fg=#4c4f69,bg=#e6e9ef`, `pane-active-border-style=fg=#1e66f5`, `pane-border-style=fg=#9ca0b0` — proving the flavor selection reaches the tmux server.

### TTMUX-039
Verifies: [TMUX-047](../user/tmux-play.md#tmux-047)

Given a launched session, `show-options -gv` on the real tmux server shall report `default-terminal = tmux-256color` and `terminal-overrides` containing `*:RGB`, confirming the launcher's `tmux set` calls applied to a real server (a stricter check than [TTMUX-038](#ttmux-038)'s argv inspection). The probe shall run against an actual tmux server (no mocks) and shall self-skip when either `tmux -V` or `glow -v` fails, since the launcher gates on both per [TMUX-051](../user/tmux-play.md#tmux-051). Whether a real terminal client subsequently negotiates the `RGB` capability is tmux's own contract, beyond the launcher's control surface, and is not asserted here.

### TTMUX-040
Verifies: [TMUX-048](../user/tmux-play.md#tmux-048)

Given a config with captain adapter `claude` and players `coder` (adapter `codex`) and `reviewer` (adapter `gemini`), when the launcher sets pane titles, the captain pane title shall be `Captain · claude` and the player pane titles shall be `Coder · codex` and `Reviewer · gemini` respectively. The separator shall be ` · ` (space, middle dot, space). The per-adapter accent lookup shall be flavor-aware per [TMUX-048](../user/tmux-play.md#tmux-048): with flavor `'mocha'` it returns `#a6e3a1` for `claude`, `#94e2d5` for `codex`, `#b4befe` for `gemini`, `#f5c2e7` for `opencode`; with flavor `'latte'` it returns `#40a02b`, `#179299`, `#7287fd`, `#ea76cb` for the same adapters. For any other adapter name the lookup shall return a value drawn from the documented per-flavor fallback pool, identical on repeated calls with the same input and flavor.

## Presenter Output

### TTMUX-024
Verifies: [TMUX-037](../user/tmux-play.md#tmux-037)

Given session mode is running, when the user enters a Boss prompt, the captured Boss/Captain pane content shall contain the prompt text exactly once.

### TTMUX-078
Verifies: [TMUX-079](../user/tmux-play.md#tmux-079)

Given a real tmux server hosting a launched tmux-play session whose Boss/Captain pane is running the real session readline with a local no-op Captain and sits at the top of its mostly-empty pane, when the Boss types `abc` and then backspaces it away (no submission), the pane's `#{history_size}` shall not increase across the edits and the pane scrollback shall contain none of the phantom rows `boss> abc`, `boss> ab`, `boss> a`; a wheel-up or `scroll-up` after the edits shall not reveal any prompt row above the pane's first line.
The acceptance probe shall run under `*.acceptance.test.ts`, shall not require adapter API keys, shall not respawn pane 0 (the defect depends on pane 0's real readline process), and shall self-skip when `tmux -V` or `glow -v` fails.

### TTMUX-025
Verifies: [TMUX-038](../user/tmux-play.md#tmux-038)

Given session mode handling a Boss turn, the captured Boss/Captain pane shall contain a line beginning with `boss> ` for the Boss input and a nonblank line beginning with `captain> ` for the Captain's reply; the captured player pane shall contain a nonblank line beginning with `captain> ` for the Captain's prompt and a nonblank line beginning with `<playerId>> ` for the player's reply. Multi-line presenter output blocks shall render continuation lines with a two-space hanging indent and no repeated speaker prefix; leading blank lines shall remain blank and shall not consume the first speaker prefix. The strings `[from captain]` and `[captain llm prompt]` shall not appear in any pane.

### TTMUX-026
Verifies: [TMUX-039](../user/tmux-play.md#tmux-039)

Given a player and Captain that finish with `status: 'ok'`, the captured pane content shall not contain `[player <id> ok]` or `[captain ok]`. Given a player that finishes with `status: 'error'`, the player pane shall contain a single `<playerId>> [error] <message>` line where `<message>` matches `result.error` and sits outside the brackets; given a Captain run that finishes with `status: 'error'`, the Boss/Captain pane shall contain a single `captain> [error] <message>` line where `<message>` matches `result.error` and sits outside the brackets. Given a player that finishes with `status: 'aborted'`, the player pane shall contain a single `<playerId>> [aborted]` line; given a Captain run that finishes with `status: 'aborted'`, the Boss/Captain pane shall contain a single `captain> [aborted]` line. Given a `runtime_error` record with `message: 'boom'` on the Boss/Captain pane, the rendered line shall be `captain> [runtime error] boom` — body outside the brackets, not `[runtime error: boom]`. Given a `turn_aborted` record with reason `ESC`, the rendered line shall be `captain> [turn aborted] ESC`.

### TTMUX-041
Verifies: [TMUX-038](../user/tmux-play.md#tmux-038)

Given the presenter receives a `captain` block, the writer shall capture bytes `\x1b[1;38;2;203;166;247mcaptain> \x1b[0m` immediately before the body's first nonblank line. Given a `coder` player whose adapter is `claude`, the same writer shall capture `\x1b[1;38;2;166;227;161mcoder> \x1b[0m` before the body. Given an unmapped player (no `playerAdapters` entry), the prefix shall fall back to the uncolored `<playerId>> ` form. Continuation indents in wrapped or multi-line blocks shall NOT carry any SGR escape.

### TTMUX-042
Verifies: [TMUX-039](../user/tmux-play.md#tmux-039)

Given a player error finished record on `coder` (adapter `claude`) with message `<message>`, the player pane shall capture `\x1b[1;38;2;166;227;161mcoder> \x1b[0m\x1b[1;38;2;243;139;168m[error]\x1b[0m <message>\n` — the bracketed tag carries the red outcome SGR span, and the body sits outside the brackets unstyled. Given a player aborted record on the same player, the pane shall capture the player prefix span followed by `\x1b[1;38;2;249;226;175m[aborted]\x1b[0m\n` with no body. Given a `turn_aborted` record on the Boss/Captain pane with reason `<reason>`, the captured bytes shall include the captain mauve prefix span followed by `\x1b[1;38;2;249;226;175m[turn aborted]\x1b[0m <reason>\n`. Given a `turn_aborted` record on the Boss/Captain pane without a reason, the captured bytes shall include the captain mauve prefix span followed by `\x1b[1;38;2;249;226;175m[turn aborted]\x1b[0m\n` — the bracketed tag stands alone with no trailing space and no synthesized placeholder body. Given a `runtime_error` record on the Boss/Captain pane with message `<message>`, the captured bytes shall include the captain mauve prefix span followed by `\x1b[1;38;2;243;139;168m[runtime error]\x1b[0m <message>\n`.

### TTMUX-027
Verifies: [TMUX-040](../user/tmux-play.md#tmux-040)

Given the fanout Captain handling a Boss turn, the captured Boss/Captain pane shall not contain any line beginning with `=== player:<id>` and shall not contain a `=== /player:<id> ===` line — i.e., the open/close sentinel framing of the Captain's prompt body shall not leak through. Synthesized references to player content within the Captain's reply shall be permitted.

### TTMUX-043
Verifies: [TMUX-049](../user/tmux-play.md#tmux-049)

Given a player `tool_use` event with `toolName: 'Bash'` and `input: { command: 'npm test' }` on a player pane writer for player `coder` (adapter `claude`), the captured bytes shall be `\x1b[1;38;2;166;227;161mcoder> \x1b[0m[tool ↪] Bash npm test\n` — the speaker prefix carries the player's adapter accent per [TMUX-038](../user/tmux-play.md#tmux-038) and the bracketed tag `[tool ↪]` is emitted uncolored per [TMUX-039](../user/tmux-play.md#tmux-039). When the caller is the captain (a `captain_event` carrying a `tool_use`) with `toolName: 'Read'` and `input: { file_path: 'a.ts' }`, the captured bytes shall be `\x1b[1;38;2;203;166;247mcaptain> \x1b[0m[tool ↪] Read a.ts\n` (captain mauve `#cba6f7` on the prefix; uncolored tag). The retired `tool> ` prefix replacement and its caller-accent coloring shall not appear.

Given a `tool_result` event with `status: 'success'`, `toolName: 'Bash'`, and `durationMs: 1234` on the `coder` player pane (adapter `claude`), the captured bytes shall begin with the colored header line `\x1b[1;38;2;166;227;161mcoder> \x1b[0m\x1b[1;38;2;166;227;161m[tool ✓]\x1b[0m Bash 1.2s\n`. Given a Captain-emitted `tool_result` with `status: 'success'`, `toolName: 'Read'`, and `durationMs: 200`, the header line shall be `\x1b[1;38;2;203;166;247mcaptain> \x1b[0m\x1b[1;38;2;166;227;161m[tool ✓]\x1b[0m Read 200ms\n` with the bracketed tag in green and the body unstyled — `200 < 1000` so the duration uses the `<n>ms` form per [TMUX-049](../user/tmux-play.md#tmux-049). Status symbol shall be `✓` for `success`, `✗` for `error`, `·` for `denied`; the corresponding bracketed-tag SGR shall use green / red / yellow per the [TMUX-039](../user/tmux-play.md#tmux-039) kind table. The duration segment shall be `<n>ms` for `durationMs < 1000`, `<n.n>s` otherwise, and absent when `durationMs` is undefined. The retired `tool< ` prefix replacement shall not appear.

Given a `tool_result` event whose extracted output is non-empty, the presenter shall strip exactly one trailing line terminator from the payload before wrapping it (so a payload ending `foo\n` does not surface a phantom blank line inside the fence), while any trailing blank lines beyond that terminator shall survive into the rendered output.
The body following the header line shall be enclosed in a fenced code block whose fence is a run of backticks one longer than the longest backtick run in the payload, with a minimum of three; the fenced payload shall be passed to `renderMarkdown` per [TMUX-050](../user/tmux-play.md#tmux-050) at the width specified in [TMUX-049](../user/tmux-play.md#tmux-049), the captured body output shall not retain `glow`'s trailing horizontal line padding while preserving leading whitespace, and every nonblank line of the rendered output shall be prefixed with two spaces before reaching the writer.
Blank lines in the rendered output (the fenced-code frame, payload edge blanks) shall remain blank with no indent and no right-padding spaces so the body's structure reads as it would in a `glow` pane outside this presenter without reserving cells to the right of visible content.
The retired `overlay0` `#6c7086` SGR pair shall not wrap any byte of the body — `glow`'s code-block rendering supersedes it per the [TMUX-049](../user/tmux-play.md#tmux-049) amendment.

Given a `tool_result` payload that itself contains a ```` ``` ```` line, the selected wrapper fence shall be at least four backticks long so the embedded fence remains inert as literal content of the outer fence and no part of the payload escapes into Markdown rendering at the writer.

Given a `tool_result` event whose extracted output is empty or undefined, the header line shall stand alone with no body.

### TTMUX-044
Verifies: [TMUX-049](../user/tmux-play.md#tmux-049)

Given a `tool_use` event whose `input` lacks the priority keys but contains `{ count: 3, flag: true }`, the input summary shall be the compact JSON `{"count":3,"flag":true}`. Given an `input` whose first priority-key string exceeds 60 cells, the summary shall be the value's first 59 cells followed by `…`. Given an empty `input` object, the rendered header shall be `<who>> [tool ↪] <toolName>` with no trailing space. Given an `input` whose only matching priority-key string is `query` (e.g., `{ query: 'select:WebFetch', max_results: 1 }`), the input summary shall be the `query` value — `query` sits in the priority list between `pattern` and `prompt` so search/fetch tools surface their query text rather than falling through to compact JSON.

### TTMUX-045
Verifies: [TMUX-040](../user/tmux-play.md#tmux-040), [TMUX-049](../user/tmux-play.md#tmux-049)

Given a `captain_event` carrying a `tool_use` record, the Boss/Captain pane writer (not any player writer) shall receive the `captain> [tool ↪] …` header per [TMUX-049](../user/tmux-play.md#tmux-049). Given a player-id `coder` `player_event` carrying the same `tool_use`, only the `coder` player pane writer shall receive the `coder> [tool ↪] …` header; the Boss/Captain pane writer shall not.

### TTMUX-071
Verifies: [TMUX-072](../user/tmux-play.md#tmux-072), [TMUX-069](../user/tmux-play.md#tmux-069)

Given a Captain that issues one `callCaptain(prompt)` and one `callCaptain(prompt, { visibility: 'hidden' })` within a turn, both calls shall return a `CaptainRunResult` with the run's `status` and `finalText`, and observers shall receive both calls' `captain_prompt` / `captain_event` / `captain_finished` records — the first call's tagged `visibility: 'visible'`, the second's tagged `visibility: 'hidden'`.

Given a hidden call whose underlying run reports an error `status`, it shall still return the full `CaptainRunResult` — `status: 'error'` with the propagated `error` — and the observers' `captain_finished` record, tagged `visibility: 'hidden'`, shall carry that error `status`.

Given the tmux presenter receives a hidden call's records (`captain_event` carrying streamed text or an `error` event, then a `captain_finished` of any `status`), the Boss/Captain pane writer shall capture zero bytes — no rendered reply block, and no `[error]`, `[aborted]`, or status line. Given the same records tagged `visibility: 'visible'` (or with `visibility` omitted), the captured Boss/Captain-pane bytes shall be identical to the presenter's behavior before the option existed.

Given a Boss/Captain pane scrolled back into copy-mode, a hidden call's records — a `captain_event` carrying a tool, text, or `error` event, then a `captain_finished` of any `status` — shall not return that pane to its live tail per [TMUX-069](../user/tmux-play.md#tmux-069): the pane shall keep its `#{scroll_position}` and remain at `#{pane_in_mode}` `1`. A later visible call whose flush writes bytes to that pane shall still return it to its live tail, so interleaved hidden records do not suppress the return owed once visible content reaches the pane.

## Player Session Continuity

### TTMUX-028
Verifies: [TMUX-041](../user/tmux-play.md#tmux-041)

Given a tmux-play session and a player whose adapter supports `resumeToken`, when the runtime handles two Boss turns in sequence, the player's `Cligent` instance on the second turn shall be the same instance as on the first turn, and the second `run()` call shall pass `resume: <resumeToken>` to the adapter where the token came from the prior `done` event.
Given the first Boss turn is aborted by ESC while a player call is active and that player's interrupted `done` carries `resumeToken: <resumeToken>`, when a later Boss turn calls the same player, the same `Cligent` instance shall pass `resume: <resumeToken>`, the `PlayerRunResult` for the aborted call shall expose `resumeToken: <resumeToken>`, and the runtime shall finish the later turn normally.
Given the first Boss turn is aborted by ESC while a player call is active and that player's interrupted `done` carries no `resumeToken`, when a later Boss turn calls the same player with no explicit resume override, the aborted `PlayerRunResult` shall omit `resumeToken`, the same `Cligent` instance shall pass no `resume` option, and the runtime/engine shall pass through the prompt supplied by the Captain rather than doing its own replay rewrite.

### TTMUX-029
Verifies: [TMUX-042](../user/tmux-play.md#tmux-042)

Given the fanout Captain handling a Boss turn with no unresolved no-token abort for a player, the prompt string passed to that player's `callPlayer` shall equal the Boss prompt verbatim — no static framing label (`The Boss asked`), no player identity preamble (`You are the`), no player-id repetition, and no inter-player trailing instructions (`Respond independently`, `other players`). The player's `instruction`, configured at `Cligent` construction, shall be the sole source of player identity.
Given a fanout player call returns `status: 'aborted'` with no `resumeToken`, when fanout handles a later Boss turn, that player's `callPlayer` prompt shall contain the retained aborted Boss prompt and the latest Boss prompt. Given consecutive no-token aborts, the later recovery prompt shall contain each retained base Boss prompt once and shall not nest a prior recovery prompt. Given an aborted player call carries `resumeToken`, the next fanout prompt for that player shall remain the Boss prompt verbatim because backend resume handles continuity.

## Real-tmux Acceptance

Items in this section verify behavior end-to-end against a real `tmux` server (not a mock or argv log). They live under `*.acceptance.test.ts`, run via `npm run test:acceptance`, and shall self-skip when either `tmux -V` or `glow -v` fails — the launcher gates on both per [TMUX-051](../user/tmux-play.md#tmux-051), so a missing binary surfaces as a clean skip rather than a launcher throw. They shall not gate on adapter API keys.

### TTMUX-030
Verifies: [TMUX-035](../user/tmux-play.md#tmux-035)

Given a real tmux server, when `launchTmuxPlay({ attach: false })` returns, `tmux display-message -t <session> -p '#{window_width}x#{window_height}'` shall report `174x49`.

### TTMUX-031
Verifies: [TMUX-027](../user/tmux-play.md#tmux-027), [TMUX-028](../user/tmux-play.md#tmux-028), [TMUX-064](../user/tmux-play.md#tmux-064)

Given a real tmux server with two configured players and a YAML config that omits `layout.columnWeights`, when `launchTmuxPlay({ attach: false })` returns, `tmux list-panes` shall report exactly three panes matching the shipped `[1, 1, 1]` multi-player default: a Boss/Captain pane at `pane_left=0` with effective width 58 columns (less tmux's 1-cell border), a first player column at `pane_left=58` with effective width 58 columns (less tmux's 1-cell border), and a second player column at `pane_left=116` with effective width 58 columns. Pane order in `list-panes` index space shall match config order.

### TTMUX-032
Verifies: [TMUX-036](../user/tmux-play.md#tmux-036)

Given a real tmux server with player ids `coder` and `reviewer`, when `launchTmuxPlay({ attach: false })` returns, `tmux display-message -p '#{pane_title}'` against each pane shall return `Captain` for the Boss/Captain pane, `Coder` for the first player pane, and `Reviewer` for the second player pane.

### TTMUX-033
Verifies: [TMUX-027](../user/tmux-play.md#tmux-027)

Given a real tmux server, when `launchTmuxPlay({ attach: false })` returns, every player pane shall report `#{pane_input_off}=1` (input disabled) and the Boss/Captain pane shall report `#{pane_input_off}=0`. After `tmux send-keys -t <player-pane> '<probe>'` is invoked with a unique probe string, `tmux capture-pane -p` against that player pane shall not contain the probe.

### TTMUX-034
Verifies: [TMUX-043](../user/tmux-play.md#tmux-043), [TMUX-064](../user/tmux-play.md#tmux-064)

Given a launcher invocation with `attach: true` and stdout routed to an in-memory writer, when `launchTmuxPlay` completes against a YAML config that omits `layout.window`, the writer's content shall contain the byte sequence `\x1b[8;49;174t`, and that sequence shall have been written before the test's `attachTmuxSession` mock is invoked.
Given the same invocation against a YAML config that supplies an explicit `layout.window` (for example `columns: 200, rows: 50`), the writer's content shall contain `\x1b[8;50;200t` and shall not contain `\x1b[8;49;174t`, so the pre-attach CSI 8 payload reads from the same `layout.window` source of truth as `new-session -x/-y` per [TMUX-035](../user/tmux-play.md#tmux-035).

### TTMUX-035
Verifies: [TMUX-044](../user/tmux-play.md#tmux-044), [TMUX-064](../user/tmux-play.md#tmux-064)

Given a real tmux server with two configured players and a YAML config that omits `layout.columnWeights`, when `launchTmuxPlay({ attach: false })` returns and the test forces the window to size `W × H` via `tmux resize-window` (with `window-size manual`), `tmux list-panes` shall report the Boss/Captain pane region width equal to `floor(W / 3)`, the first player column region width equal to `floor(W / 3)`, and the second player column region width equal to the remainder, where region width = `pane_width + 1` for each pane with a right-side border separator.
The invariant shall hold at multiple sample sizes (e.g., `80×24`, `160×40`, `200×50`).
Given the same setup with an explicit non-equal `layout.columnWeights` (for example `[3, 5, 5]`), the per-column region widths shall follow the generalized formula `floor(W * w_i / sum(w))` for each non-rightmost column `i`, with the rightmost column absorbing the remainder, so an explicit override is honored distinctly from the equal-thirds default.

### TTMUX-036
Verifies: [TMUX-045](../user/tmux-play.md#tmux-045)

Given a real tmux server with configured players, when `launchTmuxPlay({ attach: false })` returns, `tmux list-panes` shall report `#{pane_active}=1` for the Boss/Captain pane and `#{pane_active}=0` for every player pane.

### TTMUX-056
Verifies: [TMUX-053](../user/tmux-play.md#tmux-053), [TMUX-054](../user/tmux-play.md#tmux-054), [TMUX-055](../user/tmux-play.md#tmux-055), [TMUX-063](../user/tmux-play.md#tmux-063), [TMUX-071](../user/tmux-play.md#tmux-071)

Given a real tmux server with one Captain pane and at least two configured player panes, when a `TimingObserver` receives synthetic `turn_started`, `player_prompt`, `player_finished`, `captain_prompt`, `captain_finished`, and `turn_finished` records with controlled timestamps, each pane-scoped timer option shall carry the expected cumulative duration for that pane, and the session-scoped total option shall carry the expected turn duration. Given a player or Captain run that is still open when the observer refreshes with a supplied `now`, the displayed duration shall include `now - <open-start>.timestamp`, use the running glyph `⏳`, and use the bright player/Captain accent; after the matching finished record, it shall freeze with glyph `⌛` and `subtext1` (`#bac2de`), per [TMUX-054](../user/tmux-play.md#tmux-054)'s legibility-against-the-mantle-band constraint that explicitly forbids `overlay1` for the per-pane timers. Given an open Boss turn, the status-total timer shall include `now - turn_started.timestamp`, render on `status-right` with the running glyph `⏳` and `mauve`; after `turn_finished`, it shall freeze with the settled glyph `⌛` and `overlay1`. Per [TMUX-071](../user/tmux-play.md#tmux-071), the duration text on every per-pane border timer option and on the `status-right` total timer shall render in `hh:mm:ss` form, every rendered value shall match the regular expression `^[0-9]{2,}:[0-9]{2}:[0-9]{2}$`, and the probe shall pin this on a real tmux server at three regression-relevant magnitudes whose component values shall match the byte-for-byte expected text: at the sub-minute magnitude the rendered text shall begin with `00:00:` and end with a two-digit seconds field (e.g., `00:00:12`, not `12s`); at the minute magnitude the rendered text shall begin with `00:` and carry a non-zero, two-digit minutes field (e.g., `00:01:00`, `00:03:07` — not `1m0s`, not `3m07s`, and not a seconds-only `187s`); at the hour magnitude the rendered text shall carry a non-zero, two-digit hours field followed by colon-separated, two-digit minutes and seconds fields (e.g., `01:00:00`, `01:02:03` — not `1h00m`, not `1h2m3s`, and not a seconds-only `3723s`). The real tmux session shall report the `Spex` brand heading and navigation hints on `status-left` including `switch pane: ctrl+←/→ or shift+←/→`, `stop: esc`, `exit: ctrl+c`, `drag=select`, and `right-click=copy`, and shall not contain the retired `spex`, `Cligent`, or `tmux-play` headings or the retired `d=detach`, `o=switch pane`, `[=scroll`, or `Stop: ESC` fragments; `status-right` shall carry the total timer; `window-status-format`, `window-status-current-format`, and `window-status-separator` shall be empty strings so no default `0:node*` window-list text is rendered; and `pane-border-format` shall reference the pane timer slot without removing `#{pane_title}`. The probe shall assert tmux state via `show-options`, `show-options -p`, and `display-message`, and shall tolerate one cell of visual border-alignment variance for emoji glyph width. It shall run under `*.acceptance.test.ts`, shall not require adapter API keys, and shall self-skip when either `tmux -V` or `glow -v` fails.

### TTMUX-037
Verifies: [TMUX-046](../user/tmux-play.md#tmux-046)

_Superseded for text-body wrapping by [TTMUX-046](#ttmux-046), [TTMUX-047](#ttmux-047), and [TTMUX-048](#ttmux-048), matching the same supersession of [TMUX-046](../user/tmux-play.md#tmux-046) by [TMUX-050](../user/tmux-play.md#tmux-050). The character-level soft-wrap and SGR close/reopen invariants asserted below are no longer implemented by the presenter; this item is retained for spec history alongside the cell-measurement table it verifies in the [TMUX-049](../user/tmux-play.md#tmux-049) tool-input truncation path._

Given a `TmuxPresenter` whose Boss writer has display width `W_b` and whose player writer has display width `W_r`, when the presenter writes a single-logical-line player event of length greater than `W_r`, the player writer's captured text shall contain `\n  ` (newline + two spaces) at the boundary that keeps every emitted row no wider than `W_r` cells, with the first row prefixed by `<playerId>> ` and every subsequent row prefixed by exactly two spaces. The same invariant shall hold for the Boss writer at width `W_b` for a Captain reply, including across `text_delta` events split before, at, and after the wrap boundary. When a writer's width source returns `Infinity`, the writer's output shall be identical to the pre-TMUX-046 behavior (no soft-wrap), and explicit `\n` continuations shall continue to be indented per [TMUX-038](../user/tmux-play.md#tmux-038).

Cell-width and escape handling: when the source text contains East Asian Wide / Fullwidth codepoints, the presenter shall treat each such codepoint as 2 cells when computing the wrap boundary (e.g., at `W_r = 12` the captured text for `<playerId>> ` plus seven Wide characters shall wrap after the second Wide character so the first row is 11 cells and the continuation row is 12 cells). Supplementary-plane emoji whose Unicode `Emoji_Presentation` property is `Yes` shall likewise count as 2 cells, including codepoints outside the hand-curated emoji ranges in the implementation (e.g., U+1F7E7 🟧 in Geometric Shapes Extended and U+1FAE0 🫠 in Symbols and Pictographs Extended-A); the same rule shall apply to BMP emoji such as U+231A ⌚, U+2615 ☕, and U+23F0 ⏰. Each block enumerated in [TMUX-046](../user/tmux-play.md#tmux-046)'s curated EAW=Wide/Fullwidth list shall also resolve to 2 cells, including at least: U+A960 (Hangul Jamo Extended-A), U+4DC0 (Yijing Hexagram Symbols), U+17000 (Tangut), U+18800 (Tangut Components), U+18B00 and U+18CFF (Khitan Small Script, including reserved tail), U+1AFF0 (Kana Extended-B), U+1B000 (Kana Supplement), U+1B100 (Kana Extended-A), U+1B150 (Small Kana Extension), U+1B170 (Nüshu), U+1D300 (Tai Xuan Jing Symbols), and U+1D360 (Counting Rod Numerals). Codepoints that Unicode reports as Neutral, and EAW=Wide/Fullwidth codepoints in blocks not enumerated by TMUX-046 (e.g., archaic scripts not in the curated subset), shall count as 1 cell — including U+1FB70 in Symbols for Legacy Computing and U+1F800 in Supplemental Arrows-C, both Neutral per Unicode. Unicode combining marks and zero-width formatting codepoints shall not advance the wrap column. ANSI escape sequences (CSI, OSC, and `ESC` + next-byte) shall be passed through verbatim without contributing to the cell count and shall never have a `\n  ` inserted in their interior, including when the sequence's bytes arrive in two or more streaming chunks: given three player `text_delta` events whose payloads are `hello`, `\x1b[31`, and `m world` with `W_r = 12`, the player writer's captured text shall be `<playerId>> hello\x1b[31m\n   world` — i.e., the CSI is reassembled into a single `\x1b[31m` token before the soft-wrap fires, and the wrap lands between the escape and the following space rather than inside the escape's parameter bytes. Pending escape state shall not leak across block boundaries: given a player `text_delta` `hello\x1b[31` followed by a `player_finished` with `status: 'ok'` and then a fresh player `text` event `next`, the player writer's captured text shall be `<playerId>> hello\x1b[31\n<playerId>> next\n` — i.e., the partial CSI is flushed verbatim into the previous block before its closing newline, and the next block's leading `n` is not consumed as the missing CSI terminator. Additionally, given a `TmuxPlaySession` whose stdout emits `'resize'`, the session's player pane width query (`queryPaneWidths`) shall be invoked again so subsequent writes use the post-resize width; after the session has shut down, further `'resize'` emissions on stdout shall not invoke the query.

### TTMUX-046
Verifies: [TMUX-050](../user/tmux-play.md#tmux-050)

Given a `TmuxPresenter` receiving one or more `text_delta` events for the same `(writer, who)` pair, the writer shall capture zero bytes until a block boundary fires. The block boundaries that trigger a flush are: a `player_finished` or `captain_finished` record on the writer's pane; a non-streaming `text` event on the same writer; a `player_prompt` on the same writer; a `tool_use` or `tool_result` event on the same writer; and any status emission (`captain_status`, `runtime_error`, `turn_aborted`) targeting the same writer. On flush, the accumulated text shall be passed once to `renderMarkdown` per [TMUX-051](../user/tmux-play.md#tmux-051), and the rendered output shall be emitted under the [TMUX-038](../user/tmux-play.md#tmux-038) prefix grammar. A subsequent `text_delta` arriving after the flush shall open a fresh block whose render call is independent of the prior one.

Given a streaming sequence interleaved with a tool event — e.g., `text_delta('partial\n')` followed by `tool_use(...)` on the same writer — the text shall flush before the `<who>> [tool ↪] …` header so the events appear in order on the pane.

### TTMUX-047
Verifies: [TMUX-050](../user/tmux-play.md#tmux-050), [TMUX-038](../user/tmux-play.md#tmux-038)

Given the rendered output of a text block, the captured bytes shall apply the [TMUX-038](../user/tmux-play.md#tmux-038) grammar to the rendered lines: the first nonblank line shall carry the colored `<who>> ` SGR prefix; every nonblank continuation line shall carry the two-space hanging indent; blank lines in the rendered output shall remain blank without the indent.
The captured bytes shall contain no successfully rendered line that retains `glow`'s trailing horizontal line padding, including padding followed only by SGR resets, while preserving leading whitespace so existing indentation does not change.
The indent shall be uncolored — no SGR sequence shall span the two-space prefix bytes.
Real-glow acceptance shall assert that text-body and tool-result body lines retain no trailing horizontal whitespace after ANSI is stripped.

Given leading or trailing blank lines in the rendered output (introduced by `glow`'s default paragraph-margin styling), the captured bytes shall drop at most one blank line from each edge — `glow`'s outer margin — and shall preserve every other blank line as a blank line, including any blank rows inside a fenced-code frame, around table rows, or between paragraphs, without retaining `glow`'s right-padding cells on those blank lines.
A blanket multi-line trim is not applied because `glow`'s fenced-code rendering emits structural blank rows that match the same shape as its outer margin and would otherwise be collapsed away (e.g., a payload that itself starts with a blank line would lose that line).
Given a rendered block whose content is entirely whitespace after the outer-margin trim, the writer shall receive zero bytes — no synthesized `<who>> ` prefix and no stranded blanks — so empty content cannot surface as a bare prefix line or as padding between turns.

Given a `text_delta` sequence that ends without a trailing newline followed by a `player_prompt` or other boundary event on the same writer, the open block shall flush before the new block opens; the writer shall not interleave the two speakers' content on a single line.

### TTMUX-048
Verifies: [TMUX-050](../user/tmux-play.md#tmux-050)

Given a writer with a configured pane width source returning `W`, `renderMarkdown` shall be invoked for a text block with `width = max(1, W)`, compensating for `glow`'s built-in two-cell document margin while preserving that margin. Given a writer with no configured pane width source, the default render width shall be `80`. Given the first visible rendered row would exceed `W` after adding the speaker's `<who>> ` prefix (`6` cells for `boss`, `9` for `captain`, `playerId.length + 2` for a player pane), the presenter shall split only that first row at a cell-aware word boundary, emit no line wider than `W`, and keep later continuation rows free to reach the pane edge when real rendered content reaches that width. Given a `tool_result` body, the render width shall be `max(1, W - 2)`, matching the two-space continuation indent the body lines carry (not the wider tool header prefix).

### TTMUX-049
Verifies: [TMUX-051](../user/tmux-play.md#tmux-051)

Given `tmux-play` invoked in launcher mode on a host where `isGlowAvailable()` returns `false`, `launchTmuxPlay` shall reject with an error whose message names `glow` and contains the install URL `https://github.com/charmbracelet/glow#installation`. The launcher shall not invoke any subsequent launcher work — no config discovery, no work-directory creation, no `tmux` session construction — so the rejection surfaces before any side effects. The `glow` check shall run after the existing `tmux` availability check so a host missing both binaries reports `tmux` first.

## Permission Configuration

### TTMUX-052
Verifies: [TMUX-052](../user/tmux-play.md#tmux-052)

Given a YAML config that sets `permissions` on the captain and on a player, when `loadTmuxPlayConfig` returns, the loaded `captain.permissions` and `players[i].permissions` shall be the typed [`PermissionPolicy`](../user/engine.md#eng-021) values from the YAML, with `writablePaths` entries validated and canonicalized per [ENG-022](../user/engine.md#eng-022). Given a YAML with an unknown sub-field under `permissions`, with a `mode` value outside `'auto' | 'bypass'`, with a `fileWrite` / `shellExecute` / `networkAccess` value outside `'allow' | 'ask' | 'deny'`, with invalid `writablePaths`, or with `permissions` set to a non-object, the loader shall reject with an error that names the offending path per [TMUX-008](../user/tmux-play.md#tmux-008).

### TTMUX-053
Verifies: [TMUX-052](../user/tmux-play.md#tmux-052), [ENG-021](../user/engine.md#eng-021), [ENG-022](../user/engine.md#eng-022), [ENG-023](../user/engine.md#eng-023)

Given a captain or player `PermissionPolicy` accepted by the loader, when the runtime constructs the corresponding `Cligent`, the value shall reach the adapter as `AgentOptions.permissions` at the next `run()` call, and the adapter's `mapPermissionsToXxxOptions` shall translate `mode: 'auto'`, `mode: 'bypass'`, and any canonicalized `writablePaths` to the SDK knobs enumerated in [DR-005](../decisions/005-per-adapter-permission-configuration.md) and [DR-006](../decisions/006-workspace-writable-paths.md): claude → `permissionMode: 'auto'` / `'bypassPermissions'` plus ambient `writablePaths` reporting; codex → `ThreadOptions: { approvalPolicy: 'on-request' }` plus `CodexOptions.config: { approvals_reviewer: 'auto_review', default_permissions: ':workspace' }` and `exec --ignore-user-config`, or a generated extra-writes profile for writable paths / `ThreadOptions: { approvalPolicy: 'never' }` plus `CodexOptions.config: { default_permissions: ':danger-full-access' }` and `exec --ignore-user-config`; gemini → `approvalMode: 'yolo'` for either mode plus ambient `writablePaths` reporting when provided; opencode → `permission: { edit: 'allow', bash: 'allow', webfetch: 'allow' }` for `'auto'` plus ambient `writablePaths` reporting when provided, and a thrown error naming the SDK/server architecture for `'bypass'`.

### TTMUX-054
Verifies: [TMUX-052](../user/tmux-play.md#tmux-052), [TMUX-008](../user/tmux-play.md#tmux-008), [TMUX-025](../user/tmux-play.md#tmux-025)

Given a YAML config whose `permissions.mode` is outside the closed set, when the launcher CLI is invoked, the process shall exit with a nonzero status and write a single `Error: ...` line to stderr that names the offending path (e.g., `captain.permissions.mode` or `players[0].permissions.mode`). The runtime shall not start, and no `runtime_error` record shall be observable — the failure is a launcher-startup abort that falls outside [TMUX-025](../user/tmux-play.md#tmux-025)'s runtime-existence scope, per [DR-005](../decisions/005-per-adapter-permission-configuration.md)'s failure-surfacing rule.

## Reasoning Effort Configuration

### TTMUX-057
Verifies: [TMUX-056](../user/tmux-play.md#tmux-056), [ENG-020](../user/engine.md#eng-020), [CLAUDE-008](../user/adapters/claude-code.md#claude-008), [CODEX-007](../user/adapters/codex.md#codex-007), [GEMINI-011](../user/adapters/gemini.md#gemini-011), [OPENCODE-012](../user/adapters/opencode.md#opencode-012)

Given a YAML config that sets `captain.reasoningEffort` and `players[].reasoningEffort` across players covering the supported adapters, when the launcher/session seam constructs the corresponding `Cligent` instances and invokes adapter seams, the accepted values shall reach the adapter-specific mapped surfaces: Claude SDK `effort`, Codex SDK `modelReasoningEffort`, Gemini per-run settings aliases for concrete `^gemini-3` and `^gemini-2\.5` model IDs, and OpenCode v2 prompt-body top-level `variant`. The Gemini assertion shall also cover the skip cases from [GEMINI-011](../user/adapters/gemini.md#gemini-011): a CLI alias or non-matching concrete model writes no custom alias and preserves `--model <model>`, and an unset model writes no custom alias and passes no `--model` flag.

### TTMUX-058
Verifies: [TMUX-056](../user/tmux-play.md#tmux-056), [TMUX-008](../user/tmux-play.md#tmux-008), [TMUX-025](../user/tmux-play.md#tmux-025)

Given a YAML config whose `captain.reasoningEffort` or `players[0].reasoningEffort` is outside [ENG-020](../user/engine.md#eng-020)'s closed set, when the launcher CLI is invoked, the process shall exit with a nonzero status and write a single `Error: ...` line to stderr that names the offending path. The runtime shall not start, and no `runtime_error` record shall be observable because the failure is a launcher-startup abort outside [TMUX-025](../user/tmux-play.md#tmux-025)'s runtime-existence scope.

## Layout Configuration

### TTMUX-064
Verifies: [TMUX-064](../user/tmux-play.md#tmux-064), [TMUX-008](../user/tmux-play.md#tmux-008), [TMUX-025](../user/tmux-play.md#tmux-025), [TMUX-034](../user/tmux-play.md#tmux-034)

Given a YAML config that omits `layout`, when `launchTmuxPlay({ attach: false })` returns, the work-directory snapshot at `<workDir>/tmux-play.config.snapshot.json` shall carry `layout: { window: { columns: 174, rows: 49 }, columnWeights: [1, 1] }` when one player is configured and `layout: { window: { columns: 174, rows: 49 }, columnWeights: [1, 1, 1] }` when two or more players are configured.
Given a YAML config that supplies a fully concrete `layout`, the same snapshot file shall carry the same `window.columns`, `window.rows`, and `columnWeights` values verbatim per [TMUX-034](../user/tmux-play.md#tmux-034).
Given a YAML config that supplies a partial `layout.window` (for example `columns: 200` with no `rows`), the snapshot's `layout.window` shall be `{ columns: 200, rows: 49 }` — each missing sub-field independently defaulted, each supplied sub-field preserved verbatim — and the snapshot shall not contain `{ columns: 174, rows: 49 }` for that window.
Given a YAML config whose `layout` is malformed — `layout.window.columns` or `layout.window.rows` not a positive integer; `layout.columnWeights` not an array; any weight not a positive integer (decimals such as `0.5`, NaN, Infinity, zero, negatives, and non-number types shall all reject); `layout.columnWeights` length not matching the visible column count derived from the configured players (2 with one player, 3 with two or more); any unknown sub-field under `layout` or `layout.window` — when the launcher CLI is invoked, the process shall exit with a nonzero status and write a single `Error: ...` line to stderr that names the offending path (e.g., `layout.window.columns`, `layout.columnWeights[2]`) per [TMUX-008](../user/tmux-play.md#tmux-008).
The runtime shall not start, no tmux session shall be created, and no `runtime_error` record shall be observable because the failure is a launcher-startup abort outside [TMUX-025](../user/tmux-play.md#tmux-025)'s runtime-existence scope.

## Boss Input Keybindings

### TTMUX-059
Verifies: [TMUX-057](../user/tmux-play.md#tmux-057), [TMUX-026](../user/tmux-play.md#tmux-026), [TMUX-040](../user/tmux-play.md#tmux-040)

Given a `TmuxPlaySession` running against TTY-like input with an active Boss turn in flight, when the input delivers a bare ESC byte and the readline escape timeout elapses, observers shall capture one `turn_aborted` record with reason `ESC`, the Boss/Captain pane shall capture the `captain> [turn aborted] ESC` status line, no `runtime_error` record shall be emitted, and the session shall remain open.
Given the same session, when the input delivers the arrow-up sequence `\x1b[A`, no `turn_aborted` record shall be emitted.
Given the Boss readline edit buffer contained user-typed bytes when the bare ESC arrived, when the Boss presses Enter after the abort, the next Boss turn shall receive those retained bytes as its prompt.
Given non-TTY input, the ESC keybinding shall not be installed and SIGINT/SIGTERM/EOF shutdown behavior shall remain governed by [TMUX-026](../user/tmux-play.md#tmux-026).

### TTMUX-060
Verifies: [TMUX-058](../user/tmux-play.md#tmux-058)

Given a `TmuxPlaySession` running against TTY-like input and output, when the input delivers `\x1b[200~Alpha\nBravo\nCharlie\x1b[201~` followed by Enter, exactly one Boss turn shall start with prompt `Alpha\nBravo\nCharlie`.
Given the input delivers `\x1b[200~Alpha\nBravo\n\x1b[201~` followed by Enter, exactly one Boss turn shall start with prompt `Alpha\nBravo`.
Given the input delivers `\x1b[200~Alpha\nBravo\x1b[201~` followed by `-extra` and Enter, exactly one Boss turn shall start with prompt `Alpha\nBravo-extra`.
The output shall capture the bracketed-paste-enable sequence when the session starts and the bracketed-paste-disable sequence on shutdown.
Given non-TTY output, neither bracketed-paste control sequence shall be written to output.

### TTMUX-074
Verifies: [TMUX-075](../user/tmux-play.md#tmux-075), [TMUX-037](../user/tmux-play.md#tmux-037), [TMUX-057](../user/tmux-play.md#tmux-057), [TMUX-058](../user/tmux-play.md#tmux-058)

Given a `TmuxPlaySession` running against TTY-like input and output with a Boss turn in flight whose player/Captain call is blocked (the `runBossTurn` promise is still pending), when the presenter streams the Captain's `captain> ` reply to the Boss/Captain pane (player `<playerId>> ` output stays in its player pane per [TMUX-040](../user/tmux-play.md#tmux-040)), the captured Boss/Captain-pane content shall show no fresh `boss> ` readline prompt line following that streamed output between `turn_started` and the matching `turn_finished` or `turn_aborted` — the already-submitted input line that opened the turn (the `boss> <prompt>` echo per [TMUX-037](../user/tmux-play.md#tmux-037)) is unaffected; after the turn resolves, exactly one fresh `boss> ` prompt shall be restored as the pane's ready prompt.
Given the Boss types type-ahead bytes during the active turn, those bytes shall not render a fresh `boss> `-prefixed line while the turn is active, and the next Enter after the turn ends shall fire exactly one `runBossTurn` whose prompt is the preserved type-ahead bytes per [TMUX-057](../user/tmux-play.md#tmux-057).
Given the Boss instead pastes multi-line text (bracketed paste per [TMUX-058](../user/tmux-play.md#tmux-058)) during the active turn, the pasted bytes shall not render a fresh `boss> ` line while the turn is active, and the next Enter after the turn ends shall fire exactly one `runBossTurn` whose prompt preserves the pasted text's embedded newlines per [TMUX-058](../user/tmux-play.md#tmux-058).
The session-level probe shall use a real `createInterface` over a TTY-like input/output pair (as the [TTMUX-059](#ttmux-059) ESC probe does), because a stubbed readline does not echo prompt chrome and would pass vacuously.
Given a `TmuxPlaySession` whose `runBossTurn` blocks, when the Boss submits one line that starts a turn and then submits a second line that queues behind it (the runtime serializes turns per [TMUX-018](../user/tmux-play.md#tmux-018)), releasing the first turn shall paint no fresh ready `boss> ` prompt while the second turn is still queued, and exactly one fresh ready prompt shall be painted after the second (last) queued turn ends. An empty or whitespace-only line submitted while a turn is active or queued shall paint no fresh ready `boss> ` prompt. This queue-drain clause is observable through the session's prompt-paint count, so it may use a stubbed readline rather than a real `createInterface`.
Given a real tmux server with an attached client and a Boss turn in flight, pane 0 shall show no fresh `boss> ` readline prompt line after the turn's streamed Captain output between `turn_started` and the turn's terminal record (the submitted-prompt input line is unaffected); this acceptance clause shall run under `*.acceptance.test.ts` and shall self-skip when `tmux -V`, `glow -v`, or an attached-client driver is unavailable or cannot attach a client (e.g. a headless CI runner).

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

Given a text-body prose block rendered in a 40-cell pane by a real `glow` binary, at least one non-first continuation row shall be at least 39 cells wide after ANSI is stripped, and no visible row shall exceed 40 cells. The near-edge row shall begin with the presenter's two-space continuation indent followed by `glow`'s preserved two-space document margin. This pins the user-reported "empty right side of every pane" defect that remained after the trailing-padding strip: the output must compensate for `glow`'s document margin while still avoiding terminal-level rewrap.
