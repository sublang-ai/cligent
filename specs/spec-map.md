<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Spec Map

Quick-reference guide for AI agents to locate the right spec file.
Spec files are source of truth.

## Layout

```text
decisions/   Architectural decision records (DR-NNN)
iterations/  Iteration records (IR-NNN)
dev/         Implementation requirements
user/        User-facing behavior
test/        Verification criteria
```

Specs use GEARS syntax ([META-001](user/meta.md#meta-001)).
Authoring rules: [dev/style.md](dev/style.md).

## Decisions

| ID | File | Summary |
| --- | --- | --- |
| DR-000 | [000-initial-specs-structure.md](decisions/000-initial-specs-structure.md) | Specs directory layout, GEARS syntax, naming conventions |
| DR-001 | [001-unified-cli-agent-interface-architecture.md](decisions/001-unified-cli-agent-interface-architecture.md) | TypeScript library with async generator interface across CLI agents |
| DR-002 | [002-unified-event-stream-and-adapter-interface.md](decisions/002-unified-event-stream-and-adapter-interface.md) | Unified Event Stream, driver-adapter contract, permission model |
| DR-003 | [003-role-scoped-session-management.md](decisions/003-role-scoped-session-management.md) | Cligent class, role attribution, session continuity, option merge |

## Iterations

| ID | File | Goal |
| --- | --- | --- |
| IR-000 | [000-spdx-headers.md](iterations/000-spdx-headers.md) | Add SPDX headers to applicable files |
| IR-001 | [001-project-scaffold-and-core-types.md](iterations/001-project-scaffold-and-core-types.md) | Project scaffold and all DR-002 core TypeScript interfaces |
| IR-002 | [002-core-engine-and-adapter-registry.md](iterations/002-core-engine-and-adapter-registry.md) | Core engine (replaced by Cligent class in DR-003) |
| IR-003 | [003-claude-code-adapter.md](iterations/003-claude-code-adapter.md) | Claude Code adapter via @anthropic-ai/claude-agent-sdk |
| IR-004 | [004-codex-adapter.md](iterations/004-codex-adapter.md) | Codex adapter via @openai/codex-sdk |
| IR-005 | [005-gemini-cli-adapter.md](iterations/005-gemini-cli-adapter.md) | Gemini CLI adapter via child_process spawn + NDJSON |
| IR-006 | [006-opencode-adapter.md](iterations/006-opencode-adapter.md) | OpenCode adapter via @opencode-ai/sdk with SSE |
| IR-007 | [007-fanout-tmux-app.md](iterations/007-fanout-tmux-app.md) | Fanout multi-agent tmux chat app using cligent |
| IR-008 | [008-fanout-acceptance-tests.md](iterations/008-fanout-acceptance-tests.md) | Fanout end-to-end acceptance tests with real API keys |
| IR-009 | [009-tmux-play-captain-app.md](iterations/009-tmux-play-captain-app.md) | tmux-play Captain/role app extending fanout |

## Spec Files

### `dev/`

| File | Summary |
| --- | --- |
| [git.md](dev/git.md) | Commit message format and AI co-authorship trailers |
| [package.md](dev/package.md) | Package/TS config, exports map, dependency constraints |
| [style.md](dev/style.md) | Spec naming, ID format, GEARS syntax, cross-refs, record format, and SPDX headers |

### `user/`

| File | Summary |
| --- | --- |
| [meta.md](user/meta.md) | GEARS syntax definition and test-spec mapping |
| [engine.md](user/engine.md) | Cligent class, run(), parallel(), event helpers, done semantics, usage reporting |
| [ndjson.md](user/ndjson.md) | parseNDJSON() behavioral contract |
| [adapters/claude-code.md](user/adapters/claude-code.md) | Claude Code adapter: SDK normalization, UPM mapping, options mapping, resume token |
| [adapters/codex.md](user/adapters/codex.md) | Codex adapter: SDK normalization, UPM mapping, thread resumption |
| [adapters/gemini.md](user/adapters/gemini.md) | Gemini adapter: NDJSON normalization, exit codes, process lifecycle, resume token |
| [adapters/opencode.md](user/adapters/opencode.md) | OpenCode adapter: SSE normalization, two modes, session filtering, server lifecycle, resume token |

### `test/`

| File | Summary |
| --- | --- |
| [spdx-headers.md](test/spdx-headers.md) | Copyright and license header presence checks |
| [engine.md](test/engine.md) | Cligent lifecycle, session continuity, protocol hardening verification |
| [adapters.md](test/adapters.md) | Adapter verification criteria (shared + per-adapter) |
