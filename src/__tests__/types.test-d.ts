// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, it, expectTypeOf } from 'vitest';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { CodexAdapter } from '../adapters/codex.js';
import { GeminiAdapter } from '../adapters/gemini.js';
import { KimiAdapter } from '../adapters/kimi.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
import {
  AdapterRegistry,
  Cligent,
  EFFORT_SUPPORT,
  FAST_MODE_SUPPORT,
  assertFastModeSupported,
  assertSupportedEffort,
  isFastModeSupported,
  isEffortSupported,
  runAgent,
  runParallel,
} from '../index.js';
import type {
  AgentEvent,
  AgentEventType,
  AgentAdapter,
  AgentOptions,
  BaseEvent,
  ClaudeEffort,
  CligentOptions,
  CodexEffort,
  DonePayload,
  DoneUsage,
  Effort,
  FastModeDisabledReason,
  FastModeObservation,
  FastModeResponseSpeed,
  FastModeState,
  FastModeTerminalObservation,
  GeminiEffort,
  InitPayload,
  InputTokenUsage,
  KimiEffort,
  OpenCodeEffort,
  OutputTokenUsage,
  PermissionCapability,
  PermissionPolicy,
  PortableEffort,
  RunOptions,
  TextPayload,
  TokenUsage,
  TokenUsageReport,
  UsageCost,
  WritablePathsEnforcement,
  WritablePathsPermissionMapping,
} from '../index.js';

type SupportEffortMap = {
  [
    A in keyof typeof EFFORT_SUPPORT
  ]: (typeof EFFORT_SUPPORT)[A]['values'][number];
};

type AdapterParameters<T> =
  T extends AgentAdapter<infer E, infer FM> ? [E, FM] : never;
type AdapterEffort<T> = AdapterParameters<T>[0];
type AdapterFastMode<T> = AdapterParameters<T>[1];

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

  it('PermissionPolicy.mode narrows to the auto / bypass union per engine-21', () => {
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

  it('uses omission instead of flat token placeholders on done usage', () => {
    const measuredZero: DoneUsage = {
      toolUses: 0,
      tokens: {
        coverage: 'complete',
        totals: { input: { total: 0 }, output: { total: 0 } },
      },
    };
    const unavailable: DoneUsage = {
      toolUses: 3,
    };
    expectTypeOf(measuredZero.tokens).toEqualTypeOf<
      TokenUsageReport | undefined
    >();
    expectTypeOf(unavailable).toEqualTypeOf<DonePayload['usage']>();

    const legacyInput: DoneUsage = {
      // @ts-expect-error - released flat token placeholders were removed.
      inputTokens: 0,
      toolUses: 0,
    };
    const legacyOutput: DoneUsage = {
      // @ts-expect-error - released flat token placeholders were removed.
      outputTokens: 0,
      toolUses: 0,
    };
    const legacyAvailability: DoneUsage = {
      // @ts-expect-error - the availability discriminator was removed.
      tokenAvailability: 'unavailable',
      toolUses: 0,
    };
    const legacyCost: DoneUsage = {
      // @ts-expect-error - unprovenanced flat cost was removed.
      totalCostUsd: 0,
      toolUses: 0,
    };
    const legacyBreakdown: DoneUsage = {
      // @ts-expect-error - the disjoint top-level breakdown was removed.
      breakdown: { input: 0, output: 0 },
      toolUses: 0,
    };
    const legacyRecords: DoneUsage = {
      // @ts-expect-error - records now live inside an authentic token report.
      records: [],
      toolUses: 0,
    };
    void legacyInput;
    void legacyOutput;
    void legacyAvailability;
    void legacyCost;
    void legacyBreakdown;
    void legacyRecords;

    const invalid: DoneUsage = {
      toolUses: 0,
      tokens: {
        // @ts-expect-error - coverage is a closed claim.
        coverage: 'estimated',
        totals: { input: { total: 1 }, output: { total: 1 } },
      },
    };
    void invalid;
  });

  it('types inclusive token totals, exact subsets, and cost provenance', () => {
    const input: InputTokenUsage = {
      total: 6,
      uncached: 1,
      cacheRead: 2,
      cacheWrite: 3,
    };
    const output: OutputTokenUsage = { total: 9, visible: 4, reasoning: 5 };
    const totals: TokenUsage = { input, output };
    const cost: UsageCost = {
      amount: 0,
      currency: 'USD',
      source: 'agent-estimate',
    };
    expectTypeOf(input.cacheRead).toEqualTypeOf<number | undefined>();
    expectTypeOf(output.reasoning).toEqualTypeOf<number | undefined>();

    const usage: DoneUsage = {
      toolUses: 0,
      tokens: { coverage: 'partial', totals },
      cost,
    };
    expectTypeOf(usage.tokens).toEqualTypeOf<TokenUsageReport | undefined>();
    expectTypeOf(usage.cost).toEqualTypeOf<UsageCost | undefined>();

    const withoutTokens: DoneUsage = { toolUses: 0 };
    void withoutTokens;

    const unknownComponent: InputTokenUsage = {
      total: 1,
      // @ts-expect-error - the token detail vocabulary is closed.
      cachedTokens: 1,
    };
    void unknownComponent;
  });

  it('exports exact adapter-scoped effort metadata types', () => {
    expectTypeOf<SupportEffortMap>().toEqualTypeOf<{
      readonly 'claude-code': ClaudeEffort;
      readonly codex: CodexEffort;
      readonly gemini: GeminiEffort;
      readonly kimi: KimiEffort;
      readonly opencode: OpenCodeEffort;
    }>();

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
    expectTypeOf<Effort>().toEqualTypeOf<
      PortableEffort | 'ultracode' | 'ultra' | 'off' | 'on'
    >();
    expectTypeOf<ClaudeEffort>().toEqualTypeOf<PortableEffort | 'ultracode'>();
    expectTypeOf<CodexEffort>().toEqualTypeOf<PortableEffort | 'ultra'>();
    expectTypeOf<KimiEffort>().toEqualTypeOf<'off' | 'on'>();
    const options: AgentOptions = { effort: 'ultra' };
    expectTypeOf(options.effort).toEqualTypeOf<Effort | undefined>();
    // @ts-expect-error - the public option was renamed to effort
    const legacy: AgentOptions = { reasoningEffort: 'high' };
    void legacy;

    const claudeAdapter = {} as AgentAdapter<ClaudeEffort>;
    const codexAdapter = {} as AgentAdapter<CodexEffort>;
    const kimiAdapter = {} as AgentAdapter<KimiEffort>;
    void claudeAdapter.run('prompt', { effort: 'ultracode' });
    void codexAdapter.run('prompt', { effort: 'ultra' });
    void kimiAdapter.run('prompt', { effort: 'on' });
    // @ts-expect-error - ultra belongs only to Codex
    void claudeAdapter.run('prompt', { effort: 'ultra' });
    // @ts-expect-error - ultracode belongs only to Claude Code
    void codexAdapter.run('prompt', { effort: 'ultracode' });
    // @ts-expect-error - portable tiers are not Kimi's binary vocabulary
    void kimiAdapter.run('prompt', { effort: 'high' });
  });

  it('preserves built-in and custom vocabularies through Cligent', () => {
    const claudeAdapter = {} as AgentAdapter<ClaudeEffort>;
    const codexAdapter = {} as AgentAdapter<CodexEffort>;
    const kimiAdapter = {} as AgentAdapter<KimiEffort>;
    const claude = new Cligent(claudeAdapter, { effort: 'ultracode' });
    const codex = new Cligent(codexAdapter, { effort: 'ultra' });
    const kimi = new Cligent(kimiAdapter, { effort: 'on' });
    void claude.run('prompt', { effort: 'max' });
    void codex.run('prompt', { effort: 'max' });
    void kimi.run('prompt', { effort: 'off' });
    // @ts-expect-error - NoInfer prevents constructor options widening Claude
    new Cligent(claudeAdapter, { effort: 'ultra' });
    // @ts-expect-error - run overrides remain Claude-scoped
    void claude.run('prompt', { effort: 'ultra' });
    // @ts-expect-error - NoInfer prevents constructor options widening Codex
    new Cligent(codexAdapter, { effort: 'ultracode' });
    // @ts-expect-error - run overrides remain Codex-scoped
    void codex.run('prompt', { effort: 'ultracode' });
    // @ts-expect-error - run overrides remain Kimi-scoped
    void kimi.run('prompt', { effort: 'high' });

    type CustomEffort = 'quick' | 'deep' | 'exhaustive';
    const customAdapter = {} as AgentAdapter<CustomEffort>;
    const custom = new Cligent(customAdapter, { effort: 'deep' });
    void custom.run('prompt', { effort: 'exhaustive' });
    // @ts-expect-error - custom adapters retain their own vocabulary
    new Cligent(customAdapter, { effort: 'ultra' });
  });

  it('binds each concrete adapter to its metadata vocabulary', () => {
    expectTypeOf<{
      claude: AdapterEffort<ClaudeCodeAdapter>;
      codex: AdapterEffort<CodexAdapter>;
      gemini: AdapterEffort<GeminiAdapter>;
      kimi: AdapterEffort<KimiAdapter>;
      opencode: AdapterEffort<OpenCodeAdapter>;
    }>().toEqualTypeOf<{
      claude: ClaudeEffort;
      codex: CodexEffort;
      gemini: GeminiEffort;
      kimi: KimiEffort;
      opencode: OpenCodeEffort;
    }>();
  });

  it('keeps every heterogeneous parallel task correlated', () => {
    const claudeAdapter = {} as AgentAdapter<ClaudeEffort>;
    const codexAdapter = {} as AgentAdapter<CodexEffort>;
    const kimiAdapter = {} as AgentAdapter<KimiEffort>;
    const customAdapter = {} as AgentAdapter<'quick' | 'deep' | 'exhaustive'>;
    const claude = new Cligent(claudeAdapter);
    const codex = new Cligent(codexAdapter);
    const kimi = new Cligent(kimiAdapter);
    const custom = new Cligent(customAdapter);

    void Cligent.parallel([
      { agent: claude, prompt: 'Claude', overrides: { effort: 'ultracode' } },
      { agent: codex, prompt: 'Codex', overrides: { effort: 'ultra' } },
      { agent: kimi, prompt: 'Kimi', overrides: { effort: 'on' } },
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
        adapter: kimiAdapter,
        prompt: 'Kimi',
        options: { effort: 'off' },
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

  it('types authentic fast-mode observations by event phase', () => {
    expectTypeOf<FastModeState>().toEqualTypeOf<
      'off' | 'cooldown' | 'on'
    >();
    expectTypeOf<FastModeDisabledReason>().toEqualTypeOf<
      | 'free'
      | 'preference'
      | 'extra_usage_disabled'
      | 'network_error'
      | 'unknown'
      | 'not_first_party'
      | 'disabled_by_env'
      | 'model_not_allowed'
      | 'sdk_opt_in_required'
      | 'pending'
    >();
    expectTypeOf<FastModeResponseSpeed>().toEqualTypeOf<'standard' | 'fast'>();

    const initObservation: FastModeObservation = {
      state: 'cooldown',
      disabledReason: 'pending',
    };
    const terminalObservation: FastModeTerminalObservation = {
      state: 'on',
      responseSpeed: 'fast',
    };
    const init: InitPayload = {
      model: 'claude-opus-4-8',
      cwd: '/workspace',
      tools: [],
      fastMode: initObservation,
    };
    const done: DonePayload = {
      status: 'success',
      usage: { toolUses: 0 },
      durationMs: 1,
      fastMode: terminalObservation,
    };
    expectTypeOf(init.fastMode).toEqualTypeOf<
      FastModeObservation | undefined
    >();
    expectTypeOf(done.fastMode).toEqualTypeOf<
      FastModeTerminalObservation | undefined
    >();

    const invalidInit: InitPayload = {
      model: 'claude-opus-4-8',
      cwd: '/workspace',
      tools: [],
      fastMode: {
        // @ts-expect-error - response speed is terminal-only.
        responseSpeed: 'fast',
      },
    };
    void invalidInit;
  });

  it('correlates fast-mode support across built-in and custom APIs', () => {
    expectTypeOf<{
      claude: AdapterFastMode<ClaudeCodeAdapter>;
      codex: AdapterFastMode<CodexAdapter>;
      gemini: AdapterFastMode<GeminiAdapter>;
      kimi: AdapterFastMode<KimiAdapter>;
      opencode: AdapterFastMode<OpenCodeAdapter>;
    }>().toEqualTypeOf<{
      claude: boolean;
      codex: boolean;
      gemini: never;
      kimi: never;
      opencode: never;
    }>();

    const claudeAdapter = new ClaudeCodeAdapter();
    const codexAdapter = new CodexAdapter();
    const geminiAdapter = new GeminiAdapter();
    void claudeAdapter.run('prompt', { fastMode: true });
    void codexAdapter.run('prompt', { fastMode: false });
    // @ts-expect-error - Gemini has no native fast-mode request surface.
    void geminiAdapter.run('prompt', { fastMode: false });

    type CustomEffort = 'quick' | 'deep';
    const customDefault = {} as AgentAdapter<CustomEffort>;
    const customSupported = {} as AgentAdapter<CustomEffort, boolean>;
    // @ts-expect-error - custom adapters default to unsupported.
    void customDefault.run('prompt', { fastMode: true });
    void customSupported.run('prompt', { fastMode: true });

    const claude = new Cligent(claudeAdapter, { fastMode: true });
    const codex = new Cligent(codexAdapter, { fastMode: false });
    const gemini = new Cligent(geminiAdapter);
    const custom = new Cligent(customSupported, { fastMode: false });
    void claude.run('prompt', { fastMode: false });
    void codex.run('prompt', { fastMode: true });
    void custom.run('prompt', { fastMode: true });
    // @ts-expect-error - unsupported Cligent instances reject booleans.
    void gemini.run('prompt', { fastMode: true });

    void Cligent.parallel([
      { agent: claude, prompt: 'Claude', overrides: { fastMode: true } },
      { agent: codex, prompt: 'Codex', overrides: { fastMode: false } },
      { agent: gemini, prompt: 'Gemini' },
      { agent: custom, prompt: 'Custom', overrides: { fastMode: true } },
    ]);
    void Cligent.parallel([
      {
        agent: gemini,
        prompt: 'Gemini',
        // @ts-expect-error - parallel overrides retain adapter capability.
        overrides: { fastMode: false },
      },
    ]);
    void runParallel([
      { adapter: claudeAdapter, prompt: 'Claude', options: { fastMode: true } },
      { adapter: codexAdapter, prompt: 'Codex', options: { fastMode: false } },
      { adapter: geminiAdapter, prompt: 'Gemini' },
      { adapter: customSupported, prompt: 'Custom', options: { fastMode: true } },
    ]);
    void runParallel([
      {
        adapter: geminiAdapter,
        prompt: 'Gemini',
        // @ts-expect-error - parallel options retain adapter capability.
        options: { fastMode: true },
      },
    ]);

    const registry = new AdapterRegistry();
    registry.register(customSupported);
    void runAgent('custom-agent', 'prompt', { fastMode: false }, registry);
  });

  it('keeps existing single-parameter generic uses source compatible', () => {
    const supportedAdapter: AgentAdapter<ClaudeEffort, boolean> =
      new ClaudeCodeAdapter();
    const unsupportedAdapter: AgentAdapter<GeminiEffort> = new GeminiAdapter();
    const legacySupportedAdapter: AgentAdapter<ClaudeEffort> = supportedAdapter;
    const legacyUnsupportedAdapter: AgentAdapter<GeminiEffort> =
      unsupportedAdapter;
    const supported = new Cligent(supportedAdapter, { fastMode: true });
    const unsupported = new Cligent(unsupportedAdapter);
    const legacySupported: Cligent<ClaudeEffort> = supported;
    const legacyUnsupported: Cligent<GeminiEffort> = unsupported;

    const agentOptions: AgentOptions<ClaudeEffort> = { effort: 'high' };
    const cligentOptions: CligentOptions<ClaudeEffort> = { effort: 'high' };
    const runOptions: RunOptions<ClaudeEffort> = { effort: 'high' };
    void legacySupportedAdapter;
    void legacyUnsupportedAdapter;
    void legacySupported;
    void legacyUnsupported;
    void agentOptions;
    void cligentOptions;
    void runOptions;
  });

  it('exports fast-mode metadata types and helper narrowing', () => {
    expectTypeOf(FAST_MODE_SUPPORT['claude-code'].requestSupported).toEqualTypeOf<true>();
    expectTypeOf(FAST_MODE_SUPPORT.codex.observation).toEqualTypeOf<'none'>();
    expectTypeOf(FAST_MODE_SUPPORT.gemini.requestSupported).toEqualTypeOf<false>();

    let candidate: string = 'codex';
    if (isFastModeSupported(candidate)) {
      expectTypeOf(candidate).toMatchTypeOf<'claude' | 'claude-code' | 'codex'>();
    }
    let asserted: string = 'claude-code';
    assertFastModeSupported(asserted);
    expectTypeOf(asserted).toMatchTypeOf<
      'claude' | 'claude-code' | 'codex'
    >();
  });
});
