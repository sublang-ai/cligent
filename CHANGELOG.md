<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/sublang-ai/cligent/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/sublang-ai/cligent/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/sublang-ai/cligent/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/sublang-ai/cligent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sublang-ai/cligent/releases/tag/v0.1.0
