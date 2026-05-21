// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// TTMUX-055: real-run end-to-end probe that the Claude role can do file work
// through the tmux-play runtime. It reproduces and guards the user-reported
// failure — "write a file to a temporary location and delete it" did nothing
// — by driving a create turn and a delete turn through the fanout Captain and
// verifying the result on disk. A role whose permissions resolve to a headless
// `permissionMode: 'default'` (a config with no `permissions` block) cannot
// complete the create turn; `permissions: { mode: 'auto' }` can.
//
// The Boss prompts target the working directory — itself a freshly created
// temp directory — so the "temporary location" scenario is exercised while the
// outcome stays deterministically verifiable (a single write-then-delete turn
// leaves nothing on disk to assert against).

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import createFanoutCaptain from '../../captains/fanout.js';
import type { RoleFinishedRecord, TmuxPlayRecord } from './records.js';
import { createTmuxPlayRuntime, type TmuxPlayRuntime } from './runtime.js';

const MAX_ATTEMPTS = 2;
const ready = Boolean(process.env.ANTHROPIC_API_KEY);

// Acceptance files are excluded from the standard CI matrix; when the
// acceptance config does load this file, CI hard-fails on a missing key.
const acceptanceIt = ready || process.env.CI ? it : it.skip;

// Mirrors fanout.acceptance.test.ts: retry only on upstream-capacity failures
// so a genuine permission regression still surfaces instead of being retried.
const TRANSIENT_UPSTREAM_MARKERS = [
  /\bAPI Error: Repeated \d{3}/i,
  /529 Overloaded/i,
  /\b(?:overload(?:ed)?|over_capacity)\b/i,
  /\bservice unavailable\b/i,
  /\brate.?limit/i,
];

interface ScenarioOutcome {
  readonly records: readonly TmuxPlayRecord[];
  readonly fileAfterCreate: boolean;
  readonly contentAfterCreate: string;
  readonly fileAfterDelete: boolean;
}

describe('tmux-play Claude role file write/delete (TTMUX-055)', () => {
  acceptanceIt(
    'writes then deletes a file via the fanout Captain runtime',
    async () => {
      if (!ready) {
        throw new Error(
          'Missing ANTHROPIC_API_KEY for the tmux-play Claude acceptance probe',
        );
      }

      let outcome: ScenarioOutcome | undefined;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        outcome = await runScenario();
        const transient = transientFailure(outcome.records);
        if (!transient || attempt === MAX_ATTEMPTS) break;
        process.stderr.write(
          `tmux-play Claude acceptance attempt ${attempt} hit transient ` +
            `upstream error: ${transient}\n`,
        );
      }

      const result = outcome!;
      const roleFinished = result.records.filter(
        (record): record is RoleFinishedRecord =>
          record.type === 'role_finished',
      );
      const finishedSummary = roleFinished
        .map((record) => `${record.result.status}:${record.result.error ?? '-'}`)
        .join(' | ');

      // Control-plane: both turns completed cleanly.
      const types = result.records.map((record) => record.type);
      expect(types, finishedSummary).not.toContain('runtime_error');
      expect(types, finishedSummary).not.toContain('turn_aborted');
      expect(roleFinished.length, finishedSummary).toBe(2);
      for (const record of roleFinished) {
        expect(record.result.status, finishedSummary).toBe('ok');
      }

      // Ground truth: the role actually created, then deleted, the file.
      expect(
        result.fileAfterCreate,
        'file missing after the create turn — the Claude role could not write',
      ).toBe(true);
      expect(result.contentAfterCreate).toContain('SENTINEL_');
      expect(
        result.fileAfterDelete,
        'file still present after the delete turn — the role could not delete',
      ).toBe(false);
    },
    300_000,
  );
});

async function runScenario(): Promise<ScenarioOutcome> {
  const cwd = mkdtempSync(join(tmpdir(), 'tmux-play-claude-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  const fileName = `scratch_${randomUUID().slice(0, 8)}.txt`;
  const sentinel = `SENTINEL_${randomUUID().slice(0, 8)}`;
  const filePath = join(cwd, fileName);
  const records: TmuxPlayRecord[] = [];

  let runtime: TmuxPlayRuntime | undefined;
  try {
    runtime = await createTmuxPlayRuntime({
      captain: createFanoutCaptain({ maxRoleOutputChars: 2_000 }),
      captainConfig: { adapter: 'claude', permissions: { mode: 'auto' } },
      roles: [
        { id: 'claude', adapter: 'claude', permissions: { mode: 'auto' } },
      ],
      cwd,
      observers: [
        {
          onRecord(record) {
            records.push(record);
          },
        },
      ],
    });

    // Turn 1 only creates — it must not forbid deletion, since the role's
    // session resumes on turn 2 (TMUX-041) and Claude would treat a turn-1
    // "do not delete" against a turn-2 "delete" as a contradiction to refuse.
    await runtime.runBossTurn(
      `Create a file named ${fileName} in the current working directory ` +
        `containing exactly the text "${sentinel}".`,
    );
    const fileAfterCreate = existsSync(filePath);
    const contentAfterCreate = fileAfterCreate
      ? readFileSync(filePath, 'utf8')
      : '';

    await runtime.runBossTurn(
      `Delete the file named ${fileName} from the current working directory.`,
    );
    const fileAfterDelete = existsSync(filePath);

    return { records, fileAfterCreate, contentAfterCreate, fileAfterDelete };
  } finally {
    if (runtime) await runtime.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
}

function transientFailure(
  records: readonly TmuxPlayRecord[],
): string | undefined {
  for (const record of records) {
    if (record.type !== 'role_finished' && record.type !== 'captain_finished') {
      continue;
    }
    if (record.result.status !== 'error') continue;
    const text = record.result.error ?? record.result.finalText ?? '';
    if (TRANSIENT_UPSTREAM_MARKERS.some((pattern) => pattern.test(text))) {
      return text;
    }
  }
  return undefined;
}
