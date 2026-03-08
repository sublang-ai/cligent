// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { resolveAgents, type ResolvedAgent } from './agents.js';
import { formatEvent } from './session.js';

const AGENTS = ['claude', 'codex', 'gemini', 'opencode'] as const;

// OpenCode needs an explicit model; pick one based on available API keys.
function pickOpencodeModel(): string | undefined {
  if (process.env.MOONSHOT_API_KEY) return 'moonshotai-cn/kimi-k2-turbo-preview';
  if (process.env.OPENAI_API_KEY) return 'openai/gpt-4.1-nano';
  return undefined;
}

const OPENCODE_MODEL = pickOpencodeModel();

describe('Fanout acceptance', () => {
  let workDir: string;
  let sentinelName: string;
  let agents: ResolvedAgent[];

  beforeAll(async () => {
    // Create temp work dir with git repo (required by Codex/OpenCode)
    workDir = mkdtempSync(join(tmpdir(), 'fanout-accept-'));
    execSync('git init', { cwd: workDir, stdio: 'ignore' });

    // Create log files, session marker, and sentinel
    for (const name of AGENTS) {
      writeFileSync(join(workDir, `${name}.log`), '');
    }
    writeFileSync(join(workDir, '.fanout-session'), '');
    sentinelName = `SENTINEL_${randomUUID().slice(0, 8)}.txt`;
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

        if (agentName === 'opencode' && !OPENCODE_MODEL) {
          // No recognized API key for OpenCode — skip instead of
          // producing a confusing 401 failure.
          return;
        }

        const model = agentName === 'opencode' ? OPENCODE_MODEL : undefined;

        for await (const event of agent.cligent.run(prompt, {
          cwd: workDir,
          permissions,
          abortSignal: ac.signal,
          ...(model ? { model } : {}),
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

        // Assert sentinel filename appears in output.  Strip all
        // non-alphanumeric characters so token-boundary line breaks,
        // markdown formatting, and other agent rendering quirks do
        // not cause false negatives.
        const alphaLog = log.replace(/[^a-zA-Z0-9]/g, '');
        const alphaSentinel = sentinelName.replace(/[^a-zA-Z0-9]/g, '');
        expect(alphaLog).toContain(alphaSentinel);

        // Assert done line
        expect(log).toMatch(/\[success \|/);
      } finally {
        clearTimeout(timeout);
      }
    });
  }
});
