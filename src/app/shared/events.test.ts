// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, it, expect } from 'vitest';
import type { CligentEvent } from '../../types.js';
import { formatCligentEvent } from './events.js';

function makeEvent(
  type: string,
  payload: unknown,
): CligentEvent {
  return {
    type,
    agent: 'claude-code',
    timestamp: Date.now(),
    sessionId: 'test-session',
    payload,
  } as CligentEvent;
}

describe('formatCligentEvent', () => {
  it('formats text_delta events', () => {
    const event = makeEvent('text_delta', { delta: 'hello ' });
    expect(formatCligentEvent(event)).toBe('hello ');
  });

  it('formats text events with trailing newline', () => {
    const event = makeEvent('text', { content: 'hello world' });
    expect(formatCligentEvent(event)).toBe('hello world\n');
  });

  it('formats tool_use events', () => {
    const event = makeEvent('tool_use', {
      toolName: 'read_file',
      toolUseId: 'id-1',
      input: {},
    });
    expect(formatCligentEvent(event)).toBe('[tool: read_file]\n');
  });

  it('formats tool_result with string output', () => {
    const event = makeEvent('tool_result', {
      toolUseId: 'id-1',
      toolName: 'run_shell',
      status: 'success',
      output: 'file.txt\nSENTINEL.txt',
    });
    expect(formatCligentEvent(event)).toBe('file.txt\nSENTINEL.txt\n');
  });

  it('formats tool_result with stdout object', () => {
    const event = makeEvent('tool_result', {
      toolUseId: 'id-2',
      toolName: 'run_shell',
      status: 'success',
      output: { stdout: 'hello world' },
    });
    expect(formatCligentEvent(event)).toBe('hello world\n');
  });

  it('formats tool_result with other object as JSON', () => {
    const event = makeEvent('tool_result', {
      toolUseId: 'id-3',
      toolName: 'read_file',
      status: 'success',
      output: { content: 'data' },
    });
    expect(formatCligentEvent(event)).toBe('{"content":"data"}\n');
  });

  it('formats error events', () => {
    const event = makeEvent('error', {
      message: 'something broke',
      recoverable: false,
    });
    expect(formatCligentEvent(event)).toBe('[error: something broke]\n');
  });

  it('formats done events with status and usage', () => {
    const event = makeEvent('done', {
      status: 'success',
      usage: {
        toolUses: 2,
        tokens: {
          coverage: 'complete',
          totals: { input: { total: 100 }, output: { total: 50 } },
        },
      },
      durationMs: 5000,
    });
    expect(formatCligentEvent(event)).toBe('\n[success | in: 100 out: 50]\n');
  });

  it('renders only the token details the producer measured', () => {
    const event = makeEvent('done', {
      status: 'success',
      usage: {
        toolUses: 2,
        tokens: {
          coverage: 'complete',
          totals: {
            input: { total: 100, uncached: 40, cacheRead: 60, cacheWrite: 0 },
            output: { total: 50 },
          },
        },
      },
      durationMs: 5000,
    });
    expect(formatCligentEvent(event)).toBe(
      '\n[success | in: 100 out: 50 (fresh 40, cache-read 60, cache-write 0)]\n',
    );
  });

  it('marks exact partial token coverage', () => {
    const event = makeEvent('done', {
      status: 'success',
      usage: {
        toolUses: 0,
        tokens: {
          coverage: 'partial',
          totals: { input: { total: 7 }, output: { total: 3 } },
        },
      },
      durationMs: 10,
    });
    expect(formatCligentEvent(event)).toBe(
      '\n[success | in: 7 out: 3 | coverage: partial]\n',
    );
  });

  it('does not render unavailable token placeholders as measured zeroes', () => {
    const event = makeEvent('done', {
      status: 'interrupted',
      usage: {
        toolUses: 3,
      },
      durationMs: 5000,
    });
    expect(formatCligentEvent(event)).toBe(
      '\n[interrupted | tokens: unavailable]\n',
    );
  });

  it('treats legacy flat-token done events as unavailable', () => {
    const event = makeEvent('done', {
      status: 'success',
      usage: { inputTokens: 0, outputTokens: 0, toolUses: 0 },
      durationMs: 5000,
    });
    expect(formatCligentEvent(event)).toBe(
      '\n[success | tokens: unavailable]\n',
    );
  });

  it('returns null for unknown event types', () => {
    const event = makeEvent('init', { model: 'x', cwd: '.', tools: [] });
    expect(formatCligentEvent(event)).toBeNull();
  });

  it('returns null for thinking events', () => {
    const event = makeEvent('thinking', { summary: 'thinking...' });
    expect(formatCligentEvent(event)).toBeNull();
  });
});
