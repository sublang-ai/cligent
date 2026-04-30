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
      usage: { inputTokens: 100, outputTokens: 50, toolUses: 2 },
      durationMs: 5000,
    });
    expect(formatCligentEvent(event)).toBe('\n[success | in: 100 out: 50]\n');
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
