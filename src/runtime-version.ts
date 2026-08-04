// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareVersions,
  type RuntimeTarget,
} from './runtime-targets.js';

const requireFromHere = createRequire(import.meta.url);

/**
 * Reads an installed package's declared version, resolving from this module's
 * own location — the same search this package's adapters resolve their
 * runtimes from, so the version read is the version that would load.
 *
 * Returns `undefined` when the package cannot be resolved or its manifest
 * cannot be read. Per [ENG-025](../specs/user/engine.md), an unreadable
 * version is not evidence of an unsupported one: vendored, bundled, and
 * archived layouts are legitimate installations whose manifests this walk
 * cannot always reach, and blocking them would turn a working install into a
 * hard stop.
 */
export function readPackageVersion(packageName: string): string | undefined {
  for (const root of requireFromHere.resolve.paths(packageName) ?? []) {
    const manifest = join(root, ...packageName.split('/'), 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name !== packageName) continue;
      if (typeof parsed.version === 'string') return parsed.version;
    } catch {
      // An unreadable or malformed manifest is an unknown version, never an
      // unsupported one.
    }
    return undefined;
  }
  return undefined;
}

/**
 * The version of the runtime a target names, read the way the adapter will
 * reach it. Where the target names a vendor executable its package selects,
 * that executable's version is the answer, because it is what runs — a Codex
 * CLI predating a requested model refuses it regardless of the SDK wrapping
 * it.
 */
export function readRuntimeVersion(target: RuntimeTarget): string | undefined {
  if (target.bundles) {
    const bundled = readPackageVersion(target.bundles);
    if (bundled !== undefined) return bundled;
  }
  return readPackageVersion(target.package);
}

/** The version an executable reports, or `undefined` when it cannot be run. */
export function parseCliVersion(output: string | undefined): string | undefined {
  if (!output) return undefined;
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output);
  return match?.[1];
}

/** Whether an installed version sits below a target's supported floor. */
export function isBelowFloor(
  installed: string | undefined,
  target: RuntimeTarget,
): boolean {
  if (installed === undefined) return false;
  return compareVersions(installed, target.supportedFrom) < 0;
}

/** Whether an installed version sits above the version this release tested. */
export function isAboveTested(
  installed: string | undefined,
  target: RuntimeTarget,
): boolean {
  if (installed === undefined) return false;
  return compareVersions(installed, target.tested) > 0;
}

/**
 * The error raised when a resolved runtime is older than the adapter
 * supports. It names what is installed, what is required, where it resolved
 * from, and the command that repairs it, because the alternative the user
 * otherwise gets is the vendor's own message about a capability that has no
 * apparent connection to a version.
 */
export function unsupportedRuntimeError(
  target: RuntimeTarget,
  installed: string,
  repair: string,
): Error {
  const named = target.bundles ?? target.package;
  const tree = resolvedTreeOf(target.package);
  return new Error(
    `${named} ${installed} is older than this release of @sublang/cligent supports ` +
      `(requires >=${target.supportedFrom}, tested at ${target.tested})` +
      `${tree ? `, resolved from ${tree}` : ''}. ` +
      `Repair: ${repair}`,
  );
}

/** The `node_modules` directory a package resolved from, for diagnostics. */
export function resolvedTreeOf(packageName: string): string | undefined {
  for (const root of requireFromHere.resolve.paths(packageName) ?? []) {
    if (existsSync(join(root, ...packageName.split('/'), 'package.json'))) {
      return root;
    }
  }
  return undefined;
}

/** This package's own root, for reporting the tree a repair must target. */
export function cligentRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * Enforces a peer runtime's supported floor after its module has loaded.
 *
 * Called from inside the loader that `isAvailable()` and `run()` share, so
 * the readiness verdict and the load it protects can never disagree — the
 * property DR-012 states and DR-013 preserves by construction rather than by
 * discipline. Memoized per package: the manifest walk is filesystem work and
 * the answer cannot change within a process.
 */
const gateCache = new Map<string, string | undefined>();

export function assertRuntimeSupported(
  target: RuntimeTarget,
  repair: string,
): void {
  if (process.env.CLIGENT_RUNTIME_GATE === 'off') return;
  let installed: string | undefined;
  if (gateCache.has(target.package)) {
    installed = gateCache.get(target.package);
  } else {
    installed = readRuntimeVersion(target);
    gateCache.set(target.package, installed);
  }
  if (installed !== undefined && isBelowFloor(installed, target)) {
    throw unsupportedRuntimeError(target, installed, repair);
  }
}

/** The state of one runtime an adapter requires, per ENG-026. */
export type RuntimeReadinessState =
  | 'satisfied'
  | 'missing'
  | 'unsupported'
  | 'untested'
  | 'unknown';

export interface RuntimeReadiness {
  readonly state: RuntimeReadinessState;
  readonly target: RuntimeTarget;
  /** The version found, absent when missing or unreadable. */
  readonly installed?: string;
  /** The `node_modules` tree the runtime resolved from, when known. */
  readonly resolvedFrom?: string;
}

/**
 * Classifies one already-probed runtime.
 *
 * `available` is the adapter's own availability answer, so a caller cannot
 * produce a verdict that disagrees with the load. The version is read here
 * rather than inferred, which is what separates *installed but too old* from
 * *absent* — a distinction a boolean cannot carry and consumers were
 * previously forced to collapse into "not installed".
 */
export function classifyRuntime(
  target: RuntimeTarget,
  available: boolean,
  installed: string | undefined = readRuntimeVersion(target),
): RuntimeReadiness {
  const resolvedFrom = resolvedTreeOf(target.package);
  const base = { target, ...(resolvedFrom ? { resolvedFrom } : {}) };
  if (installed === undefined) {
    // An adapter that loads without a readable version is working; only an
    // adapter that also fails to load is missing.
    return available
      ? { state: 'unknown', ...base }
      : { state: 'missing', ...base };
  }
  if (isBelowFloor(installed, target)) {
    return { state: 'unsupported', installed, ...base };
  }
  if (isAboveTested(installed, target)) {
    return { state: 'untested', installed, ...base };
  }
  return available
    ? { state: 'satisfied', installed, ...base }
    : { state: 'missing', installed, ...base };
}

/** A one-line human summary of a verdict, for a caller that renders text. */
export function describeRuntimeReadiness(readiness: RuntimeReadiness): string {
  const { target, installed, state } = readiness;
  const named = target.bundles ?? target.package;
  switch (state) {
    case 'satisfied':
      return `${named} ${installed} is supported`;
    case 'missing':
      return `${named} is not installed (requires >=${target.supportedFrom})`;
    case 'unsupported':
      return `${named} ${installed} is too old (requires >=${target.supportedFrom}, tested at ${target.tested})`;
    case 'untested':
      return `${named} ${installed} is newer than this release tested (${target.tested})`;
    case 'unknown':
      return `${named} is installed at an unreadable version`;
  }
}
