// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertAcceptanceDependencies,
  gateAcceptanceTest,
} from './helpers/acceptance-dependency-gate.js';

describe('auto-mode acceptance dependency gate (engine-219)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports every concrete local prerequisite before selecting skip', () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const run = Symbol('run');
    const skip = Symbol('skip');
    const missing = ['GEMINI_API_KEY', 'gemini CLI on PATH'];

    expect(gateAcceptanceTest(run, skip, 'gemini', missing, false)).toBe(skip);
    expect(stderr).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith(
      'Missing gemini auto-mode acceptance dependencies: ' +
        'GEMINI_API_KEY, gemini CLI on PATH; skipping locally\n',
    );
  });

  it('runs a missing-prerequisite case under CI and hard-fails readiness', () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const run = Symbol('run');
    const skip = Symbol('skip');
    const missing = ['MOONSHOT_API_KEY', 'opencode CLI on PATH'];

    expect(gateAcceptanceTest(run, skip, 'opencode', missing, true)).toBe(run);
    expect(stderr).not.toHaveBeenCalled();
    expect(() => assertAcceptanceDependencies('opencode', missing)).toThrow(
      'Missing opencode auto-mode acceptance dependencies: ' +
        'MOONSHOT_API_KEY, opencode CLI on PATH',
    );
  });

  it('runs a ready local case without a diagnostic', () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const run = Symbol('run');

    expect(gateAcceptanceTest(run, Symbol('skip'), 'codex', [], false)).toBe(
      run,
    );
    expect(stderr).not.toHaveBeenCalled();
    expect(() => assertAcceptanceDependencies('codex', [])).not.toThrow();
  });
});
