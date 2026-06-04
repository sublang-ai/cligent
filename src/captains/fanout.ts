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
  private readonly pendingRecoveryPrompts = new Map<string, string[]>();

  async handleBossTurn(
    turn: BossTurn,
    context: CaptainContext,
  ): Promise<void> {
    const playerResults = await Promise.all(
      context.players.map((player) =>
        context.callPlayer(
          player.id,
          playerPrompt(
            turn.prompt,
            player,
            this.pendingRecoveryPrompts.get(player.id) ?? [],
          ),
        ),
      ),
    );

    for (const result of playerResults) {
      this.captureRecoveryState(result, turn.prompt);
    }

    await context.callCaptain(summaryPrompt(turn.prompt, playerResults));
  }

  private captureRecoveryState(
    result: PlayerRunResult,
    bossPrompt: string,
  ): void {
    if (result.status === 'aborted' && !result.resumeToken) {
      const existing = this.pendingRecoveryPrompts.get(result.playerId) ?? [];
      this.pendingRecoveryPrompts.set(result.playerId, [
        ...existing,
        bossPrompt,
      ]);
      return;
    }

    this.pendingRecoveryPrompts.delete(result.playerId);
  }
}

export function playerPrompt(
  bossPrompt: string,
  _player: PlayerHandle,
  recoveryPrompts: readonly string[] = [],
): string {
  if (recoveryPrompts.length > 0) {
    return [
      'Previous Boss turn(s) sent to you were interrupted before your backend exposed a resumable session token.',
      'Continue from the interrupted Boss turn(s), then apply the latest Boss turn.',
      '',
      'Interrupted Boss turn(s):',
      ...recoveryPrompts.map(
        (prompt, index) => `${index + 1}. ${prompt}`,
      ),
      '',
      'Latest Boss turn:',
      bossPrompt,
    ].join('\n');
  }

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
