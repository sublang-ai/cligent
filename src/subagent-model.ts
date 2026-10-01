// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { EFFORT_SUPPORT, type ClaudeEffort } from './effort.js';
import type { AgentType } from './types.js';

export type BuiltinSubagentModelAgent =
  'claude-code' | 'codex' | 'gemini' | 'kimi' | 'opencode';

export interface SubagentModelSupport {
  readonly requestSupported: boolean;
  readonly notes: string;
}

/** Built-in per-run subagent-model request transport (engine-92). */
export const SUBAGENT_MODEL_SUPPORT = Object.freeze({
  'claude-code': Object.freeze({
    requestSupported: true,
    notes:
      "Support means native-request delivery of subagentModel and subagentEffort, not selected-model, account, provider, or installed-runtime availability. Claude sets CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1, with CLAUDE_CODE_SUBAGENT_MODEL for a named model or alone for inherit, so the model binds every subagent of the run; registers subagent definitions, one carrying the pinned effort or one per effort for the agent to choose, replacing general-purpose by name at the pinned effort or, where the agent chooses, at medium, while Explore and Plan keep their own definitions and the agent's effort; and composes a delegation directive into the system prompt. It changes which model and effort subagents use, never whether the agent may start them.",
  }),
  codex: Object.freeze({
    requestSupported: false,
    notes:
      'Codex exposes no per-run subagent-model or subagent-effort surface.',
  }),
  gemini: Object.freeze({
    requestSupported: false,
    notes:
      'Gemini exposes no per-run subagent-model or subagent-effort surface.',
  }),
  opencode: Object.freeze({
    requestSupported: false,
    notes:
      'OpenCode exposes no per-run subagent-model or subagent-effort surface.',
  }),
  kimi: Object.freeze({
    requestSupported: false,
    notes: 'Kimi exposes no per-run subagent-model or subagent-effort surface.',
  }),
}) satisfies Readonly<Record<BuiltinSubagentModelAgent, SubagentModelSupport>>;

export type SubagentModelForAgent<A extends AgentType | 'claude'> = A extends
  'claude' | 'claude-code'
  ? string
  : never;

/** Claude's orchestration effort, which no subagent definition can carry. */
type ClaudeOrchestrationEffort =
  (typeof EFFORT_SUPPORT)['claude-code']['orchestrationValues'][number];

/**
 * Accepted `subagentEffort` values for the built-in Claude Code adapter: its
 * effort vocabulary without the session-scoped `ultracode` (engine-90).
 */
export type ClaudeSubagentEffort = Exclude<
  ClaudeEffort,
  ClaudeOrchestrationEffort
>;

/**
 * The default subagent-effort capability (engine-90): none without a
 * subagent model, otherwise the effort vocabulary without `ultracode`, so
 * existing annotations that bind `SM` stay assignable from Claude.
 */
export type DefaultSubagentEffort<E extends string, SM extends string> = [
  SM,
] extends [never]
  ? never
  : Exclude<E, ClaudeOrchestrationEffort>;

export type SubagentEffortForAgent<A extends AgentType | 'claude'> = A extends
  'claude' | 'claude-code'
  ? ClaudeSubagentEffort
  : never;

type SubagentModelSupportedAgent = 'claude' | 'claude-code';

function canonicalSubagentModelAgent(
  agent: AgentType | 'claude',
): BuiltinSubagentModelAgent | undefined {
  switch (agent) {
    case 'claude':
    case 'claude-code':
      return 'claude-code';
    case 'codex':
      return 'codex';
    case 'gemini':
      return 'gemini';
    case 'kimi':
      return 'kimi';
    case 'opencode':
      return 'opencode';
    default:
      return undefined;
  }
}

export function getSubagentModelSupport(
  agent: AgentType | 'claude',
): SubagentModelSupport | undefined {
  const canonical = canonicalSubagentModelAgent(agent);
  return canonical === undefined
    ? undefined
    : SUBAGENT_MODEL_SUPPORT[canonical];
}

export function isSubagentModelSupported<A extends AgentType | 'claude'>(
  agent: A,
): agent is A & SubagentModelSupportedAgent {
  return getSubagentModelSupport(agent)?.requestSupported === true;
}

export function assertSubagentModelSupported<A extends AgentType | 'claude'>(
  agent: A,
  path = 'subagentModel',
): asserts agent is A & SubagentModelSupportedAgent {
  const support = getSubagentModelSupport(agent);
  if (support === undefined) {
    throw new Error(
      `${path} cannot be validated for unknown adapter "${agent}"`,
    );
  }
  if (!support.requestSupported) {
    throw new Error(`${path} is not supported for adapter "${agent}"`);
  }
}

/** Whether a value is a string carrying at least one non-whitespace character. */
export function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function assertBuiltInSubagentModelOption(
  agent: BuiltinSubagentModelAgent | 'claude',
  value: unknown,
  path = 'subagentModel',
): asserts value is string | undefined {
  if (value === undefined) return;

  const support = getSubagentModelSupport(agent);
  if (!support?.requestSupported) {
    throw new Error(`${path} is not supported for adapter "${agent}"`);
  }
  if (!isNonBlankString(value)) {
    throw new Error(
      `${path} for adapter "${agent}" must be a non-blank string`,
    );
  }
}

/**
 * engine-97: the `subagentEffort` values a built-in adapter accepts — its
 * effort vocabulary without its orchestration values — or `undefined` where
 * it serves no subagent model.
 */
export function subagentEffortValues(
  agent: AgentType | 'claude',
): readonly string[] | undefined {
  const canonical = canonicalSubagentModelAgent(agent);
  if (
    canonical === undefined ||
    !SUBAGENT_MODEL_SUPPORT[canonical].requestSupported
  ) {
    return undefined;
  }
  const { values, orchestrationValues } = EFFORT_SUPPORT[canonical];
  const orchestration: readonly string[] = orchestrationValues;
  return values.filter((value) => !orchestration.includes(value));
}

/**
 * engine-97: reject a `subagentEffort` an adapter cannot serve before any
 * backend work — on an adapter without a subagent model, without a
 * `subagentModel` beside it, or outside the adapter's vocabulary less its
 * orchestration values.
 */
export function assertBuiltInSubagentEffortOption(
  agent: BuiltinSubagentModelAgent | 'claude',
  subagentModel: unknown,
  value: unknown,
  path = 'subagentEffort',
): void {
  if (value === undefined) return;

  const values = subagentEffortValues(agent);
  if (values === undefined) {
    throw new Error(`${path} is not supported for adapter "${agent}"`);
  }
  if (subagentModel === undefined) {
    throw new Error(`${path} for adapter "${agent}" requires subagentModel`);
  }
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new Error(
      `${path} for adapter "${agent}" must be one of: ${values.join(', ')}`,
    );
  }
}
