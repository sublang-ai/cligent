// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  probeClaudeExecutable,
  type ClaudeExecutableLookup,
} from './adapters/claude-executable.js';
import {
  CODEX_LAUNCHER_PACKAGE,
  codexSdkResolves,
  probeCodexExecutable,
  type CodexExecutableLookup,
} from './adapters/codex-executable.js';

/**
 * Where the native executable an agent runtime's SDK spawns stands, per
 * engine-88:
 *
 * - `present`: the executable exists at `path`;
 * - `missing`: the SDK resolves, but `package` — the platform package the
 *   SDK would spawn from first on this host, or `@openai/codex` when the
 *   Codex CLI entry itself does not resolve — is not installed;
 * - `unsupported`: the SDK publishes no executable for this platform and
 *   architecture;
 * - `no-sdk`: the SDK itself does not resolve, so there is no second fault
 *   to report beside the missing SDK.
 */
export type AgentExecutable =
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

/** @internal Where a lookup runs; each member defaults to this host and the
 * trees this package resolves each SDK from. */
export interface AgentExecutableLookup {
  platform?: NodeJS.Platform;
  arch?: string;
  preferMusl?: boolean;
  claude?: Pick<ClaudeExecutableLookup, 'anchor'>;
  codex?: Pick<CodexExecutableLookup, 'resolution'>;
}

/**
 * @internal `locateAgentExecutable` over an injected host and SDK trees,
 * for tests; the public function is this over the real host.
 */
export function locateAgentExecutableWith(
  runtime: 'claude' | 'codex',
  lookup: AgentExecutableLookup,
): AgentExecutable {
  const platform = lookup.platform ?? process.platform;
  const arch = lookup.arch ?? process.arch;
  if (runtime === 'claude') {
    // The Claude probe's states are engine-88's own.
    return probeClaudeExecutable({
      ...lookup.claude,
      platform,
      arch,
      preferMusl: lookup.preferMusl,
    });
  }
  if (!codexSdkResolves(lookup.codex?.resolution)) return { state: 'no-sdk' };
  const probe = probeCodexExecutable({ ...lookup.codex, platform, arch });
  // An unresolvable launcher entry leaves @openai/codex itself missing.
  return probe.state === 'no-entry'
    ? { state: 'missing', package: CODEX_LAUNCHER_PACKAGE, platform, arch }
    : probe;
}

/**
 * Locates the native executable the `claude` or `codex` runtime's SDK
 * spawns, by the same lookup that runtime's adapter applies before calling
 * the adapter available (engine-88), so a host can name the missing piece
 * without copying any SDK's layout rule.
 */
export function locateAgentExecutable(
  runtime: 'claude' | 'codex',
): AgentExecutable {
  return locateAgentExecutableWith(runtime, {});
}
