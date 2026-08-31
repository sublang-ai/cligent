<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-011: Kimi Code ACP Integration

## Status

Accepted

## Context

Moonshot AI is winding down the Python `MoonshotAI/kimi-cli` project in favor of the TypeScript Kimi Code CLI in `MoonshotAI/kimi-code` [[1]][[2]].
The published `@moonshot-ai/kimi-agent-sdk` launches the legacy CLI's Wire mode, while the successor's in-process `@moonshot-ai/kimi-code-sdk` package is private and unpublished [[3]][[4]].
Neither Kimi-specific SDK is therefore a suitable supported dependency for Cligent.

The successor CLI exposes three automation surfaces.
Prompt mode can emit `stream-json`, ACP mode exposes JSON-RPC over stdio for external clients, and server mode exposes a persistent REST and WebSocket service [[5]][[6]].
Prompt mode always uses Kimi's headless `auto` policy, omits thinking content from JSONL, and publishes the resumable session identifier only after a successful prompt [[5]][[12]].
The omission preserves thought privacy, but prompt mode cannot preserve Cligent's native-default permission posture, structured permission and cancellation flow, or early fresh-session resume continuity.
The persistent server adds lifecycle and network state that Cligent's stateless per-run adapter does not need.
A caller cancellation can become terminal before process cleanup later discovers a nonzero or unexpected close, required `SIGKILL`, or a child surviving final grace.
Because terminal `done` closes the unified event stream, preserving cancellation-before-termination and replacing that terminal with a subsequently discovered cleanup error are incompatible.

## Decision

Cligent shall integrate the current Kimi Code CLI through `kimi acp`.
Each `KimiAdapter.run()` call shall spawn one fresh ACP subprocess, negotiate protocol version 1, create or resume one Kimi session, stream one prompt, and terminate the process after completion or cancellation.
The adapter shall use the official generic `@agentclientprotocol/sdk` version compatible with Kimi's pinned ACP surface; it shall not depend on a Kimi-specific SDK [[6]][[7]].

The client shall advertise no filesystem or terminal capabilities.
Kimi shall therefore retain its process-local filesystem implementation rather than delegating file access back to Cligent [[8]].
Fresh runs shall use `session/new`; resumed runs shall use `session/resume`, not `session/load`, so history is not replayed as new Cligent output.
The session identifier returned before the prompt shall be the backend resume token.
Terminal selection shall use the first applicable row of this priority table:

| Priority state | Selected outcome |
| --- | --- |
| caller signal already aborted at adapter entry | interruption before runtime and option validation, with no child spawned |
| no entry abort; runtime or option validation fails | propagate the rejection before spawning or emitting events |
| caller abort after spawn and before another terminal cause commits | interruption ahead of every native stop, authentication, protocol, setup, prompt, process, or cleanup outcome |
| no caller abort; authentication-classified ACP failure | actionable authentication error |
| no higher candidate; protocol failure | protocol error |
| no higher candidate; child spawn or asynchronous process error, nonzero or unexpected-signal close, required `SIGKILL`, or survival through final grace | process error, overriding every native stop including `cancelled` |
| no higher candidate; another setup or prompt failure | operation error |
| valid native stop after a clean close or adapter-owned cleanup `SIGTERM` | the native stop mapping |

The first observed caller abort or non-provisional failure shall commit its terminal cause synchronously before initiating forced teardown; a native stop remains provisional until clean close or adapter-owned `SIGTERM` cleanup commits it, and a later failure may still replace a lower-priority non-abort candidate.
After backend identity is known and caller abort commits first, abort shall send ACP `session/cancel` exactly once and drain the active prompt result and queued updates when possible.
The interrupted `done` shall be queued before abort-initiated final child termination begins; containment shall wait until an active consumer advances past it or one event-loop handoff completes, whichever occurs first, and shall never require another iterator request.
A cleanup failure discovered afterward shall invoke a constructor-supplied `reportCleanupFailure` exactly once with the cleanup `Error`, or shall make one default `console.error` call with `Kimi ACP cleanup after caller abort failed: ${error.message}` when no reporter is supplied, without adding a post-terminal event or replacing the interrupted outcome.
A supplied reporter's exception shall be suppressed without restarting containment or invoking the default reporter.
Containment shall retain the caller's abort listener until a terminal cause commits and remove it at that boundary.
Every path shall share one idempotent containment sequence even when the child survives final grace.

ACP assistant message chunks shall normalize to UES text deltas.
Raw `agent_thought_chunk` content shall not be emitted because [DR-002](002-unified-event-stream-and-adapter-interface.md) permits only safe reasoning summaries, not chain-of-thought.
Tool calls shall be correlated through ACP tool-call identifiers and normalize to one `tool_use` followed by one terminal `tool_result`.
Permission reverse requests shall emit `permission_request` for observability and receive a fail-closed rejection in headless runs.

An omitted permission policy shall leave Kimi's native configuration in effect.
`PermissionPolicy.mode: 'auto'` shall select Kimi's native ACP `auto` mode.
`mode: 'bypass'` shall be rejected because Kimi's `yolo` mode retains higher-priority static rules and sensitive-operation checks and is not engine-52's unchecked bypass [[9]][[10]].
A provided policy with no supported whole-mode mapping shall be rejected because ACP sees only permission decisions that Kimi has already reduced to `ask`; it cannot override earlier configured allows, denies, or native safe-tool decisions.
Explicit tool lists shall likewise be rejected because ACP exposes no exact tool-registry restriction.
Valid `writablePaths` accompanying a supported `auto` policy shall be reported as ambient rather than sandbox-enforced.

Kimi's ACP configuration surface exposes thinking as the provider-native binary values `off` and `on`; enabled thinking uses the selected model's default effort [[11]].
`KimiEffort` shall therefore be `'off' | 'on'` rather than Cligent's portable reasoning-depth ladder.
Explicit model selection shall be applied before the thinking toggle.

The adapter shall not start an authentication flow.
Kimi Code `0.39.1` dispatches `kimi acp` to its native v2 server unless `KIMI_CODE_LEGACY_FLAG` is truthy [[18]].
That native server gates ACP session creation on any of three routes: stored OAuth material resolved from the default model or reported by any logged-in provider, including after `kimi login`; a configured default model whose alias resolves to non-OAuth credentials; or the `KIMI_MODEL_NAME` plus `KIMI_MODEL_API_KEY` environment overlay, which synthesizes a provider and alias in the runtime configuration only and makes it the default model [[5]][[6]][[14]][[15]][[16]][[19]][[20]].
A bare provider key such as `MOONSHOT_API_KEY` or `KIMI_API_KEY` satisfies none of them, because it establishes no default model alias.
ACP authentication failures shall therefore instruct the user to authenticate through `kimi login`.

## Consequences

Cligent targets the maintained Kimi Code product without coupling to a legacy or unpublished Kimi SDK.
The ACP session identifier is available before model work begins, so fresh aborts can preserve continuity.
Text, tools, permissions, model selection, and cancellation remain structured, while raw Kimi thought content stays outside UES.
One short-lived process per run preserves adapter thread safety and avoids a resident Kimi service.
Caller cancellation remains the terminal cause of an aborted run, while a bounded delivery handoff keeps containment live and abnormal or forced cleanup remains observable as secondary diagnostic detail that cannot restart it.
Without caller cancellation, process failure takes precedence over a provisional native outcome, including native cancellation.
Kimi users receive a narrower permission, tool-filter, and effort surface than adapters whose vendor APIs expose deterministic per-run controls; unsupported requests fail before backend invocation.
The generic ACP SDK and its schema peer become production dependencies, while Kimi Code itself remains an external CLI with an exact CI conformance target.
Wire-schema ownership sits with the adapter, not with the protocol SDK.
The SDK generates a complete set of schemas but publishes them only inside its build output, so consuming them means depending on a file layout rather than on an interface — a dependency its `1.3.0` `exports` map ended, without offering any public replacement.
Their generation also diverges from what this adapter needs in kind rather than in detail: they validate the entire protocol where the adapter reads a small subset of it, and they broadly salvage malformed payloads.
The adapter therefore validates control fields it consumes against schemas held in this repository, strictly, while ignoring everything else, so an agent may extend the protocol without this client calling valid traffic malformed.
Optional prompt usage and the pinned runtime's session-context `usage_update` are the deliberate exceptions: neither exposes invocation accounting per [[kimi-13](../packages/adapters/kimi.md#kimi-13)], and a malformed unstable extension is ignored instead of changing an otherwise completed turn into the malformed-control error required by [[kimi-27](../packages/adapters/kimi.md#kimi-27)].
Credential-free CI shall always exercise the exact ACP initialization handshake.
This handshake is the release-critical Kimi signal: it validates the protocol surface the adapter depends on, runs against an empty `KIMI_CODE_HOME`, and never needs a credential.
Local live acceptance shall resolve an authenticated source home from `CLIGENT_KIMI_ACCEPTANCE_HOME`, then an absolute `KIMI_CODE_HOME`, then Kimi Code's documented `~/.kimi-code` default, and shall resolve `kimi` from PATH or the source home's managed `bin` directory [[13]].
CI live acceptance shall require the explicit dedicated-home override containing `config.toml` and `credentials/kimi-code.json`, and shall fail when that fixture or the authenticated CLI is absent, matching the other coding-agent credential gates.

An absent fixture and a spent credential are distinct conditions and shall be gated differently.
On the native v2 path, session readiness first resolves the default model's API-key or OAuth material and then falls back to any logged-in OAuth provider; a bare `KIMI_API_KEY` creates neither a provider nor a default model and therefore cannot act as a non-interactive credential [[14]][[15]][[16]][[19]].
The acceptance harness takes that route, so its fixture is an OAuth credential and the gating below concerns that credential's lifetime.
Its refresh response is required to carry a replacement `refresh_token`, which the CLI persists into whichever home performed the refresh; a refusal writes a revoked tombstone into that home instead, and the tombstone then fails every later leg sharing that home [[17]].
A credential restored from an immutable store is therefore single-use whenever a run refreshes it: the replacement is discarded with the temporary home, leaving the stored token spent.
Refresh is lazy — it fires only once the token is within `max(300s, expires_in / 2)` of expiry — so a run early in a credential's life can pass without exercising the network auth path at all, and its success is not evidence that the credential still works.
Two mechanisms can independently deny a refresh, and which one governs a given failure has not been established here: the stored token may already have been rotated away, or the refresh may be rejected because the cloned home presents a different `device_id` than the one that logged in, since the CLI mints a fresh identifier when that file is absent and sends it with the refresh request.
Either way the credential cannot be relied upon across stateless runs, so live acceptance shall probe credential usability once, before any leg runs, and shall self-skip the live Kimi legs with a precise reason when the credential is rejected — including under `CI`, where failing would report a false regression rather than a defect in this repository.
The probe shall exercise a model call, not merely session setup: the gate treats any non-empty access token as authenticated without consulting its expiry, so `session/new` succeeds against a credential that a prompt then rejects.
A clone shall reproduce the source home's `device_id` when it exists, so a cloned run presents the same device identity as the login it descends from.
Continuous live Kimi coverage in CI requires a writable, persistent credential home that retains each rotation — a self-hosted runner holding its own `~/.kimi-code`, or a run that writes the rotated credential back to the secret it came from — and either arrangement is outside this decision.
The harness shall clone only the source home's dereferenced configuration and credential directory into one permission-hardened temporary home, share that clone across the complete acceptance suite including bounded retries and fanout, restore the caller environment around each consumer, and remove the clone without mutating the source.
Acceptance files that consume the shared Kimi OAuth clone shall run serially so its mutable credential state has one writer.
An absent or invalid automatically discovered local source shall self-skip with a precise reason.
Because a refresh performed against a clone rotates the shared server-side token, a dedicated CI source is consumed by its first refreshing run and a local source may require `kimi login` again before a later probe.
A local source and a CI fixture copied from it share one token lineage, so exercising either invalidates the other; a CI fixture shall therefore come from an account dedicated to CI.
A future public, documented Kimi Code SDK may replace the ACP subprocess only through a new decision that preserves the same observable contract.

## References

[1]: https://github.com/MoonshotAI/kimi-cli "MoonshotAI legacy Kimi CLI"
[2]: https://github.com/MoonshotAI/kimi-code "MoonshotAI Kimi Code"
[3]: https://github.com/MoonshotAI/kimi-agent-sdk "MoonshotAI legacy Kimi Agent SDK"
[4]: https://github.com/MoonshotAI/kimi-code/tree/main/packages/node-sdk "Kimi Code private Node SDK package"
[5]: https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command "Kimi Code command reference"
[6]: https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html "Kimi Code ACP reference"
[7]: https://agentclientprotocol.com/libraries/typescript "Official ACP TypeScript library"
[8]: https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-adapter/src/kaos-acp.ts "Kimi Code ACP filesystem bridge"
[9]: https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-adapter/src/modes.ts "Kimi Code ACP modes"
[10]: https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files "Kimi Code permission rules"
[11]: https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-adapter/src/config-options.ts "Kimi Code ACP configuration options"
[12]: https://github.com/MoonshotAI/kimi-code/blob/main/apps/kimi-code/src/cli/run-prompt.ts "Kimi Code prompt-mode implementation"
[13]: https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html "Kimi Code data locations"
[14]: https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/packages/acp-server/src/server.ts#L619-L640 "Kimi Code 0.39.1 native ACP authentication gate"
[15]: https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/packages/agent-core-v2/src/app/auth/authService.ts#L628-L695 "Kimi Code 0.39.1 default-model and OAuth readiness"
[16]: https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/packages/agent-core-v2/src/app/kosongConfig/envOverlay.ts#L87-L174 "Kimi Code 0.39.1 environment model overlay"
[17]: https://github.com/MoonshotAI/kimi-code/blob/main/packages/oauth/src/oauth-manager.ts "Kimi Code OAuth manager — refresh rotation, persistence, and revoked tombstone"
[18]: https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/apps/kimi-code/src/cli/sub/acp.ts#L1-L44 "Kimi Code 0.39.1 native ACP dispatch"
[19]: https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/packages/agent-core-v2/src/app/kosongConfig/configSection.ts#L23-L71 "Kimi Code 0.39.1 environment provider credentials"
[20]: https://github.com/MoonshotAI/kimi-code/blob/5efca0c3116743855c28426000073bfe34a4862f/packages/agent-core-v2/src/kosong/model/modelAuth.ts#L27-L73 "Kimi Code 0.39.1 model and provider authentication resolution"
