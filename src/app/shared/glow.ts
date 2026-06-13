// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';

export const GLOW_INSTALL_URL =
  'https://github.com/charmbracelet/glow#installation';

// Probes `glow --version` to confirm the binary is on PATH and actually
// runs. The TMUX-051 gate exists to fail fast — checking spawn-success
// alone would let a broken or incompatible `glow` (one that spawns but
// exits nonzero on `--version`) pass the gate and surface later inside
// the presenter's render call. Status check is required.
export function isGlowAvailable(): boolean {
  const probe = spawnSync('glow', ['--version'], { stdio: 'pipe' });
  return probe.error === undefined && probe.status === 0;
}

// Renders `text` as Markdown via glow at the requested cell width and
// returns glow's stdout. `width` is the effective render budget chosen by
// the caller: text blocks pass the full pane width so glow's built-in
// document margin plus presenter continuation indentation can still reach the
// pane edge, while fenced tool bodies pass their continuation-body budget.
// The style is pinned from tmux-play's resolved Catppuccin flavor because
// glow's `auto` style picks `notty` when stdout is not a TTY (our case under
// spawnSync), which strips ANSI styling.
export function renderMarkdown(
  text: string,
  width: number,
  flavor: 'mocha' | 'latte' = 'mocha',
): string {
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error(
      `renderMarkdown requires a positive width, got: ${width}`,
    );
  }
  const style = flavor === 'latte' ? 'light' : 'dark';
  const result = spawnSync(
    'glow',
    ['-w', String(Math.trunc(width)), '-s', style, '-'],
    { input: text, stdio: 'pipe' },
  );
  if (result.error) {
    throw new Error(`glow render failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    throw new Error(
      `glow render failed: ${stderr || `exit ${result.status}`}`,
    );
  }
  return result.stdout.toString();
}
