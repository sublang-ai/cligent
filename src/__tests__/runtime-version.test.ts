// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AGENT_RUNTIME_TARGETS,
  agentRuntimeTargets,
  compareVersions,
  type RuntimeTarget,
} from '../runtime-targets.js';
import {
  assertRuntimeSupported,
  classifyRuntime,
  describeRuntimeReadiness,
  isAboveTested,
  isBelowFloor,
  isCliRuntimeSupported,
  isUnsupportedRuntimeError,
  parseCliVersion,
  readPackageVersion,
  readRuntimeVersion,
  readRuntimeVersionFromResolver,
  resolvedTreeOf,
  unsupportedRuntimeError,
} from '../runtime-version.js';

// DR-013 / engine-25 / engine-26: cligent owns which runtime versions work. The
// descriptor is the declaration and the loader is the enforcement; these pin
// the comparison rules both depend on.
describe('agent runtime targets (package-16)', () => {
  it('declares a supported floor at or below the tested version', () => {
    for (const target of agentRuntimeTargets()) {
      expect(
        compareVersions(target.supportedFrom, target.tested),
        `${target.package}: floor must not exceed the tested version`,
      ).toBeLessThanOrEqual(0);
    }
  });

  it('keeps the paired OpenCode SDK and CLI targets equal', () => {
    // package-23 requires the SDK client and its CLI server to share a target.
    const [sdk, cli] = AGENT_RUNTIME_TARGETS.opencode;
    expect(sdk?.tested).toBe(cli?.tested);
    expect(sdk?.supportedFrom).toBe(cli?.supportedFrom);
  });

  it('keeps compatibility in one coherent runtime version domain', () => {
    // Claude compatibility belongs to the version-tied SDK. Its selected
    // executable identity is SDK-owned metadata, not an independently
    // resolvable package dependency.
    expect(AGENT_RUNTIME_TARGETS.claude[0]?.bundles).toBeUndefined();
    // The Codex CLI, not the SDK wrapping it, is what refuses a model newer
    // than itself. It is a real dependency in the SDK's version domain.
    expect(AGENT_RUNTIME_TARGETS.codex[0]?.bundles).toBe('@openai/codex');
  });

  it('is frozen against mutation by a consumer', () => {
    expect(Object.isFrozen(AGENT_RUNTIME_TARGETS)).toBe(true);
    expect(Object.isFrozen(AGENT_RUNTIME_TARGETS.codex[0])).toBe(true);
  });

  it('requires every CLI target to carry its configured command identity', () => {
    for (const target of agentRuntimeTargets()) {
      if (target.kind === 'cli') {
        expect(target.command.length).toBeGreaterThan(0);
      }
    }
    // @ts-expect-error A CLI descriptor without its command has no identity.
    const missingCommand: RuntimeTarget = {
      kind: 'cli',
      package: '@example/cli-runtime',
      repairSpec: '@example/cli-runtime@1.0.0',
      supportedFrom: '1.0.0',
      tested: '1.0.0',
    };
    expect(missingCommand.kind).toBe('cli');
  });
});

describe('runtime version comparison (engine-25)', () => {
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
    // engine-25 fails open: vendored and archived layouts are legitimate.
    expect(isBelowFloor(undefined, target)).toBe(false);
    expect(isAboveTested(undefined, target)).toBe(false);
    expect(readPackageVersion('@example/definitely-not-installed')).toBeUndefined();
  });

  it('reads a version through the same resolution the adapter loads with', () => {
    // zod is a real production dependency of this package.
    expect(readPackageVersion('zod')).toMatch(/^\d+\.\d+\.\d+/);
    const claude = AGENT_RUNTIME_TARGETS.claude[0]!;
    expect(readRuntimeVersion(claude)).toBe(readPackageVersion(claude.package));
    expect(
      describeRuntimeReadiness(classifyRuntime(claude, true, claude.tested)),
    ).toBe(`${claude.package} ${claude.tested} is supported`);
    expect(readRuntimeVersion(AGENT_RUNTIME_TARGETS.codex[0]!)).toMatch(
      /^\d+\.\d+\.\d+/,
    );
  });

  it('reads a selected package only from the SDK physical tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'cligent-runtime-owner-'));
    const consumer = join(root, 'consumer');
    const store = join(root, 'store');
    const packageDirectory = (tree: string, packageName: string): string =>
      join(tree, 'node_modules', ...packageName.split('/'));
    const writePackage = (
      tree: string,
      packageName: string,
      version: string,
      extra: Readonly<Record<string, unknown>> = {},
    ): string => {
      const directory = packageDirectory(tree, packageName);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'package.json'),
        `${JSON.stringify({ name: packageName, version, ...extra })}\n`,
        'utf8',
      );
      return directory;
    };

    try {
      const physicalSdk = writePackage(store, '@openai/codex-sdk', '0.146.0', {
        dependencies: { '@openai/codex': '0.146.0' },
      });
      const ownedCodex = writePackage(physicalSdk, '@openai/codex', '0.146.0');
      // This decoy is on the physical SDK resolver's ancestor path. Node can
      // find it after the nested dependency disappears, so the reader must
      // also validate the candidate against the SDK's exact declaration.
      writePackage(store, '@openai/codex', '9.9.9');
      writePackage(consumer, '@openai/codex', '8.8.8');
      const linkedSdk = packageDirectory(consumer, '@openai/codex-sdk');
      mkdirSync(dirname(linkedSdk), { recursive: true });
      symlinkSync(physicalSdk, linkedSdk, 'junction');

      const resolver = createRequire(join(consumer, 'probe.mjs'));
      const codex = AGENT_RUNTIME_TARGETS.codex[0]!;
      expect(readRuntimeVersionFromResolver(codex, resolver)).toBe('0.146.0');

      writeFileSync(
        join(physicalSdk, 'package.json'),
        `${JSON.stringify({
          name: '@openai/codex-sdk',
          version: '0.146.0',
        })}\n`,
        'utf8',
      );
      expect(readRuntimeVersionFromResolver(codex, resolver)).toBeUndefined();
      writeFileSync(
        join(physicalSdk, 'package.json'),
        `${JSON.stringify({
          name: '@openai/codex-sdk',
          version: '0.146.0',
          dependencies: { '@openai/codex': '0.146.0' },
        })}\n`,
        'utf8',
      );
      expect(readRuntimeVersionFromResolver(codex, resolver)).toBe('0.146.0');

      // Once the SDK-owned dependency disappears, the unrelated package in
      // the consumer tree is not a substitute, nor may the SDK version be
      // fabricated as the selected executable's version.
      rmSync(ownedCodex, { recursive: true, force: true });
      expect(readRuntimeVersionFromResolver(codex, resolver)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a peer tree and a CLI command without inventing a CLI path', () => {
    const peerVersion = readPackageVersion('zod');
    const peerTree = resolvedTreeOf('zod');
    expect(peerVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(peerTree).toBeDefined();
    if (peerVersion === undefined || peerTree === undefined) {
      throw new Error('expected the installed zod peer and its resolved tree');
    }

    const peer: RuntimeTarget = {
      kind: 'peer',
      package: 'zod',
      repairSpec: `zod@${peerVersion}`,
      supportedFrom: '0.0.1',
      tested: peerVersion,
    };
    expect(classifyRuntime(peer, true)).toEqual({
      state: 'satisfied',
      target: peer,
      installed: peerVersion,
      resolvedFrom: peerTree,
      repair: { spec: `zod@${peerVersion}`, steps: [] },
    });
    expect(
      unsupportedRuntimeError(
        peer,
        '0.0.0',
        `npm install zod@${peerVersion}`,
      ).message,
    ).toBe(
      `zod 0.0.0 is older than this release of @sublang/cligent supports ` +
        `(requires >=0.0.1, tested at ${peerVersion}), resolved from ` +
        `${peerTree}. Repair: npm install zod@${peerVersion}`,
    );

    const previousPath = process.env.PATH;
    const command = basename(process.execPath);
    try {
      process.env.PATH =
        `${dirname(process.execPath)}${delimiter}${previousPath ?? ''}`;
      const cli: RuntimeTarget = {
        kind: 'cli',
        package: '@example/cli-runtime',
        command,
        repairSpec: '@example/cli-runtime@99.0.0',
        supportedFrom: '99.0.0',
        tested: '99.0.0',
      };
      const readiness = classifyRuntime(cli, true);
      expect(readiness).toEqual({
        state: 'unsupported',
        target: cli,
        installed: process.versions.node,
        repair: { spec: '@example/cli-runtime@99.0.0', steps: [] },
      });
      expect(readiness).not.toHaveProperty('resolvedFrom');
      expect(describeRuntimeReadiness(readiness)).toBe(
        `${command} ${process.versions.node} is too old ` +
          '(requires >=99.0.0, tested at 99.0.0)',
      );
      let refusal: unknown;
      try {
        assertRuntimeSupported(
          cli,
          'npm install -g @example/cli-runtime@99.0.0',
        );
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(Error);
      expect((refusal as Error).message).toBe(
        `${command} ${process.versions.node} is older than this release of ` +
          '@sublang/cligent supports (requires >=99.0.0, tested at 99.0.0). ' +
          'Repair: npm install -g @example/cli-runtime@99.0.0',
      );
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
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
    expect(classifyRuntime(codex, true, '0.144.0').state).toBe('satisfied');
    expect(classifyRuntime(codex, true, '0.143.0').state).toBe('unsupported');
  });

  it('keeps a CLI probe and the verdict from disagreeing', () => {
    // The gap this closes: readRuntimeVersion could read a CLI version, but
    // the gemini/kimi/opencode probes still answered "does it run", so
    // isAvailable() reported true for a runtime the verdict called
    // unsupported — the disagreement DR-013 forbids. `node` stands in for a
    // real executable so this exercises the spawn path without depending on
    // an agent CLI being installed.
    const asNode = (supportedFrom: string): RuntimeTarget => ({
      kind: 'cli',
      package: 'node',
      command: process.execPath,
      repairSpec: 'node@latest',
      supportedFrom,
      tested: '99.0.0',
    });
    expect(isCliRuntimeSupported(asNode('99.0.0'))).toBe(false);
    expect(isCliRuntimeSupported(asNode('0.0.1'))).toBe(true);
    // Fail open: an executable that cannot be run is unknown, not refused.
    expect(
      isCliRuntimeSupported({
        ...asNode('99.0.0'),
        command: 'cligent-no-such-command',
      }),
    ).toBe(true);
  });

  it('throws for a below-floor CLI, so a direct run is refused too', () => {
    // The gap: the CLI check lived only in `isAvailable()`, but
    // `Cligent.run()` reaches `adapter.run()` directly, so a stale CLI was
    // spawned and failed mid-turn. Both paths now share this assertion.
    const asNode = (supportedFrom: string): RuntimeTarget => ({
      kind: 'cli',
      package: `node-${supportedFrom}`,
      command: process.execPath,
      repairSpec: 'node@latest',
      supportedFrom,
      tested: '99.0.0',
    });
    expect(() =>
      assertRuntimeSupported(asNode('99.0.0'), 'npm install -g node'),
    ).toThrow(/is older than this release/);
    expect(() =>
      assertRuntimeSupported(asNode('0.0.1'), 'npm install -g node'),
    ).not.toThrow();
  });

  it('enforces a CLI runtime floor, not only a peer one', () => {
    // readRuntimeVersion ignored `kind` and searched node_modules for every
    // target, so a CLI on PATH read as unknown and its floor never applied.
    const kimi = AGENT_RUNTIME_TARGETS.kimi[0]!;
    expect(kimi.kind).toBe('cli');
    expect(classifyRuntime(kimi, true, '0.27.0').state).toBe('unsupported');
    expect(classifyRuntime(kimi, true, '0.28.1').state).toBe('satisfied');
    const opencodeCli = AGENT_RUNTIME_TARGETS.opencode[1]!;
    expect(opencodeCli.kind).toBe('cli');
    expect(classifyRuntime(opencodeCli, true, '1.18.11').state).toBe('unsupported');
  });

  it('carries the repair the verdict promises', () => {
    // engine-26 and the changelog both say the verdict carries repair
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
