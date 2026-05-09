<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Spec Map

Quick-reference index for locating spec files.
Spec items are the source of truth.
Code can be inconsistent with specs during development.

## Authoring and reviewing specs

Know the rules in [`meta.md`](meta.md) before authoring, modifying, or reviewing a DR, IR, or item.

- DRs and IRs: see [Organization](meta.md#organization), [Record format](meta.md#record-format), and [Citation](meta.md#citation).
- Items: see [Organization](meta.md#organization), [Item syntax](meta.md#item-syntax), [Spec packages](meta.md#spec-packages), and [Citation](meta.md#citation).

## Layout

```text
decisions/  Decision records (DRs)
iterations/ Iteration records (IRs)
user/       User-visible behavior
dev/        Implementation requirements
test/       Acceptance testing
map.md      This index
meta.md     The spec of specs
```

## Decisions

| ID | File | Summary |
| --- | --- | --- |
| DR-000 | [000-spec-structure-format.md](decisions/000-spec-structure-format.md) | Spec structure, format, and naming conventions |
| DR-001 | [001-unified-cli-agent-interface-architecture.md](decisions/001-unified-cli-agent-interface-architecture.md) | TypeScript library with async generator interface across CLI agents |
| DR-002 | [002-unified-event-stream-and-adapter-interface.md](decisions/002-unified-event-stream-and-adapter-interface.md) | Unified Event Stream, driver-adapter contract, permission model |
| DR-003 | [003-role-scoped-session-management.md](decisions/003-role-scoped-session-management.md) | Cligent class, role attribution, session continuity, option merge |
| DR-004 | [004-tmux-play-captain-architecture.md](decisions/004-tmux-play-captain-architecture.md) | tmux-play Captain/role architecture, records, presenter boundary |

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
| IR-009 | [009-tmux-play-captain-app.md](iterations/009-tmux-play-captain-app.md) | Implement tmux-play Captain/role app from DR-004 |
| IR-010 | [010-tmux-play-quickstart.md](iterations/010-tmux-play-quickstart.md) | YAML configs, home fallback, first-run auto-create per DR-004 |
| IR-011 | [011-tmux-play-presenter-and-layout-refresh.md](iterations/011-tmux-play-presenter-and-layout-refresh.md) | tmux geometry, 4/6/6 split, prefix-style presenter, role continuity |

## Packages

### CLAUDE

| Group | File | Summary |
| --- | --- | --- |
| user | [adapters/claude-code.md](user/adapters/claude-code.md) | Claude Code adapter: SDK normalization, UPM mapping, options mapping, resume token |

### CODEX

| Group | File | Summary |
| --- | --- | --- |
| user | [adapters/codex.md](user/adapters/codex.md) | Codex adapter: SDK normalization, UPM mapping, thread resumption |

### ENG

| Group | File | Summary |
| --- | --- | --- |
| user | [engine.md](user/engine.md) | Cligent class, run(), parallel(), event helpers, done semantics, usage reporting |
| test | [engine.md](test/engine.md) | Cligent lifecycle, session continuity, protocol hardening verification |

### GEMINI

| Group | File | Summary |
| --- | --- | --- |
| user | [adapters/gemini.md](user/adapters/gemini.md) | Gemini adapter: NDJSON normalization, exit codes, process lifecycle, resume token |

### GIT

| Group | File | Summary |
| --- | --- | --- |
| dev | [git.md](dev/git.md) | Commit message format and AI co-authorship trailers |

### LIC

| Group | File | Summary |
| --- | --- | --- |
| dev | [licensing.md](dev/licensing.md) | SPDX header requirements and file-scope rules |
| test | [licensing.md](test/licensing.md) | Copyright and license header presence checks |

### NDJSON

| Group | File | Summary |
| --- | --- | --- |
| user | [ndjson.md](user/ndjson.md) | parseNDJSON() behavioral contract |

### OPENCODE

| Group | File | Summary |
| --- | --- | --- |
| user | [adapters/opencode.md](user/adapters/opencode.md) | OpenCode adapter: SSE normalization, two modes, session filtering, server lifecycle, resume token |

### PKG

| Group | File | Summary |
| --- | --- | --- |
| dev | [package.md](dev/package.md) | Package/TS config, exports map, dependency constraints |

### RELEASE

| Group | File | Summary |
| --- | --- | --- |
| dev | [release.md](dev/release.md) | SemVer, changelog, tag-driven release workflow, npm provenance |

### TADAPT

| Group | File | Summary |
| --- | --- | --- |
| test | [adapters.md](test/adapters.md) | Adapter verification criteria (shared + per-adapter) |

### TMUX

| Group | File | Summary |
| --- | --- | --- |
| user | [tmux-play.md](user/tmux-play.md) | tmux-play CLI, YAML config, discovery and auto-create, Captain contract, records, observers, topology, runtime API, fanout |
| test | [tmux-play.md](test/tmux-play.md) | tmux-play config discovery, runtime causality, observer dispatch, topology, fanout acceptance, real-tmux acceptance |
