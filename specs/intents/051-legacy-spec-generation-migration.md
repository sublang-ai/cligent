<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-051: Legacy Spec Generation Migration

## Status

In progress.
Tasks 1 through 39 are done; tasks 40 through 53 remain.
The owner closed the two losses the map found: `META-15`'s concern returns as `meta-35` and `meta-36`, which every package from task 7 onward must satisfy and which the four already landed satisfy unchanged, while `META-26` is retired under the released-ID amendment its approval carried.
Task 6 found the parser conflict that task 50 now carries, and the superseded-item cluster task 51 now carries, and completion waits on both.
Task 7 landed `package` with `package-1`, `package-5`, `package-8`, and `package-9` unverified, a gap it inherited and handed to task 49's table.
Task 8 landed `claude-code` the same way, with `claude-code-1`, `claude-code-6`, and `claude-code-10` reaching no verification item, and left the cross-adapter file's engine halves for task 13.
Task 9 landed `codex` with `codex-1` and `codex-9` reaching none, emptied `specs/dev/`, and left the two remaining Codex-bodied criteria in `test/adapters.md` for the engine halves they still verify.
Task 10 landed `gemini` with `gemini-1` and `gemini-2` reaching none, consuming the whole `Gemini` section of `test/adapters.md` along with its three Gemini-only criteria elsewhere.
Task 11 landed `kimi` as the first adapter package whose every behavior a verification item reaches; later clause and execution audit found that reachability incomplete as coverage, and its partial and unrun gaps now have their own task-49 row.
Task 12 landed `opencode` with `opencode-1` and `opencode-4` reaching none, moving ten of its twenty-three criteria whole rather than restating them, and left `test/adapters.md` holding engine-verifying items alone.
Task 13 landed `engine` with `engine-7` and `engine-29` reaching none, deleted `test/adapters.md` and `test/engine.md`, moved the peer-SDK-floor clause to `package-201`, and restored `engine-219`, whose engine half task 12 had consumed because it lived in a body citation rather than a `Verifies:` line.
Its review found `engine-221` restating `codex-221` in Codex-internal vocabulary, and scoping that by concept rather than by the instance named found `engine-222` and `engine-223` doing the same to `opencode-222` and `codex-223`: task 13 had moved each dissolved criterion's adapter body into the engine package instead of writing the engine copy [DR-017](../decisions/017-spec-generation-migration.md) requires, so task 14's commit consolidates all three into one adapter-neutral `engine-221` covering [[meta-34](../meta.md#meta-34)] the `writablePaths` contract alone and retargets the two map rows.
The same review found `engine-219` reconstructed without the retry bound and sandbox self-skip its source carried, and without the gating its deleted section preamble supplied, leaving a five-adapter live-API item no reader could implement without hard-failing every credential-less host; task 14's commit states that gating inline [[meta-15](../meta.md#meta-15)].
Task 14 landed `tmux-play` as 184 items matching the map exactly, emptied `specs/user/` and `specs/test/`, and handed task 49 ten uncovered behaviors; two defects its move carried out of the legacy generation were resolved against the destination's law in the same commit, `tmux-play-152` citing peer behavior a verification item may not reach [[meta-20](../meta.md#meta-20)] and `tmux-play-116` deferring its Kimi harness discipline to a citation instead of stating it [[meta-15](../meta.md#meta-15)].
Task 14's own review then found `.github/workflows/ci.yml` still naming `TMUX-051` and `TTMUX-050`, the last legacy IDs quoted outside the records: the retarget sweep had asked only whether every current-form ID resolved, a question no legacy-form token can fail, so the invariant above now states the check in both directions.
The same both-directions sweep found [DR-004](../decisions/004-tmux-play-captain-architecture.md) pointing at the deleted `user/` directory in a link whose href task 14 had already retargeted, the stale name surviving in the visible text alone.
At that point only the six `META-*` citations task 28 carried, the two the `DR-017` index row names as history, and the legacy paths in the `specs/iterations/` records remained, each owned.
A further round found the residue that survives both directions until they expand shorthand: task 14 had rewritten only the leading element of eleven slash-separated ID lists, leaving continuations such as `/039` naming nothing, now expanded to whole IDs at every site.
It also found the deleted `Real-tmux` and `Real-glow` preambles had carried the self-skip discipline for eighteen acceptance items that stated none of their own, the same loss `engine-219` suffered, so each now states it inline [[meta-8](../meta.md#meta-8)], and `engine-219` regained the *external*-CLI wording whose absence let it contradict `codex-219` on whether an absent SDK may skip a leg.
That expansion then got seven IDs wrong by dropping the `+100` offset on continuations of a `TTMUX-` list, every one resolving to a live behavior item where a test item was meant, which is why the invariant above now checks a retargeted ID against the rename map rather than against the tree.
Restating those preambles had also kept only their harness half, leaving eighteen probes that named a runner and a skip condition but never required the real `tmux` or `glow` they exist to exercise, so each now states that mandate too, `meta-32` preferring real behavior where the preamble demanded it.
A fourth round then found the same expansion had never covered `..` ranges at all: eight survived half-converted, two of them descending and so impossible on their face, one in `src/` and therefore leaving this plan's own retarget invariant unmet rather than merely unverified.
Each round's instrument had improved while its scope stayed pinned to the separator its worked example named, so the invariant now states the property — no item ID adjacent to a bare number — instead of a pattern.
The same round found one legacy goal line had dropped eight of the ten items it claimed, a citation whose text named `TMUX-027/028` and `TMUX-035..042` while its href named one anchor, the lawful conversion keeping the href and silently discarding the rest.
That resize then over-reached: it made the package the atomic unit where only the item is one, which would have forced `tmux-play`'s entire 161-item top-level split workload into a single commit — more than half the workload the resize had just rejected — so the invariant now binds the split of one item and lets a package come into item law across commits.
The same round found task 15's whole output, two standing rules, resting in this plan alone, which [[meta-28](../meta.md#meta-28)] does not allow of a record whose deletion must lose nothing, so both now land in decision records.
A last round settled three findings against the item-law task and resized it: it had grown to every package at once, 310 of 478 items carrying more than one top-level `shall`, which meta-5 does not admit and which no staging rule bounded, so it is now the rule-settling task 15, eight one-commit package tasks 16 through 23, and bounded `tmux-play` slices in tasks 24 through 27.
Reviewing that plan-only commit found its one `tmux-play` task still spanning several commits, its package-wide staging sentence calling unsplit multi-requirement items lawful, and its section boundary able to separate a behavior branch from the assertion reaching it, so tasks 24 through 27 now own baseline item slices and retain per-item behavior-to-verification atomicity.
The same review found task 15 leaving framework law conditional despite both `DR-000` and `meta.md` being owner-gated, and found the retained map sections naming eighteen item IDs rather than sixteen once the two legacy `META-*` tokens are counted.
Task 15 landed the owner's approved shared-test-precondition law as [[meta-37](../meta.md#meta-37)] with its rationale in [DR-000](../decisions/000-spec-structure-format.md), made [DR-005](../decisions/005-per-adapter-permission-configuration.md) require every built-in adapter to exhaust the closed mode set, distinguished both policy-presence cases under `undefined`, and corrected Gemini's same-control auto and bypass rows; no package item changed.
Reviewing task 15's commit found its item census counting `shall`-bearing lines and then first paragraphs instead of normative `shall` tokens throughout top-level prose, so the corrected package and slice counts below replace that understated census.
Task 16 found no hidden behavior, cross-package restatement, or uncited peer dependency in `licensing` or `ndjson`, and no classification move in any of its four packages.
It removed `git-6`'s false assertion that a completed-commit audit can verify `git-1`'s preparation report and refusal, bound the release workflow to the clean package build and its publication controls, and split `RELEASE-008` between provenance in `release-8` and OIDC authentication in `release-13`.
The new decision-map row keeps that released concern traceable, while the locator summaries in `specs/map.md` remain accurate without an edit.
Reviewing the intervening tmux-play runtime fix found its code and focused check sound and task 16 unchanged, but found its result-less-`done` `finalText` boundary absent from the package; `tmux-play-59` and `tmux-play-73` now settle that drift without changing a released concern or the map locator, with the unrun Captain and already-newline cases handed to task 49.
Task 17 and its review split `package` into one-requirement items `package-17` through `package-34`, classified its type-test mandate as Internal Behavior, and made the dependency, build, documentation, conformance, descriptor, and installed-package verification flows name every resulting branch.
It dropped runtime-range enforcement to `engine-26`, missing-runtime reporting to `tmux-play-10` and `tmux-play-89`, and the now-wholly-redundant `package-106` to `tmux-play-201`, with every released concern's destination recorded in [DR-017](../decisions/017-spec-generation-migration.md).
The assertions no current check executes remain explicit in task 49, while the `package` locator in `specs/map.md` remains accurate without an edit.
Reviewing task 17 corrected its install-layout fixture, declaration-compilation trigger, verification-gap handoff, source-reference residue, and topic boundary; the declaration split adds `package-34`, and the result-less-`done` rule now covers captured deltas followed by a complete message.
The same review found [[package-16](../packages/package.md#package-16)] false of Claude's descriptor and runtime reader: SDK-domain compatibility versions are paired with a separately versioned, non-dependency `@anthropic-ai/claude-code` package name, so task 52 now carries the required design settlement ahead of handover.
Task 18 split Claude's loading, normalization, permission, option, resume, and accounting requirements into behavior items `claude-code-13` through `claude-code-34`, `claude-code-42`, `claude-code-46`, `claude-code-48`, `claude-code-50`, and `claude-code-51`, classified the repair signature, session-identifier selector, and query-environment rule as Internal Behavior, and added verification items `claude-code-35` through `claude-code-41`, `claude-code-43` through `claude-code-45`, `claude-code-47`, and `claude-code-49` for the assertions and independent triggers the split exposed.
It made the [DR-005](../decisions/005-per-adapter-permission-configuration.md) mode matrix exhaustive, stated native message, query-failure, cancellation, tool, resume, no-result, environment, and accounting outcomes the artifact already produced, dropped effort rejection and record-sum restatements to their engine owners, and recorded every remaining unrun assertion in task 49 while keeping the `claude-code` locator in `specs/map.md` exact.
Its final audit found the caller abort listener can outlive an unsupported-effort rejection because the mapper installs it before effort validation and `run()` acquires the returned cleanup only afterward; [[claude-code-33](../packages/adapters/claude-code.md#claude-code-33)] therefore remains intentionally true as the required lifecycle, with the artifact contradiction assigned to task 31 ahead of verification closure.
Task 19 split Codex SDK loading, canonical and compatibility normalization, terminal outcomes, permissions, resumption, session and runtime-model identity, usage validity, working-directory and trust mapping, executable resolution, and setup cleanup into `codex-8`, `codex-18` through `codex-40`, `codex-53`, and `codex-54`, and added verification items `codex-41` through `codex-52` for the assertions and independent triggers the split exposed.
It made Codex's [DR-005](../decisions/005-per-adapter-permission-configuration.md) mode matrix exhaustive, classified session identity, runtime-model identity, usage validity, working-directory, writable-path delivery, trust, executable resolution, and setup cleanup as Internal Behavior, dropped upstream effort rejection, same-resume serialization, and record-sum restatements to their engine owners, retargeted the released-concern map and source references, and recorded every remaining unrun assertion in task 49 while keeping the `codex` locator in `specs/map.md` exact without an edit.
Its artifact audit found [[codex-21](../packages/adapters/codex.md#codex-21)] false for both the legacy `status: 'failed'` alias, which the compatibility normalizer currently reports as success, and a top-level result whose array-valued `content` is treated only as nested blocks and therefore emits no tool result; task 32 owns both repairs without weakening the released concern.
The same audit found [[codex-6](../packages/adapters/codex.md#codex-6)] false when a non-aborted stream exhausts or throws after reporting a backend identifier, because those synthetic error terminals omit it; task 33 owns that separate continuity repair ahead of verification closure.
Task 20 split Gemini invocation, normalization, permission, option, accounting, cancellation, continuity, and lifecycle behavior into `gemini-18` through `gemini-44`, leaving 44 behavior items and 16 verification items.
It made Gemini's [DR-005](../decisions/005-per-adapter-permission-configuration.md) mode matrix exhaustive, corrected init tool selection for capability-derived allows, classified settings, cleanup, telemetry validation, reconciliation, capture, session identity, and process containment as Internal Behavior, dropped the upstream-effort-rejection restatement to [[engine-226](../packages/engine.md#engine-226)], and retargeted every released concern and moved citation.
Its artifact audit found [[gemini-9](../packages/adapters/gemini.md#gemini-9)] false when a synthetic error follows a backend identifier, [[gemini-8](../packages/adapters/gemini.md#gemini-8)] false when abort follows a parsed native result but precedes child close, and [[gemini-44](../packages/adapters/gemini.md#gemini-44)] false when a child exposes no stdout and temporary-resource cleanup starts without awaiting its close.
Review also found [[gemini-5](../packages/adapters/gemini.md#gemini-5)] and [[gemini-8](../packages/adapters/gemini.md#gemini-8)] false when an interrupted close carries non-empty stderr, because the close branch publishes that diagnostic as a result; task 34 owns the cohesive terminal-state and containment repair, while every remaining unrun assertion is explicit in task 49 and the `gemini` locator in `specs/map.md` remains exact without an edit.
Task 21 split Kimi's probing, ACP lifecycle, normalization, permissions, options, cancellation, continuity, and accounting into behavior items `kimi-14` through `kimi-31`, added `kimi-32` for the independently checked future-usage gate, classified the protocol dependency, wire boundary, event identity, and process containment as Internal Behavior, and made the [DR-005](../decisions/005-per-adapter-permission-configuration.md) mode matrix exhaustive.
It dropped generic effort-vocabulary and per-run-state restatements to [[engine-20](../packages/engine.md#engine-20)] and [[engine-18](../packages/engine.md#engine-18)], dropped upstream effort rejection to [[engine-226](../packages/engine.md#engine-226)], restored every released verification branch, retargeted the concern map and moved references, and corrected task 49's Kimi handoff by walking from every existing assertion back to the clauses it proves.
Its artifact audit found [[kimi-11](../packages/adapters/kimi.md#kimi-11)] false on active abort because the implementation awaits child shutdown before emitting interrupted `done`, found no complete precedence across preflight rejection, caller abort, native stop, authentication, protocol, process, and cleanup outcomes, and found teardown repeating its complete signal sequence when a child survives final grace; task 35 owns that settlement and the resulting [[kimi-29](../packages/adapters/kimi.md#kimi-29)] and [[kimi-25](../packages/adapters/kimi.md#kimi-25)] contradictions, while the Kimi locator in `specs/map.md` remains exact without an edit.
The same audit found same-session updates can normalize during configuration before `init`, so task 36 restores [[kimi-16](../packages/adapters/kimi.md#kimi-16)]'s released init-first order and [[kimi-30](../packages/adapters/kimi.md#kimi-30)]'s concern-preserving queue before verification closure.
Review corrected the init capability member paths, expressed the ten remaining compound requirements as single operation or verification matrices, assigned the local future-usage verifier the lowest free `kimi-32`, removed task 51's stale example, and added [[kimi-15](../packages/adapters/kimi.md#kimi-15)]'s unasserted legacy-SDK exclusion to task 49.
A following review removed envelope-level `sessionId` from [[kimi-17](../packages/adapters/kimi.md#kimi-17)]'s payload matrix, mapped `KIMI-004`'s released event-identity clause to [[kimi-26](../packages/adapters/kimi.md#kimi-26)], and bound its executing assertion there.
Task 22 split OpenCode runtime probing, normalization, permissions, options, session lifecycle, liveness, and authentic accounting into behavior items `opencode-22` through `opencode-51`, and added `opencode-52` through `opencode-55` for option delivery, server lifecycle, the real inactivity flow, and the real permission flow.
It made the [DR-005](../decisions/005-per-adapter-permission-configuration.md) mode matrix exhaustive, classified permission delivery, descendant discovery, resource ownership, prompt-boundary, and causal-accounting mechanics as Internal Behavior, dropped upstream effort rejection to [[engine-226](../packages/engine.md#engine-226)], retargeted every released concern and moved citation, and recorded every remaining unrun assertion in task 49 while keeping the OpenCode locator in `specs/map.md` exact without an edit.
Its artifact audit initially found [[opencode-44](../packages/adapters/opencode.md#opencode-44)] false because the maintained v2 wrapper omitted `steps` from fresh and resumed prompt requests; task 37's review instead established that the pinned runtime exposes no exact per-run turn-limit control, so the owner settled explicit `maxTurns` as fail-closed rejection.
It also found [[opencode-9](../packages/adapters/opencode.md#opencode-9)] false because SDK loading precedes caller-listener installation and managed readiness neither receives nor races the run-owned abort signal, so task 38 restores preflight and readiness cancellation; found [[opencode-35](../packages/adapters/opencode.md#opencode-35)] false because completed permission-response keys accumulate for the run's lifetime, so task 39 bounds and releases that correlation state; and found [[opencode-10](../packages/adapters/opencode.md#opencode-10)] false before readiness because that exit is normalized as a generic stream failure, so task 40 restores the released managed-crash outcome.
Review restored [[opencode-47](../packages/adapters/opencode.md#opencode-47)]'s released causal-parent and task-child propagation, separated resumed wrapper discovery in [[opencode-34](../packages/adapters/opencode.md#opencode-34)] from every-run adapter ownership in new [[opencode-56](../packages/adapters/opencode.md#opencode-56)], returned [[opencode-37](../packages/adapters/opencode.md#opencode-37)]'s consumer-visible active-wait guarantees to External Behavior, and corrected task 49's init, startup, and lifecycle coverage debt.
A following review bound [[opencode-6](../packages/adapters/opencode.md#opencode-6)]'s descendant permission and lifecycle clauses to their distinct owners and added [[opencode-237](../packages/adapters/opencode.md#opencode-237)]'s unexecuted identifier-less lineage-entry tolerance to task 49.
Task 23 split `engine`'s live requirements into one-requirement behavior and verification items, allocating `engine-33` through `engine-73`, retargeting every released concern and moved citation, and recording each remaining unrun assertion in task 49; the `engine` locator in `specs/map.md` remains accurate without an edit.
Its artifact audit found [[engine-14](../packages/engine.md#engine-14)] false for a parallel task whose `CligentOptions.role` is omitted, [[engine-25](../packages/engine.md#engine-25)] and [[engine-26](../packages/engine.md#engine-26)] false for CLI diagnostics and readiness because they retain no resolved executable path, and [[engine-219](../packages/engine.md#engine-219)] false because local dependency skips report no reason; tasks 41 through 43 own those repairs ahead of verification closure.
Review restored [[engine-40](../packages/engine.md#engine-40)]'s renderable Kimi vocabulary and [[engine-49](../packages/engine.md#engine-49)] through [[engine-50](../packages/engine.md#engine-50)]'s released helper names, stated synthesized-error resume clearing in [[engine-8](../packages/engine.md#engine-8)] and [[engine-12](../packages/engine.md#engine-12)], and corrected task 49's exact policy and continuity handoff.
Task 24 made the first forty-five baseline `tmux-play` behavior items lawful as one operation or case matrix, split existing-home migration into [[tmux-play-90](../packages/tmux-play.md#tmux-play-90)], the shared `CaptainContext` admission boundary into [[tmux-play-91](../packages/tmux-play.md#tmux-play-91)], exported effort correlation into [[tmux-play-95](../packages/tmux-play.md#tmux-play-95)], non-layout visibility handling into [[tmux-play-98](../packages/tmux-play.md#tmux-play-98)], and reply runtime behavior into [[tmux-play-97](../packages/tmux-play.md#tmux-play-97)], retargeted their released concerns and references, and added [[tmux-play-161](../packages/tmux-play.md#tmux-play-161)]'s missing no-config diagnostics assertion.
Its bidirectional assertion audit corrected task 49's handoff rather than inferring coverage from citations, while the `tmux-play` locator in `specs/map.md` now binds the reply surface to its signature, runtime, and presentation owners.
The artifact audit found the released ordinary CLI-mode triggers overlapping diagnostics mode, released observer fanout failing after an observer rejection, and released config-order pane placement disagreeing with explicit startup-visible order; tasks 44 through 46 own those independent settlements ahead of verification closure.
Task 25 made the remaining forty-five task-14 baseline `tmux-play` External Behavior items lawful as one operation or case matrix, while preserving the already-superseded items for task 51.
It split run-result continuity into [[tmux-play-99](../packages/tmux-play.md#tmux-play-99)], snapshot consumption into [[tmux-play-100](../packages/tmux-play.md#tmux-play-100)], the minimum tmux gate into [[tmux-play-172](../packages/tmux-play.md#tmux-play-172)], flavor resolution into [[tmux-play-194](../packages/tmux-play.md#tmux-play-194)], flavor-aware adapter accents into [[tmux-play-195](../packages/tmux-play.md#tmux-play-195)], pane-border presentation into [[tmux-play-199](../packages/tmux-play.md#tmux-play-199)], and title round-trip diagnostics into [[tmux-play-189](../packages/tmux-play.md#tmux-play-189)].
It moved the remaining prompt-styling, hidden-call presentation and follow, and public-export clauses to their existing owners, retargeted the concern map and references, made Boss prompt styling follow the resolved flavor the artifact already applies, and corrected task 49's exact handoff.
Its artifact audit found [[tmux-play-69](../packages/tmux-play.md#tmux-play-69)] false across rapid writes: the follow observer records a live-pane no-op in its 250-millisecond throttle, so a pane scrolled before the next visible write can remain hidden from that write; task 47 owns the focused repair ahead of verification closure.
Task 26 made every live baseline `tmux-play` verification item from 101 through 150 lawful as one execution flow or explicit case matrix, while preserving superseded [[tmux-play-137](../packages/tmux-play.md#tmux-play-137)] for task 51.
It centralized the real-tmux and real-`glow` acceptance conditions in [[tmux-play-130](../packages/tmux-play.md#tmux-play-130)] and [[tmux-play-150](../packages/tmux-play.md#tmux-play-150)], split the independent minimum-version and adapter-accent assertions into [[tmux-play-200](../packages/tmux-play.md#tmux-play-200)] and [[tmux-play-202](../packages/tmux-play.md#tmux-play-202)], retargeted their released concerns and source references, and corrected task 49's bidirectional coverage handoff.
Its audit found [[tmux-play-116](../packages/tmux-play.md#tmux-play-116)]'s released two-retry allowance false of the acceptance harness, which stops after two attempts rather than making the required third attempt; task 48 carries that verification repair with deterministic retry and exhaustion assertions.
Task 27 made every remaining live task-14 baseline `tmux-play` verification item lawful as one execution flow or explicit case matrix, while preserving retired [[tmux-play-166](../packages/tmux-play.md#tmux-play-166)] and [[tmux-play-167](../packages/tmux-play.md#tmux-play-167)] for task 51.
It centralized the remaining repeated real-tmux acceptance conditions in [[tmux-play-130](../packages/tmux-play.md#tmux-play-130)], dropped left-click setup and delivered-ESC restatements to [[tmux-play-162](../packages/tmux-play.md#tmux-play-162)] and [[tmux-play-159](../packages/tmux-play.md#tmux-play-159)], and split the independent package-export flow from [[tmux-play-196](../packages/tmux-play.md#tmux-play-196)] into [[tmux-play-203](../packages/tmux-play.md#tmux-play-203)].
The released-concern map and historical reference follow those moves.
The reverse audit restores `SIGHUP` to [[tmux-play-77](../packages/tmux-play.md#tmux-play-77)]'s cancellation set, makes [[tmux-play-173](../packages/tmux-play.md#tmux-play-173)]'s no-`TMUX` no-op exact, records every newly visible coverage gap in task 49, including [[tmux-play-75](../packages/tmux-play.md#tmux-play-75)]'s idle-empty and non-TTY prompt branches, and leaves the `tmux-play` locator in `specs/map.md` accurate without an edit.
Task 28 moved all 50 legacy records into `specs/intents/`, preserved their status and checkbox state, normalized their required sections and sentence layout, repaired the decision and meta citations, and removed `specs/iterations/` while keeping the temporary intent index accurate for task 30.
Task 29 moved the remaining design rationale and unresolved provisioning questions into their owning decisions, removed every cross-record intent mention and the temporary intent index, and converted both legacy decision footnote sets to numbered external references.
Task 30 rebuilt `specs/map.md` as one concise decision table and one concise package table with no intent-record index or item IDs; the guidance audit found the tracked repository guidance already describes the current layout.
Task 31 validates Claude effort before acquiring caller abort-listener state and adds a live-signal rejection assertion, closing the pre-query leak without invoking the SDK query and narrowing task 49's remaining lifecycle handoff to cleanup after successful option mapping.
Task 32 makes only the compatibility normalizer honor case-insensitive `failed` and preserve a top-level result alias's array-valued `content` as selected result output while still emitting its recognized blocks as ordered content events, adds integration assertions for all four named statuses and array output, and narrows task 49's remaining Codex handoff without changing canonical lifecycle mapping.
Task 33 routes both non-aborted synthetic error terminals through [[codex-6](../packages/adapters/codex.md#codex-6)]'s normal resume selector, preserves the latest backend thread identifier without echoing an inbound resume when none arrives from the backend, adds exhaustion and iterator-failure assertions for both identity states, and narrows task 49's remaining Codex continuity handoff.
Task 34 makes caller abort outrank any buffered native result before terminal selection, routes non-aborted synthetic failures through [[gemini-9](../packages/adapters/gemini.md#gemini-9)]'s normal resume selector, removes stderr-derived results from interrupted closes, installs close observation immediately after spawn, and adds focused identity, precedence, stderr-omission, and teardown-order assertions while narrowing task 49's remaining Gemini handoff.
Task 35 records the owner's caller-abort-first causal precedence in [DR-011](../decisions/011-kimi-code-acp-integration.md), adds [[kimi-33](../packages/adapters/kimi.md#kimi-33)]'s complete selector and [[kimi-34](../packages/adapters/kimi.md#kimi-34)]'s close matrix, retains abort observation until another cause commits, queues interrupted `done` before abort teardown while bounding stalled delivery to one event-loop handoff, and makes cleanup one idempotent sequence whose later failure follows [[kimi-35](../packages/adapters/kimi.md#kimi-35)]'s defined and independently checked reporter contract without replacing that terminal.
Task 36 retains valid same-session updates received during model, thinking, or mode configuration until after `init`, flushes them in arrival order through [[kimi-5](../packages/adapters/kimi.md#kimi-5)]'s ordinary normalization, measures tool duration between the original first and terminal update observations, keeps pre-prompt permission requests on [[kimi-27](../packages/adapters/kimi.md#kimi-27)]'s failure path, and adds the exact integration flow that closes task 49's init-first handoff.
Task 37 records the owner's fail-closed OpenCode turn-limit choice in [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md), removes inert legacy and v2 prompt `steps` data, rejects explicit `maxTurns` including zero before SDK loading or backend work, preserves omitted limits without turn-limit request data, and narrows task 49's remaining OpenCode option handoff.
Task 38 establishes caller cancellation before OpenCode SDK loading, preempts pending SDK and managed-readiness waits through one run-owned signal, prevents later child/client/session/prompt work after abort, preserves interrupted-terminal-before-child-signal order with bounded escalation, and narrows task 49's remaining OpenCode lifecycle handoff.
Task 39 retains each OpenCode permission request's denial correlation through an accepted reply or exact reply-time disappearance until matching native confirmation, consults the provider's pending registry to suppress both pre-confirmation repeats and post-confirmation stale replays while admitting a genuinely pending later lifecycle, gives registry lookup and reply one shared five-second provider-operation budget and permission-specific failure path without charging downstream suspension, gives an already-settled operation precedence at the budget boundary, retains zero completed-response tombstones, releases failed, timed-out, aborted, and terminal request and wait state, and adds a high-volume sequence with 257 distinct completed requests that closes task 49's bounded-correlation handoff.
All five approval questions in [DR-017](../decisions/017-spec-generation-migration.md) are answered, so task 2's respelling stands and the tasks below may move the released IDs their work collides on.

## Intent

Migrate the whole specs tree from the legacy generation — `user/` + `dev/` + `test/` item files, `iterations/` records, uppercase `<PACK>-<N>` IDs, and `Verifies:` metadata lines — to the current generation that `spex scaffold --update` reinstated in [`meta.md`](../meta.md) and [DR-000](../decisions/000-spec-structure-format.md).
Measured when this plan was written, the tree held 402 items across 18 legacy item files and 51 legacy records, and `spex lint` reported 1110 errors and 105 warnings against the current law, so the work is decomposed below rather than attempted at once.
Later tasks shrink those counts; they are this plan's baseline, not a live measurement.
Every stated behavior, local extension, record state, and item concern in the project's own spec body survives the move; nothing is invented or dropped.
The framework law is not part of that body — the refresh replaced it wholesale — so the map records which of its released items reached no successor rather than hiding the loss.

These invariants govern every task:

- Each commit leaves every citation resolving: the inbound citations across `specs/` and the item IDs quoted in `src/`, `scripts/`, and `.github/workflows/` are retargeted in the same commit that moves their package.
  That retarget is checked in both directions, because either direction alone passes over the residue the other catches: forward, that every current-form ID and path resolves, and backward, that no legacy-form ID or path survives anywhere the migration reaches.
  A forward-only sweep cannot match `TMUX-051` at all, and a link whose href already resolves hides stale visible text such as `[user/tmux-play.md](../packages/tmux-play.md)`, so each reports clean a file that still carries the legacy name.
  The backward pattern is anchored on the legacy name alone, never on a prefix the text may omit.
  Both directions expand every element a reader could follow before resolving it, and the property checked is that no item ID anywhere in the tree is adjacent to a bare number, whatever punctuation joins them — `/`, `..`, a comma, or a separator nobody has written yet.
  Naming one separator is what let each earlier round pass: a check built for `TMUX-038/039/049` cannot see `TTMUX-030..036`, and the worked example, not the rule, is what the implementation kept following.
  Each expanded or retargeted ID is then checked against the rename map rather than against the tree, the question being whether it names what the legacy token named and not whether it names anything: expanding `TTMUX-039` by dropping its padding yields `tmux-play-39`, a live behavior item, where the map gives `tmux-play-139`, the test item meant.
  A legacy citation whose text named more IDs than its anchor keeps every one of them, because converting it to the lawful form preserves the href and silently drops whatever the text carried beyond it, and every link check then reports clean.
- Each task's citation figure counts inbound citations from other files, a package's own internal citations moving with it.
- A destination package lands complete in one commit — `Intent`, `External Behavior`, optional `Internal Behavior`, `Verification`, in that order [[meta-30](../meta.md#meta-30)] — because a package without `Verification` is unlawful and cannot be staged across commits.
- One item's split lands whole in one commit — every branch, the assertion reaching each [[meta-33](../meta.md#meta-33)], the citation naming it [[meta-20](../meta.md#meta-20)], and the rename-map rows it changes — because a branch that arrives without its assertion is unlawful at the commit boundary.
  An unsplit multi-requirement item remains explicit migration debt under the tasks below rather than becoming lawful merely because the port left it that way.
  A package therefore comes into item law across as many commits as its size needs, each leaving every item it splits lawful and every new behavior branch verified; the move invariant above does not generalize because [[meta-30](../meta.md#meta-30)] makes a package with no `Verification` section unlawful while item law answers to no whole-file fact.
  The item ranges below are ownership slices over the 184-item task-14 baseline: every new branch belongs to its originating baseline item's task, and where splitting a behavior makes a reaching verification item's own split necessary, that verifier lands whole with the behavior while its later range task skips the already-lawful result.
- A legacy test file survives until its last item reaches a lawful home: a test item's behavior citations stay inside its own package [[meta-20](../meta.md#meta-20)], so a clause verifying a peer's behavior waits for that peer's task.
- A task that changes where a released concern lives — splitting an item [[meta-29](../meta.md#meta-29)], dropping a restatement another package already owns [[meta-34](../meta.md#meta-34)], or moving a clause — records the added, removed, or retargeted row in the same commit, so the map never lags the tree.
- A released item found false of the artifact it describes moves unchanged, because a move settles where a requirement lives and never what it says; its contradiction becomes a task of its own ahead of the handover, closed by conforming the artifact to the item or by a decision record [[meta-24](../meta.md#meta-24)] carrying the decision that amends the item, and this plan stays incomplete until every such task closes.
- Every citation the tree carries is rewritten as it moves: 1249 item citations still use the legacy unbracketed `[ID](path#anchor)` form rather than the outer-bracketed form the current law requires [[meta-16](../meta.md#meta-16)].
- A task that restates a shared criterion into a package checks that restatement in both directions before it commits, clause by clause: no clause of the legacy criterion naming that package is left without a destination, and no clause of the destination is without a legacy source.
  The behavior sections move whole and a normalized diff proves them, but a restatement is not a move and no diff can check it, so this is the only guard the verification slice has.
  The commit states the pairing the task made and whatever it found unmatched in each direction, because this check is not recomputable the way the diff is: which clauses name the package is the very judgment it exists to make, so an unreported run leaves a claim no reviewer can tell apart from a mis-scoped one.
- Text a task moves whole is normalized to one sentence per line as it lands [[meta-25](../meta.md#meta-25)], the legacy files being hard-wrapped so a moved line often carries a second sentence's start.
  Moving whole is otherwise the safer transformation, because a diff proves it and no restatement can be proved that way, and this is the cost it carries: it inherits the source file's line discipline along with its prose.
  A pass that skips a line opening with a citation, or that runs over the behavior sections alone, misses exactly the lines the legacy verification files are densest in, and `spex lint` has no rule that would catch what it left.
  Moved text is resolved against the destination's structure as well as its line breaks, because a cross-reference shaped as an ID travels while one shaped as prose does not: a phrase naming the source file's own structure — a gating preamble, a rule stated above — keeps pointing at what stayed behind, and no ID sweep, diff, or lint rule sees it.
- A check this plan requires is scoped by the concept it hunts, never by an enumeration of the literals already seen, that enumeration being what three of these checks each had to be rewritten past: a supersession scope reading the literal `Superseded by` missed the notes worded `is superseded by`, a fidelity pass comparing backticked tokens missed the plain word `different`, and a sweep for a dangling structural reference listed known phrasings and missed `as the existing OpenCode real-run acceptance`.
  Each was found by a reader, not by the check, and each cost a round, so a check whose scope is a list of examples has not yet been written.

The destination packages, the `+100` and `+200` ID blocks, the dropped zero padding, and the scope boundary are recorded as the migration contract in [DR-017](../decisions/017-spec-generation-migration.md).

## Deliverables

- [x] A decision record fixes the destination package set, the ID scheme, the disposition of the cross-adapter test file, and what the migration leaves alone.
- [x] `specs/packages/` holds one lawful package per subject, and `specs/user/`, `specs/dev/`, and `specs/test/` are gone.
- [x] `specs/intents/` holds every intent record with its status and checkbox state intact, and `specs/iterations/` is gone.
- [ ] Every item states one GEARS requirement [[meta-29](../meta.md#meta-29)] under the current section order, with peer relationships and verification evidence carried only by inline citations [[meta-14](../meta.md#meta-14)], [[meta-16](../meta.md#meta-16)], [[meta-20](../meta.md#meta-20)], and no `Verifies:` line survives.
- [x] `specs/map.md` indexes decisions and packages in the current shape and names no intent record [[meta-18](../meta.md#meta-18)].
- [ ] Comments, test names, and CI annotations quote current item IDs, while released `CHANGELOG.md` history stays byte-for-byte.
- [ ] `spex lint` reports no error and no warning.
- [ ] The per-item rename map built into the decision record in task 4 and reconciled in task 53, every classification and split judgment, and every open question reach a human diff review.

## Tasks
1. **Record the migration contract.**
   Add `specs/decisions/017-spec-generation-migration.md` as `Proposed`, fixing the destination package set, the `+100` and `+200` ID blocks and the dropped zero padding, the dissolution of the cross-adapter test file into per-package verification, `tmux-play` remaining one package, and the exemption of released changelog history from the rename.
   Record the three owner-approval questions it turns on — respelling the item IDs that public releases carried, duplicating a shared adapter criterion into each adapter package rather than introducing a shared adapter-contract package, and renumbering the IDs where a merge or relocation collides [[meta-12](../meta.md#meta-12)] — the second scoping the third.
   No file moves in this task.

2. **Fold `git` and `licensing` onto their scaffold seeds.**
   Reconcile `dev/git.md` into `packages/git.md` and `dev/licensing.md` plus `test/licensing.md` into `packages/licensing.md`, keeping every project-local exclusion, example, and trailer rule the seeds do not already state.
   Reconcile the duplicated SPDX-header record into the canonical record with this project's true checkbox state, then delete the legacy trio and the duplicate and retarget their 8 inbound citations.

3. **Settle the approval gates.**
   Put the three questions of [DR-017](../decisions/017-spec-generation-migration.md) to the owner before any further item moves, taking the shape question before the renumbering one it scopes, and record each answer.
   Since the answers let the migration go on, amend the released-ID clause of [`meta.md`](../meta.md) as the renumbering answer requires, rewrite that record's Decision and Consequences and the index summary to the shape chosen, and set it to `Accepted` once its text states that combination.

4. **Build the complete rename map.**
   Enumerate every one of the 402 baseline items with the destination the settled gates give it, one row per branch where a clause splits, and add the 24 released `META-<N>` items with whatever now carries each concern — an item, a decision record, or several between them — or an explicit no-successor row, checking each against the current law and the decision records rather than taking the scaffold's list as final.
   A row that finds no carrier is a loss of released law rather than a resolved mapping, so it closes only as [DR-017](../decisions/017-spec-generation-migration.md) allows: a carrier restored, which the row then points at, or the owner's approved amendment, which the row records as the retirement it admits.
   Record it in [DR-017](../decisions/017-spec-generation-migration.md), extending the family table there to per-item resolution, because the map outlives this plan as the only bridge from a released ID to where its concern went [[meta-28](../meta.md#meta-28)].
   The migration's own terms require the map before content moves, and the settled gates are what make it decidable.

5. **Resolve the two losses the map found.**
   Put `META-15`'s minimizing of project references and `META-26`'s observable-outcome drafting rule to the owner, each closing as [DR-017](../decisions/017-spec-generation-migration.md) requires: a carrier restored, or an approved amendment admitting the retirement.
   Restoring either writes law that every task below must then satisfy.
   Where a carrier is restored, re-check every package already migrated — `git`, `licensing`, `ndjson`, `release` — against it and redraft what it fails, in the commit that records the outcome.
   Carry each outcome into every place that states the loss: the map's framework table, that record's finding and its consequence, this plan's status, and the index summary.
   Leave this plan incomplete for as long as a row stays open.

6. **Migrate `ndjson` and `release`.**
   Create `packages/ndjson.md` and `packages/release.md`, moving the parser's verification out of `test/adapters.md` and deleting `user/ndjson.md` and `dev/release.md`.
   The release behaviors carry no legacy verification at all, so add verification items only where a real check exists today and leave the residual coverage gap [[meta-33](../meta.md#meta-33)] to task 49 instead of inventing tests here.
   Retarget the 5 inbound citations the parser package carries.

7. **Migrate `package`.**
   Merge `dev/package.md` and `test/package.md` into `packages/package.md` under the `+100` block, take the conformance-target clause of `test/adapters.md` under the `+200` block, and retarget its 28 inbound citations and the 16 ID references in `scripts/` and `src/`.
   Leave the clauses that verify Codex and tmux-play behavior in `test/package-parked.md`, renamed off the `package` basename the new file now holds [[meta-10](../meta.md#meta-10)], for tasks 9 and 14 to absorb.

8. **Migrate the Claude Code adapter package.**
   Merge `user/adapters/claude-code.md` with its slice of `test/adapters.md` into `packages/adapters/claude-code.md`, restating each item as one GEARS requirement and converting its `Verifies:` lines to inline citations at the verifying assertion.
   Strip the migrated claims from `test/adapters.md`, whose 14 criteria naming two or more adapters each fan out into every adapter they name, and retarget the 28 inbound citations and 7 code references.

9. **Migrate the Codex adapter package.**
   Merge `user/adapters/codex.md`, `dev/adapters/codex.md`, the Codex slice of `test/adapters.md`, and the Codex clauses parked in `test/package-parked.md` into `packages/adapters/codex.md`, classifying the delivery and executable-resolution items as `Internal Behavior`.
   Retarget the 39 inbound citations and 7 code references.

10. **Migrate the Gemini adapter package.**
    Merge `user/adapters/gemini.md` with its slice of `test/adapters.md` into `packages/adapters/gemini.md`, and retarget the 33 inbound citations.

11. **Migrate the Kimi adapter package.**
    Merge `user/adapters/kimi.md` with its slice of `test/adapters.md` into `packages/adapters/kimi.md`, and retarget the 35 inbound citations and 13 code references.

12. **Migrate the OpenCode adapter package.**
    Merge `user/adapters/opencode.md`, the largest behavior file, with its slice of `test/adapters.md` into `packages/adapters/opencode.md`, and retarget the 69 inbound citations and 6 code references.

13. **Migrate `engine`.**
    Merge `user/engine.md` and `test/engine.md` under the `+100` block with the cross-adapter tests that verify engine behavior, move the clause that verifies the peer-SDK floor into `packages/package.md`, and delete `test/adapters.md` once its last item has moved.
    Retarget the 91 inbound citations and 55 code references.

14. **Port `tmux-play` structurally.**
    Merge `user/tmux-play.md` and `test/tmux-play.md` under the `+100` block into `packages/tmux-play.md` with the lawful section order, faithful item text, renamed IDs, and all 93 `Verifies:` lines converted to inline citations.
    Move the clauses verifying adapter and engine behavior into those packages, absorb the last clauses parked in `test/package-parked.md`, delete both tmux-play files, the emptied `test/package-parked.md`, and the three emptied legacy directories, and retarget the 472 spec citations and 458 code references.

15. **Settle the item-law rules every package split applies.**
    Two decisions and one framework item constrain how every later split is written, so they land before any of them, and this task changes no package item.
    Neither rule may rest in this plan: its whole output is the two rules, and an intent record is disposable [[meta-28](../meta.md#meta-28)], so a rule the next author needs after this one is deleted belongs in a decision record [[meta-24](../meta.md#meta-24)].
    This task carries the first to the exhaustive mode-mapping contract in [DR-005](../decisions/005-per-adapter-permission-configuration.md), whose subject it is, and the second to the package-structure decision in [DR-000](../decisions/000-spec-structure-format.md) with its framework law in [[meta-37](../meta.md#meta-37)], both owner-gated files having the owner's approval for this phase.
    The twelve tasks below apply those durable sources directly rather than taking either rule from this plan.
    The adapter decision covers [[engine-21](../packages/engine.md#engine-21)]'s three mode rows and distinguishes a missing policy from a supplied policy whose mode is omitted in its `undefined` row.
    That rule found each instance by construction at this task's baseline, where every enumeration this plan attempted was wrong within a round: `claude-code-4` stated no `mode` row at all, no `gemini` item stated what `'auto'` and `'bypass'` map to though `gemini-6` stated that they take precedence, and no `opencode` item stated the `'bypass'` rejection its adapter raises before the run.
    At that baseline, `claude-code-4` stated a missing `permissions` field maps to `permissionMode: 'default'` with no `canUseTool` callback, `gemini-12` and `codex-4` stated their own absent-policy rules, and task 49's table already recorded that `codex-224` asserts none of `codex-4`'s three unset controls.
    The resulting audit is five packages against that decision's complete matrix, and the count is not a licence to check fewer.
    The shared-condition decision and [[meta-37](../meta.md#meta-37)] govern the real-artifact and harness conditions the eighteen acceptance items now carry among them.
    Eighteen copies across the real-`tmux` and real-`glow` conditions are already two rules with eighteen places to stay consistent, splitting multiplies them, and a copy that drifts is invisible to every check this plan runs.
    Applying item law to a package, in each of the twelve tasks below, means splitting its multi-requirement items into one requirement each [[meta-29](../meta.md#meta-29)], classifying behavior hidden from the package's users as `Internal Behavior` [[meta-30](../meta.md#meta-30)], dropping restatements another package already owns [[meta-34](../meta.md#meta-34)], binding every remaining uncited peer-package dependency at the phrase it makes specific [[meta-14](../meta.md#meta-14)], applying the exhaustive mode-mapping contract in [DR-005](../decisions/005-per-adapter-permission-configuration.md) to every built-in adapter permission mapper, and applying [[meta-37](../meta.md#meta-37)] to every shared test precondition.
    Where an item states a narrower outcome set than the artifact demonstrably produces, the task states the missing outcomes rather than records them, the package otherwise failing to be sufficient to reimplement its behavior [[meta-34](../meta.md#meta-34)]: that documents behavior another spec already mandates and the concern the released ID names is preserved [[meta-12](../meta.md#meta-12)], so it is not the invention the migration tasks forbid.
    Each split carries its verification with it: every branch takes the assertion reaching it and the citation naming it [[meta-20](../meta.md#meta-20)], [[meta-33](../meta.md#meta-33)]; before adding or changing a task-49 row, the task also walks every existing check assertion relevant to the split back to every behavior branch it actually proves and every verification assertion it executes, then records in the same commit a branch lacking a verification assertion under `Behavior no assertion reaches`, whether or not an incidental check exercises it, and a verification assertion no check proves under `Audit stated but unrun`.
    That row is the whole handoff: an assertion no check executes fails no suite and satisfies this plan's coverage criterion, so nothing but the row keeps it visible.
    None of the twelve moves a file, so each can be reviewed as pure item law.
    The counts below are the multi-`shall` items measured when this list was written, a sizing signal rather than a target: not every one splits.

16. **Apply item law to the four smallest packages.**
    `git`, `licensing`, and `ndjson` already state one requirement per item, so their work is classification, restatement, and citation; `release` joins them because its only split is `release-8`, and one commit holds all four.
    `release-8` is here, mandating its provenance attestation and its OIDC authentication independently, either able to fail while the other holds, and it would otherwise reach the handover unlawful because no other task applies item law.

17. **Apply item law to `package`.**
    Nine of its twenty-four items carry more than one `shall`.

18. **Apply item law to `claude-code`.**
    Twelve of its twenty-six items carry more than one `shall`, and `claude-code-4` is where the exhaustive mode-mapping contract in [DR-005](../decisions/005-per-adapter-permission-configuration.md) bites hardest, stating no `mode` row at all.

19. **Apply item law to `codex`.**
    Seventeen of its thirty-seven items carry more than one `shall`, and `codex-4`'s absent-policy rule is part of the complete matrix [DR-005](../decisions/005-per-adapter-permission-configuration.md) requires.

20. **Apply item law to `gemini`.**
    Eighteen of its thirty-four items carry more than one `shall`, and no `gemini` item yet states the `'auto'` and `'bypass'` rows [DR-005](../decisions/005-per-adapter-permission-configuration.md) requires.

21. **Apply item law to `kimi`.**
    Thirteen of its twenty-seven items carry more than one `shall`, including the permission mapper to which [DR-005](../decisions/005-per-adapter-permission-configuration.md)'s exhaustive contract applies.

22. **Apply item law to `opencode`.**
    Thirty-two of its forty-five items carry more than one `shall`, and no `opencode` item states the `'bypass'` rejection [DR-005](../decisions/005-per-adapter-permission-configuration.md) requires before the run.

23. **Apply item law to `engine`.**
    Forty-six of its sixty-eight items carry more than one `shall`.

24. **Apply item law to the first half of `tmux-play` External Behavior.**
    Split the first forty-five task-14 baseline behavior items in current document order, beginning with [[tmux-play-1](../packages/tmux-play.md#tmux-play-1)] and ending with [[tmux-play-29](../packages/tmux-play.md#tmux-play-29)], thirty-five of which carry more than one top-level `shall`.
    Every reaching verification assertion and citation and every changed rename-map row lands with its behavior branch; where carrying an assertion requires splitting its verifier, that verifier's whole split lands here.
    Where the legacy verification never reached a branch — [[tmux-play-61](../packages/tmux-play.md#tmux-play-61)]'s create-no-config case, which [[tmux-play-161](../packages/tmux-play.md#tmux-play-161)] omits and no test covers — this task writes the assertion and, in the same commit, adds the branch to task 49's table as an audit stated but unrun.

25. **Apply item law to the second half of `tmux-play` External Behavior.**
    Split the remaining forty-five task-14 baseline behavior items in current document order, beginning with [[tmux-play-30](../packages/tmux-play.md#tmux-play-30)] and ending with [[tmux-play-96](../packages/tmux-play.md#tmux-play-96)], forty-one of which carry more than one top-level `shall`.
    Every reaching verification assertion and citation and every changed rename-map row lands with its behavior branch; where carrying an assertion requires splitting its verifier, that verifier's whole split lands here.

26. **Apply item law to baseline `tmux-play` verification items 101 through 150.**
    Split each of those fifty task-14 baseline items that a behavior task has not already made lawful, forty-four carrying more than one top-level `shall`, with every branch retaining the behavior citation at its assertion and every changed rename-map row landing in the same commit.
    Keep the real-`tmux` condition in the behavior-verifying owner derived from [[tmux-play-130](../packages/tmux-play.md#tmux-play-130)] and add that owner as a destination of the twelve other source rows carried by [[tmux-play-131](../packages/tmux-play.md#tmux-play-131)] through [[tmux-play-137](../packages/tmux-play.md#tmux-play-137)], [[tmux-play-139](../packages/tmux-play.md#tmux-play-139)], and [[tmux-play-146](../packages/tmux-play.md#tmux-play-146)] through [[tmux-play-149](../packages/tmux-play.md#tmux-play-149)].
    Keep the real-`glow` condition in the behavior-verifying owner derived from [[tmux-play-150](../packages/tmux-play.md#tmux-play-150)] and add that owner as a destination of the six other source rows carried by [[tmux-play-147](../packages/tmux-play.md#tmux-play-147)], [[tmux-play-151](../packages/tmux-play.md#tmux-play-151)], [[tmux-play-192](../packages/tmux-play.md#tmux-play-192)], [[tmux-play-193](../packages/tmux-play.md#tmux-play-193)], [[tmux-play-196](../packages/tmux-play.md#tmux-play-196)], and [[tmux-play-197](../packages/tmux-play.md#tmux-play-197)].
    Every dependent item cites its corresponding owner per [[meta-37](../meta.md#meta-37)]; the source items above 150 take that citation now, keep their substantive destinations, and remain otherwise in their baseline state for task 27.
    IDs allocated by earlier item-law tasks are outside this baseline range and do not enlarge this task.

27. **Apply item law to baseline `tmux-play` verification items 151 through 201.**
    Split each of the forty-four extant task-14 baseline items in that range that a behavior task has not already made lawful, forty-one carrying more than one top-level `shall`, with every branch retaining the behavior citation at its assertion and every changed rename-map row landing in the same commit.
    IDs allocated by earlier item-law tasks are outside task 14's baseline set and do not enlarge this task, even when their numbers lie from 151 through 201.

28. **Move the records.**
    Move the 50 records left in `specs/iterations/` to `specs/intents/`, task 2 having retired the duplicate, rename `Goal` to `Intent` and both `Acceptance criteria` and `Acceptance` to `Verification`, supply the `Status` the two remaining records without one are missing, and order the sections per [[meta-5](../meta.md#meta-5)].
    Normalize all 69 decision-record citations in the moved records to the plain relative-file-link form [[meta-16](../meta.md#meta-16)] — linking the 7 previously bare semantic citations and dropping fragments from 18 of the 62 existing links — and retarget the six legacy `META-*` citations left on what the task-4 map settled for each concern.
    A concern with a carrier takes a citation pointing at it, while a concern whose retirement the owner approved keeps its still-true prose and loses the link, a claim the current law no longer makes being rewritten or removed — the `META-20` sentence about `Verifies:` lines among them.
    This task waits on that map rather than leaving a citation unresolved.

29. **Empty the records of design.**
    Move the design content the legacy records hold — their `Mechanism notes`, `Design decision`, and `Open questions` sections — into the decision records that own it, so deleting an intent record loses nothing [[meta-28](../meta.md#meta-28)].
    Remove every mention of an intent record from the other specs — the index, the one decision record that names one, and the intent records that cite each other [[meta-18](../meta.md#meta-18)].
    While the decision records are open, convert the two that carry `[^n]` footnotes to the numbered external-reference markers the current law requires [[meta-19](../meta.md#meta-19)].

30. **Rewrite the index and the guidance.**
    Rebuild `specs/map.md` in the current shape — layout block, decisions table, packages table — with no intent-record index [[meta-18](../meta.md#meta-18)], and refresh whatever repo guidance still describes the legacy layout.
    Each summary shall carry only what locates a file [[meta-23](../meta.md#meta-23)], the `tmux-play` cell being 691 words of a 3,147-word index against 88 for the next largest, a lossy copy of the package competing with the package for authority.
    The rebuilt index shall name no item ID: fourteen sit in that one cell and eighteen across the two sections the rebuild keeps — sixteen current-form IDs and the two legacy `META-*` tokens in the migration-decision summary — several naming items the item-law tasks split, after which the parenthetical describes a branch that no longer carries it while the ID still resolves and every check still passes.

31. **Close Claude abort-listener cleanup.**
    Task 18 found [[claude-code-33](../packages/adapters/claude-code.md#claude-code-33)] false when a live caller signal accompanies unsupported effort: the option mapper installs the abort listener before fallible effort validation, then throws before `run()` receives the cleanup callback and enters its `finally` block.
    Conform the artifact to the required per-run lifecycle without weakening effort rejection or invoking the SDK, and add an integration assertion that the rejected run leaves no caller listener behind; the code, check, and resulting task-49 handoff update land in this task's one commit.
    Leave this plan incomplete until it closes.

32. **Close Codex legacy tool-result normalization.**
    Task 19 found two contradictions in [[codex-21](../packages/adapters/codex.md#codex-21)]'s one compatibility normalizer: case-insensitive `status: 'failed'` is reported as success, and a top-level tool-result alias carrying array-valued `content` as its output is treated only as a container of nested blocks and therefore emits no tool result.
    Conform both artifact branches to the released requirement without changing canonical Codex lifecycle mapping, and add integration assertions for the failed/error/denied/success status rows and for top-level array-valued result content; the code, checks, and resulting task-49 handoff update land in this task's one commit.
    Leave this plan incomplete until it closes.

33. **Preserve Codex continuity on synthetic errors.**
    Task 19 found [[codex-6](../packages/adapters/codex.md#codex-6)] false when a non-aborted stream exhausts or its iterator throws after reporting a backend identifier: both synthetic error terminals omit `resumeToken`, although a native `turn.failed` and `turn.completed` already select it.
    Conform both synthetic paths to the shared normal-terminal selector without echoing an inbound resume value when no backend identifier arrived, and add focused integration assertions for backend-ID preservation on exhaustion and iterator failure plus the resumed no-backend omission; the code, checks, and resulting task-49 handoff update land in this task's one commit.
    Leave this plan incomplete until it closes.

34. **Close Gemini terminal continuity, abort precedence, and process containment.**
    Task 20 found [[gemini-9](../packages/adapters/gemini.md#gemini-9)] false when a non-aborted synthetic stream or child failure follows a backend identifier: the error terminal omits `resumeToken` instead of using the normal backend-ID selector.
    The same terminal state machine makes [[gemini-8](../packages/adapters/gemini.md#gemini-8)] false when abort sends `SIGTERM` after a native result is parsed but before child close, because the buffered native status wins over the released interrupted outcome.
    Its ordinary close branch also makes [[gemini-5](../packages/adapters/gemini.md#gemini-5)] and [[gemini-8](../packages/adapters/gemini.md#gemini-8)] false when an interrupted close has non-empty stderr, because it publishes that diagnostic as a result.
    Process containment also makes [[gemini-44](../packages/adapters/gemini.md#gemini-44)] false when a spawned child exposes no stdout: the run sends `SIGTERM` but has created no close observation to await before cleaning temporary resources.
    Conform synthetic non-abort terminals to the normal selector without echoing an inbound resume when no backend identifier arrived, give requested abort precedence over a buffered native result while preserving the backend/inbound/omit interrupted selector, omit the result from every interrupted terminal even when its close supplied stderr, and establish close observation before validating stdout so every spawned child is terminated and awaited before cleanup.
    Add focused integration assertions for backend-ID failure continuity, resumed no-backend omission, result-then-abort-before-close, interrupted close with non-empty stderr, and missing-stdout teardown ordering; the code, checks, and resulting task-49 handoff update land in this task's one commit.
    Leave this plan incomplete until it closes.

35. **Settle Kimi terminal precedence.**
    Task 21 found [[kimi-11](../packages/adapters/kimi.md#kimi-11)] false on an active-prompt abort: the adapter sends `session/cancel` and drains the prompt, but then awaits child shutdown before it emits the released interrupted terminal rather than emitting that terminal before termination.
    Terminal selection has no coherent complete priority today: runtime and option validation can beat an already-aborted signal; caller abort beats every valid native stop reason in [[kimi-6](../packages/adapters/kimi.md#kimi-6)] and every authentication, protocol, setup, prompt, or process failure in the execution catch; process failure beats `end_turn`, max-turn, and refusal after a prompt response; native `cancelled` suppresses the same close failure; and caller abort or native cancellation suppresses [[kimi-29](../packages/adapters/kimi.md#kimi-29)] and [[kimi-25](../packages/adapters/kimi.md#kimi-25)] when a child exits nonzero or requires forced cleanup.
    Discovering a required `SIGKILL` only after an already emitted interrupted terminal also means the released terminal-before-termination rule and unconditional cleanup-error rule cannot both stand without an explicit priority decision.
    Put the complete precedence relation to the owner, covering preflight validation, caller abort, every valid stop reason, authentication, protocol, setup and prompt failure, ordinary close, and `SIGTERM` / `SIGKILL` cleanup; record any necessary released-concern amendment in a decision, conform the adapter and package to that choice, and make teardown idempotent even when a child survives the final grace.
    Add a focused integration matrix pairing clean, nonzero, unexpected-signal, and force-killed closes with success, refusal, native cancellation, and caller abort, including terminal-versus-termination order and a child that ignores `SIGKILL`.
    The decision, code, checks, and resulting task-49 handoff update land in this task's one commit, and this plan remains incomplete until it closes.

36. **Preserve Kimi init-first update ordering.**
    Task 21 found [[kimi-16](../packages/adapters/kimi.md#kimi-16)] and [[kimi-30](../packages/adapters/kimi.md#kimi-30)] false when a valid same-session update arrives during model, thinking, or mode configuration: the session-update handler accepts it as soon as backend identity is known and can emit normalized traffic before `init`.
    Conform the artifact to the released init-first stream by retaining each valid pre-prompt update without exposing it until after `init`, preserving its order and ordinary normalization through [[kimi-5](../packages/adapters/kimi.md#kimi-5)], while permission requests outside the active prompt remain protocol failures under [[kimi-27](../packages/adapters/kimi.md#kimi-27)].
    Add an integration flow that emits text, tool, and plan updates during configuration and asserts one `init` precedes their exact ordered events; the code, check, and resulting task-49 handoff update land in this task's one commit.
    Leave this plan incomplete until it closes.

37. **Settle OpenCode turn-limit support.**
    Task 22 found [[opencode-44](../packages/adapters/opencode.md#opencode-44)] false on the maintained v2 SDK path because the adapter mapped `AgentOptions.maxTurns` to a wrapper `steps` member that only the legacy prompt body received.
    Review then established that OpenCode 1.18.13 accepts no prompt-level `steps` member and derives its ceiling only from persistent agent configuration, so either prompt placement is ineffective and mutating the agent would escape one run's scope.
    Put [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md)'s released OpenCode support claim to the owner, conform the decision, package, and adapter to the chosen fail-closed rejection without inventing a `maxBudgetUsd` control, and remove both inert prompt members.
    Add focused integration assertions for explicit zero and nonzero limits on fresh and resumed calls rejecting before SDK or backend work plus omitted-limit preservation on fresh and resumed legacy and v2 requests; the decision, code, checks, and resulting task-49 handoff update land in this task's one settlement commit.
    Leave this plan incomplete until it closes.

38. **Preempt OpenCode preflight and readiness on caller abort.**
    Task 22 found [[opencode-9](../packages/adapters/opencode.md#opencode-9)] false before the active SSE phase: `run()` awaits SDK loading before it installs the caller listener, and its managed readiness wait neither receives the run-owned abort signal nor races caller abort, so an already-aborted or newly aborted caller cannot preempt either wait.
    Establish run-owned cancellation before fallible SDK loading, make managed readiness observe that cancellation, and preserve the released interrupted-terminal-before-`SIGTERM` order without creating a client, session, or prompt after abort.
    Add focused integration assertions for an already-aborted caller, abort during a pending SDK load, and abort during a non-settling readiness wait, including caller-listener removal and bounded managed teardown; the code, checks, and resulting task-49 handoff update land in this task's one commit.
    Leave this plan incomplete until it closes.

39. **Bound OpenCode permission-correlation state.**
    Task 22 found [[opencode-35](../packages/adapters/opencode.md#opencode-35)] false on successful permission traffic: although the adapter releases the active request mapping after `permission.replied`, its `repliedPermissionRequests` tombstones grow for the run's lifetime with every distinct completed response.
    Conform permission tracking so [[opencode-20](../packages/adapters/opencode.md#opencode-20)]'s once-only response and denial correlation remain intact while active mappings and completed-response state are released or bounded independently of the number of completed permission events.
    Add a focused integration sequence with repeated and more-than-the-bound distinct completed requests, plus failed, timed-out, and aborted replies, asserting one native response per request and bounded retained correlation and wait-control state; the code, checks, and resulting task-49 handoff update land in this task's one commit.
    Leave this plan incomplete until it closes.

40. **Normalize OpenCode pre-readiness server exits.**
    Task 22 found [[opencode-10](../packages/adapters/opencode.md#opencode-10)] false when the managed child exits before readiness: `defaultWaitForServerReady()` rejects with a generic `Error`, and the outer run failure path consequently emits `OPENCODE_STREAM_ERROR` rather than the released `OPENCODE_SERVER_EXIT` diagnostic.
    Preserve caller-abort precedence while carrying child code and signal through readiness failure so an unexpected managed exit before or after readiness selects the same server-exit diagnostic, error terminal, and bounded [[opencode-36](../packages/adapters/opencode.md#opencode-36)] cleanup.
    Add a focused managed lifecycle check that closes the child before it announces a URL and asserts the exact error, terminal, and cleanup order; the code, check, and resulting task-49 handoff update land in this task's one commit.
    Leave this plan incomplete until it closes.

41. **Settle parallel role attribution.**
    Task 23 found [[engine-14](../packages/engine.md#engine-14)] false when a `Cligent.parallel()` task omits `CligentOptions.role`: [[engine-4](../packages/engine.md#engine-4)] makes that field optional, `Cligent.run()` omits the event member in that state, and `parallel()` delegates to that stream without supplying a role.
    Put the released guarantee to the owner, who either makes role identity a required, validated parallel-task input and conforms the artifact, or amends the concern so every parallel event carries backend identity while role remains conditional on configuration.
    The decision, package, types or runtime where required, focused parallel integration assertions for configured and omitted roles, and resulting task-49 handoff update land in this task's one commit.
    Leave this plan incomplete until it closes.

42. **Settle CLI runtime-path readiness.**
    Task 23 found [[engine-25](../packages/engine.md#engine-25)]'s below-floor diagnostic and [[engine-26](../packages/engine.md#engine-26)]'s readiness payload false for a CLI target: peer readiness can retain its resolved `node_modules` tree as `resolvedFrom`, but the CLI probe retains only the configured command and never resolves or reports the executable path it actually invoked.
    Put the identity contract to the owner, who either makes CLI probing resolve and carry the selected executable path, or amends the released concern and runtime-compatibility decision to name the stable identity a portable probe can guarantee without inventing resolution.
    The decision, package, readiness type and reader where required, diagnostics, and isolated integration assertions for peer and CLI targets land in this task's one commit, with the resulting task-49 handoff updated there.
    Leave this plan incomplete until it closes.

43. **Report local missing-dependency skips.**
    Task 23 found [[engine-219](../packages/engine.md#engine-219)] false when a local acceptance prerequisite is missing: `gatedIt()` selects the runner's skip primitive but neither the test name nor any output records which dependency caused the skip.
    Make every missing-dependency local skip expose its concrete reason while preserving sandbox and CI failure behavior, and add a focused assertion of that diagnostic rather than relying on visual runner output.
    The harness, check, package assertion, and resulting task-49 handoff update land in this task's one commit.
    Leave this plan incomplete until it closes.

44. **Settle tmux-play CLI mode precedence.**
    Task 24 found the released ordinary-mode triggers in [[tmux-play-2](../packages/tmux-play.md#tmux-play-2)], [[tmux-play-3](../packages/tmux-play.md#tmux-play-3)], and [[tmux-play-10](../packages/tmux-play.md#tmux-play-10)] overlapping [[tmux-play-61](../packages/tmux-play.md#tmux-play-61)]'s diagnostics mode: diagnostics without `--session` skips the ordinary launcher gate, tmux construction, and attach; diagnostics with `--session` rejects rather than dispatching session mode; and diagnostics with no config skips first-run creation.
    Put the complete CLI-mode partition and precedence to the owner, who either scopes the earlier released triggers through a decision record or conforms dispatch while preserving diagnostics' no-runtime, no-tmux, and no-config guarantees.
    The decision, package, CLI where required, focused integration assertions for ordinary launcher, session, diagnostics, and their invalid combination, and resulting task-49 handoff update land in this task's one commit.
    Leave this plan incomplete until it closes.

45. **Settle tmux-play observer-failure delivery.**
    Task 24 found [[tmux-play-23](../packages/tmux-play.md#tmux-play-23)] and [[tmux-play-24](../packages/tmux-play.md#tmux-play-24)] false when an observer rejects: `RecordDispatcher` stops delivering the original record, sends only [[tmux-play-25](../packages/tmux-play.md#tmux-play-25)]'s synthesized `runtime_error` to later observers, and latches the failure, while a passing check pins that short circuit.
    Put the released no-drop and every-observer guarantees to the owner, who either isolates observer failure and completes original-record delivery before error handling, or amends those concerns with an explicit failure boundary; audit the same path against [[tmux-play-22](../packages/tmux-play.md#tmux-play-22)] when a terminal-record observer fails.
    The decision, package, dispatcher, focused multi-observer integration assertions, and resulting task-49 handoff update land in this task's one commit.
    Leave this plan incomplete until it closes.

46. **Settle tmux-play startup pane order.**
    Task 24 found [[tmux-play-27](../packages/tmux-play.md#tmux-play-27)]'s released config-order rule false when [[tmux-play-80](../packages/tmux-play.md#tmux-play-80)] supplies an explicit startup-visible order: the launcher deliberately resolves and creates panes in that array's order, and [[tmux-play-182](../packages/tmux-play.md#tmux-play-182)] states the same later behavior.
    Put the ordering contract to the owner, who either conforms the artifact to configuration order and reconciles the explicit-order concern, or amends the earlier concern to the resolved visible-set order.
    The decision, package, launcher where required, focused reordered-subset system assertion, and resulting task-49 handoff update land in this task's one commit.
    Leave this plan incomplete until it closes.

47. **Preserve copy-mode follow across rapid writes.**
    Task 25 found [[tmux-play-69](../packages/tmux-play.md#tmux-play-69)] false when a destination enters copy-mode within the follow observer's 250-millisecond per-pane throttle: the observer records an earlier visible write even when its mode-gated tmux command does nothing, then suppresses the later visible write before checking the pane's new mode, while a passing unit check pins that unconditional coalescing.
    Make write coalescing preserve the released rule that every visible write finding its destination in copy-mode returns that pane to its live tail: a live-pane no-op may not suppress a later needed exit, and a pane that re-enters copy-mode after one exit may not remain scrolled across another visible write.
    Add focused integration sequences for live write → enter copy-mode → rapid write and follow → re-enter copy-mode → rapid write, while retaining per-pane isolation and the no-visible-bytes exclusion; the observer, checks, package citations, and resulting task-49 handoff update land in this task's one commit.
    Leave this plan incomplete until it closes.

48. **Honor the fanout acceptance retry bound.**
    Task 26 found [[tmux-play-116](../packages/tmux-play.md#tmux-play-116)] false of the acceptance harness it specifies: the released item permits two retries and makes the third consecutive named transient fatal, while `runFanoutWithRetry()` sets `maxAttempts = 2`, permits only one retry, and makes the second transient fatal.
    Conform the live acceptance harness to retry a complete fresh probe after, and only after, explicit upstream-overload, rate-limit, or service-unavailable failures, making at most two retries and preserving every other failure as immediately fatal.
    Add deterministic harness checks for transient-then-success, three consecutive named transients, and a non-transient failure, asserting fresh-attempt cardinality and that the third or first applicable failure remains visible rather than being replaced.
    The harness and checks land in this task's one commit, and this plan remains incomplete until it closes.

49. **Close or record the verification gaps.**
    Give every behavior in the table below an integration or system check [[meta-21](../meta.md#meta-21)] that prefers real behavior to a substitute [[meta-32](../meta.md#meta-32)], implementing the audits the table's packages state and nothing runs, and writing the verification items they still lack [[meta-33](../meta.md#meta-33)]:

    | Package     | Audit stated but unrun                                                                               | Behavior no assertion reaches                                                                                                                                                                                                                           |
    | ----------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `licensing` | `licensing-3`, `licensing-4`, and `licensing-6`, no script, workflow, or hook reading an SPDX header | `licensing-7` and `licensing-8`, which reach `licensing-3` and `licensing-4` as preconditions only                                                                                                                                                      |
    | `release`   | `release-11`'s workflow audit and `release-12`'s smoke composition                                   | `release-1`, `release-3`, `release-4`, and `release-5`, which no verification item cites; `release-7`'s build, notes-extraction, and GitHub-release steps, which `release-11` cites without asserting; and every `release-10` checklist line outside `smoke:release` |
    | `package`   | `package-101`'s runtime-descriptor and optional-runtime documentation assertions; `package-102`'s runtime-targets import assertion; `package-103`'s lifecycle-acquisition and remediation-safeguard assertions; `package-104`'s floor-change history, non-derivation, descriptor expected-version sourcing, identity/repair/vendor-resolution, and forced-divergence assertions; `package-105`'s Claude and OpenCode own-tree resolution cases; and `package-201`'s load-success assertion in all three rows plus its `'untested'` and `'unknown'` verdict assertions | `package-1` and `package-5`, which no verification item cites and no check reaches; and `package-8`, which no verification item cites while `types.test-d.ts` exercises its narrowing and assignability assertions through `npm run typecheck` |
    | `git`       | `git-6`, nothing auditing a commit message                                                           | both halves of `git-1`, its reporting duty and its refusal to commit until both values are configured, `git-6` reading a commit already made                                                                                                            |
    | `claude-code` | `claude-code-202`, `claude-code-35`, and `claude-code-36` against a physically absent SDK rather than an injected loader failure; | |
    | `claude-code` | `claude-code-201`'s mixed assistant-field/block ordering and source priority, assistant-`delta`, empty-value suppression and empty-text-block preservation, `stream_event`, top-level-`delta`, stream-text fallback and field priority, `tool_use` `toolUseId` / `toolName` aliases and alias priority plus generated-ID, unknown-name, and default-input cases, `tool_result` `toolUseId` / `id`, `name`, `output` / `result`, and `durationMs` alternatives and their priority, generated-ID / unknown-name / null-output defaults, non-numeric-duration fallback and omitted duration, case-insensitive denied/error status, `isError` / `is_error` flags, denied-over-error precedence, and absent-or-unrecognized status defaults, thinking/missing-type/non-string-type/unknown-message/block suppression, nested native-error members, top-level-over-nested field priority, nested-code-over-type and recoverable-over-retryable priority, `retryable`, and native-error defaults; | |
    | `claude-code` | `claude-code-43`'s absent, empty, and non-string subtype handshakes, repeated-init suppression, and model/cwd/tool payload fallbacks; | |
    | `claude-code` | `claude-code-44`'s `error_max_budget_usd`, `isError`, `is_error`-only and error-flag-over-status cases, subtype-only and default-coded errors, status/stop-reason alias and precedence, `success`/`completed`/`ok`, `interrupted`/`cancelled`/`aborted`, `maxturns`, `max_budget`/`maxbudget`/`budget_exceeded`, `error`/`failed`, case-insensitive and unknown statuses, multi-entry diagnostic joining, result-versus-error-text priority, status-only error-array omission, `durationMs` selection and priority over `duration_ms`, non-numeric-duration fallback, elapsed-duration fallback, and distinct/duplicate normal-terminal tool-use accounting; | |
    | `claude-code` | `claude-code-45`'s synchronous query failure, non-`Error` message fallback, elapsed duration, distinct/duplicate observed-tool accounting, and omitted result/resume fields; | |
    | `claude-code` | `claude-code-49`'s synchronous query-failure exit case, elapsed duration, distinct/duplicate observed-tool accounting, and omitted result; | |
    | `claude-code` | `claude-code-47`'s undefined absent `cwd`, `model`, `maxTurns`, and `maxBudgetUsd` values; | |
    | `claude-code` | `claude-code-41`'s exact error message, elapsed duration, distinct/duplicate observed-tool accounting, ordinary-exhaustion result omission, and resume-token omission; | |
    | `claude-code` | `claude-code-204`'s empty and partial no-mode policies, bypass-over-capability precedence, dangerous-flag omission in explicit all-ask and mixed callback rows, `MultiEdit` / `NotebookEdit` categories, capability-naming deny, and unavailable-interactive `ask` messages; | |
    | `claude-code` | `claude-code-210`'s generated-ID UUID form, session-identifier aliases and priority, latest-backend-ID replacement, and resumed normal-terminal rows with and without a replacement backend ID; | |
    | `claude-code` | `claude-code-220`'s session-identifier aliases and priority plus latest-backend-ID replacement; | |
    | `claude-code` | `claude-code-222`'s absent/empty-path omission and writable-path preservation through every non-auto permission-control row; | |
    | `claude-code` | `claude-code-229`'s undefined no-list `disallowedTools`, denylist-only case, and non-empty allowlist's undefined settings sources; | |
    | `claude-code` | `claude-code-38`'s repeated qualifying no-ops, pure-`text`, `text_delta`, `thinking`, orphan-`tool_result`, isolated-`tool_use`, camel-case, missing/malformed/nonzero/conflicting required counters, valid-zero/nonzero/malformed/conflicting cache counters, and absent/malformed/nonzero/conflicting reported-tool counter cases; | |
    | `claude-code` | `claude-code-39`'s absent, already-aborted, listener cleanup after option mapping succeeds, and multiple-run controller cases; | |
    | `claude-code` | `claude-code-40`'s fresh-clone and unrelated-variable assertions; | |
    | `claude-code` | and `claude-code-240`'s empty/array/non-object `modelUsage`, array/non-object entries, agreeing/conflicting dual counter aliases, unsafe per-record and cross-record sums, all-zero token and cost, empty/absent canonical-model map-key and empty/absent provider fallbacks, absent per-model cost and web units, per-model cost alias fallback/priority, agreeing/conflicting web-search aliases, and whole-run cost alias fallback/priority | |
    | `claude-code` | | `claude-code-1`, which no verification item cites and no check reaches |
    | `codex` | `codex-202` and `codex-48` against a physically absent SDK rather than an injected loader failure; | |
    | `codex` | `codex-201`'s later-`item.started` suppression, missing-ID canonical lifecycle rows, and command/MCP payload fallbacks for empty commands, case-insensitive failed status, server/tool names, absent or parsed/raw arguments, absent `aggregated_output`, absent or non-finite exit codes, and result/error/null priority; | |
    | `codex` | `codex-41`'s requested-over-event model/cwd priority, empty requested model/cwd, event and process fallbacks, top-level/session/turn SDK-tool priority and filtering, known/`sdk` capability rows, and natural empty-stream init; | |
    | `codex` | `codex-42`'s status-source priority, remaining status aliases and case handling, result/duration/usage priority and fallbacks, resumed normal-terminal no-backend-ID omission, interrupted-status resume selection, and stop-after-done behavior; | |
    | `codex` | `codex-43`'s elapsed duration, result omission, no-backend resume omission, and `turn.failed` usage; | |
    | `codex` | `codex-44`'s remaining top-level and content text/tool aliases plus the remaining rows of the legacy name, ID, input, output, duration, error-flag, default, and priority matrices, including denied-over-error priority; | |
    | `codex` | `codex-45`'s exact exhaustion diagnostic, elapsed duration, result omission, non-`Error` iterator fallback and JSON error-message unwrapping, and already-aborted or iterator-throw abort exits; | |
    | `codex` | `codex-46`'s compatibility use-only and result-only identifier counts; | |
    | `codex` | `codex-206`'s remaining top-level and item-contained file aliases and payload-priority fallbacks; | |
    | `codex` | `codex-217`'s remaining error code, message, recoverability, and fallback matrix rows; | |
    | `codex` | `codex-204`'s capability-populated `bypass` precedence and configuration isolation; | |
    | `codex` | `codex-211` and `codex-220`'s `session_id` and nested session/thread aliases, alias priority, invalid-value retention, and replacement of one backend identifier by a later backend identifier; | |
    | `codex` | `codex-215`'s generated-identifier form and resumed pre-backend event identity; | |
    | `codex` | `codex-218`'s ultra-invariant sandbox/network omissions; | |
    | `codex` | `codex-221`'s empty and invalid writable paths; | |
    | `codex` | `codex-223`'s valid non-worktree `gitdir:` fallback; | |
    | `codex` | `codex-224`'s caller-`CODEX_HOME` restoration; | |
    | `codex` | `codex-229`'s omitted tool-list native-set preservation; | |
    | `codex` | `codex-205`'s actual scheduled-abort termination; | |
    | `codex` | `codex-51`'s installed error-code and every-attempted-anchor assertions; | |
    | `codex` | `codex-52`'s loader-before-search precedence, valid-loader missing-entry continuation, and physical-symlink canonicalization; | |
    | `codex` | `codex-49`'s empty-cwd preservation and absent-cwd `workingDirectory` undefined value; | |
    | `codex` | `codex-50`'s repeated failed-setup abort-listener cleanup; | |
    | `codex` | and `codex-240`'s complete usage-source, counter-alias, disagreement, absent, and malformed matrix, optional- and output-counter decreases, cache-write-only details, cache-write and combined-cache subset overflows, reasoning overflow, cache-write/reasoning shape transitions, exact optional-detail deltas, malformed-accounting tool-count preservation, and first-runtime-model selection | |
    | `codex` | | `codex-1`, whose `agent: 'codex'` identity no verification item cites and no check asserts |
    | `engine` | `engine-103`'s `disallowedTools` and explicit-empty tool-list replacement rows plus its call-scoped-only `abortSignal` / `resume` type boundary; | |
    | `engine` | `engine-104`'s explicit and stored empty-string resume rows; | |
    | `engine` | `engine-106`'s exact canned-event values, payloads, and order; | |
    | `engine` | `engine-107`'s generator `.return()` assertion; | |
    | `engine` | `engine-108`'s pre-`done` `ADAPTER_ERROR` non-recoverability and stored-resume clearing plus its post-`done` throw row; | |
    | `engine` | `engine-109`'s stored-resume clearing after `MISSING_DONE`; | |
    | `engine` | `engine-110`'s actual abort / native-`done` race; | |
    | `engine` | `engine-111`'s exact interleaving and per-event attribution; | |
    | `engine` | `engine-112`'s exact failing-stream error-then-`done` sequence and cardinality; | |
    | `engine` | `engine-113`'s exact failing-stream sequence and error terminal; | |
    | `engine` | `engine-115`'s ordered-ladder type assertion plus Gemini and OpenCode direct, `Cligent`, and heterogeneous-parallel vocabulary cases; | |
    | `engine` | `engine-116`'s exact Claude `minimal`-to-`low` lossy-note disclosure; | |
    | `engine` | `engine-118`'s `missing` verdict and false compatibility, satisfied load-success half, `untested` and `unknown` verdict, load-success, and true-compatibility rows, exact installed/range/tested/repair payload fields, and exact resolved-location reporting, with task 42 owning the missing CLI path; | |
    | `engine` | `engine-122`'s missing-`toolUses` compile rejection; | |
    | `engine` | `engine-69`'s interrupted and pre-aborted synthetic usage shape plus distinct-count behavior for duplicate tool identifiers across every synthetic terminal path; | |
    | `engine` | `engine-70`'s valid greater-than-one request-count interpretation and remaining malformed total, detail, request, record, and priced-unit cases; | |
    | `engine` | `engine-72`'s provider- and account-estimate provenance; | |
    | `engine` | `engine-202`'s exact accepted-policy pass-through beyond the tested `mode: 'auto'` with canonical non-empty `writablePaths`: empty-policy, capability-only, bare-`bypass`, writablePaths-only, and explicit-empty-`writablePaths` cases; | |
    | `engine` | `engine-209`'s Claude denylist-only and Kimi non-empty allowlist and denylist rejection cases; | |
    | `engine` | `engine-214`'s cross-run stream, option, and state isolation for Claude, Codex, Gemini, and OpenCode plus Kimi per-call option isolation; | |
    | `engine` | `engine-218`'s Gemini omitted effort and Kimi `off`, omitted, other-adapter, and arbitrary-unknown inputs; | |
    | `engine` | `engine-219`'s missing-prerequisite, CI, cross-adapter-isolation, and sandbox gates, with task 43 repairing the missing local-skip diagnostic; | |
    | `engine` | `engine-221`'s complete five-adapter accepted, invalid, absent, and empty writable-path matrix; | |
    | `engine` | `engine-226`'s Kimi upstream-effort-rejection case; | |
    | `engine` | `engine-240`'s complete every-built-in authentic-zero, authentic-nonzero, malformed, and absent accounting matrix; | |
    | `engine` | and `engine-32`'s different-resume and fresh-run concurrency plus queue release after error, interrupted, and setup-failure exits | |
    | `engine` | | `engine-1`'s constructor option surface; |
    | `engine` | | `engine-7`, whose exported `createEvent()`, `generateSessionId()`, and `isAgentEvent()` helpers no verification item cites while `events.test.ts` directly exercises all three; |
    | `engine` | | `engine-9`, whose pre-aborted outcome no verification item cites while `cligent.test.ts` and `engine.test.ts` exercise it; |
    | `engine` | | `engine-12`'s `MISSING_DONE` error non-recoverability; |
    | `engine` | | `engine-35`'s exact 500-millisecond drain bound and no-fabricated-resume-from-nonterminal-`sessionId` branch; |
    | `engine` | | `engine-13`'s controlled elapsed-duration branch; |
    | `engine` | | `engine-17`'s omitted-list preservation and exact-identifier boundary; |
    | `engine` | | `engine-20`, whose generic effort surface no verification item cites while `types.test-d.ts` exercises direct and `Cligent` calls; |
    | `engine` | | `engine-46`'s dynamic-input responsibility matrix; |
    | `engine` | | `engine-52`'s absent-policy, supplied-undefined, bypass, independent-axis, precedence, protected-auto non-expansion, and unreachable-mode-rejection branches; |
    | `engine` | | `engine-64`'s supplementary-source cross-validation and protocol-boundary rule; |
    | `engine` | | `engine-65`'s independent tool count across every terminal status; |
    | `engine` | | and `engine-29`, superseded by `engine-31` and cited by no verification item, which task 51 settles rather than task 49 |
    | `kimi` | `kimi-201`'s complete event order beyond the configuration-time init queue flow; empty text, non-text message, user-chunk, and no-result rows; interleaved distinct tools; remaining later-field merge and priority; kind and unknown names; parsed-object-string, raw-string, absent/null/empty, array, and other inputs; forced fallback, description, both terminal update forms, raw-output-null, joined-text, content-array and null outputs, remaining duration cases beyond task 36's configuration-time observation span, and remaining duplicate rows; exact payloads for all three plan forms; remaining permission payload and option-priority rows; every-stop resume and accounting fields; exact refusal error and recoverability; elapsed duration; exactly one terminal on ordinary, ACP-failure, and child-exit paths; and error-before-`done`. | |
    | `kimi` | `kimi-202`'s single application-configuration through runtime-created `Cligent` to Kimi ACP model and `thinking: 'on'` flow. | |
    | `kimi` | `kimi-203`'s queued-response and update draining, configuration-abort child cleanup and terminal count, and caller-listener and protocol-resource cleanup. | |
    | `kimi` | `kimi-204`'s exhaustive capability-level matrix beyond the tested absent-policy, capability-populated `auto`, bare-`bypass`, and empty no-mode rows; permission kind/unknown-name, remaining input fallbacks, and reason payloads; identifier-only and case-variant-name `Reject and Exit` cases; first-of-multiple reject-once and reject-always priorities; and cancellation specifically on caller abort. | |
    | `kimi` | `kimi-218`'s ACP `off`, omitted-effort, arbitrary-unknown, exact adapter/allowed-values error, and absent and empty model rows. | |
    | `kimi` | `kimi-219`'s configured-default-model and environment-overlay authentication routes plus bare-`MOONSHOT_API_KEY` insufficiency. | |
    | `kimi` | `kimi-220`'s pre-backend inbound-resume identity on every event, one generated identity shared by every pre-backend event, replacement only after backend identity, and backend identity on every failure event plus error-terminal continuity. | |
    | `kimi` | `kimi-222`'s `writablePaths`-absent and explicit-empty omission under `mode: 'auto'` plus invalid-path forms beyond the tested parent traversal. | |
    | `kimi` | `kimi-229`'s omitted-list native-registry preservation and non-empty allowlist and denylist rows. | |
    | `kimi` | `kimi-230`'s real default availability probe and its supported-version, nonzero, missing, timeout, below-floor, and non-mutation outcomes; arbitrary and coalesced framing beyond fixed midpoint splits; oversized decoded buffers; invalid JSON-RPC object, request, notification, response, error, id, and pending-id shapes; remaining invalid consumed payloads; handled traffic with valid unknown fields; handled pre-session and cross-session update traffic; per-failure termination; empty-resume `session/new` selection and the full resumed-run cwd/config/init/event lifecycle; unsupported negotiated protocol; omitted configuration calls; exact empty ACP capability advertisement; init cwd and model fallbacks; exactly one spawn and cleanup sequence plus interrupted/error terminal counts and order beyond [[kimi-34](../packages/adapters/kimi.md#kimi-34)]'s close matrix; inherited environment and drained bounded stderr; one-text-block prompt; zero-valued limits; bare `KIMI_API_KEY` insufficiency; non-authentication ACP throws, asynchronous process errors, the null-close row, non-recoverable flags on the remaining process and operation failures, structured details priority, stderr inclusion and deduplication; caller-abort priority against independent authentication, protocol, setup, and prompt failures; authentication over concurrent protocol and process failures; protocol over an independent operation failure; process over an independent operation failure; and post-abort isolation. | |
    | `kimi` | `kimi-240`'s token and cost omission, status and result preservation, and distinct-tool counting across interrupted, max-turn, refusal, error, and synthetic terminals | |
    | `kimi` | | `kimi-15`'s prohibition on importing a legacy or unpublished Kimi-specific SDK, which no verification item asserts |
    | `opencode` | `opencode-201`'s object-name, empty, and malformed wrapper-tool rows; SDK-model, unknown-model, caller-cwd, and process-cwd init fallbacks; exact ordinary and fallback-init capabilities; remaining content payload members; nested error sources, priorities, retryability, and defaults; remaining terminal status, result, and duration selectors; ordinary non-abort iterator rejection, non-`Error` fallback, backend-ID continuity, and exact recoverability, usage, duration, and tool-count fields across the remaining setup/stream-throw rows; and exact aborted and non-aborted EOF diagnostics, continuity, usage, and duration. | |
    | `opencode` | `opencode-202` against a physically absent SDK; the real managed CLI probe's supported, unreadable or unparseable fail-open, missing, nonzero, timed-out, and below-floor outcomes; managed positive availability; and below-floor `run()` refusal before spawn. | |
    | `opencode` | `opencode-52`'s absent and empty model/cwd and ignored-budget rows. | |
    | `opencode` | `opencode-204`'s bypass rejection after SDK load but before managed or SDK work, and invalid-writable-path validation before that bypass diagnostic. | |
    | `opencode` | `opencode-53`'s managed-startup cwd and the pre-readiness managed-child crash that task 40 repairs. | |
    | `opencode` | `opencode-212`'s wrapper `session_id`, `thread_id`, top-level `id`, and nested `session.id` aliases; stream `session_id` and nested `session.id`; alias priority and invalid values; generated or inbound provisional identity on every pre-backend event; and replacement after the wrapper identifies the backend. | |
    | `opencode` | `opencode-219`'s transient-only live retry classification, third-attempt exhaustion, fresh retry directories after side effects, successful-terminal and invariant-violation non-retry, and errored-result and stranded-use retry eligibility. | |
    | `opencode` | `opencode-222`'s absent and explicit-empty path omission plus invalid forms beyond parent traversal. | |
    | `opencode` | `opencode-227`'s private reset on legacy fresh and resumed calls and v2 fresh calls. | |
    | `opencode` | `opencode-231`'s `callId` / `toolUseId` / generated identifiers and selector priority; `toolName`, object-tool, unknown-name, and later-name replacement; remaining input sources and priority, arrays, parsed object/array strings, invalid strings, and empty defaults; description sources and omission; null outputs; omitted duration for absent or non-finite endpoints; and remaining denied-output sources, priority, and null fallback. | |
    | `opencode` | `opencode-232`'s explicit transient-only classification and three-attempt bound, fresh-directory retry after a side effect, successful-terminal and invariant-violation non-retry, and errored-result and stranded-use retry eligibility. | |
    | `opencode` | `opencode-234`'s top-level and case-insensitive role sources. | |
    | `opencode` | `opencode-235`'s exact 300,000 ms default, monotonic-clock resistance to wall-clock jumps, arbitrary other non-idle recovery, and earlier-error idle recovery. | |
    | `opencode` | `opencode-237`'s resumed-lineage identifier-less-child tolerance, task-part child ownership, resumed lifecycle addition, owned-parent `session.updated` adoption, owned-descendant deletion, malformed lifecycle preservation, remaining permission-name, request-ID, tool-use-ID, input, pattern, decision, status, response, denial-name, and denial-output aliases, defaults, and priorities; and synchronous and non-`Error` reply failures. | |
    | `opencode` | `opencode-240`'s no-role and multiple-candidate prompt-boundary rows; missing, fractional, non-finite, unsafe, overflow, cache-write, reasoning, and cost step variants beyond the representative malformed cases; missing title routes, non-string resumed title, update failure, and mismatched echoed title; missing, rejected, timed-out, and unhealthy health routes; repeated internal-prompt identity and error signals, conflicting evidence, and retry without a correlated request; missing-child enrichment, conflicting parent or child identity, and a matched child followed by unmatched or error background results; and exact partial-record and whole-run cost coverage across those rows | |
    | `opencode` | | `opencode-1`, whose `agent: 'opencode'` identity no verification item cites and no check asserts |
    | `gemini` | `gemini-201`'s repeated-init, first-unknown-type, malformed-before-init, missing/empty/non-string-type, and empty-stream init rows; caller-over-stream and empty-caller model/cwd priority plus model/cwd fallbacks; object-valued or invalid stream tools, configured non-empty, capability-derived, unavailable, and effective-deny init states; message aliases, priority, and suppression; the remaining tool-use and tool-result type, container, name, ID, input, output, status, duration, default, and priority rows; native-error nested fields, priorities, retryable, and defaults; native-result remaining status aliases and case handling, error/result diagnostic priorities, duration priority and fallback, first-result/trailing suppression, post-result malformed suppression, and pending-result stream failure; and duplicate, distinct, generated, and result-only tool-ID counts across terminal paths. | |
    | `gemini` | `gemini-203`'s already-aborted and pre-spawn aborts, listener removal, post-exit no-kill, elapsed duration, observed tool count with tokens absent, and result omission on the remaining abort paths. | |
    | `gemini` | `gemini-204`'s capability-populated `bypass`, `bypass` with independent tool lists, duplicate-list de-duplication, surviving multi-allow sorting, complete denylist-only outcome, and explicit-empty-policy `write_file` and `google_web_search` default-ask rows. | |
    | `gemini` | `gemini-207`'s settings- and policy-setup failures, complete synchronous-spawn, missing-stdout, and iterator-failure payloads, non-`Error` fallback, arbitrary nonzero/null/other-signal and bare-`SIGTERM` close rows, non-interrupted trimmed-stderr result selection, elapsed duration, normal resume selection beyond the exercised iterator-failure/backend-ID and child-failure/resumed-no-backend cases, observed count, and synthetic-error omitted tokens/result. | |
    | `gemini` | `gemini-213` and `gemini-220`'s `session_id`, thread and nested aliases, alias priority, invalid-value retention, latest-ID replacement, resumed normal-terminal no-backend omission, and early-error no-ID omission outside task 34's resumed child-failure case. | |
    | `gemini` | `gemini-216`'s present empty-string environment row. | |
    | `gemini` | `gemini-218`'s omitted-effort row. | |
    | `gemini` | `gemini-222`'s absent/empty path omission, run-level invalid-path pre-spawn rejection, and tool-control preservation. | |
    | `gemini` | `gemini-225`'s absent/empty model and `maxBudgetUsd` omissions, absent-resume generated/common identity, no-rule policy-file omission, runtime `tools.exclude` omission, installed Admin-policy precedence, compatibility-helper allowed-only and denied-only shapes, defaults-file absent/platform/error/malformed/non-object states and merge collisions, unique mode-protected temporary paths, write-failure cleanup, exactly-one cleanup rejection, creation-failure cleanup, and partially initialized cleanup. | |
    | `gemini` | `gemini-229`'s non-empty configured-init override, omitted-list unavailable/capability-derived/object-name tool sources, and effective denied-tools payload. | |
    | `gemini` | `gemini-240`'s all-zero response, distinct telemetry paths, capture-setup and unreadable/missing-file failures, malformed JSON sequences and no-successful-response files, timestamp aliases, missing identities, the remaining invalid and unsafe counter/subset/total cases, unidentifiable and signature-member duplicate conflicts, unsafe aggregation, the remaining whole-run and per-model reconciliation failures, valid- and malformed-accounting nonzero observed-tool-count preservation, and native-result-error and telemetry-read-failure cleanup | |
    | `gemini` | | `gemini-1` and `gemini-18`, which no verification item cites and no check reaches; |
    | `gemini` | | and `gemini-2`, which no verification item cites while `gemini-adapter.test.ts` asserts injected true and false probe results but does not execute the real probe's supported-version zero-exit, nonzero-exit, missing-executable, timeout, or below-floor-version branches |
    | `tmux-play` | `tmux-play-73`'s seven rows other than player plus two `text` messages without a prior newline; | |
    | `tmux-play` | `tmux-play-101`'s one-line stdout cardinality; | |
    | `tmux-play` | `tmux-play-102`'s home-YAML byte nonmutation; | |
    | `tmux-play` | `tmux-play-103`'s unset-`XDG_CONFIG_HOME` row; | |
    | `tmux-play` | `tmux-play-104`'s `.mjs` and `.js` warning rows; | |
    | `tmux-play` | `tmux-play-105`'s offending-path diagnostic for invalid, duplicate, and reserved `captain` player IDs; | |
    | `tmux-play` | `tmux-play-106`'s actual session-mode import resolution for local paths and package specifiers; | |
    | `tmux-play` | `tmux-play-107`'s exact shared numeric `turnId` across its causal sequence; | |
    | `tmux-play` | `tmux-play-111`'s active-turn abort after observer rejection; | |
    | `tmux-play` | `tmux-play-114` and `tmux-play-182`'s zero-player navigation, `C-c`, ESC, drag, and right-click binding installation and absence of missing-player targets beyond the asserted session-mouse and primary-button cases; | |
    | `tmux-play` | `tmux-play-116`'s composite spent-Kimi self-skip and missing-dependency local-skip/CI-hard-fail rows; | |
    | `tmux-play` | `tmux-play-120`'s source-YAML mutation after launch; | |
    | `tmux-play` | `tmux-play-130`'s missing-binary and disposable-server self-skip rows; | |
    | `tmux-play` | `tmux-play-134` and `tmux-play-146` through `tmux-play-149`'s complete matrices under `tmux-play-130`'s real-tmux harness; | |
    | `tmux-play` | `tmux-play-152`'s accepted and invalid `shellExecute` / `networkAccess` members; | |
    | `tmux-play` | `tmux-play-153`'s mapping matrix beyond the exercised Claude `auto` plus writable paths and Codex `auto` plus writable paths cases — Claude and Codex bypass, every Gemini, OpenCode, and Kimi row, and the remaining role and capability variants; | |
    | `tmux-play` | `tmux-play-154`'s Captain-path invalid-mode launcher failure and offending-path diagnostic plus exact single-line stderr cardinality for both role paths; | |
    | `tmux-play` | `tmux-play-157`'s Kimi YAML-through-runtime-to-native-ACP `thinking: on` mapping flow; | |
    | `tmux-play` | `tmux-play-158`'s exact single-line stderr cardinality for both invalid-effort role paths; | |
    | `tmux-play` | `tmux-play-159`'s non-TTY ESC-keybinding omission; | |
    | `tmux-play` | `tmux-play-161`'s concrete-YAML, fallback, and create-no-config diagnostics rows; | |
    | `tmux-play` | `tmux-play-164`'s omitted-layout, partial-window, canonical, and two-element-alias snapshot rows, every launcher-CLI malformed-layout case except decimal `columnWeights`, and exact single-line stderr cardinality for that exercised decimal case; | |
    | `tmux-play` | `tmux-play-181`'s cwd-project nonmutation and no-intermediate-alias-plus-canonical assertions; | |
    | `tmux-play` | `tmux-play-183`'s accepted-call preservation of configured-roster fields beyond the asserted IDs and player `Cligent` continuity; | |
    | `tmux-play` | `tmux-play-185`'s timer-option, mouse-binding, and layout-hook reapplication plus successful changed-list tracking before a same-list no-op; | |
    | `tmux-play` | `tmux-play-186`'s accepted pre-close status emission and multiple accepted-emission in-order drains on ordinary and failed cleanup; | |
    | `tmux-play` | `tmux-play-187`'s actual update-failure branch; | |
    | `tmux-play` | `tmux-play-191`'s normal records, result, and resolved visibility on its fresh-plus-empty-tools row; | |
    | `tmux-play` | `tmux-play-192`, `tmux-play-193`, `tmux-play-196`, and `tmux-play-197`'s substantive assertions under `tmux-play-150`'s real-`glow` harness; | |
    | `tmux-play` | `tmux-play-138`'s exact Mocha theme values beyond its pinned anchors and every exact Latte value beyond `status-style`; | |
    | `tmux-play` | `tmux-play-143`'s undefined-output header-only case; | |
    | `tmux-play` | `tmux-play-146`'s non-streaming `text`, `captain_finished`, `tool_result`, `captain_status`, and `turn_aborted` flush boundaries even under a substitute presenter harness; | |
    | `tmux-play` | `tmux-play-149`'s both-binaries-missing tmux-first ordering even under injected availability checks; | |
    | `tmux-play` | `tmux-play-150`'s missing-glow self-skip row; | |
    | `tmux-play` | `tmux-play-202`'s fallback-pool exclusion of the reserved `blue`, `mauve`, `peach`, `red`, and `yellow` speaker / tool / status roles under both flavors, plus repeated unknown-adapter stability under Latte; | |
    | `tmux-play` | `tmux-play-156`'s full Latte border, timer, and status palette, active-Captain-versus-active-player highlight cases, and real-tmux `[=scroll` omission; | |
    | `tmux-play` | `tmux-play-160`'s bracketed-paste disable on shutdown paths other than ordinary EOF; | |
    | `tmux-play` | `tmux-play-169`'s real-tmux tool, bracketed-status, turn-abort, and runtime-error live-follow paths; | |
    | `tmux-play` | `tmux-play-173`'s no-`TMUX` preservation of inherited `TMUX_PANE` and `TMUX_TMPDIR`; | |
    | `tmux-play` | `tmux-play-174`'s no-fresh-prompt and exactly-once restoration assertions when the active turn aborts; | |
    | `tmux-play` | and all of `tmux-play-198`'s logical-key, title- and order-independent routing, title-round-trip warning-and-continue, and no-warning assertions | |
    | `tmux-play` | | `tmux-play-2`'s ordinary config-to-gate-to-construct-to-attach-to-exit sequence beyond `tmux-play-192`'s construction gate; |
    | `tmux-play` | | `tmux-play-3`'s player, readline, observer, and cleanup parts beyond `tmux-play-115`; |
    | `tmux-play` | | `tmux-play-4`, which no verification item cites while config and CLI checks assert explicit selection and forwarding, but whose no-auto-create side effect no assertion reaches; |
    | `tmux-play` | | `tmux-play-5`'s optional top-level fields; |
    | `tmux-play` | | `tmux-play-6`'s full Captain member and opaque-options surface; |
    | `tmux-play` | | `tmux-play-7`'s optional members and reused adapter/model row; |
    | `tmux-play` | | `tmux-play-9`'s neither-file result; |
    | `tmux-play` | | `tmux-play-10`'s no-runtime stdout silence; |
    | `tmux-play` | | `tmux-play-11`'s non-Claude/Codex ordering and no-pin rows plus its example-only permission-default boundary; |
    | `tmux-play` | | `tmux-play-14`, which no verification item cites while contract, session, and acceptance checks exercise a synchronous default factory and Captain lifecycle shape, but no check runs a Promise-returning factory; |
    | `tmux-play` | | all of `tmux-play-15`; |
    | `tmux-play` | | `tmux-play-16`'s turn-scoped `signal` and runtime delivery of a string `CallCaptainOptions.resume`; |
    | `tmux-play` | | and `tmux-play-16` / `tmux-play-17`'s complete public declaration/type surfaces — including readonly manifests, optional status data, and member signatures — which `tmux-play-contract.test-d.ts` only partly exercises while no verification item claims them; |
    | `tmux-play` | | `tmux-play-18`'s at-most-one in-flight `handleBossTurn` invocation per session, which `runtime.test.ts` exercises without proving, while no verification item reaches that guarantee; |
    | `tmux-play` | | `tmux-play-20`; |
    | `tmux-play` | | `tmux-play-21`'s active-turn `captain_status` and both active- and outside-turn `captain_telemetry` cases, of which `runtime.test.ts` exercises the status and outside-telemetry cases without a verifier while no check reaches active-turn telemetry; |
    | `tmux-play` | | `tmux-play-22`'s unawaited completed/failed join and terminal-fence rows; |
    | `tmux-play` | | `tmux-play-24`'s null-lane ordering; |
    | `tmux-play` | | `tmux-play-25`'s startup-error, remaining-observer-order, and individual-call-error rows; |
    | `tmux-play` | | `tmux-play-29`'s record-type and observer subexports; |
    | `tmux-play` | | `tmux-play-31`, `tmux-play-32`, and `tmux-play-33`, whose stated surfaces no verification item fully asserts; |
    | `tmux-play` | | `tmux-play-52`'s absent-policy row, which `players.test.ts` exercises without a verifier; |
    | `tmux-play` | | `tmux-play-56`'s absent-effort row, which `players.test.ts` exercises without a verifier; |
    | `tmux-play` | | `tmux-play-60`, which no verification item cites while config checks execute its complete theme matrix; |
    | `tmux-play` | | `tmux-play-81`'s uncaught-invalid route plus preservation of the runtime player map and per-player logs; |
    | `tmux-play` | | `tmux-play-82`'s emitted-record timestamp; |
    | `tmux-play` | | `tmux-play-83`'s post-failure recovery and fixed-200-with-no-YAML-or-Captain-option boundary; |
    | `tmux-play` | | `tmux-play-84`'s hidden-call, log-accumulation, no-live-pane, and hide/show state-loss rows; |
    | `tmux-play` | | `tmux-play-86`'s same-directory atomic-update mechanism; |
    | `tmux-play` | | `tmux-play-90`'s legacy-effort delegation; |
    | `tmux-play` | | `tmux-play-91`, which no verification item cites while runtime checks exercise every row except the pre-resumption scheduled-continuation row; |
    | `tmux-play` | | `tmux-play-92`, which no verification item cites while presenter and follow checks exercise its presentation flow; |
    | `tmux-play` | | `tmux-play-97`, which no verification item cites while runtime checks exercise its admitted, rejected, and terminal-order rows; |
    | `tmux-play` | | `tmux-play-34`'s preservation of every other resolved config member, which `config.test.ts` exact-compares without a verification item; |
    | `tmux-play` | | `tmux-play-37`'s exact Mocha and Latte prompt bytes, which `session.test.ts` asserts without a verification item, plus its untested six-cell cursor measurement; |
    | `tmux-play` | | `tmux-play-38`'s Latte Captain and player speaker prefixes; |
    | `tmux-play` | | `tmux-play-39`'s structured-data status tail and Latte red, yellow, and green tags; |
    | `tmux-play` | | `tmux-play-49`'s selected `path`, `pattern`, and `description` input-summary alternatives, whitespace collapse, pretty-printed-JSON output extraction, and absent-output omission; |
    | `tmux-play` | | `tmux-play-43`'s terminal-honors and terminal-ignores outcomes; |
    | `tmux-play` | | `tmux-play-44`'s exact resize-hook installation and stale-visible-shape worker rejection; |
    | `tmux-play` | | `tmux-play-53`'s `turn_aborted` session-total closure; |
    | `tmux-play` | | `tmux-play-54`'s two-cell emoji budget; |
    | `tmux-play` | | `tmux-play-55`'s resolved-blue status heading and segment-length preservation; |
    | `tmux-play` | | `tmux-play-57`'s idle bare-ESC no-op; |
    | `tmux-play` | | `tmux-play-58`'s non-TTY-stdin branch; |
    | `tmux-play` | | `tmux-play-62`'s toast style and auto-dismiss, stock click and wheel behavior, terminal-policy fallback, and server-global binding lifetime; |
    | `tmux-play` | | `tmux-play-68`'s keyboard-switch selection preservation; |
    | `tmux-play` | | `tmux-play-69`'s target-not-in-mode, other-session, and pane-process-survival branches, with task 47 owning rapid-write correctness; |
    | `tmux-play` | | `tmux-play-71`'s negative clamp and 100-hour expansion, the latter exercised only by `timing.test.ts`; |
    | `tmux-play` | | `tmux-play-72`'s hidden-versus-visible `turnId` and `resumeToken` result parity; |
    | `tmux-play` | | `tmux-play-75`'s exactly-once prompt restoration after a runtime error; |
    | `tmux-play` | | `tmux-play-75`'s idle empty-or-whitespace fresh-ready-prompt branch, which `session.test.ts` asserts while no verification item reaches that branch; |
    | `tmux-play` | | `tmux-play-75`'s non-TTY no-keypress-handling beyond `tmux-play-159`'s no-ESC assertion, active-turn prompt-suspension no-op, and static between-turn readline-prompt preservation; |
    | `tmux-play` | | `tmux-play-74`'s pane-0 orchestrator placement; |
    | `tmux-play` | | `tmux-play-88`'s explicit-string Captain resume and presentation invariance beyond the tested fresh-plus-empty-tools row; |
    | `tmux-play` | | `tmux-play-89`'s above-tested nonblocking, below-floor-versus-missing diagnostic, credential exclusion, and gate ordering; |
    | `tmux-play` | | `tmux-play-99`'s Captain token-presence and token-omission rows, which `runtime.test.ts` asserts without a verification item; |
    | `tmux-play` | | `tmux-play-194`'s concrete programmatic Mocha choice, exact OSC query and timeout, channel-width, terminator, normalization, and luminance-boundary cases, fallback-cause variants, and ordinary-launch snapshot persistence; |
    | `tmux-play` | | and `tmux-play-67`, superseded by `tmux-play-68` and cited by no verification item, which task 51 settles rather than task 49 |

    A citation is not coverage: where a verification item asserts less than the behavior it cites states, strengthen it, or add the item its own statement cannot reach, until every case that behavior states is asserted [[meta-33](../meta.md#meta-33)], each assertion citing every behavior it reaches [[meta-20](../meta.md#meta-20)].
    `git-6`'s trailer bullet shows the shape: it takes `git-4`'s `Co-authored-by` without its `<model> (<role>) <email>` schema, its role set, or its address, so a check written to it would accept the address this project forbids.
    Also add and audit the trailer-block integrity rule that every raw commit-message line beginning `Co-authored-by:` shall parse as a Git trailer, so a separated attribution cannot masquerade as body text.
    Reconciling every behavior against the items citing it is this task's output rather than this plan's, so the clause-by-clause list lands in the strengthened items instead of here.
    The branches tasks 16 through 27 split arrive as further rows of that table, as does any gap a migration task hands over, and this task closes only once none is left.

    Where a behavior admits no check at all, `git-3`'s bullets-if-clearer clause the candidate, a decision record [[meta-24](../meta.md#meta-24)] amends it into a checkable form with its concern preserved [[meta-12](../meta.md#meta-12)], the package then verifying everything it states.
    Where a gap is neither closed nor so amended, this plan does not complete: record it as blocking, name the behavior left unverified, and leave the deliverable open, a package that states a behavior it never verifies being unlawful [[meta-33](../meta.md#meta-33)].

50. **Settle the parser's unterminated-tail conflict.**
    `ndjson-2` carries `NDJSON-002`'s rule that a result follows only a complete newline-delimited line, while `parseNDJSON()` has read an unterminated final line since it was written, a passing test pins that flush, and the Gemini adapter is its only consumer.
    Put the contradiction to the owner, who either conforms the parser and its test to the rule, the package's `External Behavior` then standing as written, or writes the decision record adopting the flush, which amends `ndjson-2` to stop excluding the end of the stream, gains the package an item for the tail, and gains the map its row.
    Either branch ends the silence this question bought: `ndjson-207` gains the assertion of what a stream ending without a newline yields, and the trigger that carries it.
    Task 6 found this and left it open rather than settling a behavior question inside a move.
    Leave this plan incomplete until it closes.

51. **Settle the superseded items.**
    Every item the tree marks superseded when this task runs is in scope, wherever it then lives and however the marker is worded: an item-level note retiring the whole item, and an embedded note retiring one passage of an otherwise live item alike, but not an ordinary sentence that merely uses the word.
    What each marker admits is that the artifact stopped following the passage it covers, while the rest of a partly superseded item stays authoritative.
    Whatever still cites retired content shall be reconciled with the outcome in the same commit, because a live item may draw its own scope from retired content, and retiring that content unreconciled would leave a live requirement no reader can bound.
    No census can stand in for that rule: the tasks below still carry markers out of the legacy files, and dissolving one superseded cross-adapter criterion copies its marker into every destination package, so the total grows as the migration proceeds rather than holding steady.
    This task shall therefore measure the set itself, over the whole tree, at the moment it runs.
    An item the artifact no longer satisfies is the contradiction this plan's own rule sends to a task of its own ahead of the handover, and no earlier task carries these.
    Put the cluster to the owner, who either restores each concern by conforming the artifact to it, or approves the retirement that a decision record then admits [[meta-12](../meta.md#meta-12)], the packages losing the item and gaining the map's row.
    Neither `spex lint` nor the coverage criterion sees this, a superseded item stating a requirement its package never meets [[meta-34](../meta.md#meta-34)], so nothing but this task keeps it visible.
    Leave this plan incomplete until it closes.

52. **Settle selected-vendor runtime identity.**
    Task 17's review found the shipped Claude target contradicting [[package-16](../packages/package.md#package-16)] and [DR-013](../decisions/013-cligent-owned-runtime-compatibility.md): it pairs SDK-domain `supportedFrom: '0.3.219'` and `tested: '0.3.220'` values with `bundles: '@anthropic-ai/claude-code'`, although that SDK has no dependency by that name and reports its selected executable separately as Claude Code `2.1.220`.
    The current runtime reader first searches cligent's own dependency roots for that unrelated package name, so a separately installed Claude Code `2.x` can shadow the SDK-embedded executable, compare permanently above an SDK-domain `0.3.x` target, and make readiness and error text name a runtime different from the repair.
    Put the version-domain choice to the owner: either model SDK compatibility and selected-executable identity and version separately in the descriptor, reading the latter through the SDK's actual selection path, or amend the decision and [[package-16](../packages/package.md#package-16)] so the version-tied SDK is the compatibility authority and the selected executable's consistency is derived without pretending it is a resolvable package dependency.
    Whichever branch is chosen shall eliminate capture of an unrelated top-level CLI, make the readiness label, compared version, and repair identify one coherent runtime domain, remove the independently hard-coded Claude Code expectation, audit Codex's analogous SDK-relative `bundles` lookup, and add isolated-layout system coverage for both adapters; the decision branch carries its DR, spec, descriptor, reader, documentation, and verification changes in this task's one commit.
    Leave this plan incomplete until it closes.

53. **Verify and hand over.**
    Drive `spex lint` to zero errors and zero warnings, reconcile the task-4 rename map against the tree, run typecheck, lint, unit tests, and build, and hand that map, the classifications, the split judgments, the open questions, and any coverage left open to human diff review.

## Verification

- `spex lint` reports no error and no warning.
- No path under `specs/user/`, `specs/dev/`, `specs/test/`, or `specs/iterations/` exists, and no file in the repository links to one, except the two `CHANGELOG.md` hyperlinks the next bullet's byte-for-byte rule freezes.
- No legacy uppercase item ID remains anywhere except in `CHANGELOG.md`, whose released entries are unchanged byte-for-byte, and in the migration's own two records, which name those IDs to bridge them — the decision record through its rename map, this plan through the retargeting its tasks describe.
  No such ID stands as the referent of an instruction, which is the use the exemption was written for and the one a file-wide carve-out cannot tell apart: naming a legacy token as the source of a rename, or as the string a pattern failed to match, bridges it, while directing a task to act on one leaves a referent that resolves to nothing for whoever executes it.
  Three sat in the item-law task's own text until this round, each now written as the live item it meant.
- Each of the 402 items in that baseline resolves through the rename map to at least one live destination anchor, a split clause resolving to one per branch so that no branch is dropped to make the count come out.
- Each of the 24 released `META-<N>` items resolves through that map to every current carrier of its concern, item or decision record and a restored one among them, or to a no-successor row that only the owner's amendment admits, an unsettled loss leaving this plan incomplete.
- Each of the 51 baseline records keeps its status and checkbox state, except where a legacy checkbox was factually wrong and the record states why it was corrected.
- Every package file carries the required sections in order and cites no peer behavior from its `Verification` section.
- Every package's `Verification` covers every behavior in that package [[meta-33](../meta.md#meta-33)], which `spex lint` does not check; any gap that stays open leaves this plan incomplete.
- Every item citation uses the outer-bracketed inline form, and the two `src/` comments that link into the legacy layout point at their packages.
- `npm run typecheck`, `npm run lint`, `npm run test`, and `npm run build` stay green, as does every check task 49 adds or cites, including the smoke and acceptance suites `npm run test` excludes.
- A human settles whether the two released `CHANGELOG.md` hyperlinks into the deleted `specs/user/adapters/kimi.md` stay as they are and 404 on `main`, or are repointed at the tag whose release the entry records so the entry stays historically exact, the byte-for-byte rule admitting no third option and this plan not completing until one is chosen.
- A human settles each of the decision record's five approval gates, every loss its map has recorded, `META-15` and `META-26` among them, and every contradiction a move recorded between an item and the artifact it describes, then reviews the full diff before it merges.
