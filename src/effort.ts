// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { AgentType } from './types.js';

export type BuiltinEffortAgent =
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'opencode';

interface EffortSupportShape {
  readonly values: readonly string[];
  readonly orchestrationValues: readonly string[];
  readonly modelDependent: boolean;
  readonly notes: string;
}

/**
 * Discoverable effort metadata for built-in adapters. Provider-native values
 * remain scoped to their owning adapter and are not portable aliases.
 */
export const EFFORT_SUPPORT = Object.freeze({
  'claude-code': Object.freeze({
    values: Object.freeze([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
    ] as const),
    orchestrationValues: Object.freeze(['ultracode'] as const),
    modelDependent: true,
    notes:
      'minimal maps to low; ultracode requires workflows and an xhigh-capable model, account, and installed runtime.',
  }),
  codex: Object.freeze({
    values: Object.freeze([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ] as const),
    orchestrationValues: Object.freeze(['ultra'] as const),
    modelDependent: true,
    notes:
      'Values pass to Codex; availability is model-, account-, and installed-runtime-dependent, and ultra enables automatic delegation.',
  }),
  gemini: Object.freeze({
    values: Object.freeze([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ] as const),
    orchestrationValues: Object.freeze([] as const),
    modelDependent: true,
    notes:
      'Gemini 3 collapses high, xhigh, and max to HIGH; Gemini 2.5 non-Pro models collapse xhigh and max to the same budget. Aliases, unmatched models, and an omitted model receive no effort override.',
  }),
  opencode: Object.freeze({
    values: Object.freeze([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ] as const),
    orchestrationValues: Object.freeze([] as const),
    modelDependent: true,
    notes:
      'Anthropic collapses minimal through high to high and xhigh/max to max; OpenAI collapses max to xhigh; Google collapses minimal through medium to low and high through max to high. Unknown providers and malformed or omitted models receive no effort override.',
  }),
}) satisfies Readonly<Record<BuiltinEffortAgent, EffortSupportShape>>;

type EffortValue<A extends BuiltinEffortAgent> =
  (typeof EFFORT_SUPPORT)[A]['values'][number];

/** Portable effort values shared by every built-in adapter. */
export type PortableEffort = EffortValue<'gemini'>;

/** Accepted effort values for the built-in Claude Code adapter. */
export type ClaudeEffort = EffortValue<'claude-code'>;

/** Accepted effort values for the built-in Codex adapter. */
export type CodexEffort = EffortValue<'codex'>;

/** Accepted effort values for the built-in Gemini adapter. */
export type GeminiEffort = EffortValue<'gemini'>;

/** Accepted effort values for the built-in OpenCode adapter. */
export type OpenCodeEffort = EffortValue<'opencode'>;

/** Union of every effort value accepted by a built-in adapter. */
export type Effort = EffortValue<BuiltinEffortAgent>;

export type EffortForAgent<A extends AgentType | 'claude'> = A extends
  'claude' | 'claude-code'
  ? ClaudeEffort
  : A extends 'codex'
    ? CodexEffort
    : A extends 'gemini'
      ? GeminiEffort
      : A extends 'opencode'
        ? OpenCodeEffort
        : Effort;

export interface EffortSupport {
  /** Values Cligent accepts for this built-in adapter. */
  readonly values: readonly Effort[];
  /** Values that enable provider-native multi-agent orchestration. */
  readonly orchestrationValues: readonly Effort[];
  /** Whether the selected model/provider may support only a subset. */
  readonly modelDependent: boolean;
  /** Short user-facing qualification for selectors and validation UIs. */
  readonly notes: string;
}

function canonicalEffortAgent(
  agent: AgentType | 'claude',
): BuiltinEffortAgent | undefined {
  switch (agent) {
    case 'claude':
    case 'claude-code':
      return 'claude-code';
    case 'codex':
      return 'codex';
    case 'gemini':
      return 'gemini';
    case 'opencode':
      return 'opencode';
    default:
      return undefined;
  }
}

export function getEffortSupport(
  agent: AgentType | 'claude',
): EffortSupport | undefined {
  const canonical = canonicalEffortAgent(agent);
  return canonical === undefined ? undefined : EFFORT_SUPPORT[canonical];
}

export function supportedEffortValues(
  agent: AgentType | 'claude',
): readonly Effort[] | undefined {
  return getEffortSupport(agent)?.values;
}

export function isEffortSupported<A extends AgentType | 'claude'>(
  agent: A,
  value: unknown,
): value is EffortForAgent<A> {
  const values = supportedEffortValues(agent);
  return (
    typeof value === 'string' &&
    values !== undefined &&
    (values as readonly string[]).includes(value)
  );
}

export function assertSupportedEffort<A extends AgentType | 'claude'>(
  agent: A,
  value: unknown,
  path = 'effort',
): asserts value is EffortForAgent<A> {
  const values = supportedEffortValues(agent);
  if (values === undefined) {
    throw new Error(
      `${path} cannot be validated for unknown adapter "${agent}"`,
    );
  }
  if (!isEffortSupported(agent, value)) {
    throw new Error(
      `${path} for adapter "${agent}" must be one of: ${values.join(', ')}`,
    );
  }
}
