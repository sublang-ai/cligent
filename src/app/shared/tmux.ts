// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';

export function isTmuxAvailable(): boolean {
  const probe = spawnSync('tmux', ['-V'], { stdio: 'pipe' });
  return probe.error === undefined;
}

export function runTmux(...args: string[]): void {
  const result = spawnSync('tmux', args, { stdio: 'pipe' });
  if (result.error) {
    throw new Error(`tmux ${args[0]} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    throw new Error(`tmux ${args[0]} failed: ${stderr || `exit ${result.status}`}`);
  }
}

export function attachTmuxSession(sessionName: string): void {
  const attach = spawnSync('tmux', ['attach-session', '-t', sessionName], {
    stdio: 'inherit',
  });
  if (attach.error) {
    throw new Error(`tmux attach-session failed: ${attach.error.message}`);
  }
  if (attach.status !== 0) {
    throw new Error(`tmux attach-session failed: exit ${attach.status}`);
  }
}

export function killTmuxSession(sessionName: string): void {
  spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
}
