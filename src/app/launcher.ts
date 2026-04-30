// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveAgents, type AgentEntry } from './agents.js';
import { logFilePath, prepareLogDirectory } from './shared/logs.js';
import { shellQuote } from './shared/shell.js';
import {
  attachTmuxSession,
  isTmuxAvailable,
  runTmux,
} from './shared/tmux.js';

export interface LaunchOptions {
  agentEntries?: AgentEntry[];
  cwd?: string;
}

export async function launch(options: LaunchOptions): Promise<void> {
  // Check tmux is installed
  if (!isTmuxAvailable()) {
    console.error(
      'Error: tmux is not installed — see https://github.com/tmux/tmux#installation',
    );
    process.exit(1);
  }

  // Resolve agents to validate names / check availability
  const agents = await resolveAgents(options.agentEntries, options.cwd);
  const agentNames = agents.map((a) => a.name);

  const sessionId = randomBytes(4).toString('hex');
  const sessionName = `fanout-${sessionId}`;

  // Create persistent log directory under project root
  const projectDir = options.cwd ?? process.cwd();
  const workDir = join(projectDir, '.fanout');
  prepareLogDirectory(workDir, agentNames, '.fanout-session', sessionId);

  // Build the boss pane command args (no shell interpolation)
  const selfBin = process.argv[1];
  const entries: AgentEntry[] =
    options.agentEntries ?? agentNames.map((n) => ({ name: n }));
  const bossArgs = ['node', selfBin, '--session', sessionId];
  for (const e of entries) {
    bossArgs.push('--agent', e.model ? `${e.name}=${e.model}` : e.name);
  }
  bossArgs.push('--work-dir', workDir);
  if (options.cwd) {
    bossArgs.push('--cwd', options.cwd);
  }
  const bossCmd = bossArgs.map(shellQuote).join(' ');

  // Build tmux session (IR-007 layout)
  // a. Create session with first agent pane
  const firstLog = logFilePath(workDir, agentNames[0]);
  runTmux('new-session', '-d', '-s', sessionName, 'tail', '-f', firstLog);

  // b. Split for additional agent panes
  for (let i = 1; i < agentNames.length; i++) {
    const logFile = logFilePath(workDir, agentNames[i]);
    runTmux('split-window', '-h', '-t', sessionName, 'tail', '-f', logFile);
  }

  // c. Even-horizontal layout for agent panes
  runTmux('select-layout', '-t', sessionName, 'even-horizontal');

  // d. Boss pane (full-width bottom) — tmux runs this as a shell command
  runTmux('split-window', '-v', '-f', '-t', sessionName, bossCmd);

  // e. Set pane titles
  for (let i = 0; i < agentNames.length; i++) {
    runTmux('select-pane', '-t', `${sessionName}:0.${i}`, '-T', agentNames[i]);
  }
  runTmux(
    'select-pane',
    '-t',
    `${sessionName}:0.${agentNames.length}`,
    '-T',
    'boss',
  );

  // Enable pane border titles (name only, no index)
  runTmux('set', '-t', sessionName, 'pane-border-status', 'top');
  runTmux(
    'set',
    '-t',
    sessionName,
    'pane-border-format',
    '#{?pane_active,#[reverse],}#{pane_title}#[default]',
  );

  // Attach (replaces current terminal)
  attachTmuxSession(sessionName);
}
