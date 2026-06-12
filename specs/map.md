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
| DR-005 | [005-per-adapter-permission-configuration.md](decisions/005-per-adapter-permission-configuration.md) | YAML `permissions` through `CligentOptions` (typed `PermissionPolicy`); `PermissionPolicy` expands for auto-mode incl. Codex auto-review on modern `default_permissions` profiles; permission-managed Codex runs ignore user-level config for deterministic profiles; no project-wide default |
| DR-006 | [006-workspace-writable-paths.md](decisions/006-workspace-writable-paths.md) | Typed `PermissionPolicy.writablePaths` for workspace-relative write grants; all adapters accept and report a per-adapter enforcement class (Codex `profile` / Claude+Gemini `sandbox` when independently active / OpenCode `ambient`), with Codex profile enforcement the release bar |

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
| IR-020 | [020-abort-continuity-and-pane-contrast.md](iterations/020-abort-continuity-and-pane-contrast.md) | All adapters preserve `resumeToken` on `interrupted` `done` from a known session id or inbound `resume`, and fanout consumes exposed no-token interrupted player results by retaining aborted Boss prompts per player; tmux-play pane-border row uses one surface tone and a legible timer color |
| IR-021 | [021-unified-bracketed-tag-grammar.md](iterations/021-unified-bracketed-tag-grammar.md) | tmux-play presenter unifies status / error / aborted / turn-aborted / runtime-error / tool lifecycle lines under one `<who>> [<tag> <optional glyph>] <optional body>` grammar; bodies move outside brackets; `tool>` / `tool<` prefix retired |
| IR-022 | [022-tmux-play-layout-configuration.md](iterations/022-tmux-play-layout-configuration.md) | tmux-play YAML `layout` block exposes initial window resolution and per-column weights; shipped multi-player default shifts from equal thirds to `4 : 6 : 6` |
| IR-023 | [023-tmux-play-default-config-refresh.md](iterations/023-tmux-play-default-config-refresh.md) | Refresh tmux-play shipped defaults: window `174 × 49` (1080p @ 18pt monospace), multi-player `columnWeights: [1, 1, 1]`, Captain + `claude` player `model: claude-opus-4-8`; `codex` player and all `permissions` / `reasoningEffort` defaults unchanged |
| IR-024 | [024-copy-mode-live-follow-and-single-ctrl-c-exit.md](iterations/024-copy-mode-live-follow-and-single-ctrl-c-exit.md) | tmux-play panes return to their live tail when new output arrives while scrolled in copy-mode (copy-mode live-follow, TMUX-069); `C-c` bound across `root` / `copy-mode` / `copy-mode-vi` with a cancel-pane-0-then-forward true branch so a single press quits from any pane in any mode (TMUX-065 amend) |
| IR-025 | [025-boss-prompt-suspension-during-active-turn.md](iterations/025-boss-prompt-suspension-during-active-turn.md) | tmux-play session suspends/clears the live Boss readline `boss> ` prompt while a Boss turn is in flight and restores it once on completion / ESC abort, so streaming output is never followed by a spurious `boss> ` a turn-completion consumer would read as turn-over; preserves type-ahead and ESC per TMUX-057 (new TMUX-075; TMUX-037 / TMUX-057 reconciled; TTMUX-074) |
| IR-026 | [026-workspace-writable-paths.md](iterations/026-workspace-writable-paths.md) | Implement DR-006 `PermissionPolicy.writablePaths`: typed workspace-relative write grants, adapter enforcement reporting, and Codex profile-enforced `.git` writes |

## Packages

### CLAUDE

| Group | File | Summary |
| --- | --- | --- |
| user | [adapters/claude-code.md](user/adapters/claude-code.md) | Claude Code adapter: SDK normalization, UPM mapping, options mapping, fresh SDK session id, resume token |

### CODEX

| Group | File | Summary |
| --- | --- | --- |
| user | [adapters/codex.md](user/adapters/codex.md) | Codex adapter: SDK normalization, UPM/default-permissions mapping including writablePaths profile enforcement and user-config isolation for permission-managed runs, thread resumption, options mapping |
| dev | [adapters/codex.md](dev/adapters/codex.md) | Codex adapter implementation: generated writablePaths profile delivery without repository/user config mutation |

### ENG

| Group | File | Summary |
| --- | --- | --- |
| user | [engine.md](user/engine.md) | Cligent class, run(), parallel(), event helpers, done semantics including abort-drain precedence for adapter-emitted interrupted `done`, resume-token capture, usage reporting, reasoning effort, permission policy and writablePaths contracts |
| test | [engine.md](test/engine.md) | Cligent lifecycle, session continuity including interrupted-done resume capture across abort, protocol hardening verification |

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
| test | [adapters.md](test/adapters.md) | Adapter verification criteria (shared + per-adapter), including interrupted resume tokens, Claude early-abort continuity, writablePaths enforcement/reporting, and Codex user-config isolation |

### TMUX

| Group | File | Summary |
| --- | --- | --- |
| user | [tmux-play.md](user/tmux-play.md) | tmux-play CLI, YAML config (top-level `theme: mocha \| latte \| auto`, top-level `layout` with `window` resolution and `columnWeights`, per-player/captain `permissions` and `reasoningEffort`), discovery and auto-create, Captain contract, records, observers, topology, mouse selection + system clipboard right-click copy via tmux `copy-pipe` (not `copy-pipe-and-cancel`) so the clicked pane's copy-mode scroll position survives the copy + left-click behavior that drops any active selection in every pane while preserving each pane's copy-mode state and scroll position, copy-mode live-follow (TMUX-069) that returns a scrolled pane to its live tail when new output is written to it while leaving panes with no concurrent output scrolled, OSC 11 flavor-aware Catppuccin theme + diagnostics, run-time timers whose per-pane and status-bar duration text renders in `hh:mm:ss` form (all three components always present and zero-padded to two digits, e.g., `00:00:00`, `00:01:00`, `01:02:03`; hours field expands past two digits at 100 h so `100:00:00` follows `99:59:59`), Boss input keybindings, active-turn `boss> ` prompt suspension (TMUX-075) that paints no fresh `boss> ` prompt line while a turn is in flight (the submitted-prompt input line aside) and paints a fresh ready prompt exactly once the queue of submitted Boss lines drains — never between consecutive queued turns and never amid a turn for an empty/whitespace submission — restoring it on every turn-end path (completion, ESC abort, or runtime error) so streaming output is never followed by a spurious turn-over prompt while typed/pasted type-ahead and ESC stay preserved per TMUX-057 / TMUX-058, session-wide `Ctrl+C` exit (TMUX-065) and `ESC` turn-abort (TMUX-070) each forwarded to the Boss/Captain pane via cancel-then-forward `root` + `copy-mode` + `copy-mode-vi` bindings (single-press from any pane in any mode — fixing the scrolled-pane double-press defect for `Ctrl+C` and the swallowed-on-player-pane defect for `ESC`), player continuity that survives ESC-aborted interrupted `done` through resume tokens and fanout-owned recovery for no-token aborts, speaker colors, tool lifecycle, glow-rendered Markdown pipeline + launcher gate, runtime API, per-call `callCaptain` visibility (TMUX-072) where a `hidden` call keeps its result and observer trace but produces zero Boss-pane output, session-mode player-agent tmux isolation (TMUX-074) that strips `TMUX` / `TMUX_PANE` and redirects `TMUX_TMPDIR` for spawned agents so an agent's `tmux` (even `kill-server`) cannot reach or kill the session hosting the run while the orchestrator's own tmux commands keep targeting it via a pinned pre-scrub environment, fanout |
| test | [tmux-play.md](test/tmux-play.md) | tmux-play config discovery, runtime causality, observer dispatch, topology, fanout acceptance, permission / reasoning-effort / layout configuration, run-time timers pinned on a real tmux server at the sub-minute (`00:00:SS`), minute (`00:MM:SS` with non-zero `MM` and retained `SS`), and hour (`HH:MM:SS` with non-zero `HH` and retained `MM:SS`) magnitudes so the `hh:mm:ss` form catches regressions to a seconds-only `<n>s` form and to the retired padded `Xm…s` / `Xh…m` rollups, Boss input keybindings, active-turn `boss> ` prompt suspension (TTMUX-074) verified over a real-readline TTY pair (typed and pasted type-ahead) plus a real-tmux attached-client probe asserting no fresh `boss> ` prompt line on pane 0 between `turn_started` and the turn's terminal record, plus a stubbed-readline prompt-paint-count clause asserting no fresh ready prompt between consecutive queued Boss turns or amid a turn for an empty submission, with exactly one paint once the queue drains, session-scoped `MouseDown1Pane` override that runs `send-keys -X clear-selection` (not the retired `-X cancel`) per in-mode pane before the per-table stock tail — static binding shape pinned alongside a real attached-client mouse-click probe that asserts an active selection is cleared while copy-mode and scroll position are preserved, catching regressions either layer alone would miss — right-click copy bound to `copy-pipe` (not `copy-pipe-and-cancel`) so the clicked pane's scroll position is also preserved, pinned by static binding assertions plus a real-tmux copy behavior probe, copy-mode live-follow (TTMUX-069) as a real-tmux integration probe asserting that output written to a scrolled-back pane returns it to its live tail while a pane with no concurrent output stays scrolled, player continuity including resume-token and fanout no-token recovery paths after ESC-aborted interrupted `done`, session-wide `Ctrl+C` exit (TTMUX-065) and `ESC` turn-abort (TTMUX-070) each pinned across `root` + `copy-mode` + `copy-mode-vi` with cancel-then-forward binding-shape assertions + real-tmux `list-keys` and attached-client byte-delivery probes, so regressions that re-bound only `root`, skipped pane-0 copy-mode cancellation, or failed to route from scrolled player panes fail behaviorally, hidden `callCaptain` visibility tagging + presenter Boss-pane suppression (TTMUX-071), session-mode player-agent tmux isolation (TTMUX-073) asserting spawned agents inherit a scrubbed environment (`TMUX` / `TMUX_PANE` removed, `TMUX_TMPDIR` redirected away from the run's socket dir) while the orchestrator stays attached and runs its own tmux commands with the pinned pre-scrub environment, real-tmux acceptance, real-glow acceptance |
