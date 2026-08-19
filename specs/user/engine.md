<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# ENG: Core Engine

## Intent

This component defines the `Cligent` class, `Cligent.parallel()`, and event helpers per [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md) and [DR-003](../decisions/003-role-scoped-session-management.md).

## Cligent Class

### ENG-001

The `Cligent` constructor shall accept an `AgentAdapter` and optional `CligentOptions` per [DR-003](../decisions/003-role-scoped-session-management.md). `CligentOptions` contains instance-level defaults (`role`, `cwd`, `model`, `permissions`, `maxTurns`, `maxBudgetUsd`, `effort`, `allowedTools`, `disallowedTools`). Call-scoped fields (`abortSignal`, `resume`) exist only in `RunOptions`.

### ENG-002

`Cligent.run()` shall throw when called while a previous `run()` generator on the same instance is still active (single-flight enforcement per [DR-003](../decisions/003-role-scoped-session-management.md#single-flight-enforcement)).

### ENG-003

`Cligent.run()` shall merge `CligentOptions` instance defaults with per-call `RunOptions` overrides per [DR-003](../decisions/003-role-scoped-session-management.md#option-merge-semantics): deep merge for `permissions`, replace for `allowedTools`/`disallowedTools` arrays, per-call wins for other scalars. `abortSignal` and `resume` exist only in `RunOptions` (per-call), not in instance defaults.
Within `permissions`, `writablePaths` is an array grant field: when a per-call `permissions.writablePaths` array is provided, it shall replace the instance default array rather than merging element-wise.

### ENG-004

When `CligentOptions.role` is set, every event yielded by `run()` shall carry a `role` field matching that value. When `role` is not set, events shall not include a `role` field.

## Session Continuity

### ENG-005

When the adapter emits a `done` event with a `resumeToken`, `Cligent` shall store it. On subsequent `run()` calls, `Cligent` shall inject `resume: resumeToken` into adapter options — unless the caller explicitly sets `resume` in per-call overrides.

### ENG-006

When the adapter emits a `done` event without a `resumeToken`, `Cligent` shall not inject `resume` on subsequent calls. Auto-resume is a no-op for adapters that do not support resumption.

## Event Helpers

### ENG-007

The engine shall export `createEvent()`, `generateSessionId()`, and `isAgentEvent()` helpers for constructing events, generating unique session IDs, and runtime type-guarding `AgentEvent` values.

## Protocol Hardening (run)

### ENG-008

When the adapter's generator throws and no `done` event has been yielded, `run()` shall yield an `error` event (`code: 'ADAPTER_ERROR'`, `recoverable: false`) followed by a `done` event (`status: 'error'`). When the throw occurs after `done`, the exception shall be swallowed.

### ENG-009

When the `AbortSignal` fires and no `done` event has been yielded, `run()` shall call `.return()` on the adapter generator and yield a `done` event (`status: 'interrupted'`). When the signal is already aborted before `.run()` is called, `run()` shall yield `done` (`status: 'interrupted'`) without calling the adapter.
When the signal fires while an adapter `.next()` read is already pending, `run()` shall give the adapter a short bounded drain window before synthesis. During that drain, post-abort non-terminal events shall be suppressed; if the drain reaches an adapter-emitted `done`, that adapter event shall be yielded and processed normally before generator cleanup. For stateful `Cligent.run()`, processing that adapter `done` includes [ENG-005](#eng-005) resume-token capture. If the drain does not reach `done`, the synthesized interrupted `done` may include the inbound `resume` token when one was passed into the run, but shall not fabricate a token from a non-terminal event `sessionId`.

### ENG-010

Once a `done` event is yielded (whether from the adapter or synthesized), the engine shall call `.return()` on the generator and suppress all subsequent events. No event of any type shall follow `done`.

### ENG-011

Exactly one `done` event shall be yielded per `run()` call.

### ENG-012

When the adapter's generator exhausts without yielding a `done` event, `run()` shall yield an `error` event (`code: 'MISSING_DONE'`, `recoverable: false`) followed by a `done` event (`status: 'error'`).

### ENG-013

Synthesized `done` payloads shall require only `usage.toolUses`, shall preserve any independently known tool-use count, shall omit `usage.tokens` and `usage.cost` rather than fabricate accounting, and shall use `durationMs` measured from when the adapter's `.run()` was called.
An adapter-emitted `done` shall take precedence over synthesis.
This precedence includes an adapter-emitted interrupted `done` observed during the abort-drain path of [ENG-009](#eng-009).

## Cligent.parallel()

### ENG-014

`Cligent.parallel()` shall merge multiple `Cligent` streams, yielding `CligentEvent` values from each instance as they become available. Each event carries both `agent` (backend identity) and `role` (task identity).

### ENG-015

When one instance's adapter throws and no `done` has been yielded for that instance, `parallel()` shall yield an `error` event and `done` event for that instance and remove it from the pool. Remaining instances shall continue.

### ENG-016

Each task's `overrides.abortSignal` controls only that task. When a task's signal fires, `parallel()` shall yield `done` (`status: 'interrupted'`) for that task and remove it from the pool; remaining tasks continue. To abort all tasks, the caller shall share one `AbortController` across all task overrides.

## Tool Filtering

### ENG-017

When `allowedTools` is set, adapters shall restrict available tools to that list. An explicit empty `allowedTools` list shall make no tools available and shall remain distinct from omission, which preserves the adapter's native tool surface. When `disallowedTools` is also set, adapters shall further exclude those tools from the allowed set. Tool names shall be matched as exact identifiers unless the adapter explicitly documents pattern support per [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md#adapter-interface). Where an adapter has no compatible surface for an explicit tool restriction, it shall reject before invoking the backend rather than silently ignore or weaken the restriction.

## Adapter Thread Safety

### ENG-018

`AgentAdapter.run()` shall be safe for concurrent calls on the same adapter instance unless the adapter explicitly documents an environmental constraint. Each call shall create fresh local state and `run()` shall not mutate adapter instance state per [DR-003](../decisions/003-role-scoped-session-management.md#adapter-thread-safety).
Where a backend reports token accounting cumulatively per session rather than per turn, the adapter shall be permitted to retain one usage baseline per backend session identifier and a per-resume-session serialization queue across calls, as the sole exception, because the turn's own usage is otherwise unrecoverable.
That baseline shall be keyed by backend session identity so concurrent runs on different sessions cannot observe each other's counters, and an adapter holding no baseline for a session it did not observe shall omit token accounting per [ENG-031](#eng-031) rather than attribute the session's accumulated total to one turn.
Where an adapter retains that cumulative baseline, runs carrying the same non-empty resume identifier shall enter the backend serially through terminal cleanup so their snapshots have one causal order; fresh runs and runs carrying different resume identifiers shall remain concurrent, and normal completion, error, interruption, or setup failure after acquisition shall release the queue for its successor.

## Usage Reporting

### ENG-019

_Superseded by [ENG-031](#eng-031); retained for the released flat-field contract._

Where token accounting is `'reported'`, `inputTokens` shall include all input tokens consumed by the request, regardless of caching tier (base, cache-read, and cache-creation).
Where a provider defines its base input counter as cache-exclusive, the adapter shall sum provider-specific cache-read and cache-write fields into `inputTokens` exactly once.
Where a provider defines its base input counter as cache-inclusive, including Codex `input_tokens` and Gemini `StreamStats.input_tokens`, the adapter shall preserve that base total and validate separately reported cache subset/detail counters without adding them again.
Where token accounting is `'reported'`, `outputTokens` shall include every model-generated output token, including reasoning or thinking tokens.
Where a provider reports reasoning or thinking separately from a visible or candidate output base, the adapter shall add that disjoint detail exactly once; where an aggregate exposes additional token use without partitioning it between normalized input and output, the adapter shall mark accounting unavailable rather than allocate the residual by estimation.
Cache or reasoning details shall not make incomplete base input and output accounting `'reported'`; availability shall remain governed by [ENG-027](#eng-027).
Where the producer publishes the optional `DoneUsage.breakdown` partition of [ENG-028](#eng-028), the input side `input` + `cacheRead` + `cacheWrite` shall equal `inputTokens` exactly in integers, and the output side `output` + `reasoning` shall equal `outputTokens` exactly, treating an omitted member of a published side as a zero contribution.
Where a provider's base input counter is cache-inclusive, the producer shall obtain `input` by subtracting the mapped cache counters from that base, and where a provider's output counter includes reasoning, it shall obtain `output` by subtracting the mapped reasoning counter.
Where such a subtraction is negative, the producer shall omit that side rather than clamp it, because a clamped component would make the side exceed the aggregate it partitions.

## Effort

### ENG-020

Per [DR-009](../decisions/009-adapter-scoped-effort-vocabularies.md), `AgentOptions<E>.effort` shall accept the selected adapter's effort vocabulary `E`, with `undefined` reserved to defer to applicable adapter, model, account, and user-configuration defaults and configuration-isolation rules.
`PortableEffort` shall be the six-value ladder `'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`, ordered from least to greatest reasoning depth.
`ClaudeEffort` shall be `PortableEffort | 'ultracode'`; `CodexEffort` shall be `PortableEffort | 'ultra'`; `GeminiEffort` and `OpenCodeEffort` shall each be `PortableEffort`; `KimiEffort` shall be the provider-native binary union `'off' | 'on'`; and the adapter-neutral built-in `Effort` union shall cover every value in those aliases.
Those public aliases shall be derived from the literal values in [ENG-024](#eng-024)'s runtime support table rather than maintained as a second vocabulary definition.
Where a built-in provider lacks a one-to-one portable value, its adapter item shall map to the nearest supported neighbour in the portable ordering; where mapping depends on a concrete model or provider that is absent or unrecognised, the adapter item may leave the provider override unset and shall document that behavior.
`AgentAdapter<E>`, `CligentOptions<E>`, `RunOptions<E>`, and `Cligent<E>` shall carry the same vocabulary through constructor defaults, run overrides, direct adapter calls, `Cligent.parallel()`, and `runParallel()` without widening one adapter's values to another adapter's values.
A custom adapter may bind an arbitrary string-literal vocabulary with any names or number of levels and shall retain that vocabulary through direct and heterogeneous parallel calls.
On the legacy name-based mutable-registry path, `runAgent()` shall accept `AgentOptions<string>` and forward the exact effort string unchanged; because registrations may be removed and rebound dynamically, that path shall not claim compile-time agent-name-to-vocabulary correlation.
Built-in adapters shall perform their specified runtime validation on the dynamic path, while custom adapters remain responsible for validating their own dynamic inputs; callers requiring compile-time correlation shall use a statically adapter-bound surface such as direct `AgentAdapter<E>` calls, `Cligent`, `Cligent.parallel()`, or `runParallel()`.

The built-in vocabularies and provider mappings are defined by [CLAUDE-008](adapters/claude-code.md#claude-008), [CODEX-007](adapters/codex.md#codex-007), [GEMINI-011](adapters/gemini.md#gemini-011), [OPENCODE-012](adapters/opencode.md#opencode-012), and [KIMI-009](adapters/kimi.md#kimi-009).

### ENG-024

The exported `EFFORT_SUPPORT` object shall be deeply frozen at runtime and define each built-in adapter's accepted `values`, provider-native `orchestrationValues`, `modelDependent` flag, and user-facing `notes` without promising model, account, or installed-runtime availability.
Each `values` array shall define its adapter's public effort alias in the [ENG-020](#eng-020) order; Claude and Codex `orchestrationValues` shall be exactly `['ultracode']` and `['ultra']`, respectively, while Gemini, OpenCode, and Kimi shall expose empty orchestration arrays; and `modelDependent` shall be `true` for all five built-ins.
Where a mapping is lossy or ignored without a concrete model or provider, `notes` shall state that condition.
Kimi's notes shall state that `on` selects the chosen model's native default thinking effort rather than a portable reasoning-depth tier.
`getEffortSupport`, `supportedEffortValues`, `isEffortSupported`, and `assertSupportedEffort` shall expose and validate the same values in `EFFORT_SUPPORT`; the alias `claude` shall resolve to `claude-code`; and the predicate and assertion shall narrow known adapter values to that adapter's public effort alias.
For an unknown adapter, the lookup functions shall return `undefined`, the predicate shall return `false`, and the assertion shall throw an error naming the adapter and validation path.
For a known adapter and unsupported value, the assertion shall throw an error naming the adapter, validation path, and allowed values.
Where a metadata-accepted value is unavailable to the selected model, account, or installed runtime and the backend rejects it, the adapter shall expose that upstream failure through its normal error path without substituting another effort.

## Permission Policy Mode

### ENG-021

`PermissionPolicy.mode` shall accept the closed set `'auto' | 'bypass' | undefined` per [DR-005](../decisions/005-per-adapter-permission-configuration.md).
When `mode` is set, adapters shall use it as the session-wide automation posture at their SDK-knob selection step: `'auto'` shall map to each provider's native auto posture, whose protection and approval semantics are adapter-specific, and `'bypass'` shall map to the unchecked-bypass mode where the SDK supports one.
Where an SDK models the automation posture and the local-access surface (filesystem, command, network) as independent axes, the adapter's mapping item may additionally derive the local-access surface from `fileWrite` / `shellExecute` / `networkAccess` while `mode` governs the automation posture; where it does not, `mode` shall take precedence over those per-capability levels.
Where an SDK exposes an automatic reviewer for otherwise interactive approval prompts, the `'auto'` mapping shall select it when that reviewer is part of the SDK's protected auto posture; this shall not expand filesystem, network, or sandbox permissions.
Adapters whose architecture cannot reach a given mode shall reject it at mapping time with an error naming the constraint; the rejection surfaces per [DR-005](../decisions/005-per-adapter-permission-configuration.md)'s failure-surfacing rule.
When `mode` is `undefined`, adapters shall continue to derive their SDK options from `fileWrite` / `shellExecute` / `networkAccess` as before.

## Workspace Writable Paths

### ENG-022

`PermissionPolicy.writablePaths` shall accept an optional array of workspace-relative path strings per [DR-006](../decisions/006-workspace-writable-paths.md). Adapters shall emit only canonical workspace-relative entries: separators use `/`, leading `./` components and trailing slashes are absent, and `.` components do not appear. Adapters shall reject empty entries, root-equivalent entries such as `.` or `./`, absolute paths, paths containing `..`, empty path segments, glob metacharacters, shell expansion characters, or control characters.

### ENG-023

`WritablePathsEnforcement` shall accept the closed set `'profile' | 'sandbox' | 'ambient'` per [DR-006](../decisions/006-workspace-writable-paths.md). `WritablePathsPermissionMapping` shall report canonical `paths` and the field-local `enforcement` class for accepted non-empty `writablePaths` policies. When `writablePaths` is absent or empty, permission mapping shall not emit a `WritablePathsPermissionMapping` payload.

## Runtime Compatibility

### ENG-025

Where an adapter's runtime is a package resolved from the installed `@sublang/cligent` tree, the adapter shall read that package's declared version through the same resolution it uses to load the runtime, and shall refuse to load a version below the supported floor declared for it by [[package-16](../packages/package.md#package-16)].
The refusal shall be an error naming the package, the version that is installed, the version that is required, the `node_modules` tree it resolved from, and the command that repairs it.
Where the version cannot be read, the runtime shall load unchanged, because a vendored, bundled, or archived layout is a supported installation and an unreadable version is not evidence of an unsupported one.
Where an adapter's runtime is an executable found through `PATH`, the adapter shall read the version that executable reports and apply the same rules.

### ENG-026

`Cligent` shall expose a runtime-readiness verdict for an adapter reporting one of the closed set `'satisfied' | 'missing' | 'unsupported' | 'untested' | 'unknown'`, carrying the installed version where one was read, the supported range and tested version from [[package-16](../packages/package.md#package-16)], the resolved `node_modules` tree or executable path, and the repair commands.
`'unsupported'` shall name a runtime below the supported floor and `'untested'` a runtime above the tested version, and the two shall not be reported as the same verdict.
`'unknown'` shall report a runtime whose version could not be read and shall not be treated as a failure by any caller-facing behavior in this repository.
`adapter.isAvailable()` shall remain a boolean and shall report `false` for exactly `'missing'` and `'unsupported'`, so a caller that has not adopted the verdict keeps its current contract while a caller that has can distinguish an absent runtime from an incompatible one.

## Token Usage Availability

### ENG-027

_Superseded by [ENG-031](#eng-031); retained for the released availability-discriminator contract._

Every `DonePayload.usage` shall carry the required `tokenAvailability` discriminator with the closed values `'reported' | 'unavailable'` per [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md#key-payloads).
Where upstream supplies complete finite non-negative integer input and output counters, including explicit zeroes, and every present mapped cache or reasoning counter has the same form, the adapter shall set `'reported'`, shall preserve the mapped counters and [ENG-019](#eng-019) composition rules, and shall not estimate any missing component.
Where an optional cache counter is absent, its contribution shall be zero without invalidating otherwise complete accounting; where a required counter is absent or any present mapped token or cache counter is non-finite, negative, fractional, or non-numeric, the producer shall set `'unavailable'` rather than silently substituting a reported zero.
Where complete upstream token counters are absent, malformed, or unavailable on a synthesized, errored, interrupted, exhausted, or other terminal path, the producer shall set `'unavailable'`; numeric token fields shall remain present for object-shape compatibility but consumers shall not treat them as measurements.
Where either availability state applies, the producer shall preserve an independently known `toolUses` count from observed tool lifecycles or a valid provider-reported count instead of deriving its availability from token accounting.
This discriminator shall govern the `inputTokens` and `outputTokens` aggregates only; the presence of the optional `breakdown` partition shall be governed by [ENG-028](#eng-028).
Where the discriminator is `'unavailable'`, the producer shall omit `breakdown` entirely, so that no consumer can sum components into a figure the run did not measure.

## Token Usage Breakdown

### ENG-028

_Superseded by [ENG-031](#eng-031); retained for the unreleased disjoint-breakdown design._

`DoneUsage.breakdown` shall be an optional `TokenBreakdown` whose optional members `input`, `cacheRead`, `cacheWrite`, `output`, and `reasoning` are a disjoint partition of the aggregates per [DR-014](../decisions/014-unified-token-usage-breakdown.md), counting every token at most once and satisfying the [ENG-019](#eng-019) identities.
A present member shall be a finite non-negative integer the producer measured, and an absent member shall mean the runtime does not report that quantity; a present zero shall therefore never be interpreted as an unreported component, nor an absent member as a measured zero.
The members shall form two sides, `input` / `cacheRead` / `cacheWrite` and `output` / `reasoning`, and the producer shall publish each side in full or omit it in full.
Where a runtime's accounting model contains no counter for a member of a side it publishes, the producer shall omit that member alone.
Where a runtime is known to bill a quantity that it does not expose separately, the producer shall omit that member's whole side, because publishing the remaining total under a narrower component name would assert a measurement the runtime did not make.
Where neither side is publishable, the producer shall omit `breakdown` rather than emit an empty object.

### ENG-029

_Superseded by [ENG-031](#eng-031); retained for the original supplementary-source rule._

Where an adapter derives token accounting from a source other than the protocol stream it consumes for the run, including state the runtime writes outside that stream, it shall cross-validate the derived totals against the aggregates that stream itself reported.
Where the cross-validation fails, or the source is absent, unreadable, or unparsable, the adapter shall fall back to the accounting the protocol stream supports, including `'unavailable'` where that accounting is incomplete, so that a supplementary source can only raise fidelity and never lower correctness.
An adapter shall not read a source that lies outside a protocol boundary an applicable decision record establishes for it.

### ENG-030

_Superseded by [ENG-031](#eng-031); retained for the original billable-record design._

`DoneUsage.records` shall be an optional list of `UsageRecord` values decomposing the run into billable groups per [DR-014](../decisions/014-unified-token-usage-breakdown.md), each carrying that group's `tokens` in the [ENG-028](#eng-028) frame and, where the runtime supplies them, the rate-card `model` and `provider`, the number of API `requests` the group covers, and the `costUsd` the runtime computed for it.
Where the producer publishes records, their components shall sum exactly to `breakdown`, member by member, so that a component present in one is present in the other; where that identity cannot hold, the producer shall omit `records` entirely rather than publish a decomposition the aggregates do not support.
Where a runtime does not report which model performed a group's work, the producer shall omit `model` rather than substitute a placeholder, because a placeholder selects a rate as confidently as a real identifier would.
Where `requests` is `1`, a context-length pricing tier shall be determinable from that record's own tokens; where it is greater, it shall not be, because such tiers are selected per request and the record's counts are a sum; where it is absent, the request count is unreported.
Where token accounting is `'unavailable'`, the producer shall omit `records`, on the same grounds as [ENG-027](#eng-027)'s suppression of `breakdown`.

## Authentic Usage Accounting

### ENG-031

`DonePayload.usage` shall require only the independently observed finite non-negative integer `toolUses` count and shall optionally carry `tokens` and `cost` per [DR-014](../decisions/014-unified-token-usage-breakdown.md).
The public `DoneUsage` declaration shall not expose `tokenAvailability`, `inputTokens`, `outputTokens`, `totalCostUsd`, or `breakdown`; a synthesized terminal or a runtime with no authentic token source shall omit `tokens` rather than publish numeric placeholders.

Where `tokens` is present, `totals.input.total` shall include cache reads and cache writes, and `totals.output.total` shall include reasoning or thinking.
Every present total, detail, request count, priced-unit quantity, and cost amount shall be finite and non-negative; token and count fields shall additionally be safe integers.
An absent detail shall mean unreported and a present zero shall mean measured.
Input `uncached`, `cacheRead`, and `cacheWrite` details and output `visible` and `reasoning` details shall be exact subsets of their inclusive total; where a producer publishes every detail on a side, those details shall sum exactly to the total, and no producer shall clamp, estimate, or allocate an unexplained residual.

`tokens.coverage` shall be `'complete'` only where every model request causally owned by the current `run()` invocation, including descendant-agent work and excluding resumed history, is represented.
Where every published number is authentic but the runtime surface may omit invocation work, the producer shall use `'partial'`; where even that exact scope cannot be established, it shall omit `tokens`.

Where `tokens.records` is present, each record shall carry authentic inclusive input and output totals for one rate-card group, the records shall sum exactly to `tokens.totals` and every aggregate detail it publishes, and a missing model or provider shall remain absent rather than become a placeholder.
A present `requests` shall be a positive safe integer; `1` shall mean the record describes one model request, while a greater value shall mean per-request context tiers cannot be recovered from the aggregate.

Where a runtime reports cost, the producer shall preserve it as `{ amount, currency: 'USD', source }` without applying a Cligent price table.
`source` shall distinguish an `agent-estimate`, `provider-reported` value, or `account-estimate`, and no source shall be described as billed cost without such authority.
Cost and token accounting shall remain independent so a valid runtime cost may survive absent tokens and vice versa.
Separately priced non-token quantities shall be emitted as named `pricedUnits`, never folded into token totals.

Where an adapter reads a run-owned supplementary source, it shall cross-validate that source against the runtime's ordinary terminal counters, omit the supplementary token report on absence, read or parse failure, duplication, or mismatch, and remain inside every applicable protocol boundary.
The engine and built-in adapters shall preserve `toolUses` independently on all terminal statuses whether `tokens` and `cost` are present or absent.
