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
  CaptainPromptRecord,
  PlayerFinishedRecord,
  PlayerPromptRecord,
  TmuxPlayRecord,
} from './records.js';
import type { PlayerAdapterName } from './players.js';
import { createTmuxPlayRuntime, type TmuxPlayRuntime } from './runtime.js';

const GEMINI_MODEL = process.env.GEMINI_MODEL;
const OPENCODE_MODEL =
  process.env.OPENCODE_MODEL ?? 'moonshotai-cn/kimi-k2.5';
const PLAYER_ADAPTERS = [
  'claude',
  'codex',
  'gemini',
  'opencode',
] as const satisfies readonly PlayerAdapterName[];
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
      const maxAttempts = 2;
      let records: TmuxPlayRecord[] = [];

      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          records = await withIsolatedGeminiCliHome(() =>
            runFanoutTurn({ workDir, sentinel }),
          );
          const transient = findTransientUpstreamFailure(records);
          if (!transient || attempt === maxAttempts) break;
          process.stderr.write(
            `tmux-play acceptance attempt ${attempt} hit transient upstream error: ${transient}\n`,
          );
        }
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }

      const types = records.map((record) => record.type);
      expect(types[0]).toBe('turn_started');
      expect(types).not.toContain('runtime_error');
      expect(types).not.toContain('turn_aborted');
      expect(types.at(-1)).toBe('turn_finished');

      const playerFinished = records.filter(isPlayerFinished);
      expect(playerFinished.map((record) => record.playerId).sort()).toEqual([
        ...PLAYER_ADAPTERS,
      ]);
      const playerPrompts = records.filter(isPlayerPrompt);
      expect(playerPrompts.map((record) => record.playerId).sort()).toEqual([
        ...PLAYER_ADAPTERS,
      ]);
      expect(types.lastIndexOf('player_prompt')).toBeLessThan(
        types.indexOf('player_finished'),
      );
      for (const record of playerFinished) {
        expect(
          record.result.status,
          `${record.playerId} failed: ${record.result.error ?? '(no error text)'}`,
        ).toBe('ok');
        expect(normalized(record.result.finalText), record.playerId).toContain(
          normalized(sentinel),
        );
      }

      const captainPrompts = records.filter(isCaptainPrompt);
      expect(captainPrompts).toHaveLength(1);
      const summaryPrompt = captainPrompts[0]?.prompt ?? '';
      for (const record of playerFinished) {
        expect(
          summaryPrompt,
          `${record.playerId} summary result section`,
        ).toContain(
          [
            `=== player:${record.playerId} status:${record.result.status} ===`,
            record.result.finalText,
            `=== /player:${record.playerId} ===`,
          ].join('\n'),
        );
      }

      const captainFinishedRecords = records.filter(isCaptainFinished);
      expect(captainFinishedRecords).toHaveLength(1);
      const captainFinished = captainFinishedRecords[0];
      expect(captainFinished?.result.status).toBe('ok');
      expect(normalized(captainFinished?.result.finalText)).toContain(
        normalized(sentinel),
      );

      const lastPlayerFinishedIndex = Math.max(
        ...records
          .map((record, index) =>
            record.type === 'player_finished' ? index : -1,
          )
          .filter((index) => index !== -1),
      );
      expect(types.indexOf('captain_prompt')).toBeGreaterThan(
        lastPlayerFinishedIndex,
      );
    },
    240_000,
  );
});

// Keep competing auth and model routes inactive so workspace .env discovery
// cannot override the explicit API key or the harness-selected model policy.
const GEMINI_ISOLATED_ENV_KEYS = [
  'GEMINI_MODEL',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_GCA',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GEMINI_BASE_URL',
  'GEMINI_CLI_USE_COMPUTE_ADC',
  'CLOUD_SHELL',
] as const;

async function withIsolatedGeminiCliHome<T>(run: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'cligent-gemini-fanout-'));
  const previousHome = process.env.GEMINI_CLI_HOME;
  const previousConflicts = new Map<string, string | undefined>(
    GEMINI_ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  process.env.GEMINI_CLI_HOME = home;
  for (const key of GEMINI_ISOLATED_ENV_KEYS) {
    // Keep the key present so Gemini's workspace .env loader cannot restore
    // a competing auth or model route from the repository under test.
    process.env[key] = '';
  }

  try {
    return await run();
  } finally {
    if (previousHome === undefined) {
      delete process.env.GEMINI_CLI_HOME;
    } else {
      process.env.GEMINI_CLI_HOME = previousHome;
    }
    for (const [key, value] of previousConflicts) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(home, { recursive: true, force: true });
  }
}

interface RunFanoutTurnOptions {
  readonly workDir: string;
  readonly sentinel: string;
}

async function runFanoutTurn(
  options: RunFanoutTurnOptions,
): Promise<TmuxPlayRecord[]> {
  const records: TmuxPlayRecord[] = [];
  let runtime: TmuxPlayRuntime | undefined;
  let primaryError: unknown;

  try {
    runtime = await createTmuxPlayRuntime({
      captain: createFanoutCaptain(),
      captainConfig: {
        adapter: 'gemini',
        instruction:
          'You are the Captain. Include required acceptance tokens exactly.',
        ...(GEMINI_MODEL ? { model: GEMINI_MODEL } : {}),
      },
      // This acceptance test intentionally uses player id == adapter name
      // so each player proves one canonical adapter path.
      players: PLAYER_ADAPTERS.map((adapter) => ({
        id: adapter,
        adapter,
        instruction:
          `You are player ${adapter}. Keep replies short and include required acceptance tokens exactly.`,
        ...adapterModel(adapter),
      })),
      cwd: options.workDir,
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
        `Every player response and the final Captain answer must include exactly this token: ${options.sentinel}`,
        'No file edits are needed.',
      ].join('\n'),
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await disposeRuntime(runtime, primaryError);
  }

  return records;
}

const TRANSIENT_UPSTREAM_MARKERS = [
  /\bAPI Error: Repeated \d{3}/i,
  /529 Overloaded/i,
  /\b(?:overload(?:ed)?|over_capacity)\b/i,
  /\bservice unavailable\b/i,
  /\brate.?limit/i,
];

function findTransientUpstreamFailure(
  records: readonly TmuxPlayRecord[],
): string | undefined {
  for (const record of records) {
    if (record.type === 'player_finished') {
      const transient = matchTransient(record.result);
      if (transient) return `${record.playerId}: ${transient}`;
      continue;
    }
    if (record.type === 'captain_finished') {
      const transient = matchTransient(record.result);
      if (transient) return `captain: ${transient}`;
    }
  }
  return undefined;
}

function matchTransient(result: {
  readonly status: string;
  readonly error?: string;
  readonly finalText?: string;
}): string | undefined {
  if (result.status !== 'error') return undefined;
  const text = result.error ?? result.finalText ?? '';
  return TRANSIENT_UPSTREAM_MARKERS.some((pattern) => pattern.test(text))
    ? text
    : undefined;
}

function isPlayerFinished(
  record: TmuxPlayRecord,
): record is PlayerFinishedRecord {
  return record.type === 'player_finished';
}

function isPlayerPrompt(record: TmuxPlayRecord): record is PlayerPromptRecord {
  return record.type === 'player_prompt';
}

function isCaptainFinished(
  record: TmuxPlayRecord,
): record is CaptainFinishedRecord {
  return record.type === 'captain_finished';
}

function isCaptainPrompt(
  record: TmuxPlayRecord,
): record is CaptainPromptRecord {
  return record.type === 'captain_prompt';
}

function normalized(value: string | undefined): string {
  return (value ?? '').replace(/[^a-zA-Z0-9]/g, '');
}

function adapterModel(
  adapter: PlayerAdapterName,
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

async function disposeRuntime(
  runtime: TmuxPlayRuntime | undefined,
  primaryError: unknown,
): Promise<void> {
  if (!runtime) return;
  try {
    await runtime.dispose();
  } catch (error) {
    if (primaryError) {
      process.stderr.write(
        `tmux-play acceptance runtime dispose failed after test failure: ${errorMessage(error)}\n`,
      );
      return;
    }
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
