// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, it, expectTypeOf } from 'vitest';
import {
  EFFORT_SUPPORT,
  assertSupportedEffort,
  isEffortSupported,
} from '../index.js';
import type {
  ClaudeEffort,
  CodexEffort,
  GeminiEffort,
  OpenCodeEffort,
} from '../index.js';
import type {
  AgentEvent,
  AgentEventType,
  AgentAdapter,
  BaseEvent,
  TextPayload,
  PermissionCapability,
  PermissionPolicy,
  WritablePathsEnforcement,
  WritablePathsPermissionMapping,
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

  it('PermissionCapability names the permission-level fields only', () => {
    expectTypeOf<PermissionCapability>().toEqualTypeOf<
      'fileWrite' | 'shellExecute' | 'networkAccess'
    >();
  });

  it('WritablePathsPermissionMapping carries canonical paths and enforcement class', () => {
    const profile: WritablePathsPermissionMapping = {
      paths: ['.git'],
      enforcement: 'profile',
    };
    const sandbox: WritablePathsPermissionMapping = {
      paths: ['generated/cache'],
      enforcement: 'sandbox',
    };
    const ambient: WritablePathsPermissionMapping = {
      paths: ['dist'],
      enforcement: 'ambient',
    };
    expectTypeOf(profile.enforcement).toEqualTypeOf<WritablePathsEnforcement>();
    expectTypeOf(sandbox).toMatchTypeOf<WritablePathsPermissionMapping>();
    expectTypeOf(ambient).toMatchTypeOf<WritablePathsPermissionMapping>();
    const bad: WritablePathsPermissionMapping = {
      paths: ['.git'],
      // @ts-expect-error - enforcement is a closed field-local class
      enforcement: 'filesystem',
    };
    void bad;
  });

  it('BaseEvent.type accepts AgentEventType and arbitrary strings', () => {
    expectTypeOf<AgentEventType>().toMatchTypeOf<BaseEvent['type']>();
    expectTypeOf<string>().toMatchTypeOf<BaseEvent['type']>();
  });

  it('exports exact adapter-scoped effort metadata types', () => {
    expectTypeOf<
      (typeof EFFORT_SUPPORT)['claude-code']['values'][number]
    >().toEqualTypeOf<ClaudeEffort>();
    expectTypeOf<
      (typeof EFFORT_SUPPORT)['codex']['values'][number]
    >().toEqualTypeOf<CodexEffort>();
    expectTypeOf<
      (typeof EFFORT_SUPPORT)['gemini']['values'][number]
    >().toEqualTypeOf<GeminiEffort>();
    expectTypeOf<
      (typeof EFFORT_SUPPORT)['opencode']['values'][number]
    >().toEqualTypeOf<OpenCodeEffort>();

    const candidate: unknown = 'ultra';
    if (isEffortSupported('codex', candidate)) {
      expectTypeOf(candidate).toEqualTypeOf<CodexEffort>();
    }

    let asserted: unknown = 'ultracode';
    assertSupportedEffort('claude-code', asserted);
    expectTypeOf(asserted).toEqualTypeOf<ClaudeEffort>();
  });
});
