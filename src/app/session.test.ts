// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, it, expect } from 'vitest';
import { formatEvent } from './session.js';
import type { CligentEvent } from '../types.js';

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

describe('formatEvent', () => {
  it('formats text_delta events', () => {
    const event = makeEvent('text_delta', { delta: 'hello ' });
    expect(formatEvent(event)).toBe('hello ');
  });

  it('formats text events with trailing newline', () => {
    const event = makeEvent('text', { content: 'hello world' });
    expect(formatEvent(event)).toBe('hello world\n');
  });

  it('formats tool_use events', () => {
    const event = makeEvent('tool_use', {
      toolName: 'read_file',
      toolUseId: 'id-1',
      input: {},
    });
    expect(formatEvent(event)).toBe('[tool: read_file]\n');
  });

  it('formats error events', () => {
    const event = makeEvent('error', {
      message: 'something broke',
      recoverable: false,
    });
    expect(formatEvent(event)).toBe('[error: something broke]\n');
  });

  it('formats done events with status and usage', () => {
    const event = makeEvent('done', {
      status: 'success',
      usage: { inputTokens: 100, outputTokens: 50, toolUses: 2 },
      durationMs: 5000,
    });
    expect(formatEvent(event)).toBe('\n[success | in: 100 out: 50]\n');
  });

  it('returns null for unknown event types', () => {
    const event = makeEvent('init', { model: 'x', cwd: '.', tools: [] });
    expect(formatEvent(event)).toBeNull();
  });

  it('returns null for thinking events', () => {
    const event = makeEvent('thinking', { summary: 'thinking...' });
    expect(formatEvent(event)).toBeNull();
  });
});
