// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createInterface } from 'node:readline';
import { resolveAgents, type AgentEntry, type ResolvedAgent } from './agents.js';
import { formatCligentEvent } from './shared/events.js';
import {
  closeLogStreams,
  openAppendLogStreams,
  writeBossPrompt,
} from './shared/logs.js';
import { killTmuxSession } from './shared/tmux.js';

export interface SessionOptions {
  sessionId: string;
  agentEntries?: AgentEntry[];
  workDir: string;
  cwd?: string;
}

export async function runSession(options: SessionOptions): Promise<void> {
  const { sessionId, agentEntries, workDir, cwd } = options;
  const sessionName = `fanout-${sessionId}`;

  const agents = await resolveAgents(agentEntries, cwd);

  const streams = openAppendLogStreams(
    workDir,
    agents.map((agent) => agent.name),
    (name, err) => {
      console.error(`[${name}] log write error: ${err.message}`);
    },
  );

  let abortController: AbortController | null = null;

  const cleanup = () => {
    // Abort any in-flight runs
    abortController?.abort();

    // Close streams (logs persist in .fanout/)
    closeLogStreams(streams.values());

    // Kill tmux session
    killTmuxSession(sessionName);
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
      writeBossPrompt(streams.values(), text);

      abortController = new AbortController();
      const { signal } = abortController;

      // Run all agents in parallel
      const drainAgent = async (agent: ResolvedAgent) => {
        const stream = streams.get(agent.name)!;
        try {
          for await (const event of agent.cligent.run(text, {
            abortSignal: signal,
          })) {
            const formatted = formatCligentEvent(event);
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
