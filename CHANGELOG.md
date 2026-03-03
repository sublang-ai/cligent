<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/sublang-dev/cligent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sublang-dev/cligent/releases/tag/v0.1.0
