// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolveAgents, type AgentEntry } from './agents.js';

export interface LaunchOptions {
  agentEntries?: AgentEntry[];
  cwd?: string;
}

export async function launch(options: LaunchOptions): Promise<void> {
  // Resolve agents to validate names / check availability
  const agents = await resolveAgents(options.agentEntries, options.cwd);
  const agentNames = agents.map((a) => a.name);

  const sessionId = randomBytes(4).toString('hex');
  const sessionName = `allsides-${sessionId}`;

  // Create temp directory and log files
  const workDir = mkdtempSync(join(tmpdir(), 'allsides-'));
  for (const name of agentNames) {
    writeFileSync(join(workDir, `${name}.log`), '');
  }
  writeFileSync(join(workDir, '.allsides-session'), sessionId);

  // Build the allsides command for the boss pane
  const selfBin = process.argv[1];
  const entries: AgentEntry[] =
    options.agentEntries ?? agentNames.map((n) => ({ name: n }));
  const agentFlags = entries
    .map((e) => `--agent ${e.name}${e.model ? `=${e.model}` : ''}`)
    .join(' ');
  const cwdFlag = options.cwd ? ` --cwd ${options.cwd}` : '';
  const bossCmd = `node ${selfBin} --session ${sessionId} ${agentFlags} --work-dir ${workDir}${cwdFlag}`;

  // Build tmux session
  // a. Create session with first agent pane
  const firstLog = join(workDir, `${agentNames[0]}.log`);
  execSync(
    `tmux new-session -d -s ${sessionName} "tail -f ${firstLog}"`,
  );

  // b. Split for additional agent panes
  for (let i = 1; i < agentNames.length; i++) {
    const logFile = join(workDir, `${agentNames[i]}.log`);
    execSync(
      `tmux split-window -h -t ${sessionName} "tail -f ${logFile}"`,
    );
  }

  // c. Even-horizontal layout for agent panes
  execSync(`tmux select-layout -t ${sessionName} even-horizontal`);

  // d. Boss pane (full-width bottom)
  execSync(
    `tmux split-window -v -f -t ${sessionName} "${bossCmd}"`,
  );

  // e. Set pane titles
  // Agent panes are 0..n-1, boss is n
  for (let i = 0; i < agentNames.length; i++) {
    execSync(
      `tmux select-pane -t ${sessionName}:0.${i} -T "${agentNames[i]}"`,
    );
  }
  execSync(
    `tmux select-pane -t ${sessionName}:0.${agentNames.length} -T "boss"`,
  );

  // Enable pane border titles
  execSync(
    `tmux set -t ${sessionName} pane-border-status top`,
  );

  // Attach (replaces current process)
  execSync(`tmux attach-session -t ${sessionName}`, { stdio: 'inherit' });
}
