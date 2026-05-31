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
| DR-004 | [004-tmux-play-captain-architecture.md](decisions/004-tmux-play-captain-architecture.md) | tmux-play Captain/player architecture, records, presenter boundary |
| DR-005 | [005-per-adapter-permission-configuration.md](decisions/005-per-adapter-permission-configuration.md) | YAML `permissions` through `CligentOptions` (typed `PermissionPolicy`); `PermissionPolicy` expands for auto-mode incl. Codex auto-review on modern `default_permissions` profiles; no project-wide default |

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
| IR-009 | [009-tmux-play-captain-app.md](iterations/009-tmux-play-captain-app.md) | Implement tmux-play Captain/player app from DR-004 |
| IR-010 | [010-tmux-play-quickstart.md](iterations/010-tmux-play-quickstart.md) | YAML configs, home fallback, first-run auto-create per DR-004 |
| IR-011 | [011-tmux-play-presenter-and-layout-refresh.md](iterations/011-tmux-play-presenter-and-layout-refresh.md) | tmux geometry, 4/6/6 split (replaced by equal columns in TMUX-028), prefix-style presenter, player continuity |
| IR-012 | [012-tmux-play-semantic-ui.md](iterations/012-tmux-play-semantic-ui.md) | Truecolor, adapter-aware pane borders, speaker-prefix colors, tool lifecycle rendering |
| IR-013 | [013-tmux-play-markdown-rendering.md](iterations/013-tmux-play-markdown-rendering.md) | Markdown-rendered pane output via glow, replacing character-level soft-wrap |
| IR-014 | [014-per-adapter-permission-configuration.md](iterations/014-per-adapter-permission-configuration.md) | Implement DR-005: YAML `permissions` field; `PermissionPolicy.mode` + per-adapter auto-mode mappings |
| IR-015 | [015-codex-auto-review-permission-mode.md](iterations/015-codex-auto-review-permission-mode.md) | Add Codex `approvals_reviewer = auto_review` to `PermissionPolicy.mode: 'auto'` |
| IR-016 | [016-tmux-play-run-time-timers.md](iterations/016-tmux-play-run-time-timers.md) | Per-pane and session-total run-time timers on the tmux panes and status bar |
| IR-017 | [017-codex-modern-permission-profiles.md](iterations/017-codex-modern-permission-profiles.md) | Codex adapter: modern `default_permissions` profile model, automation/local-access axis composition |
| IR-018 | [018-reasoning-effort-yaml-and-per-adapter-mappings.md](iterations/018-reasoning-effort-yaml-and-per-adapter-mappings.md) | tmux-play YAML `reasoningEffort` per player/captain; Claude `xhigh` mapping refresh; Gemini settings-file + OpenCode variant wiring |
| IR-019 | [019-boss-esc-interrupt-and-bracketed-paste.md](iterations/019-boss-esc-interrupt-and-bracketed-paste.md) | tmux-play Boss input: ESC interrupts active turn without ending the session; bracketed paste submits multi-line as one Boss turn |
| IR-020 | [020-abort-continuity-and-pane-contrast.md](iterations/020-abort-continuity-and-pane-contrast.md) | All adapters preserve `resumeToken` on `interrupted` `done` from backend id or inbound `resume`, so player context survives ESC; tmux-play pane-border row uses one surface tone and a legible timer color |
| IR-021 | [021-unified-bracketed-tag-grammar.md](iterations/021-unified-bracketed-tag-grammar.md) | tmux-play presenter unifies status / error / aborted / turn-aborted / runtime-error / tool lifecycle lines under one `<who>> [<tag> <optional glyph>] <optional body>` grammar; bodies move outside brackets; `tool>` / `tool<` prefix retired |
| IR-022 | [022-tmux-play-layout-configuration.md](iterations/022-tmux-play-layout-configuration.md) | tmux-play YAML `layout` block exposes initial window resolution and per-column weights; shipped multi-player default shifts from equal thirds to `4 : 6 : 6` |
| IR-023 | [023-tmux-play-default-config-refresh.md](iterations/023-tmux-play-default-config-refresh.md) | Refresh tmux-play shipped defaults: window `174 × 49` (1080p @ 18pt monospace), multi-player `columnWeights: [1, 1, 1]`, Captain + `claude` player `model: claude-opus-4-8-1m`; `codex` player and all `permissions` / `reasoningEffort` defaults unchanged |

## Packages

### CLAUDE

| Group | File | Summary |
| --- | --- | --- |
| user | [adapters/claude-code.md](user/adapters/claude-code.md) | Claude Code adapter: SDK normalization, UPM mapping, options mapping, resume token |

### CODEX

| Group | File | Summary |
| --- | --- | --- |
| user | [adapters/codex.md](user/adapters/codex.md) | Codex adapter: SDK normalization, UPM mapping, thread resumption, options mapping |

### ENG

| Group | File | Summary |
| --- | --- | --- |
| user | [engine.md](user/engine.md) | Cligent class, run(), parallel(), event helpers, done semantics, usage reporting, reasoning effort |
| test | [engine.md](test/engine.md) | Cligent lifecycle, session continuity, protocol hardening verification |

### GEMINI

| Group | File | Summary |
| --- | --- | --- |
| user | [adapters/gemini.md](user/adapters/gemini.md) | Gemini adapter: NDJSON normalization, exit codes, process lifecycle, resume token, reasoning-effort thinking settings |

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
| user | [adapters/opencode.md](user/adapters/opencode.md) | OpenCode adapter: SSE normalization, two modes, session filtering, server lifecycle, resume token, options mapping, reasoning-effort variants |

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
| user | [tmux-play.md](user/tmux-play.md) | tmux-play CLI, YAML config (top-level `theme: mocha \| latte \| auto`, top-level `layout` with `window` resolution and `columnWeights`, per-player/captain `permissions` and `reasoningEffort`), discovery and auto-create, Captain contract, records, observers, topology, mouse selection + system clipboard right-click copy + single-pane click-to-deselect, OSC 11 flavor-aware Catppuccin theme + diagnostics, run-time timers, Boss input keybindings, session-wide Ctrl+C exit, speaker colors, tool lifecycle, glow-rendered Markdown pipeline + launcher gate, runtime API, fanout |
| test | [tmux-play.md](test/tmux-play.md) | tmux-play config discovery, runtime causality, observer dispatch, topology, fanout acceptance, permission / reasoning-effort / layout configuration, run-time timers, Boss input keybindings, mouse click-to-deselect binding, session-wide Ctrl+C exit, real-tmux acceptance, real-glow acceptance |
