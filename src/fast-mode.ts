// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { AgentType } from './types.js';

export type BuiltinFastModeAgent =
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'kimi'
  | 'opencode';

export type FastModeObservationSupport = 'none' | 'init-and-done';

export interface FastModeSupport {
  readonly requestSupported: boolean;
  readonly observation: FastModeObservationSupport;
  readonly modelDependent: boolean;
  readonly accountDependent: boolean;
  readonly notes: string;
}

/** Built-in request transport and authentic-observation capabilities. */
export const FAST_MODE_SUPPORT = Object.freeze({
  'claude-code': Object.freeze({
    requestSupported: true,
    observation: 'init-and-done',
    modelDependent: true,
    accountDependent: true,
    notes:
      'Support means native-request delivery, not selected-model, account, provider, policy, network, or installed-runtime availability. Claude exposes authentic initialization and terminal observations.',
  }),
  codex: Object.freeze({
    requestSupported: true,
    observation: 'none',
    modelDependent: true,
    accountDependent: true,
    notes:
      'Support means native-request delivery, not selected-model, account, provider, policy, network, or installed-runtime availability. The public Codex SDK exposes no effective-tier event.',
  }),
  gemini: Object.freeze({
    requestSupported: false,
    observation: 'none',
    modelDependent: false,
    accountDependent: false,
    notes: 'Gemini exposes no native fast-mode request surface.',
  }),
  opencode: Object.freeze({
    requestSupported: false,
    observation: 'none',
    modelDependent: false,
    accountDependent: false,
    notes: 'OpenCode exposes no native fast-mode request surface.',
  }),
  kimi: Object.freeze({
    requestSupported: false,
    observation: 'none',
    modelDependent: false,
    accountDependent: false,
    notes: 'Kimi exposes no native fast-mode request surface.',
  }),
}) satisfies Readonly<Record<BuiltinFastModeAgent, FastModeSupport>>;

export type FastModeForAgent<A extends AgentType | 'claude'> = A extends
  | 'claude'
  | 'claude-code'
  | 'codex'
  ? boolean
  : never;

type FastModeSupportedAgent = 'claude' | 'claude-code' | 'codex';

function canonicalFastModeAgent(
  agent: AgentType | 'claude',
): BuiltinFastModeAgent | undefined {
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

export function getFastModeSupport(
  agent: AgentType | 'claude',
): FastModeSupport | undefined {
  const canonical = canonicalFastModeAgent(agent);
  return canonical === undefined ? undefined : FAST_MODE_SUPPORT[canonical];
}

export function isFastModeSupported<A extends AgentType | 'claude'>(
  agent: A,
): agent is A & FastModeSupportedAgent {
  return getFastModeSupport(agent)?.requestSupported === true;
}

export function assertFastModeSupported<A extends AgentType | 'claude'>(
  agent: A,
  path = 'fastMode',
): asserts agent is A & FastModeSupportedAgent {
  const support = getFastModeSupport(agent);
  if (support === undefined) {
    throw new Error(
      `${path} cannot be validated for unknown adapter "${agent}"`,
    );
  }
  if (!support.requestSupported) {
    throw new Error(`${path} is not supported for adapter "${agent}"`);
  }
}

export function assertBuiltInFastModeOption(
  agent: BuiltinFastModeAgent | 'claude',
  value: unknown,
  path = 'fastMode',
): asserts value is boolean | undefined {
  if (value === undefined) return;

  const support = getFastModeSupport(agent);
  if (!support?.requestSupported) {
    throw new Error(`${path} is not supported for adapter "${agent}"`);
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${path} for adapter "${agent}" must be a boolean`);
  }
}
