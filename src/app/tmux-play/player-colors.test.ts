// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';

import {
  SGR_RESET,
  SPEAKER_BOSS,
  SPEAKER_CAPTAIN,
  STATUS_ABORTED,
  STATUS_ERROR,
  TOOL_DENIED,
  TOOL_FAIL,
  TOOL_INVOKE,
  TOOL_OK,
  TOOL_OUTPUT_DIM,
  bold24bitFg,
  fg24bit,
  playerAccent,
} from './player-colors.js';

// TMUX-048 fallback pools; changes here are normative. Sapphire is absent
// from both because the `kimi` adapter claims it.
const FALLBACK_POOL_MOCHA = new Set([
  '#89dceb', // sky
  '#f5e0dc', // rosewater
  '#eba0ac', // maroon
  '#f2cdcd', // flamingo
]);

const FALLBACK_POOL_LATTE = new Set([
  '#04a5e5', // sky
  '#dc8a78', // rosewater
  '#e64553', // maroon
  '#dd7878', // flamingo
]);

const KNOWN_ADAPTERS = ['claude', 'codex', 'gemini', 'kimi', 'opencode'];

describe('playerAccent', () => {
  it('returns the canonical Mocha accent for each known adapter', () => {
    // Anchors per TMUX-048; changes here are normative.
    expect(playerAccent('claude')).toBe('#a6e3a1');
    expect(playerAccent('codex')).toBe('#94e2d5');
    expect(playerAccent('gemini')).toBe('#b4befe');
    expect(playerAccent('kimi')).toBe('#74c7ec');
    expect(playerAccent('opencode')).toBe('#f5c2e7');
  });

  it('returns the canonical Latte accent for each known adapter', () => {
    expect(playerAccent('claude', 'latte')).toBe('#40a02b');
    expect(playerAccent('codex', 'latte')).toBe('#179299');
    expect(playerAccent('gemini', 'latte')).toBe('#7287fd');
    expect(playerAccent('kimi', 'latte')).toBe('#209fb5');
    expect(playerAccent('opencode', 'latte')).toBe('#ea76cb');
  });

  it('returns a stable fallback color for unknown adapters', () => {
    const first = playerAccent('some-future-adapter');
    const second = playerAccent('some-future-adapter');
    expect(first).toBe(second);
  });

  it('keeps fallback colors inside the documented pool', () => {
    for (const name of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']) {
      expect(FALLBACK_POOL_MOCHA.has(playerAccent(name))).toBe(true);
      expect(FALLBACK_POOL_LATTE.has(playerAccent(name, 'latte'))).toBe(true);
    }
  });

  it('never hands an unknown adapter a known adapter accent', () => {
    // TMUX-048: neither pool may contain an accent assigned to a known
    // adapter. `kimi` claimed sapphire, so sapphire left both pools —
    // otherwise `cursor`/`qwen`/`agentx`/`cline` would render identically
    // to a `kimi` player in the same session.
    for (const adapter of KNOWN_ADAPTERS) {
      expect(FALLBACK_POOL_MOCHA.has(playerAccent(adapter))).toBe(false);
      expect(FALLBACK_POOL_LATTE.has(playerAccent(adapter, 'latte'))).toBe(
        false,
      );
    }
    for (const name of ['cursor', 'qwen', 'agentx', 'cline', 'some-future']) {
      for (const adapter of KNOWN_ADAPTERS) {
        expect(playerAccent(name)).not.toBe(playerAccent(adapter));
        expect(playerAccent(name, 'latte')).not.toBe(
          playerAccent(adapter, 'latte'),
        );
      }
    }
  });

  it('does not collapse all unknown adapters to a single color', () => {
    // djb2 over a handful of distinct strings should land on >=2 buckets.
    const seen = new Set<string>();
    for (const name of ['adapter-a', 'adapter-b', 'adapter-c', 'adapter-d', 'adapter-e']) {
      seen.add(playerAccent(name));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('does not return a reserved speaker/tool/status accent for known adapters', () => {
    // Sanity guard that the published map avoids the colors already claimed
    // by boss=blue, captain=mauve, tool/peach, error/red, aborted/yellow.
    const reserved = new Set([
      SPEAKER_BOSS,
      SPEAKER_CAPTAIN,
      '#fab387', // peach (tool>)
      STATUS_ERROR,
      STATUS_ABORTED,
    ]);
    for (const adapter of KNOWN_ADAPTERS) {
      expect(reserved.has(playerAccent(adapter))).toBe(false);
    }
  });
});

describe('SGR helpers', () => {
  it('emits bold + 24-bit foreground for the speaker palette anchors', () => {
    // Anchors per TMUX-038/039 — changes here are normative.
    expect(SPEAKER_BOSS).toBe('#89b4fa');
    expect(SPEAKER_CAPTAIN).toBe('#cba6f7');
    expect(STATUS_ERROR).toBe('#f38ba8');
    expect(STATUS_ABORTED).toBe('#f9e2af');
  });

  it('builds bold24bitFg from the hex byte pairs', () => {
    expect(bold24bitFg('#89b4fa')).toBe('\x1b[1;38;2;137;180;250m');
    expect(bold24bitFg('#a6e3a1')).toBe('\x1b[1;38;2;166;227;161m');
    expect(bold24bitFg('#000000')).toBe('\x1b[1;38;2;0;0;0m');
    expect(bold24bitFg('#ffffff')).toBe('\x1b[1;38;2;255;255;255m');
  });

  it('exposes a reset escape that closes the SGR span', () => {
    expect(SGR_RESET).toBe('\x1b[0m');
  });

  it('exposes the tool lifecycle palette anchors per TMUX-049', () => {
    expect(TOOL_INVOKE).toBe('#fab387'); // peach
    expect(TOOL_OK).toBe('#a6e3a1'); // green
    expect(TOOL_FAIL).toBe('#f38ba8'); // red
    expect(TOOL_DENIED).toBe('#f9e2af'); // yellow
    expect(TOOL_OUTPUT_DIM).toBe('#6c7086'); // overlay0
  });

  it('builds fg24bit without bold for the dim tool-output body', () => {
    expect(fg24bit('#6c7086')).toBe('\x1b[38;2;108;112;134m');
    expect(fg24bit('#ffffff')).toBe('\x1b[38;2;255;255;255m');
  });
});
