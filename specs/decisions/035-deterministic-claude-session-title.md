<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-035: Deterministic Claude Session Title

## Status

Accepted (2026-10-02).

## Context

The Claude SDK can generate a native session title from the first user message, independently of the requested conversational model.
A paired tool-free Opus 5.5 diagnostic reported ancillary Haiku usage without an explicit title and only Opus usage with one.
The SDK documents a `title` option that replaces automatic first-message naming and preserves a resumed session's persisted title [[1]].
Cligent already assigns each fresh Claude session a generated UUID [[claude-code-7](../packages/adapters/claude-code.md#claude-code-7)].

## Decision

Fresh Claude sessions receive the deterministic native title `Cligent <session UUID>` [[claude-code-81](../packages/adapters/claude-code.md#claude-code-81)].
The title uses the existing session identity rather than a prompt, workspace, or model-generated label.
Resumes supply no title and keep the provider's persisted identity and title.
No generic caller setting is added.

## Consequences

- Native history displays an opaque Cligent session identity instead of an automatically generated prose title.
- The adapter does not request automatic title generation; this does not guarantee that every provider-internal inference uses the selected conversational model.
- Model, effort, permissions, delegation, and usage accounting retain their existing contracts.

## References

[1]: https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.284/sdk.d.ts "Claude Agent SDK 0.3.284 title option"
