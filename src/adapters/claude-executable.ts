// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Where the Claude adapter finds the native binary its SDK spawns
// (claude-code-57). Kept apart from the adapter so the root entry's
// locateAgentExecutable can apply the same lookup without loading it.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** @internal */
export const CLAUDE_SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
const requireFromHere = createRequire(import.meta.url);

function toRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

let muslHost: boolean | undefined;

/**
 * The SDK's own libc test: a Linux process whose diagnostic report carries
 * no glibc runtime version runs on musl. The answer cannot change within a
 * process, so the report is generated once.
 */
function isMuslHost(): boolean {
  if (muslHost === undefined) {
    const report =
      process.platform === 'linux' &&
      typeof process.report?.getReport === 'function'
        ? (process.report.getReport() as {
            header?: { glibcVersionRuntime?: unknown };
          })
        : undefined;
    muslHost =
      report !== undefined && report.header?.glibcVersionRuntime === undefined;
  }
  return muslHost;
}

/**
 * @internal The platform packages the Claude SDK spawns its native binary
 * from, in the SDK's own order (claude-code-57): Linux tries the musl
 * package first on a musl host and the glibc package first otherwise,
 * Android its own package, every other platform the one package for its
 * platform and architecture. The file inside is `claude` (`claude.exe` on
 * Windows). `preferMusl` defaults to the SDK's libc test on this host.
 */
export function claudeExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  preferMusl: boolean = platform === 'linux' && isMuslHost(),
): string[] {
  const exe = platform === 'win32' ? '.exe' : '';
  const glibc = `${CLAUDE_SDK_PACKAGE}-linux-${arch}`;
  const musl = `${glibc}-musl`;
  const packages =
    platform === 'android'
      ? [`${glibc}-android`]
      : platform === 'linux'
        ? preferMusl
          ? [musl, glibc]
          : [glibc, musl]
        : [`${CLAUDE_SDK_PACKAGE}-${platform}-${arch}`];
  return packages.map((name) => `${name}/claude${exe}`);
}

/** @internal The package half of a `claudeExecutableCandidates()` entry. */
export function claudeExecutablePackage(candidate: string): string {
  return candidate.slice(0, candidate.lastIndexOf('/'));
}

/**
 * The SDK module's location, as an anchor for resolving its siblings: the
 * loader's resolution when it exists, else the package manifest found along
 * this module's own search paths.
 */
function claudeSdkAnchor(): string | undefined {
  if (typeof import.meta.resolve === 'function') {
    try {
      const url = new URL(import.meta.resolve(CLAUDE_SDK_PACKAGE));
      if (url.protocol === 'file:') return fileURLToPath(url);
    } catch {
      // The loader could not resolve it; the search paths may still.
    }
  }
  for (const searchPath of requireFromHere.resolve.paths(CLAUDE_SDK_PACKAGE) ??
    []) {
    const manifest = join(
      searchPath,
      ...CLAUDE_SDK_PACKAGE.split('/'),
      'package.json',
    );
    if (existsSync(manifest)) return manifest;
  }
  return undefined;
}

/**
 * The platform packages the SDK's own manifest declares as optional
 * dependencies, read from the nearest manifest at or above the anchor;
 * undefined when that manifest is unreadable, is not the SDK's, or
 * declares none, since a vendored layout is no evidence of an unsupported
 * platform.
 */
function claudeSdkPlatformPackages(
  anchor: string,
): ReadonlySet<string> | undefined {
  let directory = dirname(anchor);
  for (;;) {
    const manifestPath = join(directory, 'package.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          name?: unknown;
          optionalDependencies?: unknown;
        };
        const optional = manifest.optionalDependencies;
        if (
          manifest.name !== CLAUDE_SDK_PACKAGE ||
          typeof optional !== 'object' ||
          optional === null
        ) {
          return undefined;
        }
        return new Set(Object.keys(optional));
      } catch {
        return undefined;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** @internal Where a Claude executable lookup runs; each member defaults
 * to this host and the tree this module resolves the SDK from. */
export interface ClaudeExecutableLookup {
  /** The SDK's location; `undefined` passed explicitly means the SDK does
   * not resolve. */
  anchor?: string | undefined;
  platform?: NodeJS.Platform;
  arch?: string;
  preferMusl?: boolean;
}

/**
 * @internal What a Claude executable lookup found, with the host it looked
 * on wherever the executable is not there.
 */
export type ClaudeExecutableProbe =
  | { readonly state: 'present'; readonly path: string }
  | {
      readonly state: 'missing';
      readonly package: string;
      readonly platform: NodeJS.Platform;
      readonly arch: string;
    }
  | {
      readonly state: 'unsupported';
      readonly platform: NodeJS.Platform;
      readonly arch: string;
    }
  | { readonly state: 'no-sdk' };

/**
 * @internal Look for the native binary the Claude SDK would spawn, by the
 * SDK's own rule (claude-code-57): each candidate platform package
 * resolved from the SDK's location, the first whose binary exists, found
 * whatever the manifest lists. With none installed, the SDK's manifest
 * tells a platform it publishes no binary for (`unsupported`) from one
 * whose optional package npm dropped (`missing`, naming the package the
 * SDK tries first on this host); a manifest that says nothing either way
 * reads `missing`, since a vendored layout is legitimate. An unresolvable
 * SDK is `no-sdk`.
 */
export function probeClaudeExecutable(
  lookup: ClaudeExecutableLookup = {},
): ClaudeExecutableProbe {
  const found = 'anchor' in lookup ? lookup.anchor : claudeSdkAnchor();
  if (found === undefined) return { state: 'no-sdk' };
  const platform = lookup.platform ?? process.platform;
  const arch = lookup.arch ?? process.arch;
  // Node resolves the SDK's own imports from its physical location, so a
  // linked install searches the tree the link points into (the search-path
  // manifest is not canonical where Node predates import.meta.resolve).
  const anchor = toRealPath(found);
  const candidates = claudeExecutableCandidates(
    platform,
    arch,
    lookup.preferMusl,
  );
  const resolveFromSdk = createRequire(anchor);
  for (const candidate of candidates) {
    try {
      const path = resolveFromSdk.resolve(candidate);
      if (existsSync(path)) return { state: 'present', path };
    } catch {
      // Not installed here; try the next candidate.
    }
  }
  const packages = candidates.map(claudeExecutablePackage);
  const published = claudeSdkPlatformPackages(anchor);
  if (published !== undefined && !packages.some((pkg) => published.has(pkg))) {
    return { state: 'unsupported', platform, arch };
  }
  return { state: 'missing', package: packages[0]!, platform, arch };
}
