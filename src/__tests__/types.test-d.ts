// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, it, expectTypeOf } from 'vitest';
import type {
  AgentEvent,
  AgentEventType,
  AgentAdapter,
  BaseEvent,
  TextPayload,
  PermissionPolicy,
} from '../types.js';

describe('core types', () => {
  it('narrows discriminated union on type field', () => {
    const event = {} as AgentEvent;
    if (event.type === 'text') {
      expectTypeOf(event.payload).toEqualTypeOf<TextPayload>();
    }
  });

  it('accepts namespaced extension events', () => {
    const event: AgentEvent = {
      type: 'codex:file_change',
      agent: 'codex',
      timestamp: Date.now(),
      sessionId: 'test',
      payload: { path: '/foo' },
    };
    expectTypeOf(event).toMatchTypeOf<AgentEvent>();
  });

  it('AgentAdapter.run() returns AsyncGenerator<AgentEvent>', () => {
    expectTypeOf<AgentAdapter['run']>().returns.toMatchTypeOf<
      AsyncGenerator<AgentEvent, void, void>
    >();
  });

  it('PermissionPolicy fields are optional', () => {
    const empty: PermissionPolicy = {};
    expectTypeOf(empty).toMatchTypeOf<PermissionPolicy>();
  });

  it('PermissionPolicy.mode narrows to the auto / bypass union per ENG-021', () => {
    const auto: PermissionPolicy = { mode: 'auto' };
    const bypass: PermissionPolicy = { mode: 'bypass' };
    expectTypeOf(auto.mode).toEqualTypeOf<'auto' | 'bypass' | undefined>();
    expectTypeOf(bypass.mode).toEqualTypeOf<'auto' | 'bypass' | undefined>();
    // mode coexists with per-capability levels; unset = today's behavior.
    const combined: PermissionPolicy = {
      mode: 'auto',
      fileWrite: 'allow',
      shellExecute: 'ask',
      writablePaths: ['.git'],
    };
    expectTypeOf(combined).toMatchTypeOf<PermissionPolicy>();
    expectTypeOf(combined.writablePaths).toEqualTypeOf<string[] | undefined>();
    // @ts-expect-error - writablePaths must be an array of strings
    const badWritablePaths: PermissionPolicy = { writablePaths: '.git' };
    void badWritablePaths;
    // Invalid mode values are rejected at compile time (verified by
    // `npm run typecheck` against config/tsconfig.test.json).
    // @ts-expect-error - 'wat' is not in the mode union
    const bad: PermissionPolicy = { mode: 'wat' };
    void bad;
  });

  it('BaseEvent.type accepts AgentEventType and arbitrary strings', () => {
    expectTypeOf<AgentEventType>().toMatchTypeOf<BaseEvent['type']>();
    expectTypeOf<string>().toMatchTypeOf<BaseEvent['type']>();
  });
});
