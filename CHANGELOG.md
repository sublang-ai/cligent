<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/sublang-dev/cligent/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/sublang-dev/cligent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/sublang-dev/cligent/releases/tag/v0.1.0
