<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-019: Superseded Item Retirements

## Status

Accepted

## Context

The legacy-spec migration preserved requirements even where the shipped
artifact had stopped following them. At the migration's owner gate, the
tree held 37 marked package items: 35 wholly superseded items and two items
whose hand-written text-wrapping passages were superseded while their display
cell rules remained live. Two earlier tmux-play items had already been removed
and described only by retirement notes.

Restoring the obsolete usage shapes would reverse [DR-014](014-unified-token-usage-breakdown.md),
reintroduce unauthentic compatibility fields, and contradict the current
public usage model. Restoring either failed left-click generation would revive
either the copy-mode live-tail jump or the selection-that-survives-click defect.
Restoring character-level presenter wrapping would conflict with the current
`glow` pipeline, while deleting the whole item would also discard live terminal
cell measurement and resize behavior.

The owner approved retirement of the whole obsolete items, retirement of only
the obsolete passages in the two partly live items, and retirement of the two
already-removed tmux-play concerns. No artifact behavior is restored.

## Decision

Every disposition is listed below. A successor is the current carrier of the
surviving concern; wording identified as retired has no successor merely by
being historical. The per-item migration map in [DR-017](017-spec-generation-migration.md)
keeps every released source traceable to the listed live carrier.

| Retired item or passage | Current carrier or recorded end of concern |
| --- | --- |
| `engine-19` | The flat aggregate fields retire; the authentic public shape and inclusive totals live in [[engine-31](../packages/engine.md#engine-31)], [[engine-55](../packages/engine.md#engine-55)], [[engine-56](../packages/engine.md#engine-56)], [[engine-57](../packages/engine.md#engine-57)], and [[engine-58](../packages/engine.md#engine-58)]. |
| `engine-27` | The discriminator and placeholders retire; absence, measured detail, validity, coverage, and independent tool count live in [[engine-31](../packages/engine.md#engine-31)], [[engine-56](../packages/engine.md#engine-56)], [[engine-57](../packages/engine.md#engine-57)], [[engine-58](../packages/engine.md#engine-58)], and [[engine-65](../packages/engine.md#engine-65)]. |
| `engine-28` | The top-level disjoint breakdown retires; nested optional details and their reconciliation live in [[engine-31](../packages/engine.md#engine-31)] and [[engine-57](../packages/engine.md#engine-57)]. |
| `engine-29` | The obsolete supplementary-shape wording retires; the fidelity-source rule lives in [[engine-64](../packages/engine.md#engine-64)]. |
| `engine-30` | Top-level billable records retire; nested record reconciliation, request meaning, and cost provenance live in [[engine-59](../packages/engine.md#engine-59)], [[engine-60](../packages/engine.md#engine-60)], and [[engine-61](../packages/engine.md#engine-61)]. |
| `engine-119` | The old public-shape check retires; current shape and placeholder omission are verified by [[engine-122](../packages/engine.md#engine-122)] and [[engine-69](../packages/engine.md#engine-69)]. |
| `engine-120` | The disjoint-breakdown check retires; current token details, records, and unavailable-accounting omission are verified by [[engine-70](../packages/engine.md#engine-70)] and [[engine-71](../packages/engine.md#engine-71)]. |
| `engine-121` | The top-level-record check retires; current nested records and unavailable-accounting omission are verified by [[engine-70](../packages/engine.md#engine-70)] and [[engine-71](../packages/engine.md#engine-71)]. |
| `engine-233` | The flat availability check retires; the exhaustive current adapter usage check is [[engine-240](../packages/engine.md#engine-240)]. |
| `engine-238` | The old breakdown check retires; the exhaustive current adapter usage check is [[engine-240](../packages/engine.md#engine-240)]. |
| `engine-239` | The old record check retires; the exhaustive current adapter usage check is [[engine-240](../packages/engine.md#engine-240)]. |
| `claude-code-16` | The flat input partition retires; authentic source selection and per-model input details live in [[claude-code-12](../packages/adapters/claude-code.md#claude-code-12)] and [[claude-code-29](../packages/adapters/claude-code.md#claude-code-29)]. |
| `claude-code-17` | Whole-side output omission retires; inclusive output with absent reasoning detail lives in [[claude-code-30](../packages/adapters/claude-code.md#claude-code-30)]. |
| `claude-code-11` | The old aggregate-source rule retires; whole-run authenticity and no-op detection live in [[claude-code-12](../packages/adapters/claude-code.md#claude-code-12)] and [[claude-code-28](../packages/adapters/claude-code.md#claude-code-28)]. |
| `claude-code-27` | The first billable-record design retires; authentic per-model records live in [[claude-code-29](../packages/adapters/claude-code.md#claude-code-29)]. |
| `claude-code-238` | The old breakdown check retires; current Claude usage is verified by [[claude-code-240](../packages/adapters/claude-code.md#claude-code-240)]. |
| `claude-code-239` | The old record check retires; current Claude usage is verified by [[claude-code-240](../packages/adapters/claude-code.md#claude-code-240)]. |
| `codex-30` | Flat per-turn counters retire; authentic detail selection and reporting live in [[codex-16](../packages/adapters/codex.md#codex-16)] and [[codex-17](../packages/adapters/codex.md#codex-17)]. |
| `codex-14` | Requested-model record attribution retires; only runtime-observed model attribution lives in [[codex-17](../packages/adapters/codex.md#codex-17)]. |
| `codex-233` | The flat availability check retires; current Codex usage is verified by [[codex-240](../packages/adapters/codex.md#codex-240)]. |
| `codex-238` | The old breakdown check retires; current Codex usage is verified by [[codex-240](../packages/adapters/codex.md#codex-240)]. |
| `codex-239` | The old record check retires; current Codex usage is verified by [[codex-240](../packages/adapters/codex.md#codex-240)]. |
| `gemini-28` | Stream-only reconstruction and provider-reported tool counts retire; authentic telemetry selection, normalization, reconciliation, and coverage live in [[gemini-17](../packages/adapters/gemini.md#gemini-17)], [[gemini-37](../packages/adapters/gemini.md#gemini-37)], [[gemini-39](../packages/adapters/gemini.md#gemini-39)], and [[gemini-40](../packages/adapters/gemini.md#gemini-40)], while the independently observed distinct-tool count remains in [[gemini-27](../packages/adapters/gemini.md#gemini-27)]. |
| `gemini-233` | The stream-only availability check retires; current Gemini usage is verified by [[gemini-240](../packages/adapters/gemini.md#gemini-240)]. |
| `kimi-20` | Hypothetical ACP usage promotion retires; the pinned runtime's no-authentic-accounting contract and future-extension isolation live in [[kimi-13](../packages/adapters/kimi.md#kimi-13)] and [[kimi-31](../packages/adapters/kimi.md#kimi-31)]. |
| `kimi-233` | The hypothetical availability check retires; current Kimi usage is verified by [[kimi-240](../packages/adapters/kimi.md#kimi-240)]. |
| `kimi-238` | The hypothetical breakdown check retires; current Kimi usage is verified by [[kimi-240](../packages/adapters/kimi.md#kimi-240)]. |
| `opencode-30` | Root-stream-only accounting retires; causal invocation accounting lives in [[opencode-21](../packages/adapters/opencode.md#opencode-21)] and [[opencode-45](../packages/adapters/opencode.md#opencode-45)] through [[opencode-51](../packages/adapters/opencode.md#opencode-51)]. |
| `opencode-233` | The flat availability check retires; current OpenCode usage is verified by [[opencode-240](../packages/adapters/opencode.md#opencode-240)]. |
| `opencode-238` | The old breakdown check retires; current OpenCode usage is verified by [[opencode-240](../packages/adapters/opencode.md#opencode-240)]. |
| `opencode-239` | The old record check retires; current OpenCode usage is verified by [[opencode-240](../packages/adapters/opencode.md#opencode-240)]. |
| `tmux-play-66` | The copy-mode-cancelling click design retires; selection clearing with copy-mode and scroll preservation lives in [[tmux-play-68](../packages/tmux-play.md#tmux-play-68)]. |
| `tmux-play-67` | The stock-only click design retires; the joint click contract lives in [[tmux-play-68](../packages/tmux-play.md#tmux-play-68)]. |
| `tmux-play-166` | Verification of the cancelling click design retires; the joint behavior is verified by [[tmux-play-168](../packages/tmux-play.md#tmux-play-168)]. |
| `tmux-play-167` | Verification of the stock-only click design retires; the unchanged mouse, drag-selection, and right-click behavior remains in [[tmux-play-162](../packages/tmux-play.md#tmux-play-162)], and the joint primary-click behavior is verified by [[tmux-play-168](../packages/tmux-play.md#tmux-play-168)]. |
| obsolete passages of `tmux-play-46` | Hand-written text wrapping, streaming escape carry, SGR close/reopen, and the old no-wrap fallback retire; the item retains live display-cell and pane-width rules, while `glow` wrapping lives in [[tmux-play-50](../packages/tmux-play.md#tmux-play-50)]. |
| obsolete passages of `tmux-play-137` | Old wrapping and escape assertions retire; the item retains live cell-classification and resize assertions, while the current rendering checks live in [[tmux-play-146](../packages/tmux-play.md#tmux-play-146)], [[tmux-play-147](../packages/tmux-play.md#tmux-play-147)], and [[tmux-play-148](../packages/tmux-play.md#tmux-play-148)]. |
| removed `tmux-play-78` | The wheel-clamp concern ends in [[tmux-play-79](../packages/tmux-play.md#tmux-play-79)] and the [0.12.0 changelog](../../CHANGELOG.md#0120---2026-06-14), which records that stock tmux already clamps and the real defect was readline scrollback pollution. |
| removed `tmux-play-177` | The obsolete wheel probe ends in [[tmux-play-178](../packages/tmux-play.md#tmux-play-178)] and the [0.12.0 changelog](../../CHANGELOG.md#0120---2026-06-14) entry for the source fix. |

The 35 wholly retired package IDs and the already-removed `tmux-play-78` and
`tmux-play-177` IDs remain permanently assigned to their released concerns.
Their headings may be absent, but their numbers are reserved forever and shall
never be reused [[meta-12](../meta.md#meta-12)]. `tmux-play-46` and
`tmux-play-137` remain live assigned IDs because only passages retire.

## Consequences

- The artifact and package specs agree without restoring obsolete behavior.
- Historical usage, wrapping, and mouse designs remain auditable here instead
  of remaining normative inside package files.
- Every live concern keeps a package owner and every released source keeps a
  destination in [DR-017](017-spec-generation-migration.md).
- Future allocation skips every whole retired number permanently.
- The released changelog remains byte-for-byte unchanged.
