// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { shellQuote } from './shell.js';

describe('shellQuote', () => {
  it('leaves shell-safe values unquoted', () => {
    expect(shellQuote('node')).toBe('node');
    expect(shellQuote('/tmp/fanout-123/claude.log')).toBe('/tmp/fanout-123/claude.log');
    expect(shellQuote('@scope/pkg:bin=value')).toBe('@scope/pkg:bin=value');
  });

  it('quotes whitespace and embedded single quotes', () => {
    expect(shellQuote('/tmp/with space/file.log')).toBe("'/tmp/with space/file.log'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
