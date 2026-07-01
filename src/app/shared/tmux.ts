// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// TMUX-074: the tmux-play orchestrator runs inside pane 0 of the session it drives, so
// its process.env carries live TMUX / TMUX_PANE handles to that session.
// Player adapters spawn their agent CLIs from this same process.env, so a
// player that runs `tmux` (e.g. while debugging tmux itself) would inherit
// those handles and could reach — or even `kill-server` — the session hosting
// the run. That is not hypothetical: a coder player's `tmux kill-server` once
// took down a live playbook run, surfacing to the user as
// `[server exited]` / `tmux attach-session failed: exit 1`.
//
// `isolateOrchestratorFromAgents` (below) strips those handles from
// process.env and redirects TMUX_TMPDIR to a throwaway dir so any tmux a
// player starts lands on its own private server. To keep the orchestrator's
// OWN tmux commands targeting the real session after that scrub, it pins a
// snapshot of the real env here; every tmux invocation below runs with it.
let orchestratorTmuxEnv: NodeJS.ProcessEnv | undefined;

type TmuxStdio = 'pipe' | 'inherit' | 'ignore';

function tmuxSpawnOptions(stdio: TmuxStdio): {
  stdio: TmuxStdio;
  env?: NodeJS.ProcessEnv;
} {
  return orchestratorTmuxEnv
    ? { stdio, env: orchestratorTmuxEnv }
    : { stdio };
}

/**
 * Pin the environment the orchestrator's own tmux commands run with. Called by
 * {@link isolateOrchestratorFromAgents} with a snapshot of the real tmux
 * handles taken before they are scrubbed from process.env. Pass `undefined` to
 * clear (used by tests).
 */
export function setOrchestratorTmuxEnv(env: NodeJS.ProcessEnv | undefined): void {
  orchestratorTmuxEnv = env;
}

/**
 * Whether the orchestrator is attached to a tmux session. Reads the pinned
 * snapshot when set, otherwise live process.env — the pre-scrub default used
 * by the launcher and tests.
 */
export function isOrchestratorInTmux(): boolean {
  return (orchestratorTmuxEnv ?? process.env).TMUX != null;
}

/**
 * Sandbox player agents away from the orchestrator's tmux server. Pins the
 * orchestrator's real tmux handles for its own commands, then removes them
 * from process.env and points TMUX_TMPDIR at a throwaway directory so any
 * `tmux` a spawned agent runs targets its own private server — never the
 * session hosting the run. No-op when not running inside tmux (tests,
 * non-session invocations).
 */
export function isolateOrchestratorFromAgents(): void {
  if (!process.env.TMUX) return;
  setOrchestratorTmuxEnv({ ...process.env });
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  process.env.TMUX_TMPDIR = mkdtempSync(join(tmpdir(), 'cligent-agent-tmux-'));
}

export function isTmuxAvailable(): boolean {
  const probe = spawnSync('tmux', ['-V'], { stdio: 'pipe' });
  return probe.error === undefined && probe.status === 0;
}

export function runTmux(...args: string[]): void {
  const result = spawnSync('tmux', args, tmuxSpawnOptions('pipe'));
  if (result.error) {
    throw new Error(`tmux ${args[0]} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    throw new Error(`tmux ${args[0]} failed: ${stderr || `exit ${result.status}`}`);
  }
}

export function attachTmuxSession(sessionName: string): void {
  const attach = spawnSync(
    'tmux',
    ['attach-session', '-t', sessionName],
    tmuxSpawnOptions('inherit'),
  );
  if (attach.error) {
    throw new Error(`tmux attach-session failed: ${attach.error.message}`);
  }
  if (attach.status !== 0) {
    throw new Error(`tmux attach-session failed: exit ${attach.status}`);
  }
}

export function killTmuxSession(sessionName: string): void {
  spawnSync(
    'tmux',
    ['kill-session', '-t', sessionName],
    tmuxSpawnOptions('ignore'),
  );
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
    tmuxSpawnOptions('pipe'),
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
    tmuxSpawnOptions('pipe'),
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
