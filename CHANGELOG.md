<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/sublang-ai/cligent/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/sublang-ai/cligent/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/sublang-ai/cligent/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/sublang-ai/cligent/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/sublang-ai/cligent/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/sublang-ai/cligent/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/sublang-ai/cligent/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sublang-ai/cligent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sublang-ai/cligent/releases/tag/v0.1.0
