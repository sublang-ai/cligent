// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';

import { roleAccent } from './role-colors.js';

describe('roleAccent', () => {
  it('returns the canonical Mocha accent for each known adapter', () => {
    // Anchors per TMUX-048; changes here are normative.
    expect(roleAccent('claude')).toBe('#a6e3a1');
    expect(roleAccent('codex')).toBe('#94e2d5');
    expect(roleAccent('gemini')).toBe('#b4befe');
    expect(roleAccent('opencode')).toBe('#f5c2e7');
  });

  it('returns a stable fallback color for unknown adapters', () => {
    const first = roleAccent('some-future-adapter');
    const second = roleAccent('some-future-adapter');
    expect(first).toBe(second);
  });

  it('keeps fallback colors inside the documented pool', () => {
    const pool = new Set([
      '#74c7ec',
      '#89dceb',
      '#f5e0dc',
      '#eba0ac',
      '#f2cdcd',
    ]);
    for (const name of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
      expect(pool.has(roleAccent(name))).toBe(true);
    }
  });

  it('does not collapse all unknown adapters to a single color', () => {
    // djb2 over a handful of distinct strings should land on >=2 buckets.
    const seen = new Set<string>();
    for (const name of ['adapter-a', 'adapter-b', 'adapter-c', 'adapter-d', 'adapter-e']) {
      seen.add(roleAccent(name));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('does not return a reserved speaker/tool/status accent for known adapters', () => {
    // Sanity guard that the published map avoids the colors already claimed
    // by boss=blue, captain=mauve, tool/peach, error/red, aborted/yellow.
    const reserved = new Set([
      '#89b4fa', // blue (boss / pane active border)
      '#cba6f7', // mauve (captain / display-panes active)
      '#fab387', // peach (tool>)
      '#f38ba8', // red (error)
      '#f9e2af', // yellow (aborted)
    ]);
    for (const adapter of ['claude', 'codex', 'gemini', 'opencode']) {
      expect(reserved.has(roleAccent(adapter))).toBe(false);
    }
  });
});
