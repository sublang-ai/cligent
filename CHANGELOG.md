<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.16.0] - 2026-07-18

### Added

- Kimi Code support through the public `KimiAdapter` and tmux-play `kimi` adapter, targeting the maintained `@moonshot-ai/kimi-code` 0.27.0 CLI through one short-lived `kimi acp` process per run and the generic ACP SDK 0.23.0 rather than a legacy or unpublished Kimi-specific SDK. The adapter streams normalized text and correlated tool events without exposing raw thought chunks, creates or resumes backend sessions with automatic `resumeToken` continuity, supports model selection and provider-native binary `effort: off | on`, preserves Kimi's native permissions when no policy is supplied, and maps `permissions: { mode: auto }` to Kimi's native auto mode. Unsupported bypass, policies without a mode (including per-capability-only policies), explicit tool filters, and turn or budget limits fail before spawn; `writablePaths` with auto mode are reported as ambient rather than sandbox-enforced. Kimi Code 0.27 ACP requires the OAuth credential created by `kimi login`; exact ACP initialization is always verified, while authenticated live acceptance discovers an explicit source, `KIMI_CODE_HOME`, or `~/.kimi-code` locally, shares one isolated OAuth clone across safe-write and five-player fanout, and requires a dedicated source in CI — DR-011, IR-036, KIMI-001–KIMI-012

### Changed

- `@agentclientprotocol/sdk` 0.23.0 and its schema peer `zod` 4.4.3 are now direct runtime `dependencies` rather than optional agent peers, because the Kimi adapter imports the generic ACP protocol surface directly instead of a vendor SDK. Upgrading from 0.15.0 therefore adds both packages to the install graph; each is pinned exactly so the wire schema matches the Kimi Code CLI conformance target, while the four agent SDKs remain optional peers — PKG-003, PKG-012
- Release-candidate Codex conformance now pins Codex CLI/SDK 0.144.5, replacing the 0.144.1 target shipped in 0.14.0. The exact `devDependency`, the npm lockfile, and the repository target verifier move together; the optional `@openai/codex-sdk` peer floor remains `>=0.138.0` — PKG-012

### Fixed

- Live Kimi acceptance no longer reports a false CI failure once its OAuth credential is spent. Kimi Code 0.27 admits no non-interactive credential — the ACP gate accepts only the managed OAuth token, and `KIMI_API_KEY` never reaches it — while every refresh rotates the refresh token and persists the replacement into the refreshing home. A credential restored from an immutable CI secret is therefore single-use: the first refreshing run consumes it and writes a revoked tombstone that fails every later leg sharing the clone. The harness now probes credential usability once, up front, against the same shared clone, and self-skips the live Kimi legs with a precise reason when the token is spent — including under CI, where the failure indicated Kimi's OAuth design rather than a defect here. An absent fixture or CLI still hard-fails under CI, and the credential-free ACP initialization conformance check stays mandatory, so protocol-surface regressions still fail the build — DR-011, TADAPT-019
- tmux-play no longer renders an unknown adapter in the accent reserved for a known one. `kimi` claims Catppuccin `sapphire`, but sapphire also remained the first entry of both unknown-adapter fallback pools, so custom adapter names landing in that bucket — `cursor`, `qwen`, `agentx`, `cline` — drew exactly the `kimi` accent and became indistinguishable from a `kimi` player's speaker prefixes and pane-border timer in the same session. Both pools are now the four documented colors (sky, rosewater, maroon, flamingo) on each flavor, so every fallback accent is disjoint from the known-adapter table — TMUX-048

## [0.15.0] - 2026-07-15

### Added

- Isolated tmux-play Captain control calls: `CallCaptainOptions` now exposes a per-call session selector `resume?: string | false` and a tool restriction `allowedTools?: readonly string[]` alongside presentation visibility, so a Captain's routing and adjudication calls can start from a fresh backend session with a closed tool registry. Omitting both preserves the runtime-owned Captain `Cligent`'s automatic continuity and adapter-native tool surface; `resume: false` forces a fresh backend session; and an explicit `allowedTools: []` requires a tool-free run. The runtime-owned Captain `Cligent` forwards only the present controls, and the tmux-play records and visibility behavior are unchanged — DR-010, IR-034

### Changed

- Explicit `allowedTools` / `disallowedTools` are now enforced as a tool-availability boundary rather than an approval hint, and an adapter that cannot honor an explicit restriction fails closed instead of silently weakening the request. An explicit allowlist — including an empty one — is a control boundary: Claude Code selects the available built-ins via SDK `tools` while `allowedTools` keeps automatic approval, sets `strictMcpConfig: true` for every explicit list, and additionally uses `settingSources: []` to drop filesystem settings and `CLAUDE.md` for the empty case; Gemini emits User-tier Policy Engine allow rules plus a catch-all deny (only the catch-all deny when empty); OpenCode maps to prompt tool booleans led by a wildcard deny (`{ "*": false }` when empty); and Codex now rejects any explicit `allowedTools`/`disallowedTools` (including empty arrays) before loading its SDK. `disallowedTools` retains precedence across the enforcing adapters, and omitting both options preserves each provider's native tool surface — DR-010, IR-034

## [0.14.0] - 2026-07-12

### Added

- Adapter-scoped effort vocabularies and discovery metadata: the public API exports `PortableEffort`, per-adapter effort aliases derived from the authoritative `EFFORT_SUPPORT` literal values, and matching lookup/validation helpers; Claude Code accepts `ultracode` through native `xhigh` plus its orchestration setting, Codex accepts native `ultra` through `model_reasoning_effort`, and Gemini/OpenCode retain the portable `minimal | low | medium | high | xhigh | max` set while direct, custom, and heterogeneous calls keep adapter-correlated TypeScript inference — DR-009, IR-031, IR-033, ENG-020, ENG-024
- Optional tmux-play `Captain.prepareDispose()` lifecycle hook for lossless final session telemetry. It runs exactly once after the active turn unwinds while `CaptainSession` emissions remain live, before the session signal aborts and before legacy post-close `dispose()`. Rejected pre-close hooks still complete abort, drain, final disposal, and observer detachment; independent cleanup failures are preserved in an `AggregateError`, and partially initialized Captains receive the same two-stage cleanup — DR-008, IR-029, TMUX-085
- Per-call player session selection for tmux-play Captains: `context.callPlayer(playerId, prompt, { resume })` accepts an opaque token to override the player's stored automatic continuation, or `false` to force a fresh backend session; omitting the option keeps the existing auto-resume behavior — IR-028, TMUX-016, TMUX-041

### Changed

- **Breaking:** renamed the public `reasoningEffort` option and tmux-play YAML field to `effort`, with adapter-correlated TypeScript declarations and runtime validation that reject provider-native values on the wrong adapter. After a complete document validates, tmux-play accepts direct legacy keys in memory and makes a bounded best-effort update of their exact parsed key tokens; a changed or unwritable source keeps the validated runtime value and produces an actionable manual-rename warning, while conflicting keys, invalid values, or other validation failures reject without writing. This compatibility path intentionally carries no broader lossless formatting, filesystem-metadata, or concurrency guarantee — DR-009, IR-031, IR-033, TMUX-056, TMUX-086
- Release-candidate conformance targets now pin Claude Code 2.1.207 with Claude Agent SDK 0.3.207, Codex CLI/SDK 0.144.1, Gemini CLI 0.50.0, and OpenCode CLI/SDK 1.17.18. Repository verification checks the exact installed SDK packages, bundled Claude/Codex targets, external CLI reports, and OpenCode managed-server surface; Claude's optional peer floor is now `>=0.3.154`, while the other agent peer floors remain unchanged — IR-032, PKG-012
- Gemini CLI 0.50 permissions now use temporary non-interactive User-tier Policy Engine rules instead of deprecated runtime tool controls. Administrator configuration retains precedence, omitted permissions preserve Gemini's native defaults, and isolated live authentication leaves the CLI's default `auto` model routing unchanged unless a model is explicitly selected — IR-030, GEMINI-006, GEMINI-012, GEMINI-014
- Distributable readiness now cleans `dist` before build, prepack, and the development launcher; packs and inspects the actual npm tarball; installs it without optional agent peers; imports every public entry point and runs the installed launcher on the declared Node `>=18.3.0` floor; compiles adapter-scoped effort declarations with strict TypeScript 5.4.5; and requires clean production and full dependency audits in CI — IR-032, PKG-002, PKG-011, PKG-013, PKG-014

### Fixed

- Gemini adapter now forwards prompt, model, and resume values as joined `--prompt=<value>`, `--model=<value>`, and `--resume=<value>` tokens, preserving leading-dash values and restoring actual backend continuity instead of only carrying resume tokens through normalized events — IR-028, IR-030, GEMINI-003, GEMINI-007
- OpenCode no longer injects adapter-generated session permission rules when `PermissionPolicy` is absent, preserving the user's native OpenCode defaults while continuing to apply independent tool-list restrictions — IR-032, OPENCODE-007, OPENCODE-013
- Permission-managed Codex runs now supply active-project trust through a per-run override instead of persisting throwaway `projects.<path>.trust_level` entries in repository or user configuration — IR-032, CODEX-010

## [0.13.0] - 2026-06-29

### Added

- Dynamic player visibility for tmux-play: a Captain can change which configured players occupy the main tmux window across a session via `setVisiblePlayers(playerIds)`, exposed on both `CaptainSession` (for `init()` and between-turn phase setup) and the turn-scoped `CaptainContext`. The full roster stays static — visibility changes only which existing players have panes, never the runtime player map, per-player log streams, the `players` manifest, or any player's `Cligent` continuity. Hidden players stay live and keep accumulating output to their per-player logs, and a re-shown player's pane is rebuilt from the recent tail (`tail -n 200 -f`) of its log. The runtime validates a non-empty, duplicate-free subset of the configured IDs and, only on success, emits exactly one `player_view_changed` record (carrying `visiblePlayerIds` in order, exported from `@sublang/cligent/tmux-play`) that a session-mode layout observer reconciles with a full player-area rebuild. Non-layout observers (presenter, follow, timing, notification) ignore the record, so a visibility change writes no Boss/Captain-pane content and the rebuild path is display-only — a tmux rebuild failure never aborts the Boss turn — DR-007, IR-027, TMUX-081, TMUX-082, TMUX-083
- `layout.initialVisible` in tmux-play YAML — an optional, non-empty, duplicate-free subset of the configured player IDs naming the panes the launcher creates at startup, in that order; omitting it shows every configured player in `players` order (prior behavior). The startup visible-column shape, and thus the weight preset selected, now derives from the visible-set size rather than the configured roster size — TMUX-080, TMUX-028
- Shape-specific column weights `layout.singlePlayerColumnWeights` (length 2) and `layout.multiPlayerColumnWeights` (length 3) select the per-column widths by the visible-column shape — one visible player picks the two-column weights, two or more pick the three-column weights — with the shipped defaults unchanged at 50/50 and even thirds — TMUX-064, TMUX-044

### Changed

- `layout.columnWeights` is now a backward-compatible alias for the shape-specific weight fields: a two-element value feeds `singlePlayerColumnWeights`, a three-element value feeds `multiPlayerColumnWeights`. Setting `columnWeights` together with the matching canonical field is rejected with the offending path named, and a home config that still carries `columnWeights` is migrated in place to the canonical field — writing one final YAML form that never holds both — while `--config` files and cwd project configs are left unmutated and stay valid through the alias. The shipped default home config and the home-migration safe defaults now write `multiPlayerColumnWeights: [1, 1, 1]` rather than `columnWeights` — TMUX-064, TMUX-010, TMUX-011
- The release workflow now refuses to publish unless the tagged commit's CI run (its `push` to `main`) concluded successfully, waiting for it if still in progress and failing if it concluded unsuccessfully or never ran. Relatedly, the attached-client acceptance probes self-skip in headless CI via a `canAttachClient()` precheck instead of failing when no client can attach — the gap that let the 0.12.0 publish go out on a red CI run — RELEASE-007

## [0.12.0] - 2026-06-14

### Added

- Best-effort sound and desktop notifications for tmux-play. A top-level `notifications` block maps the `player_finished`, `turn_finished`, and `turn_aborted` events to a sink from the closed set `off` / `bell` / `desktop`; the shipped home config defaults to `player_finished: bell` and `turn_finished: desktop`, an omitted `turn_aborted` resolves to `off`, and an unknown key or sink is rejected with the offending path named. The `bell` sink plays one best-effort native sound cue — detached `afplay /System/Library/Sounds/Hero.aiff` on macOS, a freedesktop `complete` cue on Linux, a generic notification sound on Windows, no-op elsewhere — rather than writing a terminal BEL. The `desktop` sink sends one native desktop notification with a lowercase `spex` title; a macOS `turn_finished: desktop` additionally writes exactly one terminal BEL so tmux forwards the turn-completion bell to the outer terminal for Dock badging, while every other desktop path writes no terminal BEL or escape bytes — TMUX-076, TMUX-077
- Right-click copy-confirmation toast in tmux-play: right-clicking a pane that holds a selection now surfaces a brief `Copied!` toast on the status line (a tmux `display-message` styled by the session's peach `message-style`) alongside the system-clipboard copy, while an empty right-click copies silently with no toast. The copy and toast fire on the button release, so the toast survives for the session's `display-time` instead of being wiped by the release, and the right-click does not change pane focus — TMUX-062

### Changed

- Raised the optional `@openai/codex-sdk` peer dependency floor to `>=0.138.0`, the first Codex CLI line with `exec --ignore-user-config` support required by permission-managed runs.
- tmux-play status-left now uses the `Spex` brand heading, desktop notification titles use lowercase `spex`, and navigation hints use lowercase compact labels consistently (`stop: esc`, `exit: ctrl+c`, etc.).

### Fixed

- tmux-play no longer pollutes the Boss/Captain pane's scrollback when the prompt is edited: Node's readline redraws each edit with a clear-to-end-of-display (`CSI 0J`) that, with the prompt at the top of a tmux pane, made tmux scroll the erased rows into history, so typing `abc` and backspacing it away left phantom `boss> abc` / `boss> ab` / `boss> a` rows that appeared when scrolling the pane up. The session now routes readline's redraws through a scrollback-safe wrapper that rewrites that erase into a cursor-preserving, line-scoped clear (visually identical, never history-preserving). This fixes the true cause of the "scrolling the Captain pane up shows stale edit states above the first line" report and supersedes the removed wheel-up clamp (the prior `WheelUpPane` bindings and TMUX-078) that had chased the symptom — stock tmux already clamps wheel-up at the top of history — TMUX-079.
- tmux-play text blocks now fill the full pane width: continuation rows render to the `paneWidth - 2` budget instead of inheriting the first line's speaker-prefix reserve, the first visible row is prefix-fit split at a cell-aware word boundary when the `<who>> ` prefix would overflow, and `glow`'s document margin and trailing right-padding are compensated and stripped — so prose no longer leaves the right side of each pane empty — TMUX-050
- tmux-play's shipped Codex player default now uses `permissions: { mode: auto }` to select Codex's `auto_review + :workspace` profile, and Codex permission-managed runs invoke `exec --ignore-user-config` so a user-level stale or read-only Codex config cannot override Cligent's managed profile.

## [0.11.0] - 2026-06-09

### Added

- `PermissionPolicy.writablePaths`: an optional string array that grants specific workspace-relative subpaths as writable, so a `mode: 'auto'` player can write paths like `.git` without a full filesystem bypass or `:danger-full-access`. A shared validator canonicalizes each entry (normalizes separators, strips `./` and trailing slashes, collapses `.`) and rejects absolute, parent-traversing (`..`), glob, shell-expansion, control-character, and root-equivalent (`.` / `./`) entries with a path-named error; the validator guards untrusted input (e.g. YAML) as well as typed callers. A per-call `writablePaths` array replaces the instance default rather than merging element-wise. Adapters report how each grant is enforced through the exported `WritablePathsPermissionMapping` (canonical paths plus an enforcement class) over the closed `WritablePathsEnforcement` set `profile` / `sandbox` / `ambient`; absent or empty `writablePaths` emits no payload — DR-006, ENG-022, ENG-023, IR-026
- Codex `writablePaths` enforcement via a generated write profile: when `writablePaths` is non-empty and local access resolves to `:workspace`, the Codex adapter synthesizes a `cligent-workspace-extra-writes` profile that extends `:workspace` and grants write under `:workspace_roots` for each canonical path (enforcement `profile`); non-empty `writablePaths` against `:read-only` is rejected before the thread starts, and `:danger-full-access` stays broad (paths reported as `ambient`, no extra-writes profile). Because the SDK's flat dotted `--config` keys cannot express the nested `:workspace_roots` table, the profile body ships as a raw CLI `--config` inline table injected through a per-run Codex path wrapper — a temp script removed after the run — which mutates neither machine-level nor repository Codex config and preserves the user's Codex home, auth, and config layers — CODEX-004, CODEX-010, DR-006
- Ambient `writablePaths` support in the Claude, Gemini, and OpenCode adapters: these CLIs expose no filesystem-sandbox write-grant surface that cligent drives, so valid entries canonicalize and are reported with enforcement `ambient` across every mapping return path, while invalid entries throw. This adds reporting only — existing per-adapter permission and tool mapping is unchanged — CLAUDE-004, GEMINI-006, OPENCODE-007
- tmux-play `permissions.writablePaths` in YAML: captain and player permission blocks now accept `writablePaths`, granting workspace-relative writes (e.g. `.git` for a Codex player) the same way the API does. Each entry is canonicalized and validated through the shared helper (same rules as the SDK) and invalid or non-array values are rejected with a path-named error — TMUX-052, TMUX-008

### Changed

- Exported a single `PermissionCapability` type (`fileWrite` / `shellExecute` / `networkAccess`) shared across the Claude, Gemini, and OpenCode adapters, replacing the per-adapter copies and Gemini's brittle `keyof`-`Exclude` derivation that had to list `writablePaths` by hand
- Upgraded all four coding-agent integrations to their latest versions: `@anthropic-ai/claude-agent-sdk` 0.3.148 → 0.3.169, `@openai/codex-sdk` 0.133.0 → 0.138.0, and `@opencode-ai/sdk` 1.15.7 → 1.16.2 (npm dev dependencies); `@google/gemini-cli` 0.41.2 → 0.45.2 and `opencode-ai` 1.14.41 → 1.16.2 (CI global CLIs). Claude and Codex ship their agent binaries with the npm SDK, so the SDK bump moves them too — only Gemini (CLI-only) and OpenCode (SDK plus a separate CLI) carry workflow CLI pins

## [0.10.0] - 2026-06-09

### Added

- Per-call `callCaptain` visibility: `callCaptain(prompt, { visibility: 'hidden' })` runs the Captain normally and returns the same `CaptainRunResult`, but produces zero Boss-pane output. The runtime still emits the call's `captain_prompt` / `captain_event` / `captain_finished` records tagged with the resolved `visibility`, so non-presenter observers keep the full trace while the tmux presenter skips the hidden ones. Because a hidden call writes no Boss-pane bytes, the copy-mode follow observer also leaves a scrolled Boss/Captain pane at its scroll position across the call. Omitting the option (or passing `'visible'`) is byte-for-byte unchanged; `callPlayer` is unaffected — TMUX-016, TMUX-040, TMUX-069, TMUX-072

### Fixed

- Session mode no longer paints a spurious `boss> ` prompt around an active Boss turn. While a turn is in flight the live readline used to repaint `boss> ` chrome on any keystroke, which a turn-completion consumer reading the Boss/Captain pane could misread as an implicit turn-over signal; the prompt is now suspended when the runtime starts a turn and restored exactly once on every turn-end path (normal completion, ESC abort, runtime/observer-dispatch error). Separately, when the Boss queued lines back-to-back a fresh ready prompt flashed between consecutive turns; a fresh prompt is now painted only once the turn queue drains. Type-ahead the Boss types or pastes during a turn is preserved and surfaced on the restored prompt; ESC-abort and bracketed-paste handling are unchanged, and non-TTY stdin is a no-op — TMUX-075, TMUX-037, TMUX-057, TMUX-058, IR-025
- Player agents spawned during a session can no longer take down the run's own tmux server. Spawned agents inherited the orchestrator's live tmux client environment, so a player tasked with debugging tmux that ran `tmux kill-server` killed the session hosting the run, surfacing to the Boss as `[server exited]` / `tmux attach-session failed`. Session mode now scrubs `TMUX` / `TMUX_PANE` and redirects `TMUX_TMPDIR` to a private directory for spawned player agents, so any `tmux` they run resolves to its own isolated server; the orchestrator keeps targeting the real session via an environment snapshot captured before the scrub — TMUX-074, TTMUX-073

## [0.9.0] - 2026-06-04

### Added

- Per-pane mouse selection and system-clipboard right-click copy. tmux-play turns on mouse mode: left-drag selects within a pane, right-click copies the selection to the system clipboard (`pbcopy` / `wl-copy` / `xclip` / `xsel`, falling back to a tmux buffer) via `copy-pipe` (not `copy-pipe-and-cancel`), and a left-click drops any active selection — each path preserving the clicked pane's copy-mode scroll position — TMUX-062, TMUX-068
- Direct pane switching without the `Ctrl+b` prefix: `Ctrl+←/→` and `Shift+←/→` both move between panes (both pairs ship because terminal emulators variously intercept one or the other). `status-left` advertises `Switch pane: Ctrl+←/→ or Shift+←/→`. Each binding is gated on the active `#{session_name}` via `if-shell -F`, so other tmux sessions on the same server keep stock behavior — TMUX-063
- Single-press exit and turn-abort from any pane in any mode: `Ctrl+C` runs the TMUX-026 exit lifecycle and a bare `ESC` aborts the active turn even from a read-only player pane or a pane scrolled into copy-mode. Both are forwarded to the Boss/Captain pane across the `root` / `copy-mode` / `copy-mode-vi` key tables with a cancel-pane-0-then-forward true branch, fixing the "two presses to quit when scrolled" and "swallowed on a player pane" defects — TMUX-065, TMUX-070, IR-024
- Copy-mode live-follow: a pane scrolled back into copy-mode returns to its live tail when new output is written to it, while a pane with no concurrent output stays scrolled for review — TMUX-069, IR-024
- YAML `layout` block: optional `layout.window` (`columns` / `rows`) sets the initial cell grid and `layout.columnWeights` sets per-column width ratios, both validated with the offending path named on error — TMUX-064, IR-022
- OSC 11 terminal-background detection: tmux-play queries the terminal background color to auto-select the Catppuccin flavor (Mocha for dark, Latte for light), refining the prior `COLORFGBG` / `TERM_PROGRAM` heuristic; a `--theme-diagnostics` mode prints the resolved flavor and reason without creating a session — TMUX-047, TMUX-061

### Changed

- Refreshed shipped tmux-play defaults: the first-run home config uses a `174 × 49` window (1080p at 18 pt monospace), multi-player `columnWeights: [1, 1, 1]`, and `model: claude-opus-4-8` for the Captain and the `claude` player; the `codex` player and all `permissions` / `reasoningEffort` defaults are unchanged — TMUX-064, IR-023
- Run-time timers render in `hh:mm:ss` form on every per-pane border and the status-bar total: all three components are always present and zero-padded (e.g., `00:00:00`, `00:01:00`, `01:02:03`), with the hours field expanding past two digits at 100 h. This replaces the prior seconds-only `<n>s` and padded `Xm…s` / `Xh…m` forms — TMUX-071
- The `status-left` brand heading reads `Cligent` instead of `tmux-play`
- tmux-play config loading now rejects unknown top-level YAML keys (e.g. a typo like `layoutt:`) with an error naming the offending path, instead of silently ignoring them and falling through to defaults; the `captain`, `players[]`, and `layout` scopes already validated their own keys, so only the root scope changes — TMUX-008

### Fixed

- Player context now survives an ESC-aborted Boss turn end-to-end. The engine captures the adapter's interrupt-time resume token that the abort short-circuit previously discarded (so a resumable player resumes its session on the next turn); when the interrupted `done` carries no resumable token, the built-in fanout Captain re-sends the interrupted Boss prompt(s) on the player's next call so it continues with context instead of answering "this appears to be the first turn." `Cligent` stays prompt-agnostic — it captures the opaque token (exposed via the `Cligent.resumeToken` getter and the `done` event); tmux-play surfaces it as `PlayerRunResult.resumeToken`, and prompt recovery lives in the fanout Captain — ENG-009, TMUX-033, TMUX-042, CLAUDE-007, IR-020
- tmux-play flushes player log streams before session teardown, so trailing pane output is not dropped on exit

## [0.8.0] - 2026-05-28

### Changed

- tmux-play presenter unifies its operational-line family — `[status]`, `[error]`, `[aborted]`, `[turn aborted]`, `[runtime error]`, plus the previously separate `tool>` / `tool<` lines — under one bracketed-tag grammar: every line now reads `<who>> [<tag> <optional glyph>] <optional body>` where the speaker prefix is the standard TMUX-038 `<who>> `, the bracketed tag carries the kind and (for tools) a state glyph, and the body — when present — sits outside the brackets unstyled (`captain> [runtime error] boom` rather than the retired `[runtime error: boom]`). Tool lines render as `<who>> [tool ↪] <toolName> <inputSummary>` for invocations (uncolored tag) and `<who>> [tool ✓|✗|·] <toolName>[ <duration>]` for results, with the bracketed tag in the green/red/yellow outcome color and the body unstyled — the `tool>` / `tool<` prefix replacement and its caller-accent rule are retired (speaker identity now lives in the standard `<who>> ` prefix). The on-the-wire record types (`tool_use`, `tool_result`, `captain_status`, `runtime_error`, `turn_aborted`, `player_finished`, `captain_finished`) and their payloads are unchanged; only the rendered bytes in tmux panes change, so third-party observers that listen on records (visualizers, metric exporters, custom panels) need no update — IR-021, TMUX-038, TMUX-039, TMUX-049, TMUX-050
- Published `tmux-play` bin now resolves to a `bin/tmux-play.mjs` wrapper instead of pointing directly at `dist/app/tmux-play/cli.js`. The wrapper dynamic-imports `runTmuxPlayCli` from `dist/` and dispatches, mirroring the existing `bin/tmux-play-dev.mjs` shape. The +x bit lives in git (mode 100755) rather than via a build-time `postbuild` chmod, so `dist/` is now a pure function of tsc inputs and the postbuild step is gone. `files` whitelists the wrapper by name so the dev wrapper (which needs the source tree to run, removed from the tarball in 0.7.0) stays out of the published package
- CI workflows bump `actions/checkout` and `actions/setup-node` from `@v4` to `@v6` ahead of GitHub's 2026-06-02 forced switch to Node 24. The bump also clears the `npm warn Unknown user config "always-auth"` noise that `@v4`'s `registry-url` path emitted on each release

### Fixed

- `package.json#repository.url` carries the canonical `git+https://…` form, so `npm publish` no longer prints the `"repository.url" was normalized` warning on each release

## [0.7.0] - 2026-05-28

### Changed

- tmux-play picks the Catppuccin **flavor** (Mocha or Latte) to match the host terminal's background polarity instead of hard-coding Mocha against every terminal. Catppuccin ships a family — Mocha for dark backgrounds, Latte for light — and the canonical tmux pattern is to apply the flavor whose `mantle` band reads as a subtle tonal step on the user's canvas rather than an inverted block. Detection looks at `COLORFGBG` (bg index ≥ 7 → Latte), then `TERM_PROGRAM=Apple_Terminal` (→ Latte for macOS Terminal.app's white default), then falls back to Mocha. The programmatic API exposes `themeFlavor: 'mocha' | 'latte' | 'auto'` as an explicit override. `window-style` and `window-active-style` are NOT claimed — the pane content area stays on the user's terminal-native canvas, which is what makes the per-host flavor choice meaningful. The Captain pane carries the blue highlight title block when active; player pane titles always render on the mantle surface with no highlight block (read-only per TMUX-027); the pane-border row stays at the top with symmetric one-space padding around the title-and-timer band. Per-pane timer accents and the Captain pane timer accent are also flavor-aware — `playerAccent(adapter, flavor)` and `captainAccent(flavor)` return the Latte hex (dark green `#40a02b`, dark teal `#179299`, mauve `#8839ef`, etc.) on Latte sessions so the running timer reads against the light mantle band instead of washing out — TMUX-047, TMUX-048, TMUX-054 amended accordingly
- tmux-play status-right session-total timer renders `⏳` while a Boss turn is open and `⌛` between turns, matching the per-pane title timers' running-vs-settled glyph pair (TMUX-054); the unconditional `⏰` glyph is gone. The duration text keeps its mauve/overlay1 color cue, so the glyph swap adds a font-independent second signal of state without re-styling the surface — TMUX-055

### Removed

- `tmux-play-dev` published `bin` entry. The wrapper at `bin/tmux-play-dev.mjs` requires the source tree (`src/`, `tsconfig.json`, `node_modules/.bin/tsc`) to rebuild on launch; none of these ship in the npm tarball (`files` includes `dist`, `docs`, `LICENSE`, `README.md` only) and `typescript` is a `devDependency`, so the 0.6.0 published bin failed for any user not running it from a source checkout. The wrapper script stays in the repo and is exposed locally as `npm run tmux-play-dev`; for "from any directory" access, symlink or alias `bin/tmux-play-dev.mjs` from the source checkout
- **Breaking:** fanout captain's `maxPlayerOutputChars` option (and the underlying truncation feature) is removed. `createFanoutCaptain()` is now zero-arg in the `@sublang/cligent/captains/fanout` public export; the `FanoutCaptainOptions` type is gone. YAML configs whose `captain.options` still carry `maxPlayerOutputChars` continue to load (the loader treats `captain.options` as opaque per DR-004), but the value is silently ignored. The fanout captain now stitches each player's full `finalText` (or `error`) into the summary prompt verbatim; the Captain's built-in instruction ("do not copy raw player logs wholesale") remains the only soft check, so very long player outputs may consume Captain context or token budget. Re-introduce a cap as explicit configuration if your workload needs one

### Fixed

- `package-lock.json` regenerated to match `package.json` (was stale at `0.5.0` after the 0.6.0 version bump, and its root `bin` was missing `tmux-play-dev`)

## [0.6.0] - 2026-05-27

### Added

- tmux-play Boss/Captain pane keybindings (TMUX-057, TMUX-058): bare ESC during an active turn aborts the turn without ending the session and preserves the Boss readline edit buffer; multi-line pasted text submits as one Boss turn whose prompt preserves embedded newlines (bracketed paste). Both gate on TTY stdin/stdout and fall back to plain readline otherwise — IR-019
- `reasoningEffort` reachable from tmux-play YAML on each `captain` and each `players` entry (TMUX-056), validated against the closed `minimal | low | medium | high | xhigh | max` set with the offending path on error — IR-018
- Gemini adapter maps `reasoningEffort` onto per-run thinking config via a settings-file alias when `AgentOptions.model` is a concrete Gemini id (`^gemini-3` → `thinkingLevel`, `^gemini-2.5` → `thinkingBudget`); CLI aliases, unset, and non-matching models skip silently so adapter `--model` forwarding stays intact — IR-018, GEMINI-011
- OpenCode adapter maps `reasoningEffort` onto the v2 prompt body's top-level `variant` field per provider (Anthropic, OpenAI, Google); other providers defer to `opencode.jsonc` — IR-018, OPENCODE-012
- Default tmux-play home YAML pins `model` and `reasoningEffort: xhigh` on the Captain and each default player so a fresh install exercises the IR-018 wiring out of the box; existing home configs are untouched
- `tmux-play-dev` bin — dev counterpart to `tmux-play` that rebuilds `dist/` from `src/` via `tsc` on each launch before dispatching into the same CLI entry, so edits land in the next invocation without a manual `npm run build`. Both bins share the same `~/.config/tmux-play/config.yaml` discovery

### Changed

- **Breaking:** tmux-play renames its domain concept "role" to "player." YAML config key `roles:` → `players:`, record types `role_prompt` / `role_event` / `role_finished` → `player_prompt` / `player_event` / `player_finished`, fanout captain option `maxRoleOutputChars` → `maxPlayerOutputChars`, fanout summary protocol markers `=== role:NAME ===` → `=== player:NAME ===`, runtime API `RoleConfig` / `RoleHandle` / `RoleRunResult` / `callRole(...)` / `roles[]` → `PlayerConfig` / `PlayerHandle` / `PlayerRunResult` / `callPlayer(...)` / `players[]`. The engine layer (DR-003) keeps its `Cligent.role` / `CligentEvent.role` attribution tag — that's an opaque per-instance label the app populates with the player id. No backwards-compat shim; pre-existing `roles:` configs must be renamed to `players:`
- **Breaking:** tmux-play window layout uses equal column widths instead of a 4:6:6 (or 4:12) ratio. With two or more players the Boss/Captain pane and each player column each get `1/3` of the window width; with a single player the Boss/Captain pane and the player pane each get `1/2`. At the default 240-cell grid this yields 3×80 (was 60/90/90) or 2×120 (was 60/180) — TMUX-028, TMUX-044
- Claude adapter maps `reasoningEffort: 'xhigh'` to the SDK's now-native `xhigh` tier instead of collapsing it to `high`; `minimal` still falls back to `low` because Claude has no minimal tier — IR-018, CLAUDE-008
- tmux-play suppresses tmux's default window-list segment (`window-status-format`, `window-status-current-format`, and `window-status-separator` set empty after the Catppuccin theme block) so the curated status-left navigation hints and status-right session-total timer own the status bar — TMUX-047, TMUX-055
- tmux-play pane-border row keeps an explicit Catppuccin Mocha mantle surface across the full row after the pane title — the previous `#[default]` reset left a terminal-default (often black) gap between the title and the timer; the not-running pane timer color moves from `overlay1` (`#7f849c`) to `subtext1` (`#bac2de`) for legible contrast on that surface (TMUX-054 scope; the status-bar timer keeps `overlay1`) — TMUX-048, TMUX-054

### Fixed

- Adapters preserve `DonePayload.resumeToken` on `interrupted` `done` per a three-stage rule (backend session/thread id → inbound `AgentOptions.resume` → omit). Previously every adapter's interrupted path omitted the token even when an id was in scope, so cligent cleared stored continuity and ESC silently made the player's next turn fresh — IR-020, CLAUDE-007 / CODEX-006 / GEMINI-009 / OPENCODE-011
- OpenCode adapter applies the v2 `permission` field per session (via `session.create` for fresh sessions, `session.update` before each resumed prompt). The v2 SDK migration moved `permission` off the prompt body, so pre-existing `mode: 'auto'` configs hung on the first interactive prompt; the adapter also restores `tools` on the v2 prompt body, normalizes `permission.asked` (v2 only emits it for fresh requests), and surfaces SDK result errors so a rejected ruleset fails fast instead of silently hanging on the SSE stream

## [0.5.0] - 2026-05-24

### Added

- `PermissionPolicy.mode` (`'auto' | 'bypass'`) on `CligentOptions.permissions` selects each adapter's classifier-, sandbox-, or reviewer-protected auto posture (or unchecked bypass): Claude `permissionMode: 'auto'` / `'bypassPermissions'`; Codex on-request approval + `approvals_reviewer: 'auto_review'` + workspace profile / never approval + danger-full-access profile; Gemini `--yolo`; OpenCode `permission: 'allow'` (bypass rejected because the cligent OpenCode adapter drives the SDK, not the CLI flag that owns bypass) — IR-014, IR-015, ENG-021
- Codex adapter maps `PermissionPolicy` onto Codex's modern permission-profile model: local access via `CodexOptions.config.default_permissions` (`:workspace` / `:danger-full-access` / `:read-only`) derived from the per-capability levels, independent of the approval/reviewer axis. `mode: 'auto'` composes Codex auto-review with the modern profile rather than pinning the legacy sandbox model — IR-017, amended DR-005, CODEX-004
- tmux-play YAML carries `permissions` per role and per captain, forwarded to each `Cligent` instance. The default home config ships `permissions: { mode: 'auto' }` so Claude and Codex roles run in their classifier-/sandbox-/reviewer-protected auto modes out of the box — IR-014
- Run-time timers on the tmux-play session: each role and Boss/Captain pane border shows a live cumulative active-time hourglass (`⏳` running, `⌛` frozen); the tmux status bar carries the session-total clock (`⏰`) on the right and the navigation hints on the left. Catppuccin-styled, ticking at roughly 1 Hz, excludes time spent waiting between rounds — IR-016
- PKG-009: optional peer-dependency floors for the agent SDKs track the lowest SDK version the adapter code supports, not the pinned `devDependencies` version, so consumers on older compatible SDKs are not pressured to upgrade

### Changed

- Codex adapter no longer sets `ThreadOptions.sandboxMode` or `ThreadOptions.networkAccessEnabled`. Codex documents that a present `sandbox_mode` in any active config layer makes Codex ignore `default_permissions`, so cligent now expresses the local-access surface only through the modern model. A user carrying a legacy `sandbox_mode` in their own `~/.codex/config.toml` will see that config win over cligent's `default_permissions` — the documented non-composition rule
- Agent SDK devDependencies bumped to current releases: `@anthropic-ai/claude-agent-sdk` 0.2.133 → 0.3.148, `@openai/codex-sdk` 0.129.0 → 0.133.0, `@opencode-ai/sdk` 1.14.41 → 1.15.7. Optional peer-dependency floors stay at the prior versions per PKG-009

### Fixed

- Claude Code adapter's `canUseTool` callback now conforms to the SDK contract — it returns `Promise<{ behavior: 'allow', updatedInput? } | { behavior: 'deny', message }>` instead of `boolean | undefined`, so the SDK no longer rejects every Write/Bash invocation with a Zod validation error when `permissions` is configured
- tmux-play timer pane-border format strings use the correct `#{?cond,#[fg=A],#[fg=B]}` conditional shape (the previous `#[fg=#{?…}]` shape was rejected by tmux), and pane-title-keyed width computation uses the full `role · adapter` pane title so role panes get the right width budget for `glow` rendering

## [0.4.0] - 2026-05-17

### Added

- Markdown-rendered pane output via [`glow`](https://github.com/charmbracelet/glow) (IR-013) — text replies, captain summaries, and tool-result bodies render through the `glow` terminal Markdown renderer, so bold, code blocks, tables, lists, and word-boundary wrapping reach the pane intact
- Catppuccin Mocha theme on the tmux-play session (IR-012) — truecolor pane borders carry the adapter accent (claude/codex/gemini/opencode), speaker prefixes carry per-speaker colors (boss blue, captain mauve, role adapter accent), error/aborted status bodies carry red/yellow, and a dedicated tool lifecycle prefix grammar replaces inline tool noise: `tool>` (caller-colored) for invocations, `tool<` for results with outcome-keyed `✓` / `✗` / `·` markers
- Real-glow acceptance suite — integration tests exercise the presenter against the actual `glow` binary, covering well-formed prefixed output, payload trailing-blank preservation, and no-stacked-blanks between turns
- `query` priority key in the `tool_use` input summary — search/fetch tools (ToolSearch wrappers and similar) surface the query text rather than falling through to compact JSON
- DR-005 design record for per-adapter permission configuration (typed `PermissionPolicy` through `CligentOptions`; no implementation in this release)

### Changed

- **Breaking:** `tmux-play` requires [`glow`](https://github.com/charmbracelet/glow#installation) on `PATH` in addition to `tmux`; the launcher fails fast with an install-pointing error when it is missing
- **Breaking:** the `tool>` invocation prefix is colored by the caller's adapter accent (mauve for captain, the adapter accent for a role) instead of a fixed peach; `tool<` keeps the outcome palette (green / red / yellow)
- **Breaking:** the `overlay0` dim SGR around tool-result bodies is removed; styling is owned by `glow`'s code-block rendering inside a payload-safe code fence (fence width chosen as `max(3, longest_backtick_run + 1)` so embedded fences cannot terminate it early)
- Text bodies now appear on block completion rather than streaming token-by-token. Markdown is not a streamable format (a renderer cannot tell whether subsequent bytes belong to an open code fence until the closing fence arrives); this is the deliberate tradeoff for word-boundary wrapping and inline-style rendering
- Pane width budget reserves the visible `<who>> ` prefix when invoking `glow`, so prefixed first lines and indented continuations fit the pane without terminal-level rewrap
- Tool input summary truncation measures cells (CJK / emoji) rather than UTF-16 code units, so wide characters and surrogate-pair emoji never get split mid-codepoint
- README and `docs/tmux-play.md` Requirements lists updated to include `glow`
- CI acceptance job installs `glow` v2.1.2 before running acceptance tests

### Fixed

- TTMUX-039 truecolor probe scoped to the server-side option probe; the attached-client `#{client_termfeatures}` check required a PTY harness not yet in place
- IR-013 review-flagged rendering edges: outer-margin trim bounded to at most one leading + one trailing blank (fenced-code frames and payload edge blanks survive); tool body strips exactly one trailing line terminator (intentional trailing blank rows survive); blank-line detection uses visible content (real `glow` emits space-padded structural rows); fallback path skips the outer-margin trim when `glow` render fails
- Speaker-prefix coloring keeps the continuation indent uncolored across streamed text-delta chunks that split an SGR opener across the wrap boundary

## [0.3.0] - 2026-05-12

### Added

- `tmux-play` CLI and runtime — drives a multi-role agent session in a single tmux window with a Boss/Captain pane plus read-only role panes, YAML config discovery (cwd, then `${XDG_CONFIG_HOME:-~/.config}/tmux-play/config.yaml`), first-run default auto-create, and a programmatic API at `@sublang/cligent/tmux-play` for headless use
- Captain extension contract — third-party Captains ship as packages or local paths and receive a typed `CaptainContext` / `CaptainSession`; runtime owns every role and Captain `Cligent` instance
- Built-in `fanout` Captain (`@sublang/cligent/captains/fanout`) — broadcasts each Boss prompt to all roles in parallel and synthesizes a single Captain summary
- Unified `AgentOptions.reasoningEffort` (`minimal | low | medium | high | xhigh | max`) with per-adapter mapping (Claude `effort`, Codex `modelReasoningEffort`; Gemini and OpenCode ignore the field deliberately)
- Cell-aware soft wrap in the tmux-play presenter — width measured in terminal cells (curated EAW + emoji), ANSI escapes preserved as zero-width tokens across streaming chunks, per-writer resize tracking via SIGWINCH
- `<who>>` prefix presenter format with a two-space hanging indent that applies to every continuation line, including soft-wrapped ones
- Initial window geometry 240×67 (16:9 @ 1080p) with a pre-attach terminal resize request and session-scoped tmux hooks that hold the 4:6:6 column split across every window resize
- tmux-play acceptance suite — real-tmux 4:6:6 layout check plus end-to-end fanout drive across all four adapters, with a 2-attempt retry on transient upstream overloads
- New sub-exports `./tmux-play` and `./captains/fanout`

### Changed

- **Breaking:** package `bin` is now `tmux-play` (replaces `fanout`); the standalone `fanout` CLI is gone — the same fanout workflow runs as the default Captain inside `tmux-play`
- Codex adapter passes `skipGitRepoCheck: true` on every SDK thread so programmatic invocations against non-git working directories no longer hit the CLI's interactive-user safety gate
- Agent SDKs and CLIs pinned to last-green versions for reproducible CI

### Fixed

- Claude Code adapter now reads SDK `subtype` / `is_error` on the result message: `error_max_turns` and `error_max_budget_usd` preserve their protocol statuses, other `error_*` subtypes (and bare `is_error: true`) map to `status: 'error'` with `errors[]` surfaced as the message — repeated 529 overloads no longer report `status: 'ok'` with the CLI's "API Error" text as content
- Claude `reasoningEffort` narrowed to the SDK's `'low' | 'medium' | 'high' | 'max'` enum (`xhigh` collapses to `high`, `minimal` to `low`)
- Codex adapter unwraps JSON-encoded error messages, surfaces `turn.failed` before the SDK exec wrapper raises its generic non-zero-exit exception, and bumped to `@openai/codex-sdk` 0.129.0
- tmux-play launcher uses `split-window -l` for percentage sizing, focuses the Captain pane on startup, resolves symlinks in bin-entry detection, and hardens session error handling
- tmux-play presenter keeps the speaker prefix on the first nonblank line of every block
- `XDG_CONFIG_HOME` empty-string treated as unset (falls back to `~/.config`); a stderr warning fires when a legacy `tmux-play.config.{mjs,js,json}` is found in cwd
- Gemini adapter trusts the configured workspace and reports terminal errors in every done path

## [0.2.0] - 2026-03-09

### Added

- `fanout` CLI app — broadcast a prompt to multiple AI agents in parallel via tmux panes
- Persistent fanout logs in `.fanout/` directory (survive session restarts)
- `tool_result` event rendering in fanout session logs (string, stdout, JSON)
- Acceptance tests for all four agents (Claude, Codex, Gemini, OpenCode)
- Cache token reporting — `inputTokens` now includes cache-read and cache-creation tokens across all adapters (ENG-019)
- Gemini adapter surfaces terminal error messages from result events and exit fallback

### Changed

- Config files (ESLint, Prettier, Vitest) moved from root to `config/` directory
- Fanout app merged into root package as `src/app/` (no separate package)
- Pane border titles show agent names without indices

### Fixed

- Gemini adapter no longer passes unsupported `--max-session-turns` flag
- Claude Code adapter hardened for content parsing and environment detection
- Codex adapter aligned SDK call shapes for streaming compatibility
- OpenCode adapter hardened SSE parsing and availability check
- All adapters aligned SDK field names and streaming event handling

## [0.1.0] - 2026-03-03

### Added

- Core engine with adapter registry and unified event stream
- `Cligent` class with role identity, option merging, and session continuity
- Claude Code adapter via `@anthropic-ai/claude-agent-sdk`
- Codex adapter via `@openai/codex-sdk`
- Gemini CLI adapter via child-process NDJSON
- OpenCode adapter via `@opencode-ai/sdk`
- CI workflow (Node 18/20/22) and tag-triggered release workflow
- npm publish with OIDC trusted publishing and provenance attestation

[Unreleased]: https://github.com/sublang-ai/cligent/compare/v0.16.0...HEAD
[0.16.0]: https://github.com/sublang-ai/cligent/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/sublang-ai/cligent/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/sublang-ai/cligent/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/sublang-ai/cligent/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/sublang-ai/cligent/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/sublang-ai/cligent/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/sublang-ai/cligent/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/sublang-ai/cligent/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/sublang-ai/cligent/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/sublang-ai/cligent/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/sublang-ai/cligent/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/sublang-ai/cligent/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/sublang-ai/cligent/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/sublang-ai/cligent/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sublang-ai/cligent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sublang-ai/cligent/releases/tag/v0.1.0
