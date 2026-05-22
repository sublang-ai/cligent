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

// Maps pane title (e.g., `Captain`, `Claude`) to current pane width. Returns
// an empty map when tmux is unreachable or the session has no panes — callers
// fall back to Infinity (no soft-wrap) for missing entries.
export function queryPaneWidthsByTitle(
  sessionName: string,
): Map<string, number> {
  const widths = new Map<string, number>();
  const result = spawnSync(
    'tmux',
    [
      'list-panes',
      '-t',
      `${sessionName}:0`,
      '-F',
      '#{pane_title}\t#{pane_width}',
    ],
    { stdio: 'pipe' },
  );
  if (result.error || result.status !== 0) {
    return widths;
  }
  const lines = result.stdout.toString().split('\n');
  for (const line of lines) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const title = line.slice(0, tab);
    const width = Number.parseInt(line.slice(tab + 1), 10);
    if (Number.isFinite(width) && width > 0) {
      widths.set(title, width);
    }
  }
  return widths;
}

// Maps pane title (e.g., `Captain · claude`, `Coder · codex`) to tmux's
// stable pane id (e.g., `%3`). Returns an empty map when tmux is unreachable
// so callers can treat status updates as best-effort UI.
export function queryPaneTargetsByTitle(
  sessionName: string,
): Map<string, string> {
  const targets = new Map<string, string>();
  const result = spawnSync(
    'tmux',
    [
      'list-panes',
      '-t',
      `${sessionName}:0`,
      '-F',
      '#{pane_title}\t#{pane_id}',
    ],
    { stdio: 'pipe' },
  );
  if (result.error || result.status !== 0) {
    return targets;
  }
  const lines = result.stdout.toString().split('\n');
  for (const line of lines) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const title = line.slice(0, tab);
    const target = line.slice(tab + 1);
    if (target) {
      targets.set(title, target);
    }
  }
  return targets;
}
