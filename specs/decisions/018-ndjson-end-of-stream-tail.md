<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-018: NDJSON End-of-Stream Tail

## Status

Accepted

## Context

The released framing rule now carried by [[ndjson-2](../packages/ndjson.md#ndjson-2)] required `parseNDJSON()` to emit a result only for a complete newline-delimited line, while the parser and its test have read a non-empty unterminated tail at end of stream since the parser was introduced.
While a stream remains open, withholding a partial line prevents premature parsing because more bytes can still arrive.
After the stream ends, no more bytes can arrive, and discarding the final buffered content could lose the Gemini adapter's terminal event.
A malformed tail remains observable through the parser's ordinary error result instead of disappearing silently.

## Decision

- `parseNDJSON()` keeps buffering partial content while the stream is open and emits no result until a newline completes that line.
- When the stream ends with non-empty content that no newline terminated, the parser reads that content as the final line under the same valid, malformed, blank, and carriage-return rules as every other line.
- [[ndjson-2](../packages/ndjson.md#ndjson-2)] owns the framing boundary, and [[ndjson-7](../packages/ndjson.md#ndjson-7)] owns the end-of-stream tail case split from the released concern.

## Consequences

- The parser's released, test-pinned end-of-stream behavior remains unchanged.
- A valid final event is not lost merely because its producer omitted the trailing newline.
- A truncated malformed fragment yields the ordinary visible parse error with its raw content.
- [DR-017](017-spec-generation-migration.md) maps the released framing concern to both current carriers.
