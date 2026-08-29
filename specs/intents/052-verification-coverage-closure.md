<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-052: Verification Coverage Closure

## Status

Planned.
No implementation task is complete; task 1 is next.
The source audit contains 226 debt rows across 11 packages and at least 259 item scopes, so closing it as one commit would not be reviewable.

## Intent

Close the package verification debt in reviewable slices, giving every stated behavior an integration or system assertion [[meta-21](../meta.md#meta-21)], preferring real behavior to substitutes [[meta-32](../meta.md#meta-32)], and keeping every assertion bound to the same package's behavior [[meta-20](../meta.md#meta-20)].
Each slice independently walks from stated assertions to executing checks and from behaviors back to the assertions that prove every branch, so a citation alone never stands in for coverage [[meta-33](../meta.md#meta-33)].

## Deliverables

- [ ] Licensing, release, package, and Git workflow verification gaps are closed.
- [ ] Claude Code, Codex, Gemini, Kimi, and OpenCode verification gaps are closed.
- [ ] Engine verification gaps are closed.
- [ ] tmux-play verification gaps are closed, including its smoke and acceptance surfaces.
- [ ] Every package behavior is proved by a same-package Verification item and an executing integration or system check.
- [ ] Every stated verification assertion is executed, with any genuinely uncheckable concern settled by its owner and decision record.
- [ ] The final bidirectional audit finds no open verification debt.

## Tasks

Every task below is exactly one commit. Each implementation task changes only its listed scope, adds or strengthens the same-package Verification items and focused integration or system checks together, prefers real behavior, runs the affected focused suites, and removes only debt it demonstrably closes. If a slice exposes a contradiction or an uncheckable released concern, the task shall stop for its owner and carry the approved decision and resulting spec change in that task's commit rather than silently weakening the concern.

1. **Close licensing verification.** Cover `licensing-3`, `licensing-4`, `licensing-6`, `licensing-7`, and `licensing-8`, including a real repository header audit.
2. **Close release verification.** Cover `release-1`, `release-3`, `release-4`, `release-5`, `release-7`, and `release-10` through `release-12` through the real release workflow and smoke composition where feasible.
3. **Close package surface verification.** Cover `package-1`, `package-5`, `package-8`, `package-101`, and `package-102` across declarations, distributable output, documentation, and runtime-target imports.
4. **Close package readiness verification.** Cover `package-103` through `package-105` and `package-201` across lifecycle acquisition, target history, isolated resolution, and verdict behavior.
5. **Close Git workflow verification.** Cover `git-1`, `git-3`, `git-4`, and `git-6`, including raw `Co-authored-by:` line parsing, trailer schema, configured-identity reporting, and refusal before commit creation.
6. **Close Claude loader and handshake verification.** Cover `claude-code-202`, `claude-code-35`, `claude-code-36`, and `claude-code-43`, including a physically absent SDK.
7. **Close Claude normalization verification.** Exhaust the message, block, tool, native-error, alias, default, and priority matrices in `claude-code-201`.
8. **Close Claude terminal verification.** Exhaust `claude-code-41`, `claude-code-44`, `claude-code-45`, `claude-code-47`, and `claude-code-49`, including sequence, duration, result, resume, and accounting boundaries.
9. **Close Claude policy and lifecycle verification.** Exhaust `claude-code-39`, `claude-code-40`, `claude-code-204`, `claude-code-222`, and `claude-code-229`.
10. **Close Claude identity and stream verification.** Cover `claude-code-1`, `claude-code-38`, `claude-code-210`, and `claude-code-220`, including identifier replacement and malformed counter cases.
11. **Close Claude accounting verification.** Exhaust `claude-code-240` across malformed shapes, alias disagreement, unsafe sums, zero values, provenance, and cost selection.
12. **Close Codex loader and init verification.** Cover `codex-202`, `codex-48`, and `codex-41`, including a physically absent SDK and every init fallback.
13. **Close Codex normalization verification.** Exhaust `codex-201`, `codex-44`, `codex-46`, `codex-206`, and `codex-217` across lifecycle, compatibility, file, and error matrices.
14. **Close Codex terminal verification.** Exhaust `codex-42`, `codex-43`, and `codex-45`, including status, result, usage, duration, resume, exhaustion, throw, and abort outcomes.
15. **Close Codex policy and configuration verification.** Exhaust `codex-49`, `codex-50`, `codex-204`, `codex-218`, `codex-221`, `codex-224`, and `codex-229`.
16. **Close Codex identity and executable verification.** Exhaust `codex-51`, `codex-52`, `codex-205`, `codex-211`, `codex-215`, `codex-220`, and `codex-223`.
17. **Close Codex accounting and agent verification.** Cover `codex-1` and exhaust `codex-240`, including source selection, malformed transitions, exact deltas, tool counts, and runtime-model identity.
18. **Close engine option and public-surface verification.** Cover `engine-1`, `engine-7`, `engine-17`, `engine-20`, `engine-103`, `engine-104`, `engine-106`, `engine-107`, and `engine-122`.
19. **Close engine terminal and concurrency verification.** Cover `engine-9`, `engine-12`, `engine-13`, `engine-32`, `engine-35`, and `engine-108` through `engine-113`.
20. **Close engine readiness and effort verification.** Cover `engine-46`, `engine-52`, `engine-115`, `engine-116`, `engine-118`, `engine-209`, `engine-218`, `engine-219`, and `engine-226`.
21. **Close engine accounting, policy, and isolation verification.** Cover `engine-64`, `engine-65`, `engine-69`, `engine-70`, `engine-72`, `engine-202`, `engine-214`, `engine-221`, and `engine-240`.
22. **Close Kimi normalization verification.** Exhaust `kimi-201` across event order, text, tools, plans, permissions, terminals, refusal, duration, and accounting.
23. **Close Kimi configuration and policy verification.** Exhaust `kimi-202`, `kimi-204`, `kimi-218`, and `kimi-222`.
24. **Close Kimi lifecycle and identity verification.** Exhaust `kimi-203`, `kimi-219`, `kimi-220`, and `kimi-229`.
25. **Close Kimi harness verification.** Exhaust `kimi-230` across the real probe, framing, protocol validation, session setup, cleanup, process failures, and failure precedence.
26. **Close Kimi SDK and accounting verification.** Cover `kimi-15` and exhaust `kimi-240` across every terminal status.
27. **Close OpenCode loading and normalization verification.** Exhaust `opencode-201`, `opencode-202`, `opencode-204`, and `opencode-52`.
28. **Close OpenCode startup and option verification.** Exhaust `opencode-53`, `opencode-212`, `opencode-219`, `opencode-222`, and `opencode-227`.
29. **Close OpenCode lifecycle verification.** Exhaust `opencode-231`, `opencode-232`, `opencode-234`, and `opencode-235` across native errors, terminal cleanup, fallback init, and inactivity.
30. **Close OpenCode end-to-end verification.** Exhaust `opencode-237` across managed startup, session ancestry, event processing, permissions, causality, liveness, and teardown.
31. **Close OpenCode accounting and agent verification.** Cover `opencode-1` and exhaust `opencode-240` across causal usage, validity, provenance, malformed values, and omission.
32. **Close Gemini normalization verification.** Exhaust `gemini-201` across messages, tools, progress, plans, errors, terminals, resumption, duration, and accounting.
33. **Close Gemini initialization and policy verification.** Exhaust `gemini-203`, `gemini-204`, and `gemini-207`.
34. **Close Gemini option, identity, and lifecycle verification.** Exhaust `gemini-213`, `gemini-216`, `gemini-218`, `gemini-220`, `gemini-222`, `gemini-225`, and `gemini-229`.
35. **Close Gemini accounting verification.** Exhaust `gemini-240` across file selection, reconciliation, provenance, malformed data, tool counting, and cleanup.
36. **Close Gemini agent and probe verification.** Cover `gemini-1`, `gemini-2`, and `gemini-18`, including the real availability probe and all of its observable branches.
37. **Execute the first tmux-play verification slice.** Close every stated-but-unrun assertion in the contiguous Verification slice from `tmux-play-73` through `tmux-play-119`, inclusive in section order.
38. **Execute the second tmux-play verification slice.** Close every stated-but-unrun assertion in the contiguous Verification slice from `tmux-play-120` through `tmux-play-138`, inclusive in section order.
39. **Execute the third tmux-play verification slice.** Close every stated-but-unrun assertion in the contiguous Verification slice from `tmux-play-139` through `tmux-play-157`, inclusive in section order.
40. **Execute the fourth tmux-play verification slice.** Close every stated-but-unrun assertion in the contiguous Verification slice from `tmux-play-158` through `tmux-play-178`, inclusive in section order.
41. **Execute the final tmux-play verification slice.** Close every stated-but-unrun assertion in the contiguous Verification slice from `tmux-play-179` through `tmux-play-201`, inclusive in section order.
42. **Cover the first tmux-play behavior slice.** Close every behavior branch without a proving assertion in the contiguous External Behavior slice from `tmux-play-1` through `tmux-play-87`, inclusive in section order.
43. **Cover the second tmux-play behavior slice.** Close every behavior branch without a proving assertion in the contiguous External Behavior slice from `tmux-play-8` through `tmux-play-19`, inclusive in section order.
44. **Cover the third tmux-play behavior slice.** Close every behavior branch without a proving assertion in the contiguous External Behavior slice from `tmux-play-85` through `tmux-play-30`, inclusive in section order.
45. **Cover the fourth tmux-play behavior slice.** Close every behavior branch without a proving assertion in the contiguous External Behavior slice from `tmux-play-31` through `tmux-play-66`, inclusive in section order.
46. **Cover the fifth tmux-play behavior slice.** Close every behavior branch without a proving assertion in the contiguous External Behavior slice from `tmux-play-67` through `tmux-play-50`, inclusive in section order, excluding every item then marked superseded for owner settlement.
47. **Cover the final tmux-play behavior slice.** Close every behavior branch without a proving assertion in the contiguous External Behavior slice from `tmux-play-46` through `tmux-play-189`, inclusive in section order, excluding every item then marked superseded for owner settlement.
48. **Reconcile verification coverage.** Reverse-walk every package behavior and every Verification assertion, add no new product behavior, close any residual coverage gap within a newly bounded task rather than hiding it here, audit the trailer-block rule, inventory every focused, smoke, acceptance, type, workflow, and package-output check added above, and mark this record done only when no verification debt remains.

## Verification

- Every package behavior has a same-package Verification assertion that proves every stated branch [[meta-20](../meta.md#meta-20)], [[meta-33](../meta.md#meta-33)].
- Every Verification assertion executes in an integration or system check, preferring the real behavior and recording any unavoidable substitution [[meta-21](../meta.md#meta-21)], [[meta-32](../meta.md#meta-32)].
- No superseded concern is silently treated as covered; its owner settlement precedes closure.
- Every focused, smoke, acceptance, type, workflow, and package-output command introduced or relied upon by the tasks is recorded and green.
- The final bidirectional audit finds no behavior branch without a proving assertion and no stated assertion without an executing check.
