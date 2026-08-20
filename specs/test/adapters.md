<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# TADAPT: Adapter Tests

## Intent

Verification criteria for all adapters. Shared patterns apply to each adapter; per-adapter sections cover unique behaviors.

## Shared

### TADAPT-003

Verifies: [ENG-009](../user/engine.md#eng-009)

When `AbortSignal` fires during an adapter's `run()`, the adapter shall yield `done` (`status: 'interrupted'`).

### TADAPT-022

Verifies: [ENG-022](../user/engine.md#eng-022), [ENG-023](../user/engine.md#eng-023)

Given an OpenCode `PermissionPolicy` whose `writablePaths` contains valid entries and no independently active filesystem-sandbox write-grant surface, the adapter's permission mapping shall expose canonical `WritablePathsPermissionMapping` paths with `enforcement: 'ambient'` and shall preserve the existing adapter-specific permission/tool mapping. Given invalid `writablePaths`, the mapping shall reject the policy.

## Codex

### TADAPT-021

Verifies: [ENG-022](../user/engine.md#eng-022), [ENG-023](../user/engine.md#eng-023)

Given a Codex `PermissionPolicy` whose local access resolves to `:workspace` and whose `writablePaths` contains valid entries, the Codex permission mapping shall expose canonical `WritablePathsPermissionMapping` paths with `enforcement: 'profile'`, select a generated extra-writes permission profile that extends `:workspace`, and represent `write` grants under `:workspace_roots` for each canonical path. Given non-empty `writablePaths` with Codex local access resolved to `:read-only`, the mapping shall reject the policy. Given non-empty `writablePaths` with Codex local access resolved to `:danger-full-access`, the mapping shall report the canonical paths with `enforcement: 'ambient'`, shall not generate an extra-writes profile, and shall not narrow the broader posture.

## Tool Filtering

### TADAPT-009

Verifies: [ENG-017](../user/engine.md#eng-017)

Given `allowedTools` and `disallowedTools` options, each adapter shall enforce whitelist and precedence semantics or reject before backend invocation when it has no compatible restriction surface, per [ENG-017](../user/engine.md#eng-017).

### TADAPT-029

Verifies: [ENG-017](../user/engine.md#eng-017)

Where `allowedTools` is an explicit empty list, when the built-in adapters run, the adapters shall enforce the closed empty set where supported.

## Effort

### TADAPT-018

Verifies: [ENG-020](../user/engine.md#eng-020), [ENG-024](../user/engine.md#eng-024)

Where each adapter-specific effort value is supplied, when the adapter maps a run, the observable provider controls shall match the cited adapter item.

When effort is omitted, no adapter shall set an effort, orchestration, settings-alias, or variant override.
Where a provider-specific value belongs to another built-in adapter or is an arbitrary unknown string, the adapter shall reject it before invoking the backend with an error naming the adapter and the same allowed values exposed by [ENG-024](../user/engine.md#eng-024).

### TADAPT-026

Verifies: [ENG-024](../user/engine.md#eng-024)

Where an effort value is valid for a built-in adapter but unavailable to the selected model, account, or installed runtime, when the backend rejects the run, the adapter stream shall expose that upstream failure through its normal error path without substituting another effort.

## Concurrency

### TADAPT-014

Verifies: [ENG-018](../user/engine.md#eng-018)

Where an adapter does not document an environmental constraint, concurrent `run()` calls on the same adapter instance shall emit no cross-stream event leakage (events from one call shall not appear in another), maintain per-call options isolation, and retain no cross-run state except the cumulative-accounting baseline and ordering queue permitted by [ENG-018](../user/engine.md#eng-018).

## Kimi

### TADAPT-033

Verifies: [ENG-019](../user/engine.md#eng-019), [ENG-027](../user/engine.md#eng-027)

_Superseded for usage shape by [TADAPT-040](#tadapt-040)._

Given each built-in adapter receives complete finite non-negative integer token counters, including explicit zeroes, when it emits terminal `done`, `usage.tokenAvailability` shall be `'reported'`, its input count shall preserve a provider-inclusive base or fold cache-read and cache-write counters into a cache-exclusive base exactly once, and, where reasoning or thinking is supplied disjoint from the output base, its output count shall add that component exactly once.
Given a required token or cache counter is absent or any present mapped counter is negative, fractional, non-finite, or non-numeric, when the adapter emits terminal `done`, `usage.tokenAvailability` shall be `'unavailable'`; an absent optional cache counter alone shall retain zero contribution without invalidating otherwise complete accounting.
Given upstream omits complete token accounting or an adapter synthesizes an errored, interrupted, exhausted, or other terminal path, when the adapter emits terminal `done`, `usage.tokenAvailability` shall be `'unavailable'` and no token estimate shall be introduced.
Where tool calls were observed or validly provider-reported on either path, `usage.toolUses` shall preserve the greatest independently known count even when token accounting is unavailable.

### TADAPT-038

Verifies: [ENG-028](../user/engine.md#eng-028)

_Superseded by [TADAPT-040](#tadapt-040)._

Given a runtime omits a cache or reasoning counter, the corresponding component shall be absent while the remaining members of a published side still sum to their aggregate, and where the omitted counter is the reasoning counter the whole output side shall be absent.
Given a component subtraction would be negative, the affected side shall be absent while the unaffected side is still published.

### TADAPT-039

Verifies: [ENG-030](../user/engine.md#eng-030)

_Superseded by [TADAPT-040](#tadapt-040)._

Given a run pinned no model and its runtime named none, no placeholder identifier shall appear.
Given a runtime reports a group's own cost, its record shall carry that cost, and the costs of a run's records shall not exceed the run's reported total.
Given upstream accounting is incomplete, absent, or fails the partition identities, the adapter shall publish no records on that terminal.

### TADAPT-040

Verifies: [ENG-031](../user/engine.md#eng-031)

Given authentic zero or nonzero accounting from a built-in adapter, terminal `usage.tokens` shall carry inclusive input and output totals, exact reported cache/reasoning subsets, and no removed flat fields or availability placeholder; malformed or absent accounting shall omit `tokens` while preserving independently observed `toolUses`.

## Real-run Acceptance

Items in this section verify behavior end-to-end against the real coding-agent SDKs and CLIs (not mocks or canned events). They live under `src/adapters/*.acceptance.test.ts` and run via `npm run test:acceptance`. The SDK packages the adapters load (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@opencode-ai/sdk`) are cligent `devDependencies`, while the ACP SDK used by Kimi is a runtime dependency, so any checkout able to run this suite has installed them via `npm install`; their absence is therefore not a skip condition. An item shall self-skip per adapter when an _external_ CLI the adapter spawns is absent from `PATH` — the `gemini` CLI for Gemini, the `opencode` CLI for OpenCode's managed server, or the `kimi` CLI for Kimi — or when that adapter's credential is absent from the environment; a missing dependency for one adapter shall not skip the others. Under `CI` the items shall instead hard-fail on a missing dependency so a misconfigured runner is not silently green. Exact credential-free Kimi ACP initialization remains an additional mandatory CI conformance check.

### TADAPT-023

Verifies: [ENG-022](../user/engine.md#eng-022), [ENG-023](../user/engine.md#eng-023)

Given the Codex CLI can initialize its native sandbox, a credential-free Codex sandbox probe shall show that the built-in `:workspace` profile cannot write inside `.git`, while cligent's generated extra-writes profile delivery grants `write` for `.git` without creating or modifying repository `.codex/config.toml` or user-level Codex `config.toml`. Mapping tests shall prove that managed writable mappings encode active-project trust as a top-level `projects={<path>={trust_level="trusted"}}` inline table rather than a quoted dotted path, perform Codex-compatible Windows device-prefix simplification, and resolve linked worktrees to Codex's main-repository trust root; read-only mappings and mappings without a non-empty caller `cwd` shall not inject project trust. Given `CligentOptions.permissions = { mode: 'auto', writablePaths: ['.git'] }` and Codex credentials, a real Codex SDK run in a throwaway git repository shall complete a git metadata write without `permission_request`, denied tool results, or error events, and without creating or modifying repository or user-level Codex config files, including persisted `projects.<path>.trust_level` entries for the throwaway workspace. As in [[codex-219](../packages/adapters/codex.md#codex-219)], the Codex leg shall self-skip with a logged reason when the host cannot initialize Codex's native sandbox, and shall hard-fail under `CI` for missing Codex dependencies or credentials.
