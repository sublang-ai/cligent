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
 * - `supportedFrom` is the oldest version that serves the latest models the
 *   runtime's provider offers and supplies every runtime surface the adapter
 *   drives, per [DR-027](../specs/decisions/027-latest-models-oldest-serving-runtime.md).
 *   It blocks: below it the runtime refuses to load.
 *   For a peer target it is also the published `peerDependencies` floor.
 *   It is established by checking the published runtimes, not by copying
 *   the tested version, because a floor set too high refuses installs that
 *   work.
 * - `tested` is the exact version CI verifies: a peer target's
 *   `devDependencies` pin or a CLI target's exact CI install. Above it a
 *   runtime still loads, reported as untested rather than as unsupported,
 *   because a version this release never saw is not thereby broken.
 *
 * For peer targets, the gap between them is intentional and is not published
 * as an upper bound: npm intersects an optional peer range into version
 * selection, so an upper bound in `peerDependencies` silently resolves an
 * older SDK with no error. The ceiling therefore lives here and is enforced
 * at load.
 *
 * Repository verification derives its expectations from this descriptor,
 * asserts peer targets match the manifest's range and development pin, and
 * checks CLI targets against their exact CI installs.
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
  /** Lowest supported version. Blocks below; also the peer floor for peers. */
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
      repairSpec: '@anthropic-ai/claude-agent-sdk@0.3.284',
      // The first release whose baked-in model catalog, which Claude Code
      // calls its source of truth for per-model IDs and metadata, carries
      // `claude-sonnet-5-5`, the latest Sonnet: 0.3.283 lacks the entry and
      // still maps the `sonnet` alias to `claude-sonnet-5`, and 0.3.284, the
      // next published release, carries it with its low-to-max efforts and
      // adaptive thinking and makes it the `sonnet` default. The other
      // latest lines arrived earlier: `claude-opus-5-5` in 0.3.280 (0.3.278
      // lacks it and 0.3.279 was never published), `claude-fable-5-1` in
      // 0.3.257 (0.3.252 lacks it and 0.3.253 through 0.3.256 were never
      // published), while 0.3.251 already carries `claude-haiku-4-5`.
      // Bisected against the published darwin-arm64 and linux-x64 platform
      // binaries, because the catalog is data inside the bundled executable
      // rather than something the SDK's API surface reveals.
      supportedFrom: '0.3.284',
      tested: '0.3.284',
    }),
  ]),
  codex: Object.freeze([
    Object.freeze({
      kind: 'peer' as const,
      package: '@openai/codex-sdk',
      repairSpec: '@openai/codex-sdk@0.159.0',
      // The first release whose bundled model catalog carries the whole
      // GPT-6 family, the latest OpenAI models: the published 0.156.0 binary
      // carries only `gpt-6-astra` (absent from 0.153.0, bundled since
      // 0.153.1), and 0.156.1 adds `gpt-6-sol` and `gpt-6-luna`. API-key
      // runs fetch no remote model list while the under-development
      // `api_key_model_discovery` feature stays off by default, so the
      // bundled catalog alone decides; ChatGPT account runs also merge a
      // remote catalog the service filters by each entry's
      // `minimal_client_version`, which is 0.155.0 for Sol and Luna. A
      // runtime without the entry falls back to generic slug metadata with no
      // reasoning levels or speed tiers. Bisected against the published
      // darwin-arm64 binaries and the tagged `models.json`. 0.139.0, the
      // runtime DR-013 was written about, stays refused.
      supportedFrom: '0.156.1',
      tested: '0.159.0',
      // The adapter spawns this executable, and it is what refuses a model
      // newer than itself, so it is the version that must be read.
      bundles: '@openai/codex',
    }),
  ]),
  gemini: Object.freeze([
    Object.freeze({
      kind: 'cli' as const,
      package: '@google/gemini-cli',
      repairSpec: '@google/gemini-cli@0.61.0',
      command: 'gemini',
      // The first release whose bundled catalog carries the latest Gemini
      // models, `gemini-3.8-flash` and `gemini-3.5-flash-lite`: both are
      // absent from 0.60.0 and 0.61.0-preview.0 and first appear in
      // 0.61.0-preview.1, so the stable 0.61.0 is the oldest release that
      // serves them. Like every release from 0.60.0, it loads system
      // settings and defaults only from root-owned paths, so effort reaches
      // it through a per-run user-settings home rather than system defaults.
      supportedFrom: '0.61.0',
      tested: '0.61.0',
    }),
  ]),
  kimi: Object.freeze([
    Object.freeze({
      kind: 'cli' as const,
      package: '@moonshot-ai/kimi-code',
      repairSpec: '@moonshot-ai/kimi-code@2.1.1',
      command: 'kimi',
      // Serving Kimi's latest models, `kimi-k3` on the Open Platform and
      // `k3` or `k3-256k` on Kimi Code, is not gated by the CLI version: from
      // 0.28.1 through 2.1.1 a session runs only configured aliases, whether
      // from config.toml, the KIMI_MODEL_* overlay, or the Kimi Code
      // service's model list written at login, and the same alias sends the
      // same request in 0.28.1, 0.39.1, and 2.1.1. From 0.40.0 a service
      // model marked `protocol: "response"` uses the Responses API; that
      // boundary stays unbound while the service still serves k3 over chat
      // completions. The floor is therefore the surface boundary: the first
      // release whose then-current legacy ACP gate admitted a configured
      // default model with non-OAuth credentials, since
      // `hasUsableConfiguredDefaultModel` is present in 0.28.1 and absent in
      // 0.28.0. Version 0.28.1 also negotiates ACP protocol version 1, the
      // protocol surface the paired SDK and this adapter drive.
      supportedFrom: '0.28.1',
      tested: '2.1.1',
      steps: Object.freeze(['kimi login  # or configure a default model']),
    }),
  ]),
  opencode: Object.freeze([
    Object.freeze({
      kind: 'peer' as const,
      package: '@opencode-ai/sdk',
      repairSpec: '@opencode-ai/sdk@1.18.33',
      // OpenCode takes its model catalog from models.dev at runtime, so the
      // latest models resolve on any version; only two request paths are
      // version-gated. Claude Fable 5.1 and Opus 5.5 bind thinking
      // signatures to a conversation prefix OpenCode re-renders between
      // turns: 1.18.25 sends no binding control, 1.18.26 adds
      // `drop_block` but for every Claude model, which Vertex and proxy routes
      // reject for Claude 5.0 models such as Sonnet 5, and 1.18.27 limits it
      // to Claude 5.1 and later. The ChatGPT-account route drops every
      // `gpt-6-*` model through a `gpt-<major>.<minor>` filter up to 1.18.28
      // and admits them from 1.18.29. The previous 1.18.12 floor fixed an
      // Azure-only completion route. The server is the serving runtime; the
      // SDK client keeps the same floor.
      supportedFrom: '1.18.29',
      tested: '1.18.33',
    }),
    Object.freeze({
      kind: 'cli' as const,
      package: 'opencode-ai',
      repairSpec: 'opencode-ai@1.18.33',
      command: 'opencode',
      // The managed CLI is the server that serves the latest models, with
      // the 1.18.29 boundary evidenced on the SDK target above; package-23
      // requires their conformance targets to match.
      supportedFrom: '1.18.29',
      tested: '1.18.33',
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
