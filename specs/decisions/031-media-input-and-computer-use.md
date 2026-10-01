<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-031: Media Input and Computer Use

## Status

Accepted (2026-10-01).

## Context

The shared API takes a text prompt, but Claude accepts streamed user messages containing image and document blocks [[1]], Codex accepts local-image input parts [[2]], OpenCode accepts file parts [[3]], and Kimi ACP advertises image prompt capability [[4]].
Gemini's headless prompt already expands `@file` references into native multimodal content [[5]].
Kimi's ACP transport has no video input block, while its ReadMediaFile tool reads image and video paths requested in ordinary text [[6]].
These transports have different supported media, so a common-denominator feature would discard useful capabilities.

Computer use requires a configured tool and the applicable runtime and operating-system permissions.
Configured MCP tools can be invoked with ordinary prompts in Claude [[7]], Codex [[8]], and OpenCode [[9]]; Gemini exposes a separately enabled browser agent [[10]], and Kimi supports tool-providing plugins [[11]].
Cligent confines every Claude run to explicitly supplied MCP servers and currently exposes no server option, so native Claude MCP setup alone cannot enable those tools through Cligent, per [DR-030](030-players-see-only-their-own-mcp-servers.md).
An API computer-use tool and a desktop application's computer-use integration do not establish availability in that vendor's headless coding SDK.

## Decision

- Keep the string prompt and existing adapter generics; add optional local-file `attachments` only to per-call options.
- Resolve paths against the call's working directory and infer common MIME types, with an explicit MIME override for unnamed or uncommon extensions.
- Transport supported media natively; reject an unsupported request on only its selected adapter, never omit files or reduce the other adapters' capabilities.
- Claude carries image/PDF blocks, Codex local-image parts, Kimi capability-gated ACP image blocks, and OpenCode inline file data URLs, including when its server is remote.
- Gemini keeps native `@file` prompt syntax rather than introducing a second quoting, path-resolution, or file-reading implementation; its structured attachment option explicitly directs callers to that syntax.
- Leave model eligibility, size limits, decoding, and provider refusals to each runtime; transport support metadata makes no model guarantee.
- Attachments are turn-local and never become instance defaults or implicit resumed-turn input.
- Keep computer-use invocation as a normal prompt where the adapter admits an already configured native or MCP tool, and document setup and configuration-isolation limits instead of inventing a universal enablement flag.
- Preserve Claude MCP confinement; admitting explicit per-run servers remains a separate engine-level decision under [DR-030](030-players-see-only-their-own-mcp-servers.md).
- Do not download remote URLs, introduce media conversion or a computer-control execution loop, change tool restrictions, or broaden permissions.

## Consequences

Existing text calls and custom adapters remain source-compatible.
Hosts can offer each built-in adapter's attachment transport independently, and existing parallel error isolation permits other runs to finish after a rejected media request.
Passing a path selects a local file intentionally; callers remain responsible for choosing files, models, and native tool configuration.
Computer use works only where the installed runtime actually exposes suitable tools; attaching a screenshot does not install such tools.
The reference terminal UI remains a text prompt surface, including native Gemini references and tool-directed media reads.

## References

[1]: https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode "Claude Agent SDK input modes"
[2]: https://developers.openai.com/codex/sdk/ "Codex SDK"
[3]: https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/session/prompt.ts "OpenCode file-part handling"
[4]: https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp "Kimi ACP capabilities"
[5]: https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/nonInteractiveCli.ts "Gemini headless at-command processing"
[6]: https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/tools.md "Kimi ReadMediaFile tool"
[7]: https://code.claude.com/docs/en/mcp "Claude Code MCP tools"
[8]: https://developers.openai.com/codex/mcp/ "Codex MCP tools"
[9]: https://opencode.ai/docs/mcp-servers/ "OpenCode MCP servers"
[10]: https://geminicli.com/docs/core/subagents/ "Gemini browser subagent"
[11]: https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins "Kimi plugins"
