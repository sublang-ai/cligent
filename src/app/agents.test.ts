// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, it, expect } from 'vitest';
import { parseAgentArg, KNOWN_AGENTS } from './agents.js';

describe('parseAgentArg', () => {
  it('parses name only', () => {
    expect(parseAgentArg('claude')).toEqual({ name: 'claude' });
  });

  it('parses name=model', () => {
    expect(parseAgentArg('claude=claude-opus-4-6')).toEqual({
      name: 'claude',
      model: 'claude-opus-4-6',
    });
  });

  it('handles model with equals sign', () => {
    expect(parseAgentArg('gemini=model=v2')).toEqual({
      name: 'gemini',
      model: 'model=v2',
    });
  });
});

describe('KNOWN_AGENTS', () => {
  it('contains the four supported agents', () => {
    expect(KNOWN_AGENTS).toEqual(['claude', 'codex', 'gemini', 'opencode']);
  });
});
