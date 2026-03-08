// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolveAgents, type AgentEntry } from './agents.js';

export interface LaunchOptions {
  agentEntries?: AgentEntry[];
  cwd?: string;
}

function tmux(...args: string[]): void {
  const result = spawnSync('tmux', args, { stdio: 'pipe' });
  if (result.error) {
    throw new Error(`tmux ${args[0]} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    throw new Error(`tmux ${args[0]} failed: ${stderr || `exit ${result.status}`}`);
  }
}

export async function launch(options: LaunchOptions): Promise<void> {
  // Check tmux is installed
  const probe = spawnSync('tmux', ['-V'], { stdio: 'pipe' });
  if (probe.error) {
    console.error('Error: tmux is not installed — see https://github.com/tmux/tmux#installation');
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
  mkdirSync(workDir, { recursive: true });
  for (const name of agentNames) {
    writeFileSync(join(workDir, `${name}.log`), '');
  }
  writeFileSync(join(workDir, '.fanout-session'), sessionId);

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
  const firstLog = join(workDir, `${agentNames[0]}.log`);
  tmux('new-session', '-d', '-s', sessionName, 'tail', '-f', firstLog);

  // b. Split for additional agent panes
  for (let i = 1; i < agentNames.length; i++) {
    const logFile = join(workDir, `${agentNames[i]}.log`);
    tmux('split-window', '-h', '-t', sessionName, 'tail', '-f', logFile);
  }

  // c. Even-horizontal layout for agent panes
  tmux('select-layout', '-t', sessionName, 'even-horizontal');

  // d. Boss pane (full-width bottom) — tmux runs this as a shell command
  tmux('split-window', '-v', '-f', '-t', sessionName, bossCmd);

  // e. Set pane titles
  for (let i = 0; i < agentNames.length; i++) {
    tmux('select-pane', '-t', `${sessionName}:0.${i}`, '-T', agentNames[i]);
  }
  tmux('select-pane', '-t', `${sessionName}:0.${agentNames.length}`, '-T', 'boss');

  // Enable pane border titles (name only, no index)
  tmux('set', '-t', sessionName, 'pane-border-status', 'top');
  tmux('set', '-t', sessionName, 'pane-border-format',
    '#{?pane_active,#[reverse],}#{pane_title}#[default]');

  // Attach (replaces current terminal)
  const attach = spawnSync('tmux', ['attach-session', '-t', sessionName], { stdio: 'inherit' });
  if (attach.error) {
    throw new Error(`tmux attach-session failed: ${attach.error.message}`);
  }
  if (attach.status !== 0) {
    throw new Error(`tmux attach-session failed: exit ${attach.status}`);
  }
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./:=@-]+$/.test(s)) {
    return s;
  }
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
