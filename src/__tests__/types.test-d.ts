// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, it, expectTypeOf } from 'vitest';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { CodexAdapter } from '../adapters/codex.js';
import { GeminiAdapter } from '../adapters/gemini.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
import {
  AdapterRegistry,
  Cligent,
  EFFORT_SUPPORT,
  assertSupportedEffort,
  isEffortSupported,
  runAgent,
  runParallel,
} from '../index.js';
import type {
  AgentAdapter,
  AgentOptions,
  ClaudeEffort,
  CodexEffort,
  Effort,
  GeminiEffort,
  OpenCodeEffort,
  PortableEffort,
} from '../index.js';
import type {
  AgentEvent,
  AgentEventType,
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

  it('renames the public option and correlates direct adapter calls', () => {
    expectTypeOf<PortableEffort>().toEqualTypeOf<
      'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    >();
    expectTypeOf<ClaudeEffort>().toEqualTypeOf<PortableEffort | 'ultracode'>();
    expectTypeOf<CodexEffort>().toEqualTypeOf<PortableEffort | 'ultra'>();
    const options: AgentOptions = { effort: 'ultra' };
    expectTypeOf(options.effort).toEqualTypeOf<Effort | undefined>();
    // @ts-expect-error - the public option was renamed to effort
    const legacy: AgentOptions = { reasoningEffort: 'high' };
    void legacy;

    const claudeAdapter = {} as AgentAdapter<ClaudeEffort>;
    const codexAdapter = {} as AgentAdapter<CodexEffort>;
    void claudeAdapter.run('prompt', { effort: 'ultracode' });
    void codexAdapter.run('prompt', { effort: 'ultra' });
    // @ts-expect-error - ultra belongs only to Codex
    void claudeAdapter.run('prompt', { effort: 'ultra' });
    // @ts-expect-error - ultracode belongs only to Claude Code
    void codexAdapter.run('prompt', { effort: 'ultracode' });
  });

  it('preserves built-in and custom vocabularies through Cligent', () => {
    const claudeAdapter = {} as AgentAdapter<ClaudeEffort>;
    const codexAdapter = {} as AgentAdapter<CodexEffort>;
    const claude = new Cligent(claudeAdapter, { effort: 'ultracode' });
    const codex = new Cligent(codexAdapter, { effort: 'ultra' });
    void claude.run('prompt', { effort: 'max' });
    void codex.run('prompt', { effort: 'max' });
    // @ts-expect-error - NoInfer prevents constructor options widening Claude
    new Cligent(claudeAdapter, { effort: 'ultra' });
    // @ts-expect-error - run overrides remain Claude-scoped
    void claude.run('prompt', { effort: 'ultra' });
    // @ts-expect-error - NoInfer prevents constructor options widening Codex
    new Cligent(codexAdapter, { effort: 'ultracode' });
    // @ts-expect-error - run overrides remain Codex-scoped
    void codex.run('prompt', { effort: 'ultracode' });

    type CustomEffort = 'quick' | 'deep' | 'exhaustive';
    const customAdapter = {} as AgentAdapter<CustomEffort>;
    const custom = new Cligent(customAdapter, { effort: 'deep' });
    void custom.run('prompt', { effort: 'exhaustive' });
    // @ts-expect-error - custom adapters retain their own vocabulary
    new Cligent(customAdapter, { effort: 'ultra' });
  });

  it('binds the concrete Claude adapter to Claude effort values', () => {
    const claude = new Cligent(new ClaudeCodeAdapter(), {
      effort: 'ultracode',
    });
    void claude.run('prompt', { effort: 'max' });
    // @ts-expect-error - ultra is a Codex-only orchestration value
    new Cligent(new ClaudeCodeAdapter(), { effort: 'ultra' });
    // @ts-expect-error - run overrides remain Claude-scoped
    void claude.run('prompt', { effort: 'ultra' });
  });

  it('binds the concrete Codex adapter to Codex effort values', () => {
    const codex = new Cligent(new CodexAdapter(), { effort: 'ultra' });
    void codex.run('prompt', { effort: 'max' });
    // @ts-expect-error - ultracode is a Claude-only orchestration value
    new Cligent(new CodexAdapter(), { effort: 'ultracode' });
    // @ts-expect-error - run overrides remain Codex-scoped
    void codex.run('prompt', { effort: 'ultracode' });
  });

  it('binds the concrete Gemini adapter to portable effort values', () => {
    const gemini = new Cligent(new GeminiAdapter(), { effort: 'max' });
    void gemini.run('prompt', { effort: 'minimal' });
    // @ts-expect-error - Gemini does not accept Codex ultra
    new Cligent(new GeminiAdapter(), { effort: 'ultra' });
    // @ts-expect-error - Gemini does not accept Claude ultracode
    void gemini.run('prompt', { effort: 'ultracode' });
  });

  it('binds the concrete OpenCode adapter to portable effort values', () => {
    const opencode = new Cligent(new OpenCodeAdapter(), { effort: 'max' });
    void opencode.run('prompt', { effort: 'minimal' });
    // @ts-expect-error - OpenCode does not accept Codex ultra
    new Cligent(new OpenCodeAdapter(), { effort: 'ultra' });
    // @ts-expect-error - OpenCode does not accept Claude ultracode
    void opencode.run('prompt', { effort: 'ultracode' });
  });

  it('keeps every heterogeneous parallel task correlated', () => {
    const claudeAdapter = {} as AgentAdapter<ClaudeEffort>;
    const codexAdapter = {} as AgentAdapter<CodexEffort>;
    const customAdapter = {} as AgentAdapter<'quick' | 'deep' | 'exhaustive'>;
    const claude = new Cligent(claudeAdapter);
    const codex = new Cligent(codexAdapter);
    const custom = new Cligent(customAdapter);

    void Cligent.parallel([
      { agent: claude, prompt: 'Claude', overrides: { effort: 'ultracode' } },
      { agent: codex, prompt: 'Codex', overrides: { effort: 'ultra' } },
      { agent: custom, prompt: 'Custom', overrides: { effort: 'deep' } },
    ]);
    void Cligent.parallel([
      {
        agent: claude,
        prompt: 'Claude',
        // @ts-expect-error - overrides stay correlated to this Cligent
        overrides: { effort: 'ultra' },
      },
    ]);

    void runParallel([
      {
        adapter: claudeAdapter,
        prompt: 'Claude',
        options: { effort: 'ultracode' },
      },
      {
        adapter: codexAdapter,
        prompt: 'Codex',
        options: { effort: 'ultra' },
      },
      {
        adapter: customAdapter,
        prompt: 'Custom',
        options: { effort: 'exhaustive' },
      },
    ]);
    void runParallel([
      {
        adapter: codexAdapter,
        prompt: 'Codex',
        // @ts-expect-error - options stay correlated to this adapter
        options: { effort: 'ultracode' },
      },
    ]);

    const registry = new AdapterRegistry();
    registry.register(customAdapter);
    void runAgent(
      'custom-agent',
      'Custom',
      { effort: 'any-dynamic-string' },
      registry,
    );
  });
});
