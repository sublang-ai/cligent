// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';

import {
  zAcpError,
  zAcpInitializeResponse,
  zAcpNewSessionResponse,
  zAcpPromptResponse,
  zAcpRequestPermissionRequest,
  zAcpResumeSessionResponse,
  zAcpSessionNotification,
  zAcpSetSessionConfigOptionResponse,
} from '../adapters/acp-schema.js';

// KIMI-005 / KIMI-006 / DR-011: the adapter owns these schemas because the
// protocol SDK publishes its generated ones only inside `dist/`. Control
// fields stay strict, while malformed optional usage is failure-isolated.
describe('owned ACP wire schemas (KIMI-005 / KIMI-006)', () => {
  it.each([
    [
      'non-numeric input',
      { totalTokens: 3, inputTokens: 'nope', outputTokens: 2 },
    ],
    [
      'negative input',
      { totalTokens: 2, inputTokens: -1, outputTokens: 2 },
    ],
    [
      'fractional output',
      { totalTokens: 3, inputTokens: 1, outputTokens: 2.5 },
    ],
    [
      'invalid cache read',
      {
        totalTokens: 3,
        inputTokens: 1,
        outputTokens: 2,
        cachedReadTokens: -1,
      },
    ],
    [
      'invalid cache write',
      {
        totalTokens: 3,
        inputTokens: 1,
        outputTokens: 2,
        cachedWriteTokens: 0.5,
      },
    ],
  ])('isolates %s token accounting', (_case, usage) => {
    expect(
      zAcpPromptResponse.parse({ stopReason: 'end_turn', usage }),
    ).toEqual({ stopReason: 'end_turn', usage: null });
  });

  it('rejects an unrecognized stop reason', () => {
    // stopReason drives the terminal done status, so an unknown value must
    // not fall through to 'success'.
    expect(() => zAcpPromptResponse.parse({ stopReason: 'exploded' })).toThrow();
    for (const stopReason of [
      'end_turn',
      'max_tokens',
      'max_turn_requests',
      'refusal',
      'cancelled',
    ]) {
      expect(zAcpPromptResponse.parse({ stopReason }).stopReason).toBe(
        stopReason,
      );
    }
  });

  it('folds optional and absent usage counters', () => {
    expect(
      zAcpPromptResponse.parse({
        stopReason: 'end_turn',
        usage: {
          totalTokens: 12,
          inputTokens: 3,
          outputTokens: 4,
          cachedReadTokens: 5,
        },
      }).usage,
    ).toMatchObject({ inputTokens: 3, outputTokens: 4, cachedReadTokens: 5 });
    expect(
      zAcpPromptResponse.parse({ stopReason: 'end_turn', usage: null }).usage,
    ).toBeNull();
  });

  it('requires the fields the adapter reads off a session', () => {
    expect(() => zAcpNewSessionResponse.parse({})).toThrow();
    expect(zAcpNewSessionResponse.parse({ sessionId: 'abc' })).toMatchObject({
      sessionId: 'abc',
    });
    expect(() => zAcpInitializeResponse.parse({})).toThrow();
    expect(
      zAcpInitializeResponse.parse({ protocolVersion: 1 }).protocolVersion,
    ).toBe(1);
  });

  it('carries config options through for the model lookup', () => {
    const parsed = zAcpSetSessionConfigOptionResponse.parse({
      configOptions: [
        { id: 'model', type: 'select', currentValue: 'kimi-k2', options: [] },
        { id: 'thinking', type: 'select', currentValue: 'high', options: [] },
      ],
    });
    expect(parsed.configOptions?.[0]).toMatchObject({
      id: 'model',
      currentValue: 'kimi-k2',
    });
    // Kimi Code 0.31.1 reports a per-model effort ladder here rather than the
    // binary on/off it used to; the adapter reads only `model`, so the value
    // passes through untouched.
    expect(parsed.configOptions?.[1]?.currentValue).toBe('high');
    expect(zAcpResumeSessionResponse.parse({}).configOptions).toBeUndefined();
    // A select without its current value is malformed: the adapter reads that
    // field to report the effective model.
    expect(() =>
      zAcpSetSessionConfigOptionResponse.parse({
        configOptions: [{ id: 'model', type: 'select', options: [] }],
      }),
    ).toThrow();
  });

  it('rejects session/update parameters that name no update', () => {
    expect(() => zAcpSessionNotification.parse({})).toThrow();
    expect(() =>
      zAcpSessionNotification.parse({ sessionId: 's', update: {} }),
    ).toThrow();
  });

  it('accepts an unknown update case and unknown fields', () => {
    // Protocol growth must not be reported as malformed traffic: the adapter
    // ignores cases it does not handle.
    expect(
      zAcpSessionNotification.parse({
        sessionId: 's',
        update: { sessionUpdate: 'something_new', payload: { a: 1 } },
      }).update.sessionUpdate,
    ).toBe('something_new');
    expect(
      zAcpSessionNotification.parse({
        sessionId: 's',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hi', futureField: true },
        },
      }).update,
    ).toMatchObject({ sessionUpdate: 'agent_message_chunk' });
  });

  it('requires the consumed shape of a handled update case', () => {
    expect(() =>
      zAcpSessionNotification.parse({
        sessionId: 's',
        update: { sessionUpdate: 'agent_message_chunk' },
      }),
    ).toThrow();
    expect(() =>
      zAcpSessionNotification.parse({
        sessionId: 's',
        update: { sessionUpdate: 'tool_call' },
      }),
    ).toThrow();
  });

  it('validates permission requests and JSON-RPC errors', () => {
    const validPermission = {
      sessionId: 's',
      toolCall: { toolCallId: 'tc-1', title: 'Read', kind: 'read' },
      options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
    };
    expect(zAcpRequestPermissionRequest.parse(validPermission).options).toHaveLength(1);
    // The adapter reports the requesting tool and selects a rejection option
    // by kind, id, and name, so each of those is required.
    expect(() => zAcpRequestPermissionRequest.parse({ sessionId: 's' })).toThrow();
    expect(() =>
      zAcpRequestPermissionRequest.parse({ ...validPermission, toolCall: undefined }),
    ).toThrow();
    expect(() =>
      zAcpRequestPermissionRequest.parse({
        ...validPermission,
        options: [{ optionId: 'allow', kind: 'allow_once' }],
      }),
    ).toThrow();
    expect(() =>
      zAcpRequestPermissionRequest.parse({
        ...validPermission,
        options: [{ optionId: 'allow', name: 'Allow', kind: 'not_a_kind' }],
      }),
    ).toThrow();
    expect(() => zAcpError.parse({ message: 'no code' })).toThrow();
    expect(zAcpError.parse({ code: -32000, message: 'Authentication required' })).toMatchObject({
      code: -32000,
    });
  });
});
