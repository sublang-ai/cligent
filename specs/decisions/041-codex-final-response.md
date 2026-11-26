<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-041: Codex final response selection

## Status

Accepted (2026-10-30).
Amends [DR-002](002-unified-event-stream-and-adapter-interface.md).

## Decision

This amends [DR-002](002-unified-event-stream-and-adapter-interface.md)'s terminal `result` for Codex.

- Follow the public Codex SDK `Thread.run()` finalResponse contract: retain the text of the last completed `agent_message` in the current run as the terminal result fallback.
- Explicit string-valued native turn/event result keeps precedence, including empty strings; no JSON substring scraping, content repair or prompt-specific parsing.
- Keep every intermediate text event in its original stream and journal, with existing usage, resume, cancellation and permission behavior.
- A run-local variable prevents carrying a previous turn's final answer into a new run.

## Context

The installed SDK and [public SDK source](https://github.com/openai/codex/blob/main/sdk/typescript/src/thread.ts) assign `finalResponse = event.item.text` for each completed agent message.
Native SPEX workflow acceptance exposed progress text concatenated with its final JSON: the real Mac APP case implementation emitted two progress messages and one final JSON; concatenating all three made strict JSON parsing fail after its successful local test.

## Consequences

Hosts receive an authentic whole final message while their full progress journal remains available.
No workflow-specific JSON parser or relaxed assertion is introduced.
