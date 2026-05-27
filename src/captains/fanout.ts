// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type {
  BossTurn,
  Captain,
  CaptainContext,
  PlayerHandle,
  PlayerRunResult,
} from '../app/tmux-play/contract.js';

export default function createFanoutCaptain(): Captain {
  return new FanoutCaptain();
}

export class FanoutCaptain implements Captain {
  async handleBossTurn(
    turn: BossTurn,
    context: CaptainContext,
  ): Promise<void> {
    const playerResults = await Promise.all(
      context.players.map((player) =>
        context.callPlayer(player.id, playerPrompt(turn.prompt, player)),
      ),
    );

    await context.callCaptain(summaryPrompt(turn.prompt, playerResults));
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
): string {
  const sections = playerResults.map(playerResultSection);

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

function playerResultSection(result: PlayerRunResult): string {
  const body = result.finalText ?? result.error ?? '(no final text)';
  const lines = [
    `=== player:${result.playerId} status:${result.status} ===`,
    body,
  ];

  if (result.error && result.finalText) {
    lines.push('', `Error: ${result.error}`);
  }

  lines.push(`=== /player:${result.playerId} ===`);
  return lines.join('\n');
}
