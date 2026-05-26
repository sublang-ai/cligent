// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type {
  BossTurn,
  Captain,
  CaptainContext,
  PlayerHandle,
  PlayerRunResult,
} from '../app/tmux-play/contract.js';

const DEFAULT_MAX_PLAYER_OUTPUT_CHARS = 4_000;

export interface FanoutCaptainOptions {
  readonly maxPlayerOutputChars?: number;
}

interface ResolvedFanoutOptions {
  readonly maxPlayerOutputChars: number;
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
    const playerResults = await Promise.all(
      context.players.map((player) =>
        context.callPlayer(player.id, playerPrompt(turn.prompt, player)),
      ),
    );

    await context.callCaptain(
      summaryPrompt(turn.prompt, playerResults, this.options),
    );
  }
}

export function playerPrompt(
  bossPrompt: string,
  _player: PlayerHandle,
): string {
  return bossPrompt;
}

export function summaryPrompt(
  bossPrompt: string,
  playerResults: readonly PlayerRunResult[],
  options: FanoutCaptainOptions = {},
): string {
  const resolved = resolveOptions(options);
  const sections = playerResults.map((result) =>
    playerResultSection(result, resolved.maxPlayerOutputChars),
  );

  return [
    'The Boss asked:',
    bossPrompt,
    '',
    'Players answered independently. Synthesize a final answer for the Boss.',
    'Preserve useful disagreements, call out failed or aborted players, and do',
    'not copy raw player logs wholesale.',
    '',
    'Player results:',
    sections.length > 0 ? sections.join('\n\n') : '(no players configured)',
  ].join('\n');
}

function playerResultSection(
  result: PlayerRunResult,
  maxChars: number,
): string {
  const body = result.finalText ?? result.error ?? '(no final text)';
  const lines = [
    `=== player:${result.playerId} status:${result.status} ===`,
    truncate(body, maxChars),
  ];

  if (result.error && result.finalText) {
    lines.push('', `Error: ${result.error}`);
  }

  lines.push(`=== /player:${result.playerId} ===`);
  return lines.join('\n');
}

function resolveOptions(options: unknown): ResolvedFanoutOptions {
  if (!isRecord(options)) {
    return { maxPlayerOutputChars: DEFAULT_MAX_PLAYER_OUTPUT_CHARS };
  }

  const value = options.maxPlayerOutputChars;
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0
  ) {
    return { maxPlayerOutputChars: value };
  }

  return { maxPlayerOutputChars: DEFAULT_MAX_PLAYER_OUTPUT_CHARS };
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
