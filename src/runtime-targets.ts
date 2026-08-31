// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

/**
 * The agent runtimes each built-in adapter requires, and the versions of them
 * this release supports — the single declaration of that knowledge, per
 * [package-16](../specs/packages/package.md#package-16) and [DR-013](../specs/decisions/013-cligent-owned-runtime-compatibility.md).
 *
 * Consumers do not carry this. A tool built on cligent inherits the policy by
 * upgrading cligent, and renders the verdict rather than recomputing it.
 *
 * Two versions per runtime, deliberately distinct:
 *
 * - `supportedFrom` is the lowest version that satisfies both halves of the
 *   floor rule: it supports every current model of that provider, and this
 *   adapter supports it. It is the published `peerDependencies` floor, and
 *   it blocks: below it the runtime refuses to load. It is established by
 *   checking the published runtimes, not by copying the tested version,
 *   because a floor set too high refuses installs that work.
 * - `tested` is the exact version CI verifies, the `devDependencies` pin.
 *   Above it a runtime still loads, reported as untested rather than as
 *   unsupported, because a version this release never saw is not thereby
 *   broken.
 *
 * The gap between them is intentional and is not published as an upper bound:
 * npm intersects an optional peer range into version selection, so an upper
 * bound in `peerDependencies` silently resolves an older SDK with no error.
 * The ceiling therefore lives here and is enforced at load.
 *
 * Repository verification asserts every version below equals the manifest's
 * peer range and exact development pin, so this file and `package.json`
 * cannot drift apart.
 */

/** How a runtime is found, which decides how its version is read and repaired. */
export type RuntimeKind =
  /** An npm package resolved from the installed `@sublang/cligent` tree. */
  | 'peer'
  /** An executable found through `PATH`. */
  | 'cli';

export type RuntimeTarget = {
  /** npm package name; for a `cli`, the package that installs the executable. */
  readonly package: string;
  /** Lowest supported version — the published peer floor. Blocks below. */
  readonly supportedFrom: string;
  /** Exact version this release verifies. Above it is untested, not unsupported. */
  readonly tested: string;
  /**
   * A vendor executable package the peer selects and the adapter spawns.
   * Its version is resolved from the peer's physical package tree rather
   * than from cligent's ambient dependency roots. Named only where the
   * selected executable is itself a package dependency with the same version
   * domain — Codex's CLI is what rejects a model the installed version
   * predates.
   */
  readonly bundles?: string;
  /** A one-time step no install command performs, such as an OAuth login. */
  readonly steps?: readonly string[];
  /**
   * The package specifier a repair should install, at the version this
   * release verified. Rendering the surrounding command needs the install
   * tree, which only the caller knows; this is the part that is cligent's to
   * decide, so a consumer never reconstructs an adapter-to-package mapping.
   */
  readonly repairSpec: string;
} & (
  | {
      readonly kind: 'peer';
      readonly command?: never;
    }
  | {
      readonly kind: 'cli';
      /**
       * Configured executable command. The host resolves it through its
       * native lookup at spawn time; this command, not an invented
       * host-specific absolute path, is the portable readiness identity.
       */
      readonly command: string;
    }
);

export type AgentRuntimeName =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'kimi'
  | 'opencode';

/**
 * Every runtime each adapter needs. An adapter may need more than one: the
 * OpenCode adapter resolves an SDK and, in managed mode, spawns a CLI whose
 * version package-23 requires to match it.
 */
export const AGENT_RUNTIME_TARGETS: Readonly<
  Record<AgentRuntimeName, readonly RuntimeTarget[]>
> = Object.freeze({
  claude: Object.freeze([
    Object.freeze({
      kind: 'peer' as const,
      package: '@anthropic-ai/claude-agent-sdk',
      repairSpec: '@anthropic-ai/claude-agent-sdk@0.3.251',
      // The first release whose bundled model catalog carries
      // `claude-opus-5`: 0.3.218 has `claude-sonnet-5` only, and 0.3.154 —
      // the previous floor — has neither. Bisected against the published
      // tarballs, because the catalog is data inside the package rather
      // than something the API surface reveals.
      supportedFrom: '0.3.219',
      tested: '0.3.251',
    }),
  ]),
  codex: Object.freeze([
    Object.freeze({
      kind: 'peer' as const,
      package: '@openai/codex-sdk',
      repairSpec: '@openai/codex-sdk@0.151.0',
      // The lowest release that serves the current gpt-5.6 routes
      // (`-sol`, `-luna`, `-terra`). An earlier draft required a
      // `gpt-5.6-pro` slug too and set the floor at 0.145.0; the binary
      // itself refutes that — "GPT-5.6 Pro is a Responses reasoning mode on
      // the base model, not a separate `gpt-5.6-pro` slug" — so string
      // presence was never evidence of a route. 0.139.0, the runtime
      // DR-013 was written about, remains refused.
      supportedFrom: '0.144.0',
      tested: '0.151.0',
      // The adapter spawns this executable, and it is what refuses a model
      // newer than itself, so it is the version that must be read.
      bundles: '@openai/codex',
    }),
  ]),
  gemini: Object.freeze([
    Object.freeze({
      kind: 'cli' as const,
      package: '@google/gemini-cli',
      repairSpec: '@google/gemini-cli@0.57.0',
      command: 'gemini',
      // The first release whose bundled catalog carries
      // `gemini-3.5-flash`: it is absent from 0.45.0, appears in 0.45.1,
      // and that catalog entry remains unchanged through tested 0.57.0.
      // Version 0.45.0 passes an unknown slug through with `chat-base`
      // defaults instead of rejecting it, so catalog presence is the
      // capability boundary; 0.45.1 already serves every adapter surface.
      supportedFrom: '0.45.1',
      tested: '0.57.0',
    }),
  ]),
  kimi: Object.freeze([
    Object.freeze({
      kind: 'cli' as const,
      package: '@moonshot-ai/kimi-code',
      repairSpec: '@moonshot-ai/kimi-code@0.39.1',
      command: 'kimi',
      // The release that added the non-OAuth ACP route kimi-21 documents:
      // `hasUsableConfiguredDefaultModel` is present in 0.28.1 and absent
      // in 0.28.0. A floor at the tested version would refuse 0.28.1
      // through 0.30.x, which serve every route this adapter uses.
      supportedFrom: '0.28.1',
      tested: '0.39.1',
      steps: Object.freeze(['kimi login  # or configure a default model']),
    }),
  ]),
  opencode: Object.freeze([
    Object.freeze({
      kind: 'peer' as const,
      package: '@opencode-ai/sdk',
      repairSpec: '@opencode-ai/sdk@1.18.25',
      // 1.18.12 fixed GPT-5.5+ completion requests failing when reasoning
      // is enabled — the route this adapter drives whenever `effort` maps
      // to a reasoning variant — so an earlier version admits a model path
      // known to fail.
      supportedFrom: '1.18.12',
      tested: '1.18.25',
    }),
    Object.freeze({
      kind: 'cli' as const,
      package: 'opencode-ai',
      repairSpec: 'opencode-ai@1.18.25',
      command: 'opencode',
      // package-23 requires the SDK and CLI conformance targets to match.
      supportedFrom: '1.18.12',
      tested: '1.18.25',
    }),
  ]),
});

/** Every runtime target, flattened, in adapter order. */
export function agentRuntimeTargets(): readonly RuntimeTarget[] {
  return Object.values(AGENT_RUNTIME_TARGETS).flat();
}

/**
 * Compares two dotted numeric versions, ignoring any prerelease or build
 * suffix. Vendor runtimes here version as `MAJOR.MINOR.PATCH`; a suffix such
 * as `-alpha.6` orders as its release, which keeps a prerelease of a
 * supported version supported rather than refusing it on punctuation.
 */
export function compareVersions(left: string, right: string): number {
  const parts = (value: string): number[] =>
    value
      .split(/[-+]/, 1)[0]!
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}
