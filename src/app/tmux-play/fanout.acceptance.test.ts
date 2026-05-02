// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import createFanoutCaptain from '../../captains/fanout.js';
import type {
  CaptainFinishedRecord,
  RoleFinishedRecord,
  TmuxPlayRecord,
} from './records.js';
import { createTmuxPlayRuntime, type TmuxPlayRuntime } from './runtime.js';

const GEMINI_MODEL = process.env.GEMINI_MODEL;

const acceptanceIt = hasGeminiAcceptanceDeps() ? it : it.skip;

describe('tmux-play fanout acceptance', () => {
  acceptanceIt(
    'drives the fanout Captain through the runtime API',
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), 'tmux-play-accept-'));
      const sentinel = `SENTINEL_${randomUUID().slice(0, 8)}`;
      const records: TmuxPlayRecord[] = [];
      let runtime: TmuxPlayRuntime | undefined;

      try {
        runtime = await createTmuxPlayRuntime({
          captain: createFanoutCaptain({ maxRoleOutputChars: 2_000 }),
          captainConfig: {
            adapter: 'gemini',
            instruction:
              'You are the Captain. Include required acceptance tokens exactly.',
            ...(GEMINI_MODEL ? { model: GEMINI_MODEL } : {}),
          },
          roles: [
            {
              id: 'alpha',
              adapter: 'gemini',
              instruction:
                'You are role alpha. Keep replies short and include required acceptance tokens exactly.',
              ...(GEMINI_MODEL ? { model: GEMINI_MODEL } : {}),
            },
            {
              id: 'beta',
              adapter: 'gemini',
              instruction:
                'You are role beta. Keep replies short and include required acceptance tokens exactly.',
              ...(GEMINI_MODEL ? { model: GEMINI_MODEL } : {}),
            },
          ],
          cwd: workDir,
          observers: [
            {
              onRecord(record) {
                records.push(record);
              },
            },
          ],
        });

        await runtime.runBossTurn(
          [
            'Acceptance test.',
            `Every role response and the final Captain answer must include exactly this token: ${sentinel}`,
            'No file edits are needed.',
          ].join('\n'),
        );
      } finally {
        await runtime?.dispose();
        rmSync(workDir, { recursive: true, force: true });
      }

      const types = records.map((record) => record.type);
      expect(types[0]).toBe('turn_started');
      expect(types).not.toContain('runtime_error');
      expect(types).not.toContain('turn_aborted');
      expect(types.at(-1)).toBe('turn_finished');

      const roleFinished = records.filter(isRoleFinished);
      expect(roleFinished.map((record) => record.roleId).sort()).toEqual([
        'alpha',
        'beta',
      ]);
      for (const record of roleFinished) {
        expect(record.result.status).toBe('ok');
        expect(normalized(record.result.finalText)).toContain(
          normalized(sentinel),
        );
      }

      const captainFinished = records.find(isCaptainFinished);
      expect(captainFinished?.result.status).toBe('ok');
      expect(normalized(captainFinished?.result.finalText)).toContain(
        normalized(sentinel),
      );

      const lastRoleFinishedIndex = Math.max(
        ...records
          .map((record, index) =>
            record.type === 'role_finished' ? index : -1,
          )
          .filter((index) => index !== -1),
      );
      expect(types.indexOf('captain_prompt')).toBeGreaterThan(
        lastRoleFinishedIndex,
      );
    },
    120_000,
  );
});

function isRoleFinished(
  record: TmuxPlayRecord,
): record is RoleFinishedRecord {
  return record.type === 'role_finished';
}

function isCaptainFinished(
  record: TmuxPlayRecord,
): record is CaptainFinishedRecord {
  return record.type === 'captain_finished';
}

function normalized(value: string | undefined): string {
  return (value ?? '').replace(/[^a-zA-Z0-9]/g, '');
}

function hasGeminiAcceptanceDeps(): boolean {
  if (!process.env.GEMINI_API_KEY) {
    return false;
  }

  try {
    execFileSync('gemini', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
