// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

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
      'Support means native-request delivery, not selected-model, account, provider, or installed-runtime availability. Claude sets CLAUDE_CODE_SUBAGENT_MODEL with CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 so the value binds every subagent of the run, and composes a delegation directive naming it into the system prompt. It changes which model subagents use, never whether the agent may start them.',
  }),
  codex: Object.freeze({
    requestSupported: false,
    notes: 'Codex exposes no per-run subagent-model surface.',
  }),
  gemini: Object.freeze({
    requestSupported: false,
    notes: 'Gemini exposes no per-run subagent-model surface.',
  }),
  opencode: Object.freeze({
    requestSupported: false,
    notes: 'OpenCode exposes no per-run subagent-model surface.',
  }),
  kimi: Object.freeze({
    requestSupported: false,
    notes: 'Kimi exposes no per-run subagent-model surface.',
  }),
}) satisfies Readonly<Record<BuiltinSubagentModelAgent, SubagentModelSupport>>;

export type SubagentModelForAgent<A extends AgentType | 'claude'> = A extends
  'claude' | 'claude-code'
  ? string
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
