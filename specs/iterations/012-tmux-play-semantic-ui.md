<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-012: tmux-play Semantic UI

## Goal

Make tmux-play visually semantic, not merely themed.
The committed Catppuccin Mocha theme ([TMUX-047](../user/tmux-play.md#tmux-047)) colors only tmux chrome (status bar, borders, message bar); the in-pane content — speaker prefixes, tool events — still renders unstyled.
Introduce truecolor enablement so the palette actually renders, enrich the per-pane border with the role's adapter for at-a-glance pane identity, color speaker prefixes by speaker (with stable per-adapter accents for roles), and surface tool lifecycle as `tool>` / `tool<` lines with outcome-keyed color and dim body so large stdout never overpowers agent prose.

Behavioral hierarchy the design encodes (strongest to weakest visual emphasis):
pane identity > speaker identity > tool lifecycle > message body.

## Status

Planned

## Scope

In scope:

- Truecolor enablement on the launcher-created session (`default-terminal "tmux-256color"` + `terminal-overrides ",*:RGB"`).
- Enriched `pane-border-format`: `<title> · <adapter>` with active/inactive style differentiation; inactive border dimmed to `overlay0`.
- Stable per-adapter role color map (`claude`→green, `codex`→teal, `gemini`→lavender, `opencode`→pink) with a deterministic fallback for unknown adapters.
- Speaker-prefix ANSI coloring on the existing `<who>>` grammar from [TMUX-038](../user/tmux-play.md#tmux-038): `boss>` blue, `captain>` mauve, `<roleId>>` adapter-keyed.
- `[error: …]` and `[aborted]` status lines (from [TMUX-039](../user/tmux-play.md#tmux-039)) recolored: error red bold, aborted yellow bold.
- New tool lifecycle prefix grammar `tool>` (invocation) and `tool<` (result) with peach/green/red/yellow prefix coloring per outcome and `overlay0`-dimmed body for tool stdout.
- Tool events render in whichever pane the calling entity occupies: role-emitted tools in the role pane, captain-emitted tools in the Boss/Captain pane (a narrow amendment to [TMUX-040](../user/tmux-play.md#tmux-040)).
- Spec items: [TMUX-038](../user/tmux-play.md#tmux-038) amendment for optional ANSI on prefixes, [TMUX-040](../user/tmux-play.md#tmux-040) amendment for captain-pane tool events, [TMUX-047](../user/tmux-play.md#tmux-047) expansion to claim truecolor options, new TMUX-048 for the pane-border format + role color map, new TMUX-049 for tool lifecycle rendering.
- Matching test-spec items under TTMUX-… and `map.md` TMUX-summary update.

Out of scope:

- Per-pane state column (`ready` / `running` / `idle`).
  Requires runtime → tmux push plumbing (per-pane user options written from the runtime after every event); defer to a follow-up IR.
- Configurable themes via a YAML `theme:` field; the palette remains hardcoded in the launcher.
- Light-mode (Catppuccin Latte) variant.
- Coloring of any message body — only prefixes and tool lifecycle headers carry color; body text stays in the `text` Mocha role to keep dense LLM output readable.

## Deliverables

- [ ] `src/app/tmux-play/launcher.ts` — truecolor options and adapter-column pane-border format.
- [ ] `src/app/tmux-play/role-colors.ts` — adapter-name → Mocha-accent map with a deterministic hash fallback.
- [ ] `src/app/tmux-play/presenter-tmux.ts` — ANSI-colored speaker prefixes, error/aborted recolor, and tool lifecycle rendering.
- [ ] `src/app/tmux-play/launcher.test.ts` — assertions for truecolor `set` calls and the enriched pane-border format.
- [ ] `src/app/tmux-play/presenter-tmux.test.ts` — assertions for prefix ANSI by speaker, tool lifecycle formatting, and dim body for tool stdout.
- [ ] `specs/user/tmux-play.md` — TMUX-038 amendment, TMUX-040 amendment, TMUX-047 expansion, new TMUX-048, new TMUX-049.
- [ ] `specs/test/tmux-play.md` — new TTMUX items verifying each above.
- [ ] `specs/map.md` — TMUX user-row summary mentions "speaker colors" and "tool lifecycle".

## Tasks

Each task is one commit.

1. [ ] **Truecolor + enriched pane border** — TMUX-047 expansion to claim `default-terminal` and `terminal-overrides`, new TMUX-048 for `<title> · <adapter>` format with active/inactive differentiation and the adapter color map.
   Add `role-colors.ts` (the map is exported and unit-tested but unused by presenter in this task).
   Launcher test asserts both new `set` calls plus the new format string.
2. [ ] **Speaker-prefix coloring** — TMUX-038 amendment permitting ANSI on speaker prefixes; TMUX-039 prose recolored for error/aborted.
   Presenter writes SGR-color the prefix bytes only; body stays unstyled.
   Consumes `role-colors.ts` for the per-role accent.
   Presenter tests cover boss/captain/role prefixes and the recolored error/aborted lines.
3. [ ] **Tool lifecycle rendering** — new TMUX-049 for `tool>` / `tool<` two-line grammar with peach/green/red/yellow prefix colors and `overlay0`-dimmed body; narrow TMUX-040 amendment so captain-emitted tool events render in the captain pane.
   Presenter emits one `tool>` line on each `tool_use` event and one `tool<` line on each `tool_result` event, both routed to the calling entity's pane.
   Presenter tests cover the format and the destination pane for both role-emitted and captain-emitted tools.

## Acceptance criteria

- `npm run build`, `npm run lint`, `npm test`, and `npm run test:smoke` pass at every task boundary.
- After Task 1, two probes pass against a launched session:
  - Option probe (no client needed): `tmux show-options -gv -t <session> default-terminal` returns `tmux-256color`, and `tmux show-options -gv -t <session> terminal-overrides` contains an entry of `*:RGB` (the modern RGB capability, not the legacy `Tc`). The assertion shall match the entry as printed — tmux normalizes a leading-comma `set-option` argument like `,*:RGB` and emits the stored value without it, so an assertion on the literal `,*:RGB` substring is wrong.
  - Attached-client probe (real-tmux acceptance test): after a client attaches, `tmux display-message -p -t <session> '#{client_termfeatures}'` includes `RGB` in the comma-separated list. `#{client_termfeatures}` was added in tmux 3.2 and is the authoritative signal that the override negotiated through to the client's terminfo.
- After Task 2, the presenter snapshot for a Boss → Captain → Role turn shows SGR-colored prefixes per the TMUX-038 table and uncolored body text.
- After Task 3, the presenter snapshot for a tool-using role shows a `tool>` / `tool<` pair with the correct outcome color and a dim continuation body, and a tool-using captain renders the same pair in the Captain pane per the TMUX-040 amendment.
- `specs/map.md` TMUX user-row summary reflects the new content.
