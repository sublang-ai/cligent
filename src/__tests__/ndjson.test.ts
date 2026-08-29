// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { parseNDJSON, type NDJSONParseResult } from '../adapters/ndjson.js';

async function collect(
  stream: AsyncGenerator<NDJSONParseResult, void, void>,
): Promise<NDJSONParseResult[]> {
  const results: NDJSONParseResult[] = [];
  for await (const item of stream) {
    results.push(item);
  }
  return results;
}

describe('parseNDJSON', () => {
  it('parses complete newline-delimited JSON lines', async () => {
    const stream = Readable.from([
      '{"type":"message","content":"hello"}\n',
      '{"type":"message","content":"world"}\n',
    ]);

    const results = await collect(parseNDJSON(stream));

    expect(results).toEqual([
      { ok: true, data: { type: 'message', content: 'hello' } },
      { ok: true, data: { type: 'message', content: 'world' } },
    ]);
  });

  it('handles partial lines split across chunks', async () => {
    const stream = Readable.from([
      '{"type":"message"',
      ',"content":"split"}\n{"type":"tool_use","id":"1"',
      ',"name":"bash"}\n',
    ]);

    const results = await collect(parseNDJSON(stream));

    expect(results).toEqual([
      { ok: true, data: { type: 'message', content: 'split' } },
      { ok: true, data: { type: 'tool_use', id: '1', name: 'bash' } },
    ]);
  });

  it('yields parse errors for malformed lines and continues', async () => {
    const stream = Readable.from([
      '{"type":"message","content":"before"}\n',
      '{bad json}\n',
      '{"type":"message","content":"after"}\n',
    ]);

    const results = await collect(parseNDJSON(stream));

    expect(results[0]).toEqual({
      ok: true,
      data: { type: 'message', content: 'before' },
    });

    expect(results[1].ok).toBe(false);
    if (results[1].ok) {
      throw new Error('Expected parse error result');
    }
    expect(results[1].raw).toBe('{bad json}');
    expect(results[1].error).toContain('JSON');

    expect(results[2]).toEqual({
      ok: true,
      data: { type: 'message', content: 'after' },
    });
  });

  it('strips a trailing carriage return from a malformed line', async () => {
    const stream = Readable.from(['{bad json}\r\n']);

    const results = await collect(parseNDJSON(stream));

    expect(results).toHaveLength(1);
    if (results[0].ok) {
      throw new Error('Expected parse error result');
    }
    expect(results[0].raw).toBe('{bad json}');
  });

  it('applies line rules to final content without a newline (ndjson-207)', async () => {
    const stream = Readable.from([
      '\n',
      '{"type":"message","content":"first"}\n',
      '\r\n',
      '{"type":"message","content":"last"}',
    ]);

    const results = await collect(parseNDJSON(stream));

    expect(results).toEqual([
      { ok: true, data: { type: 'message', content: 'first' } },
      { ok: true, data: { type: 'message', content: 'last' } },
    ]);

    const malformed = await collect(
      parseNDJSON(Readable.from(['{"type":"message"'])),
    );
    expect(malformed).toHaveLength(1);
    if (malformed[0].ok) {
      throw new Error('Expected parse error result');
    }
    expect(malformed[0].raw).toBe('{"type":"message"');
    expect(malformed[0].error).toContain('JSON');

    expect(await collect(parseNDJSON(Readable.from([' \t\r'])))).toEqual([]);

    const carriageReturn = await collect(
      parseNDJSON(Readable.from(['{bad json}\r'])),
    );
    expect(carriageReturn).toHaveLength(1);
    if (carriageReturn[0].ok) {
      throw new Error('Expected parse error result');
    }
    expect(carriageReturn[0].raw).toBe('{bad json}');
    expect(carriageReturn[0].error).toContain('JSON');
  });
});
