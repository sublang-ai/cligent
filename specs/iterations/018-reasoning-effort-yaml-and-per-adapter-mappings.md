<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-018: Reasoning Effort YAML Surface and Per-Adapter Mappings

## Goal

Expose `AgentOptions.reasoningEffort` through the tmux-play YAML surface so per-role and per-captain effort is configurable without dropping into the programmatic API.
Refresh the Claude adapter's stale `xhigh` mapping — the installed `@anthropic-ai/claude-agent-sdk` now exposes `'xhigh'` as a native rung, so cligent's collapse of `xhigh` to `'high'` (from a previous SDK version) under-uses the requested effort.
Wire `reasoningEffort` through the Gemini and OpenCode adapters' native effort surfaces too: Gemini via a per-run settings-file `modelConfigs.customAliases` entry carrying `generateContentConfig.thinkingConfig.thinkingLevel` (Gemini 3) or `thinkingBudget` (Gemini 2.5) per [[1]] [[2]], and OpenCode via the v2 prompt body's top-level `variant` field per the provider's built-in variants per [[3]].
With this IR, all four adapters consume the unified `reasoningEffort` field at run time.

## Status

Proposed

## Scope

In scope:

- [CLAUDE-008](../user/adapters/claude-code.md#claude-008) and `mapReasoningEffortToClaudeEffort`: `reasoningEffort: 'xhigh'` shall map to SDK `effort: 'xhigh'` (currently collapses to `'high'`); the obsolete "xhigh collapses to high" rationale clause is removed.
- [TMUX-007](../user/tmux-play.md#tmux-007), [TMUX-029](../user/tmux-play.md#tmux-029), `CaptainConfig`, `RoleConfig`, `RuntimeCaptainConfig`, `RuntimeRoleConfig`, and `CreateRoleCligentOptions`: add `reasoningEffort?: ReasoningEffort` (the [ENG-020](../user/engine.md#eng-020) closed set), forwarded into each constructed `Cligent` as `CligentOptions.reasoningEffort` per [ENG-001](../user/engine.md#eng-001).
- YAML loader: validate `reasoningEffort` against the [ENG-020](../user/engine.md#eng-020) closed set; reject out-of-set values at launcher startup with an error naming the offending path (e.g. `captain.reasoningEffort`, `roles[0].reasoningEffort`), per [TMUX-008](../user/tmux-play.md#tmux-008) and [DR-005](../decisions/005-per-adapter-permission-configuration.md)'s failure-surfacing rule.
- [GEMINI-011](../user/adapters/gemini.md#gemini-011) rewrite: when `options.model` matches a concrete Gemini model ID — regex `^gemini-3` for Gemini 3 (→ `thinkingLevel`) or `^gemini-2\.5` for Gemini 2.5 (→ `thinkingBudget`) — the Gemini adapter forwards `reasoningEffort` by extending its per-run `defaultCreateSettingsOverride` to inject a self-contained custom alias under `modelConfigs.customAliases.<cligent-alias>` whose `modelConfig.model` is `options.model` (so the alias chain resolves and the CLI's resolver does not error) and whose `modelConfig.generateContentConfig.thinkingConfig` carries `thinkingLevel` or `thinkingBudget` per the mapping tables below; the adapter targets the custom alias via `--model`. When `options.model` is unset, is a Gemini CLI alias (e.g. `pro`, `flash`, `flash-lite`, `auto`, `chat-base*`), or is any other non-matching value, the adapter shall not write the custom alias and shall not override the `--model` flag: when `options.model` is set the adapter still forwards `--model <options.model>` to the CLI unchanged per its existing behavior at `src/adapters/gemini.ts:425`, and when `options.model` is unset no `--model` flag is passed (also unchanged); `reasoningEffort` is silently ignored for that call. The concrete-ID-only requirement avoids resolving CLI aliases whose target model can drift across Gemini CLI updates — a `flash` alias today may point to Gemini 2.5 in one release and Gemini 3 in the next, so prefix-dispatching against the alias string would write an incompatible `thinkingConfig` for the actually-resolved model.
- [OPENCODE-012](../user/adapters/opencode.md#opencode-012) rewrite: the OpenCode adapter forwards `reasoningEffort` by setting the top-level `variant` field on the v2 session prompt body (`prompt` / `promptAsync`) per the provider's built-in variants. The per-prompt surface (not session.create) is required so the value also applies to resumed sessions, which do not call `create`. Provider dispatch is by the `provider/model` prefix of `options.model`; for a provider without a documented variant set, `variant` is left unset (deferring to the user's `opencode.jsonc`).
- New TTMUX items: one for the YAML→adapter-options seam (a YAML `reasoningEffort` reaches each adapter's mapped surface), one for the loader's invalid-value reject path.

Out of scope (separate future IR):

- Exposing Claude `thinking` (`{ type: 'adaptive' }` / `{ type: 'enabled', budgetTokens }` / `{ type: 'disabled' }`); richer than the ordinal `reasoningEffort` dial, needs its own design for an adapter-native options surface that participates in the [ENG-003](../user/engine.md#eng-003) merge semantics.

## Mapping tables (pinned by this IR)

### Claude — `reasoningEffort` → SDK `effort`

| `reasoningEffort` | SDK `effort` |
| --- | --- |
| `minimal` | `'low'` |
| `low` | `'low'` |
| `medium` | `'medium'` |
| `high` | `'high'` |
| `xhigh` | `'xhigh'` |
| `max` | `'max'` |

### Codex — unchanged from [CODEX-007](../user/adapters/codex.md#codex-007)

| `reasoningEffort` | `modelReasoningEffort` |
| --- | --- |
| `minimal` | `'minimal'` |
| `low` | `'low'` |
| `medium` | `'medium'` |
| `high` | `'high'` |
| `xhigh` | `'xhigh'` |
| `max` | `'xhigh'` |

### Gemini 3 — `reasoningEffort` → `thinkingLevel`

| `reasoningEffort` | `thinkingLevel` |
| --- | --- |
| `minimal` | `'MINIMAL'` |
| `low` | `'LOW'` |
| `medium` | `'MEDIUM'` |
| `high` | `'HIGH'` |
| `xhigh` | `'HIGH'` |
| `max` | `'HIGH'` |

Gemini 3 exposes four rungs (`MINIMAL` / `LOW` / `MEDIUM` / `HIGH`); `xhigh` and `max` collapse to `HIGH` per the [ENG-020](../user/engine.md#eng-020) "nearest supported neighbour" rule.

### Gemini 2.5 — `reasoningEffort` → `thinkingBudget` (token integer)

| `reasoningEffort` | `thinkingBudget` |
| --- | --- |
| `minimal` | `1024` |
| `low` | `4096` |
| `medium` | `8192` |
| `high` | `16384` |
| `xhigh` | `24576` |
| `max` | `32768` for `gemini-2.5-pro*`; `24576` for `gemini-2.5-flash*` and `gemini-2.5-flash-lite*` |

The `1024..24576` ladder falls inside every Gemini 2.5 model's documented bounds (Pro 128–32768; Flash 0–24576; Flash Lite 512–24576).
`max` maps to the model's documented upper bound rather than Google's `-1` dynamic-thinking sentinel: per [ENG-020](../user/engine.md#eng-020) `max` is "the greatest reasoning depth," which is the upper bound, not adaptive.
On Flash and Flash Lite, `xhigh` and `max` collapse to `24576` (the per-model ceiling) per the [ENG-020](../user/engine.md#eng-020) nearest-neighbour rule.

### OpenCode — `reasoningEffort` → prompt-body `variant` per provider

Provider dispatch is by `provider/model` prefix of `options.model`. Where a requested effort has no corresponding variant, the mapping picks the nearest neighbour for that provider. The value is set on the v2 prompt body's top-level `variant` field (not `model.variant` on session.create), so it applies per-call to fresh and resumed sessions.

| `reasoningEffort` | Anthropic | OpenAI | Google | Other |
| --- | --- | --- | --- | --- |
| `minimal` | `'high'` | `'minimal'` | `'low'` | unset |
| `low` | `'high'` | `'low'` | `'low'` | unset |
| `medium` | `'high'` | `'medium'` | `'low'` | unset |
| `high` | `'high'` | `'high'` | `'high'` | unset |
| `xhigh` | `'max'` | `'xhigh'` | `'high'` | unset |
| `max` | `'max'` | `'xhigh'` | `'high'` | unset |

For unrecognised provider prefixes, the adapter shall leave `variant` unset and defer to the user's `opencode.jsonc`.

## Deliverables

- [ ] `specs/user/adapters/claude-code.md` — CLAUDE-008 table updated for `xhigh → 'xhigh'`; obsolete collapse-rationale removed.
- [ ] `specs/user/tmux-play.md` — TMUX-007 and TMUX-029 extended to admit `reasoningEffort?` on roles and captain.
- [ ] `specs/user/adapters/gemini.md` — GEMINI-011 rewritten with the per-run settings-file mechanism + Gemini 3 / Gemini 2.5 mapping tables; references added.
- [ ] `specs/user/adapters/opencode.md` — OPENCODE-012 rewritten with the v2 prompt-body top-level `variant` mechanism + per-provider mapping table; reference added.
- [ ] `specs/test/tmux-play.md` — new TTMUX item for the YAML→adapter-options seam across all four adapters and a new TTMUX item for the loader's invalid-value reject path.
- [ ] `specs/map.md` — IR-018 indexed.
- [ ] `src/adapters/claude-code.ts` — `mapReasoningEffortToClaudeEffort` returns `'xhigh'` for `xhigh`.
- [ ] `src/__tests__/claude-code-adapter.test.ts` — `xhigh` assertion updated to `'xhigh'`.
- [ ] `src/adapters/gemini.ts` — when `options.model` matches `^gemini-3` or `^gemini-2\.5`, `defaultCreateSettingsOverride` writes a self-contained custom alias under `modelConfigs.customAliases.<cligent-alias>.modelConfig` whose `model` is `options.model` and whose `generateContentConfig.thinkingConfig` carries `thinkingLevel`/`thinkingBudget` per the mapping tables, and the adapter targets the custom alias via `--model`; for any other `options.model` value (unset, CLI alias, or non-matching concrete name), the override is a silent no-op for `reasoningEffort` — no custom alias is written, the existing `--model <options.model>` forwarding (or its absence when unset) is preserved unchanged, and nothing is emitted on stderr; consistent with the cligent adapter's existing silent-ignore pattern for unsupported per-call options.
- [ ] `src/__tests__/gemini-adapter.test.ts` — unit tests cover Gemini 3 / Gemini 2.5 dispatch and the per-level mapping.
- [ ] `src/adapters/opencode.ts` — the session prompt body's top-level `variant` field is set per the per-provider mapping (derived from `options.model` + `reasoningEffort`); the SDK call path uses the v2 surface (`@opencode-ai/sdk/v2`) that types `variant` explicitly on the prompt body so the value reaches fresh and resumed sessions uniformly.
- [ ] `src/__tests__/opencode-adapter.test.ts` — unit tests cover per-provider variant mapping and the "no documented variant" / "unrecognised provider" fallback.
- [ ] `src/app/tmux-play/config.ts` — `CaptainConfig` and the loader accept and validate `reasoningEffort`.
- [ ] `src/app/tmux-play/roles.ts` — `RoleConfig` and `CreateRoleCligentOptions` widened; role construction forwards `reasoningEffort` to the constructed `Cligent`.
- [ ] `src/app/tmux-play/contract.ts` — `RuntimeCaptainConfig` and `RuntimeRoleConfig` widened.
- [ ] `src/app/tmux-play/config.test.ts` — loader accepts each value in the closed set and rejects invalid values at the offending path.
- [ ] `src/app/tmux-play/launcher.acceptance.test.ts` — YAML→adapter seam asserts `reasoningEffort` reaches each adapter's mapped surface (Claude `effort`, Codex `modelReasoningEffort`, Gemini settings-file thinking config only when `options.model` matches a concrete `^gemini-3` or `^gemini-2\.5` ID — with an inverse-seam assertion for the alias/non-matching/unset skip path that no custom alias is written and the user's existing `--model` forwarding is preserved unchanged, OpenCode v2 prompt-body top-level `variant`).

## Tasks

1. [ ] **Spec** — amend [CLAUDE-008](../user/adapters/claude-code.md#claude-008) (`xhigh → 'xhigh'`, drop collapse rationale), [TMUX-007](../user/tmux-play.md#tmux-007) and [TMUX-029](../user/tmux-play.md#tmux-029) (admit `reasoningEffort?`); rewrite [GEMINI-011](../user/adapters/gemini.md#gemini-011) and [OPENCODE-012](../user/adapters/opencode.md#opencode-012) with this IR's mapping tables; add the two new TTMUX items; index this IR in `map.md`. New TTMUX items carry their `Verifies:` lines per [META-20](../meta.md#meta-20) with IDs above the current TTMUX maximum per [META-11](../meta.md#meta-11) / [META-12](../meta.md#meta-12); external references per [META-19](../meta.md#meta-19).
2. [ ] **Claude xhigh mapping fix** — `mapReasoningEffortToClaudeEffort` returns `'xhigh'` for `xhigh`; the Claude adapter unit test's `xhigh` case asserts `'xhigh'`.
3. [ ] **YAML and runtime wiring** — extend `CaptainConfig` / `RoleConfig` / `CreateRoleCligentOptions` / `RuntimeCaptainConfig` / `RuntimeRoleConfig` with `reasoningEffort?: ReasoningEffort`; the loader validates against the [ENG-020](../user/engine.md#eng-020) closed set and rejects invalid values at the offending path; role and captain construction forwards the loaded value into `CligentOptions.reasoningEffort`; loader unit tests cover the accept set and the reject path.
4. [ ] **Gemini settings-file wiring** — when `options.model` matches `^gemini-3` or `^gemini-2\.5`, extend `defaultCreateSettingsOverride` to (a) dispatch by the matched prefix (Gemini 3 → `thinkingLevel`; Gemini 2.5 → `thinkingBudget`), (b) write a self-contained custom alias under `modelConfigs.customAliases.<cligent-alias>.modelConfig` whose `model` is `options.model` and whose `generateContentConfig.thinkingConfig` carries the value per the Gemini tables above so the alias chain resolves and the CLI's resolver does not error, (c) target the custom alias via `--model`; for any other `options.model` value (unset, a Gemini CLI alias such as `pro`/`flash`/`flash-lite`/`auto`/`chat-base*`, or a non-matching concrete name), skip the alias write and leave the existing `--model` forwarding behavior unchanged (the adapter still passes `--model <options.model>` when set per `src/adapters/gemini.ts:425`, and passes none when unset) — silently. Unit tests cover both dispatch branches, each per-level mapping value, the model-specific `max` upper bound for 2.5 Pro vs Flash/Lite, and the silent skip path (one case per skip reason: unset, CLI alias, non-matching concrete name).
5. [ ] **OpenCode variant wiring** — derive the `variant` value from `options.model` provider prefix + `reasoningEffort` per the OpenCode table; migrate the session-prompt path to the SDK's v2 surface at `@opencode-ai/sdk/v2` (the exported subpath confirmed in the SDK's `exports` map) so the prompt body's top-level `variant` field is typed and reaches both fresh and resumed sessions; unit tests cover per-provider mapping and the unrecognised-provider fallback.
6. [ ] **Acceptance** — extend the tmux-play YAML→adapter seam acceptance test so a YAML `reasoningEffort` on each adapter's role reaches that adapter's mapped surface; for Gemini, when `options.model` matches a concrete Gemini model ID (`^gemini-3` or `^gemini-2\.5`), assert the written settings-file alias contains the right `modelConfig.model` and `thinkingConfig.thinkingLevel` / `thinkingBudget` and the CLI invocation targets that custom alias via `--model`; when `options.model` is a Gemini CLI alias (e.g. `'flash'`) or any other non-matching concrete value, assert no custom alias is written and the CLI invocation still includes `--model <options.model>` unchanged; when `options.model` is unset, assert no custom alias is written and no `--model` flag is passed; for OpenCode, assert the v2 prompt body's top-level `variant` carries the right value per the per-provider mapping; run `npm run test:acceptance`.

## Acceptance criteria

- `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`, and `npm run test:smoke` pass at every task boundary.
- A Claude `reasoningEffort: 'xhigh'` mapping produces SDK `effort: 'xhigh'`, not `'high'`.
- A YAML config whose `captain.reasoningEffort` or `roles[i].reasoningEffort` is in the [ENG-020](../user/engine.md#eng-020) closed set loads and forwards the value to that role's or the captain's `Cligent` as `CligentOptions.reasoningEffort`.
- A YAML config whose `reasoningEffort` is outside `'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'` rejects at launcher startup with a stderr `Error: ...` line naming the offending path (`captain.reasoningEffort` or `roles[N].reasoningEffort`); the runtime shall not start, consistent with [TMUX-008](../user/tmux-play.md#tmux-008) and [DR-005](../decisions/005-per-adapter-permission-configuration.md)'s failure-surfacing rule.
- A Gemini `options.model = 'gemini-3-flash'` + `reasoningEffort: 'high'` produces a settings-file custom alias whose `modelConfig.model` is `'gemini-3-flash'` and whose `thinkingConfig.thinkingLevel` is `'HIGH'`; `options.model = 'gemini-2.5-flash'` + `reasoningEffort: 'medium'` produces a custom alias whose `modelConfig.model` is `'gemini-2.5-flash'` and `thinkingConfig.thinkingBudget` is `8192`; `reasoningEffort: 'max'` on `gemini-2.5-pro*` writes `thinkingBudget: 32768`; on `gemini-2.5-flash*` or `gemini-2.5-flash-lite*` writes `thinkingBudget: 24576`. With `reasoningEffort` set and `options.model` set to a Gemini CLI alias (e.g. `'flash'`, `'pro'`, `'flash-lite'`, `'auto'`, `'chat-base-3'`) or any other non-matching concrete value, no custom alias is written and the CLI invocation still includes `--model <options.model>` — the user's model flag is preserved unchanged; when `options.model` is unset, no custom alias is written and no `--model` flag is passed (matching the adapter's current behavior); nothing is emitted on stderr in either case.
- An OpenCode `options.model = 'anthropic/claude-sonnet-4-5'` + `reasoningEffort: 'max'` produces a session-prompt body with top-level `variant === 'max'`; `options.model = 'openai/gpt-5'` + `reasoningEffort: 'medium'` produces `variant === 'medium'`; `options.model = 'someprovider/somemodel'` (no documented variants) leaves `variant` unset; resumed sessions carry the same `variant` per prompt rather than relying on session.create.
- After Task 6, `npm run test:acceptance` passes with the YAML→adapter seam asserting `reasoningEffort` on all four adapter legs.

## References

[1]: https://ai.google.dev/gemini-api/docs/thinking "Gemini API: Thinking"
[2]: https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md "Google Gemini CLI: Configuration reference"
[3]: https://opencode.ai/docs/models/ "OpenCode: Models and variants"
