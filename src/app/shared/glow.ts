// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';

export const GLOW_INSTALL_URL =
  'https://github.com/charmbracelet/glow#installation';

// Probes `glow --version` to confirm the binary is on PATH. Mirrors
// `isTmuxAvailable` in shared/tmux.ts so the launcher can fail fast on
// missing glow with the same shape of preflight check (per TMUX-051).
export function isGlowAvailable(): boolean {
  const probe = spawnSync('glow', ['--version'], { stdio: 'pipe' });
  return probe.error === undefined;
}

// Renders `text` as Markdown via glow at the requested cell width and
// returns glow's stdout. `width` is the effective render budget; the
// caller (the presenter) subtracts the visible `<who>> ` prefix before
// invoking so prefixed first lines and indented continuations both fit
// the pane. `-s dark` is forced because glow's `auto` style picks
// `notty` when stdout is not a TTY (our case under spawnSync), which
// strips ANSI styling.
export function renderMarkdown(text: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error(
      `renderMarkdown requires a positive width, got: ${width}`,
    );
  }
  const result = spawnSync(
    'glow',
    ['-w', String(Math.trunc(width)), '-s', 'dark', '-'],
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
