// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolveAgents, type ResolvedAgent } from './agents.js';
import { formatEvent } from './session.js';

const AGENTS = ['claude', 'codex', 'gemini', 'opencode'] as const;

describe('AllSides acceptance', () => {
  let workDir: string;
  let sentinelName: string;
  let agents: ResolvedAgent[];

  beforeAll(async () => {
    // Create temp work dir
    workDir = mkdtempSync(join(tmpdir(), 'allsides-accept-'));

    // Create log files, session marker, and sentinel
    for (const name of AGENTS) {
      writeFileSync(join(workDir, `${name}.log`), '');
    }
    writeFileSync(join(workDir, '.allsides-session'), '');
    sentinelName = `SENTINEL_${randomUUID()}.txt`;
    writeFileSync(join(workDir, sentinelName), '');

    // Resolve all four agents
    agents = await resolveAgents(
      AGENTS.map((name) => ({ name })),
      workDir,
    );
  });

  afterAll(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  for (const agentName of AGENTS) {
    it(`${agentName} lists sentinel file`, async () => {
      const agent = agents.find((a) => a.name === agentName)!;
      const logPath = join(workDir, `${agentName}.log`);

      const permissions =
        agentName === 'codex'
          ? { shellExecute: 'allow' as const, fileWrite: 'allow' as const, networkAccess: 'allow' as const }
          : { shellExecute: 'allow' as const, fileWrite: 'deny' as const, networkAccess: 'deny' as const };

      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), 110_000);

      try {
        // Echo prompt to log (matches session behavior)
        const prompt = 'List the files in the current directory';
        let log = `boss> ${prompt}\n\n`;

        for await (const event of agent.cligent.run(prompt, {
          cwd: workDir,
          permissions,
          abortSignal: ac.signal,
        })) {
          const formatted = formatEvent(event);
          if (formatted !== null) {
            log += formatted;
          }
        }

        // Write log for debugging
        writeFileSync(logPath, log);

        // Assert boss echo present
        expect(log).toContain('boss>');

        // Assert sentinel filename appears in output
        expect(log).toContain(sentinelName);

        // Assert done line
        expect(log).toMatch(/\[success \|/);
      } finally {
        clearTimeout(timeout);
      }
    });
  }
});
