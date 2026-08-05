// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';

import {
  AGENT_RUNTIME_TARGETS,
  agentRuntimeTargets,
  compareVersions,
  type RuntimeTarget,
} from '../runtime-targets.js';
import {
  classifyRuntime,
  isAboveTested,
  isBelowFloor,
  parseCliVersion,
  readPackageVersion,
  readRuntimeVersion,
  isUnsupportedRuntimeError,
  unsupportedRuntimeError,
} from '../runtime-version.js';

// DR-013 / ENG-025 / ENG-026: cligent owns which runtime versions work. The
// descriptor is the declaration and the loader is the enforcement; these pin
// the comparison rules both depend on.
describe('agent runtime targets (PKG-016)', () => {
  it('declares a supported floor at or below the tested version', () => {
    for (const target of agentRuntimeTargets()) {
      expect(
        compareVersions(target.supportedFrom, target.tested),
        `${target.package}: floor must not exceed the tested version`,
      ).toBeLessThanOrEqual(0);
    }
  });

  it('keeps the paired OpenCode SDK and CLI targets equal', () => {
    // PKG-012 requires the SDK client and its CLI server to share a target.
    const [sdk, cli] = AGENT_RUNTIME_TARGETS.opencode;
    expect(sdk?.tested).toBe(cli?.tested);
    expect(sdk?.supportedFrom).toBe(cli?.supportedFrom);
  });

  it('names the vendor executable whose version actually decides behavior', () => {
    // The Codex CLI, not the SDK wrapping it, is what refuses a model newer
    // than itself — so it is the version the gate must read.
    expect(AGENT_RUNTIME_TARGETS.codex[0]?.bundles).toBe('@openai/codex');
  });

  it('is frozen against mutation by a consumer', () => {
    expect(Object.isFrozen(AGENT_RUNTIME_TARGETS)).toBe(true);
    expect(Object.isFrozen(AGENT_RUNTIME_TARGETS.codex[0])).toBe(true);
  });
});

describe('runtime version comparison (ENG-025)', () => {
  const target: RuntimeTarget = {
    kind: 'peer',
    package: '@example/sdk',
    repairSpec: '@example/sdk@0.146.0',
    supportedFrom: '0.138.0',
    tested: '0.146.0',
  };

  it('orders a frozen minor below a newer one', () => {
    // The presenting defect: 0.139.0 read as current because a caret froze it.
    expect(isBelowFloor('0.137.9', target)).toBe(true);
    expect(isBelowFloor('0.138.0', target)).toBe(false);
    expect(isBelowFloor('0.146.0', target)).toBe(false);
  });

  it('separates untested from unsupported', () => {
    // A version this release never saw is not thereby broken.
    expect(isAboveTested('0.147.0', target)).toBe(true);
    expect(isBelowFloor('0.147.0', target)).toBe(false);
    expect(isAboveTested('0.146.0', target)).toBe(false);
  });

  it('treats a prerelease as its release rather than refusing on punctuation', () => {
    expect(compareVersions('0.147.0-alpha.6', '0.146.0')).toBe(1);
    expect(isBelowFloor('0.138.0-rc.1', target)).toBe(false);
  });

  it('never reports an unknown version as unsupported', () => {
    // ENG-025 fails open: vendored and archived layouts are legitimate.
    expect(isBelowFloor(undefined, target)).toBe(false);
    expect(isAboveTested(undefined, target)).toBe(false);
    expect(readPackageVersion('@example/definitely-not-installed')).toBeUndefined();
  });

  it('reads a version through the same resolution the adapter loads with', () => {
    // zod is a real production dependency of this package.
    expect(readPackageVersion('zod')).toMatch(/^\d+\.\d+\.\d+/);
    expect(readRuntimeVersion(AGENT_RUNTIME_TARGETS.codex[0]!)).toMatch(
      /^\d+\.\d+\.\d+/,
    );
  });

  it('parses a version out of CLI output', () => {
    expect(parseCliVersion('codex-cli 0.146.0')).toBe('0.146.0');
    expect(parseCliVersion('0.53.1\n')).toBe('0.53.1');
    expect(parseCliVersion('')).toBeUndefined();
    expect(parseCliVersion(undefined)).toBeUndefined();
  });

  it('names installed, required, and repair in the refusal', () => {
    const error = unsupportedRuntimeError(
      AGENT_RUNTIME_TARGETS.codex[0]!,
      '0.139.0',
      'npm install @openai/codex-sdk@0.146.0',
    );
    expect(error.message).toContain('@openai/codex');
    expect(error.message).toContain('0.139.0');
    expect(error.message).toContain(
      `>=${AGENT_RUNTIME_TARGETS.codex[0]!.supportedFrom}`,
    );
    expect(error.message).toContain('npm install @openai/codex-sdk@0.146.0');
  });
});

describe('the runtimes DR-013 was written about', () => {
  it('refuses Codex 0.139.0, the exact runtime that motivated this work', () => {
    // The regression the first implementation shipped with: a floor of
    // 0.138.0 classified 0.139.0 as satisfied, so the gate approved the
    // runtime whose model refusal started all of this.
    const codex = AGENT_RUNTIME_TARGETS.codex[0]!;
    expect(classifyRuntime(codex, true, '0.139.0').state).toBe('unsupported');
    expect(isBelowFloor('0.139.0', codex)).toBe(true);
    // 0.145.0 is the first release carrying the whole current model family,
    // and the floor is that version rather than the tested one, so a working
    // 0.145.0 install is not refused.
    expect(classifyRuntime(codex, true, '0.145.0').state).toBe('satisfied');
    expect(classifyRuntime(codex, true, '0.144.0').state).toBe('unsupported');
  });

  it('enforces a CLI runtime floor, not only a peer one', () => {
    // readRuntimeVersion ignored `kind` and searched node_modules for every
    // target, so a CLI on PATH read as unknown and its floor never applied.
    const kimi = AGENT_RUNTIME_TARGETS.kimi[0]!;
    expect(kimi.kind).toBe('cli');
    expect(classifyRuntime(kimi, true, '0.27.0').state).toBe('unsupported');
    expect(classifyRuntime(kimi, true, '0.31.1').state).toBe('satisfied');
    const opencodeCli = AGENT_RUNTIME_TARGETS.opencode[1]!;
    expect(opencodeCli.kind).toBe('cli');
    expect(classifyRuntime(opencodeCli, true, '1.14.40').state).toBe('unsupported');
  });

  it('carries the repair the verdict promises', () => {
    // ENG-026 and the changelog both say the verdict carries repair
    // commands; without it a consumer rebuilds the adapter-to-package map
    // this work exists to delete.
    // An explicit version keeps this a pure classification check: the
    // default would probe, and a CLI probe spawns a real process.
    for (const target of agentRuntimeTargets()) {
      const verdict = classifyRuntime(target, false, '0.0.1');
      expect(verdict.repair.spec).toContain(target.package);
      expect(Array.isArray(verdict.repair.steps)).toBe(true);
    }
    expect(
      classifyRuntime(AGENT_RUNTIME_TARGETS.kimi[0]!, false, '0.0.1').repair
        .steps.length,
    ).toBeGreaterThan(0);
  });

  it('marks a version refusal so run() can re-throw it intact', () => {
    // Otherwise run() replaces it with "install it", advice that is wrong
    // for a runtime already installed.
    const error = unsupportedRuntimeError(
      AGENT_RUNTIME_TARGETS.codex[0]!,
      '0.139.0',
      'npm install @openai/codex-sdk@0.146.0',
    );
    expect(isUnsupportedRuntimeError(error)).toBe(true);
    expect(isUnsupportedRuntimeError(new Error('missing'))).toBe(false);
  });
});
