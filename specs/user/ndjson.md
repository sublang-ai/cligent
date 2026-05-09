<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# NDJSON: NDJSON Parser

## Intent

This component defines the reusable `parseNDJSON()` async generator utility.

## Parser Behavior

### NDJSON-001

`parseNDJSON()` shall accept a `Readable` stream and return an async generator of `NDJSONParseResult`.

### NDJSON-002

`parseNDJSON()` shall buffer partial lines across chunks, emitting a result only when a complete newline-delimited line is available.

### NDJSON-003

When a line contains valid JSON, `parseNDJSON()` shall yield `{ ok: true, data }`.

### NDJSON-004

When a line contains malformed JSON, `parseNDJSON()` shall yield `{ ok: false, error, raw }` and the stream shall continue.

### NDJSON-005

Empty lines and whitespace-only lines shall be skipped, and trailing carriage returns shall be stripped.
