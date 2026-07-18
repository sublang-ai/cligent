// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';

import {
  EFFORT_SUPPORT,
  assertSupportedEffort,
  getEffortSupport,
  isEffortSupported,
  supportedEffortValues,
} from '../index.js';

describe('built-in effort metadata', () => {
  it('publishes deeply frozen adapter-scoped values', () => {
    expect(EFFORT_SUPPORT['claude-code'].values).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultracode',
    ]);
    expect(EFFORT_SUPPORT['claude-code'].orchestrationValues).toEqual([
      'ultracode',
    ]);
    expect(EFFORT_SUPPORT.codex.values).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(EFFORT_SUPPORT.codex.orchestrationValues).toEqual(['ultra']);
    expect(EFFORT_SUPPORT.gemini.values).toEqual([
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(EFFORT_SUPPORT.kimi.values).toEqual(['off', 'on']);
    expect(EFFORT_SUPPORT.opencode.values).toEqual(
      EFFORT_SUPPORT.gemini.values,
    );
    expect(EFFORT_SUPPORT.gemini.orchestrationValues).toEqual([]);
    expect(EFFORT_SUPPORT.kimi.orchestrationValues).toEqual([]);
    expect(EFFORT_SUPPORT.opencode.orchestrationValues).toEqual([]);

    expect(Object.isFrozen(EFFORT_SUPPORT)).toBe(true);
    for (const support of Object.values(EFFORT_SUPPORT)) {
      expect(Object.isFrozen(support)).toBe(true);
      expect(Object.isFrozen(support.values)).toBe(true);
      expect(Object.isFrozen(support.orchestrationValues)).toBe(true);
      expect(support.modelDependent).toBe(true);
      expect(support.notes.length).toBeGreaterThan(20);

      expect(() => {
        (support as unknown as { notes: string }).notes = 'mutated';
      }).toThrow(TypeError);
      expect(() => {
        (support.values as unknown as string[]).push('turbo');
      }).toThrow(TypeError);
      expect(() => {
        (support.orchestrationValues as unknown as string[]).push('turbo');
      }).toThrow(TypeError);
    }
    expect(() => {
      (EFFORT_SUPPORT as unknown as Record<string, unknown>).codex = undefined;
    }).toThrow(TypeError);
    expect(EFFORT_SUPPORT.codex.values).toContain('ultra');
  });

  it('resolves the tmux-play claude alias', () => {
    expect(getEffortSupport('claude')).toBe(getEffortSupport('claude-code'));
    expect(supportedEffortValues('claude')).toContain('ultracode');
  });

  it('validates against the selected adapter', () => {
    expect(isEffortSupported('claude-code', 'ultracode')).toBe(true);
    expect(isEffortSupported('claude-code', 'ultra')).toBe(false);
    expect(isEffortSupported('codex', 'ultra')).toBe(true);
    expect(isEffortSupported('codex', 'ultracode')).toBe(false);
    expect(isEffortSupported('gemini', 'ultra')).toBe(false);
    expect(getEffortSupport('kimi')).toBe(EFFORT_SUPPORT.kimi);
    expect(supportedEffortValues('kimi')).toBe(EFFORT_SUPPORT.kimi.values);
    expect(isEffortSupported('kimi', 'off')).toBe(true);
    expect(isEffortSupported('kimi', 'on')).toBe(true);
    expect(isEffortSupported('kimi', 'high')).toBe(false);
    expect(isEffortSupported('gemini', 'on')).toBe(false);
  });

  it('names the path, adapter, and allowed values on validation errors', () => {
    expect(() =>
      assertSupportedEffort('codex', 'ultra', 'players[0].effort'),
    ).not.toThrow();
    expect(() =>
      assertSupportedEffort('claude', 'ultra', 'players[0].effort'),
    ).toThrow(
      'players[0].effort for adapter "claude" must be one of: minimal, low, medium, high, xhigh, max, ultracode',
    );
    expect(() => assertSupportedEffort('kimi', 'off')).not.toThrow();
    expect(() =>
      assertSupportedEffort('kimi', 'high', 'players[4].effort'),
    ).toThrow('players[4].effort for adapter "kimi" must be one of: off, on');
  });

  it('returns no support for unknown adapters', () => {
    expect(getEffortSupport('custom-agent')).toBeUndefined();
    expect(supportedEffortValues('custom-agent')).toBeUndefined();
    expect(isEffortSupported('custom-agent', 'high')).toBe(false);
    expect(() => assertSupportedEffort('custom-agent', 'high')).toThrow(
      'effort cannot be validated for unknown adapter "custom-agent"',
    );
  });

  it('documents every lossy and no-op mapping condition', () => {
    expect(EFFORT_SUPPORT.gemini.notes).toContain('collapses');
    expect(EFFORT_SUPPORT.gemini.notes).toContain('no effort override');
    expect(EFFORT_SUPPORT.opencode.notes).toContain('Anthropic collapses');
    expect(EFFORT_SUPPORT.opencode.notes).toContain('OpenAI collapses');
    expect(EFFORT_SUPPORT.opencode.notes).toContain('Google collapses');
    expect(EFFORT_SUPPORT.opencode.notes).toContain('no effort override');
    expect(EFFORT_SUPPORT.kimi.notes).toContain('binary');
    expect(EFFORT_SUPPORT.kimi.notes).toContain(
      "selected model's native default thinking effort",
    );
    expect(EFFORT_SUPPORT.kimi.notes).toContain(
      'rather than a portable reasoning-depth tier',
    );
  });
});
