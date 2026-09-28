// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Where the Codex adapter finds the CLI it runs: the launcher entry inside
// the SDK's tree (codex-12, codex-13) and the native binary that launcher
// spawns (codex-64). Kept apart from the adapter so the root entry's
// locateAgentExecutable can apply the same lookup without loading it.

import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const requireFromHere = createRequire(import.meta.url);

/** @internal */
export const CODEX_SDK_PACKAGE = '@openai/codex-sdk';
/** @internal */
export const CODEX_LAUNCHER_PACKAGE = '@openai/codex';
const CODEX_BIN_SPECIFIER = `${CODEX_LAUNCHER_PACKAGE}/bin/codex.js`;

/**
 * @internal The platform package the Codex launcher spawns from and the
 * binary's path inside that package, by the launcher's own table of target
 * triples (codex-64); undefined for a platform the launcher does not
 * support.
 */
export function codexExecutableCandidate(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { package: string; file: string } | undefined {
  const os = platform === 'android' ? 'linux' : platform;
  const triple =
    os === 'linux'
      ? arch === 'x64'
        ? 'x86_64-unknown-linux-musl'
        : arch === 'arm64'
          ? 'aarch64-unknown-linux-musl'
          : undefined
      : os === 'darwin'
        ? arch === 'x64'
          ? 'x86_64-apple-darwin'
          : arch === 'arm64'
            ? 'aarch64-apple-darwin'
            : undefined
        : os === 'win32'
          ? arch === 'x64'
            ? 'x86_64-pc-windows-msvc'
            : arch === 'arm64'
              ? 'aarch64-pc-windows-msvc'
              : undefined
          : undefined;
  if (triple === undefined) return undefined;
  const exe = platform === 'win32' ? '.exe' : '';
  return {
    package: `${CODEX_LAUNCHER_PACKAGE}-${os}-${arch}`,
    file: join('vendor', triple, 'bin', `codex${exe}`),
  };
}

/**
 * @internal Locate the native binary the Codex launcher would spawn, by the
 * launcher's own rule (codex-64): the platform package resolved beside the
 * launcher, else the launcher package's own `vendor` directory. The
 * launcher is found by codex-12's routes unless `launcherPath` is given,
 * and an unresolvable launcher raises codex-13's diagnostic. `undefined`
 * means npm dropped the optional platform package — the SDK module and the
 * launcher still load, and a run would fail with "Missing optional
 * dependency".
 */
export function locateCodexExecutable(
  options: {
    launcherPath?: string;
    platform?: NodeJS.Platform;
    arch?: string;
  } = {},
): string | undefined {
  const candidate = codexExecutableCandidate(options.platform, options.arch);
  if (candidate === undefined) return undefined;
  const launcherPath = options.launcherPath ?? resolveCodexBinPath();
  let packageRoot: string;
  try {
    const manifest = createRequire(launcherPath).resolve(
      `${candidate.package}/package.json`,
    );
    packageRoot = dirname(manifest);
  } catch {
    packageRoot = join(dirname(launcherPath), '..');
  }
  const path = join(packageRoot, candidate.file);
  return existsSync(path) ? path : undefined;
}

export interface CodexBinPathResolutionDeps {
  // Loader-provided ESM resolution; pass undefined to model runtimes that
  // predate import.meta.resolve (Node < 18.19).
  importMetaResolve?: ((specifier: string) => string) | undefined;
  // Module scope whose search paths anchor the lookup and whose resolution
  // serves as the final fallback.
  baseRequire?: Pick<NodeJS.Require, 'resolve'>;
}

interface CodexSdkAnchor {
  anchor: string;
  route: string;
}

function firstErrorLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n', 1)[0] ?? text;
}

function toRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// @openai/codex is a dependency of @openai/codex-sdk, not of cligent, so
// anchors must sit inside the installed SDK tree for layouts that do not
// hoist it (npm global prefixes, nested-strategy consumers). Anchors are
// realpath-canonicalized so pnpm-style symlinked layouts resolve from the
// SDK's physical tree, matching how Node resolves the SDK's own imports.
function codexSdkAnchors(
  importMetaResolve: ((specifier: string) => string) | undefined,
  baseRequire: Pick<NodeJS.Require, 'resolve'>,
  failures: string[],
): CodexSdkAnchor[] {
  const anchors: CodexSdkAnchor[] = [];

  if (importMetaResolve) {
    try {
      const resolvedUrl = new URL(importMetaResolve(CODEX_SDK_PACKAGE));
      if (resolvedUrl.protocol === 'file:') {
        anchors.push({
          anchor: toRealPath(fileURLToPath(resolvedUrl)),
          route: `loader-resolved ${CODEX_SDK_PACKAGE}`,
        });
      } else {
        failures.push(
          `loader resolved ${CODEX_SDK_PACKAGE} to a non-file URL ${resolvedUrl.href}`,
        );
      }
    } catch (error) {
      failures.push(
        `loader resolution of ${CODEX_SDK_PACKAGE} failed: ${firstErrorLine(error)}`,
      );
    }
  }

  const searchPaths = baseRequire.resolve.paths(CODEX_SDK_PACKAGE) ?? [];
  const manifest = searchPaths
    .map((searchPath) =>
      join(searchPath, ...CODEX_SDK_PACKAGE.split('/'), 'package.json'),
    )
    .find((candidate) => existsSync(candidate));
  if (manifest) {
    anchors.push({
      anchor: toRealPath(manifest),
      route: `search-path ${CODEX_SDK_PACKAGE} manifest`,
    });
  } else {
    failures.push(
      `no ${CODEX_SDK_PACKAGE} package manifest on module search paths ` +
        `(${searchPaths.join(', ')})`,
    );
  }

  return anchors;
}

function codexResolutionScope(deps: CodexBinPathResolutionDeps): {
  baseRequire: Pick<NodeJS.Require, 'resolve'>;
  importMetaResolve: ((specifier: string) => string) | undefined;
} {
  const baseRequire = deps.baseRequire ?? requireFromHere;
  // An injected baseRequire scopes resolution to a caller-chosen tree, so the
  // ambient loader is only auto-detected when no scope was injected; letting
  // it through would silently resolve against this module's own tree instead.
  const importMetaResolve =
    'importMetaResolve' in deps
      ? deps.importMetaResolve
      : deps.baseRequire === undefined &&
          typeof import.meta.resolve === 'function'
        ? (specifier: string) => import.meta.resolve(specifier)
        : undefined;
  return { baseRequire, importMetaResolve };
}

export function resolveCodexBinPath(
  deps: CodexBinPathResolutionDeps = {},
): string {
  const { baseRequire, importMetaResolve } = codexResolutionScope(deps);

  const failures: string[] = [];
  for (const { anchor, route } of codexSdkAnchors(
    importMetaResolve,
    baseRequire,
    failures,
  )) {
    try {
      return createRequire(anchor).resolve(CODEX_BIN_SPECIFIER);
    } catch (error) {
      failures.push(`${route} (${anchor}): ${firstErrorLine(error)}`);
    }
  }

  try {
    return baseRequire.resolve(CODEX_BIN_SPECIFIER);
  } catch (error) {
    failures.push(`cligent module scope: ${firstErrorLine(error)}`);
  }

  // Keep Node's module-resolution code so callers that degrade on a missing
  // optional CLI by testing error.code keep matching.
  throw Object.assign(
    new Error(
      `CodexAdapter could not resolve '${CODEX_BIN_SPECIFIER}', the Codex CLI ` +
        `entry owned by the '${CODEX_SDK_PACKAGE}' peer dependency.\n` +
        `Attempted:\n${failures.map((failure) => `  - ${failure}`).join('\n')}\n` +
        `Install '${CODEX_SDK_PACKAGE}' where '@sublang/cligent' can resolve ` +
        `it (for a global cligent install: npm install -g ${CODEX_SDK_PACKAGE}).`,
    ),
    { code: 'MODULE_NOT_FOUND' },
  );
}

/** @internal Where a Codex executable lookup runs; each member defaults
 * to this host and codex-12's routes from this module. */
export interface CodexExecutableLookup {
  resolution?: CodexBinPathResolutionDeps;
  platform?: NodeJS.Platform;
  arch?: string;
}

/** @internal What a Codex executable lookup found. */
export type CodexExecutableProbe =
  | { readonly state: 'present'; readonly path: string }
  | { readonly state: 'missing'; readonly package: string }
  | { readonly state: 'unsupported' }
  | { readonly state: 'no-sdk' };

/**
 * @internal Look for the native binary the Codex SDK's launcher would
 * spawn: the SDK must resolve from one of codex-12's SDK anchors, the
 * launcher must support this platform, the launcher entry must resolve
 * (else `@openai/codex` itself is what is missing), and codex-64's lookup
 * must find the binary (else its platform package is).
 */
export function probeCodexExecutable(
  lookup: CodexExecutableLookup = {},
): CodexExecutableProbe {
  const resolution = lookup.resolution ?? {};
  const { baseRequire, importMetaResolve } = codexResolutionScope(resolution);
  if (codexSdkAnchors(importMetaResolve, baseRequire, []).length === 0) {
    return { state: 'no-sdk' };
  }
  const candidate = codexExecutableCandidate(lookup.platform, lookup.arch);
  if (candidate === undefined) return { state: 'unsupported' };
  let launcherPath: string;
  try {
    launcherPath = resolveCodexBinPath(resolution);
  } catch {
    return { state: 'missing', package: CODEX_LAUNCHER_PACKAGE };
  }
  const path = locateCodexExecutable({
    launcherPath,
    platform: lookup.platform,
    arch: lookup.arch,
  });
  return path === undefined
    ? { state: 'missing', package: candidate.package }
    : { state: 'present', path };
}
