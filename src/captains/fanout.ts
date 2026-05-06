// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type {
  BossTurn,
  Captain,
  CaptainContext,
  RoleHandle,
  RoleRunResult,
} from '../app/tmux-play/contract.js';

const DEFAULT_MAX_ROLE_OUTPUT_CHARS = 4_000;

export interface FanoutCaptainOptions {
  readonly maxRoleOutputChars?: number;
}

interface ResolvedFanoutOptions {
  readonly maxRoleOutputChars: number;
}

export default function createFanoutCaptain(
  options: unknown = {},
): Captain {
  return new FanoutCaptain(resolveOptions(options));
}

export class FanoutCaptain implements Captain {
  private readonly options: ResolvedFanoutOptions;

  constructor(options: FanoutCaptainOptions = {}) {
    this.options = resolveOptions(options);
  }

  async handleBossTurn(
    turn: BossTurn,
    context: CaptainContext,
  ): Promise<void> {
    const roleResults = await Promise.all(
      context.roles.map((role) =>
        context.callRole(role.id, rolePrompt(turn.prompt, role)),
      ),
    );

    await context.callCaptain(
      summaryPrompt(turn.prompt, roleResults, this.options),
    );
  }
}

export function rolePrompt(
  bossPrompt: string,
  _role: RoleHandle,
): string {
  return [
    'The Boss asked:',
    bossPrompt,
    '',
    'Respond independently with the most useful answer you can provide.',
    'Do not wait for or speculate about other roles.',
  ].join('\n');
}

export function summaryPrompt(
  bossPrompt: string,
  roleResults: readonly RoleRunResult[],
  options: FanoutCaptainOptions = {},
): string {
  const resolved = resolveOptions(options);
  const sections = roleResults.map((result) =>
    roleResultSection(result, resolved.maxRoleOutputChars),
  );

  return [
    'The Boss asked:',
    bossPrompt,
    '',
    'Roles answered independently. Synthesize a final answer for the Boss.',
    'Preserve useful disagreements, call out failed or aborted roles, and do',
    'not copy raw role logs wholesale.',
    '',
    'Role results:',
    sections.length > 0 ? sections.join('\n\n') : '(no roles configured)',
  ].join('\n');
}

function roleResultSection(
  result: RoleRunResult,
  maxChars: number,
): string {
  const body = result.finalText ?? result.error ?? '(no final text)';
  const lines = [
    `=== role:${result.roleId} status:${result.status} ===`,
    truncate(body, maxChars),
  ];

  if (result.error && result.finalText) {
    lines.push('', `Error: ${result.error}`);
  }

  lines.push(`=== /role:${result.roleId} ===`);
  return lines.join('\n');
}

function resolveOptions(options: unknown): ResolvedFanoutOptions {
  if (!isRecord(options)) {
    return { maxRoleOutputChars: DEFAULT_MAX_ROLE_OUTPUT_CHARS };
  }

  const value = options.maxRoleOutputChars;
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0
  ) {
    return { maxRoleOutputChars: value };
  }

  return { maxRoleOutputChars: DEFAULT_MAX_ROLE_OUTPUT_CHARS };
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
