// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createInterface } from 'node:readline';
import { createWriteStream, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { WriteStream } from 'node:fs';
import type { CligentEvent } from '../types.js';
import { resolveAgents, type AgentEntry, type ResolvedAgent } from './agents.js';

export interface SessionOptions {
  sessionId: string;
  agentEntries?: AgentEntry[];
  workDir: string;
  cwd?: string;
}

export function formatEvent(event: CligentEvent): string | null {
  switch (event.type) {
    case 'text_delta':
      return (event.payload as { delta: string }).delta;
    case 'text':
      return (event.payload as { content: string }).content + '\n';
    case 'tool_use':
      return `[tool: ${(event.payload as { toolName: string }).toolName}]\n`;
    case 'error':
      return `[error: ${(event.payload as { message: string }).message}]\n`;
    case 'done': {
      const p = event.payload as {
        status: string;
        usage: { inputTokens: number; outputTokens: number };
      };
      return `\n[${p.status} | in: ${p.usage.inputTokens} out: ${p.usage.outputTokens}]\n`;
    }
    default:
      return null;
  }
}

export async function runSession(options: SessionOptions): Promise<void> {
  const { sessionId, agentEntries, workDir, cwd } = options;
  const sessionName = `fanout-${sessionId}`;

  const agents = await resolveAgents(agentEntries, cwd);

  // Open log streams
  const streams = new Map<string, WriteStream>();
  for (const agent of agents) {
    const logPath = join(workDir, `${agent.name}.log`);
    const stream = createWriteStream(logPath, { flags: 'a' });
    stream.on('error', (err) => {
      console.error(`[${agent.name}] log write error: ${err.message}`);
    });
    streams.set(agent.name, stream);
  }

  let abortController: AbortController | null = null;

  const cleanup = () => {
    // Abort any in-flight runs
    abortController?.abort();

    // Close streams
    for (const stream of streams.values()) {
      stream.end();
    }

    // Remove work dir only if marker exists
    const markerPath = join(workDir, '.fanout-session');
    if (existsSync(markerPath)) {
      rmSync(workDir, { recursive: true, force: true });
    }

    // Kill tmux session
    spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
  };

  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.setPrompt('boss$ ');
    rl.prompt();
  };
  prompt();

  // Promise chain to serialize line processing (Cligent is single-flight)
  let pending = Promise.resolve();

  rl.on('line', (line: string) => {
    const text = line.trim();
    if (!text) {
      prompt();
      return;
    }

    pending = pending.then(async () => {
      // Echo prompt to all log files
      for (const stream of streams.values()) {
        stream.write(`boss> ${text}\n\n`);
      }

      abortController = new AbortController();
      const { signal } = abortController;

      // Run all agents in parallel
      const drainAgent = async (agent: ResolvedAgent) => {
        const stream = streams.get(agent.name)!;
        try {
          for await (const event of agent.cligent.run(text, {
            abortSignal: signal,
          })) {
            const formatted = formatEvent(event);
            if (formatted !== null) {
              stream.write(formatted);
            }
          }
        } catch (err) {
          stream.write(
            `[error: ${err instanceof Error ? err.message : String(err)}]\n`,
          );
        }
      };

      await Promise.allSettled(agents.map(drainAgent));
      abortController = null;

      prompt();
    });
  });

  rl.on('close', () => {
    cleanup();
    process.exit(0);
  });
}
