<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# ndjson: NDJSON Parser

## Intent

This package gives a caller one reusable `parseNDJSON()` async generator for reading newline-delimited JSON off a stream.
It owns how the stream is framed into lines and what each line parses to, not what a caller does with the results.

## External Behavior

### ndjson-1

`parseNDJSON()` shall accept a `Readable` stream and return an async generator of `NDJSONParseResult`.

### ndjson-2

While a line has yet to reach its newline, `parseNDJSON()` shall buffer it across chunks and yield no result for it until the line is complete.

### ndjson-3

When a line contains valid JSON, `parseNDJSON()` shall yield `{ ok: true, data }`.

### ndjson-4

When a line contains malformed JSON, `parseNDJSON()` shall yield `{ ok: false, error, raw }`, and the stream shall continue.

### ndjson-5

When a line is empty or holds only whitespace, `parseNDJSON()` shall skip it.

### ndjson-6

`parseNDJSON()` shall strip a trailing carriage return from every line it reads.

## Verification

### ndjson-207

When `parseNDJSON()` reads a real stream carrying partial lines, malformed JSON, carriage returns, and blank lines, the verification shall assert the `NDJSONParseResult` values it yields:

- the call returns an async generator over the `Readable` it was given [[ndjson-1](#ndjson-1)];
- a line split across chunks yields one result, and not before its newline arrives [[ndjson-2](#ndjson-2)];
- a valid line yields `{ ok: true, data }` [[ndjson-3](#ndjson-3)];
- a malformed line yields `{ ok: false, error, raw }`, and the stream continues [[ndjson-4](#ndjson-4)];
- an empty or whitespace-only line yields nothing [[ndjson-5](#ndjson-5)];
- a malformed line ending in a carriage return reports `raw` without it [[ndjson-6](#ndjson-6)].
