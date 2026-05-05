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
import type { RoleAdapterName } from './roles.js';
import { createTmuxPlayRuntime, type TmuxPlayRuntime } from './runtime.js';

const GEMINI_MODEL = process.env.GEMINI_MODEL;
const OPENCODE_MODEL =
  process.env.OPENCODE_MODEL ?? 'moonshotai-cn/kimi-k2.5';
const ROLE_ADAPTERS = [
  'claude',
  'codex',
  'gemini',
  'opencode',
] as const satisfies readonly RoleAdapterName[];
const dependencyReport = fanoutAcceptanceDeps();

// Acceptance files are excluded from the standard CI matrix; CI hard-fails
// missing dependencies only when the acceptance config loads this file.
const acceptanceIt =
  dependencyReport.ready || process.env.CI ? it : it.skip;

describe('tmux-play fanout acceptance', () => {
  acceptanceIt(
    'drives the fanout Captain through the runtime API',
    async () => {
      if (!dependencyReport.ready) {
        throw new Error(
          `Missing tmux-play fanout acceptance dependencies: ${dependencyReport.missing.join(', ')}`,
        );
      }

      const workDir = mkdtempSync(join(tmpdir(), 'tmux-play-accept-'));
      execFileSync('git', ['init'], { cwd: workDir, stdio: 'ignore' });
      const sentinel = `SENTINEL_${randomUUID().slice(0, 8)}`;
      const records: TmuxPlayRecord[] = [];
      let runtime: TmuxPlayRuntime | undefined;
      let primaryError: unknown;

      try {
        runtime = await createTmuxPlayRuntime({
          captain: createFanoutCaptain({ maxRoleOutputChars: 2_000 }),
          captainConfig: {
            adapter: 'gemini',
            instruction:
              'You are the Captain. Include required acceptance tokens exactly.',
            ...(GEMINI_MODEL ? { model: GEMINI_MODEL } : {}),
          },
          // This acceptance test intentionally uses role id == adapter name
          // so each role proves one canonical adapter path.
          roles: ROLE_ADAPTERS.map((adapter) => ({
            id: adapter,
            adapter,
            instruction:
              `You are role ${adapter}. Keep replies short and include required acceptance tokens exactly.`,
            ...adapterModel(adapter),
          })),
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
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        await cleanup(runtime, workDir, primaryError);
      }

      const types = records.map((record) => record.type);
      expect(types[0]).toBe('turn_started');
      expect(types).not.toContain('runtime_error');
      expect(types).not.toContain('turn_aborted');
      expect(types.at(-1)).toBe('turn_finished');

      const roleFinished = records.filter(isRoleFinished);
      expect(roleFinished.map((record) => record.roleId).sort()).toEqual([
        ...ROLE_ADAPTERS,
      ]);
      for (const record of roleFinished) {
        expect(
          record.result.status,
          `${record.roleId} failed: ${record.result.error ?? '(no error text)'}`,
        ).toBe('ok');
        expect(normalized(record.result.finalText), record.roleId).toContain(
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
    240_000,
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

function adapterModel(
  adapter: RoleAdapterName,
): { model?: string } {
  if (adapter === 'gemini' && GEMINI_MODEL) {
    return { model: GEMINI_MODEL };
  }
  if (adapter === 'opencode') {
    return { model: OPENCODE_MODEL };
  }
  return {};
}

interface DependencyReport {
  readonly ready: boolean;
  readonly missing: readonly string[];
}

function fanoutAcceptanceDeps(): DependencyReport {
  const missing: string[] = [];

  if (!process.env.ANTHROPIC_API_KEY) {
    missing.push('ANTHROPIC_API_KEY');
  }
  if (!process.env.CODEX_API_KEY) {
    missing.push('CODEX_API_KEY');
  }
  if (!process.env.GEMINI_API_KEY) {
    missing.push('GEMINI_API_KEY');
  }
  if (!process.env.MOONSHOT_API_KEY) {
    missing.push('MOONSHOT_API_KEY');
  }

  // The runtime imports the default Gemini/OpenCode adapters, which spawn
  // these CLI commands by name.
  requireCommand('gemini', missing);
  requireCommand('opencode', missing);

  return {
    ready: missing.length === 0,
    missing,
  };
}

function requireCommand(command: string, missing: string[]): void {
  try {
    execFileSync(command, ['--version'], {
      stdio: 'ignore',
      timeout: 5_000,
    });
  } catch {
    missing.push(`${command} CLI on PATH`);
  }
}

async function cleanup(
  runtime: TmuxPlayRuntime | undefined,
  workDir: string,
  primaryError: unknown,
): Promise<void> {
  const errors: unknown[] = [];

  try {
    await runtime?.dispose();
  } catch (error) {
    errors.push(error);
  }

  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }

  if (errors.length === 0) {
    return;
  }
  if (primaryError) {
    process.stderr.write(
      `tmux-play acceptance cleanup failed after test failure: ${errors.map(errorMessage).join('; ')}\n`,
    );
    return;
  }
  throw errors[0];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
