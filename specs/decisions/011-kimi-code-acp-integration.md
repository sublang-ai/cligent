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

## Decision

Cligent shall integrate the current Kimi Code CLI through `kimi acp`.
Each `KimiAdapter.run()` call shall spawn one fresh ACP subprocess, negotiate protocol version 1, create or resume one Kimi session, stream one prompt, and terminate the process after completion or cancellation.
The adapter shall use the official generic `@agentclientprotocol/sdk` version compatible with Kimi's pinned ACP surface; it shall not depend on a Kimi-specific SDK [[6]][[7]].

The client shall advertise no filesystem or terminal capabilities.
Kimi shall therefore retain its process-local filesystem implementation rather than delegating file access back to Cligent [[8]].
Fresh runs shall use `session/new`; resumed runs shall use `session/resume`, not `session/load`, so history is not replayed as new Cligent output.
The session identifier returned before the prompt shall be the backend resume token.
Abort shall send ACP `session/cancel`, drain the terminal prompt result when possible, and then terminate the child.

ACP assistant message chunks shall normalize to UES text deltas.
Raw `agent_thought_chunk` content shall not be emitted because [DR-002](002-unified-event-stream-and-adapter-interface.md) permits only safe reasoning summaries, not chain-of-thought.
Tool calls shall be correlated through ACP tool-call identifiers and normalize to one `tool_use` followed by one terminal `tool_result`.
Permission reverse requests shall emit `permission_request` for observability and receive a fail-closed rejection in headless runs.

An omitted permission policy shall leave Kimi's native configuration in effect.
`PermissionPolicy.mode: 'auto'` shall select Kimi's native ACP `auto` mode.
`mode: 'bypass'` shall be rejected because Kimi's `yolo` mode retains higher-priority static rules and sensitive-operation checks and is not ENG-021's unchecked bypass [[9]][[10]].
A provided policy with no supported whole-mode mapping shall be rejected because ACP sees only permission decisions that Kimi has already reduced to `ask`; it cannot override earlier configured allows, denies, or native safe-tool decisions.
Explicit tool lists shall likewise be rejected because ACP exposes no exact tool-registry restriction.
Valid `writablePaths` accompanying a supported `auto` policy shall be reported as ambient rather than sandbox-enforced.

Kimi's ACP configuration surface exposes thinking as the provider-native binary values `off` and `on`; enabled thinking uses the selected model's default effort [[11]].
`KimiEffort` shall therefore be `'off' | 'on'` rather than Cligent's portable reasoning-depth ladder.
Explicit model selection shall be applied before the thinking toggle.

The adapter shall not start an authentication flow.
Kimi Code `0.27.0` gates ACP session creation on the OAuth credential written by `kimi login`; an API-key provider configuration can select a model after login but does not independently satisfy this ACP gate [[5]][[6]][[14]].
ACP authentication failures shall therefore instruct the user to authenticate through `kimi login`.

## Consequences

Cligent targets the maintained Kimi Code product without coupling to a legacy or unpublished Kimi SDK.
The ACP session identifier is available before model work begins, so fresh aborts can preserve continuity.
Text, tools, permissions, model selection, and cancellation remain structured, while raw Kimi thought content stays outside UES.
One short-lived process per run preserves adapter thread safety and avoids a resident Kimi service.
Kimi users receive a narrower permission, tool-filter, and effort surface than adapters whose vendor APIs expose deterministic per-run controls; unsupported requests fail before backend invocation.
The generic ACP SDK and its schema peer become production dependencies, while Kimi Code itself remains an external CLI with an exact CI conformance target.
Credential-free CI shall always exercise the exact ACP initialization handshake.
Local live acceptance shall resolve an authenticated source home from `CLIGENT_KIMI_ACCEPTANCE_HOME`, then an absolute `KIMI_CODE_HOME`, then Kimi Code's documented `~/.kimi-code` default, and shall resolve `kimi` from PATH or the source home's managed `bin` directory [[13]].
CI live acceptance shall require the explicit dedicated-home override containing `config.toml` and `credentials/kimi-code.json`, and shall fail when it or the authenticated CLI is unavailable, matching the other coding-agent credential gates.
The harness shall clone only the source home's dereferenced configuration and credential directory into one permission-hardened temporary home, share that clone across the complete acceptance suite including bounded retries and fanout, restore the caller environment around each consumer, and remove the clone without mutating the source.
Acceptance files that consume the shared Kimi OAuth clone shall run serially so its mutable credential state has one writer.
An absent or invalid automatically discovered local source shall self-skip with a precise reason.
Because an OAuth refresh performed against a clone may make the source stale, a dedicated CI source shall be treated as disposable and a local source may require `kimi login` again before a later probe.
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
[14]: https://github.com/MoonshotAI/kimi-code/blob/5cc194956f6f9752d172aa4994385d2d2e7a066f/packages/acp-adapter/src/server.ts#L107-L116 "Kimi Code 0.27 ACP authentication gate"
