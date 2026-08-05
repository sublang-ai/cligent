// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote } from '../shared/shell.js';
import { AGENT_RUNTIME_TARGETS } from '../../runtime-targets.js';
import { isBelowFloor, readRuntimeVersion } from '../../runtime-version.js';
import {
  DEFAULT_ADAPTER_IMPORTS,
  KNOWN_PLAYER_ADAPTERS,
  type PlayerAdapterImports,
  type PlayerAdapterName,
} from './players.js';

/**
 * Where the peer packages an adapter needs have to land so the running
 * `@sublang/cligent` can resolve them: `global` for an `npm install -g`
 * installation, `local` for a project `node_modules` tree.
 */
export type InstallScope = 'global' | 'local';

/**
 * The install tree a repair command has to target, resolved from the running
 * package rather than guessed from the working directory.
 *
 * Every expressible target carries `prefix`, and every peer-SDK command
 * names it: a bare `npm install [-g] <pkg>` follows whatever global prefix
 * or nearest enclosing project npm resolves in the shell where the command
 * is pasted — an environment and working directory the process that prints
 * the command can never witness — while npm's command line outranks both,
 * so the pinned form lands in {@link moduleRoot}'s tree in every context.
 * A layout no install command expresses is `unreachable` instead, which the
 * error says outright rather than printing a command that would install
 * elsewhere.
 */
export type InstallTarget =
  | {
      readonly scope: InstallScope;
      /** The `node_modules` the adapters' bare specifiers resolve from. */
      readonly moduleRoot: string;
      /** The `--prefix` value that pins a command to {@link moduleRoot}. */
      readonly prefix: string;
    }
  | {
      readonly scope: 'global';
      readonly moduleRoot: string;
      /** No `npm install` invocation is known to reach {@link moduleRoot}. */
      readonly unreachable: true;
    };

interface AdapterRuntimeRequirement {
  /**
   * npm packages resolved from the cligent installation itself — the optional
   * peer SDKs. The repair command follows the install scope of cligent.
   */
  readonly peers: readonly string[];
  /**
   * npm packages that must put an executable on `PATH`. These are always
   * installed globally, whatever scope cligent itself uses.
   */
  readonly clis: readonly string[];
  /** One-time steps that no install command covers, e.g. an OAuth login. */
  readonly steps: readonly string[];
}

/**
 * What each built-in adapter needs before it can serve a tmux-play role.
 * Credentials are out of scope: they are the vendor CLI's own concern and
 * surface as a run-time error from the provider, not as a missing runtime.
 */
const ADAPTER_RUNTIME_REQUIREMENTS: Readonly<
  Record<PlayerAdapterName, AdapterRuntimeRequirement>
> = Object.freeze({
  claude: { peers: ['@anthropic-ai/claude-agent-sdk'], clis: [], steps: [] },
  codex: { peers: ['@openai/codex-sdk'], clis: [], steps: [] },
  gemini: { peers: [], clis: ['@google/gemini-cli'], steps: [] },
  kimi: {
    peers: [],
    clis: ['@moonshot-ai/kimi-code@0.31.1'],
    // One of Kimi's three ACP auth routes, and the only one expressible as a
    // command; a configured default model or the KIMI_MODEL_* overlay also
    // satisfies the gate, so this reads as the simplest path, not the sole one.
    steps: ['kimi login  # or configure a default model'],
  },
  opencode: { peers: ['@opencode-ai/sdk'], clis: ['opencode-ai'], steps: [] },
});

/**
 * The repair commands that make one adapter runnable, in the order a user
 * should run them.
 */
export function adapterRepairCommands(
  adapter: PlayerAdapterName,
  target: InstallTarget,
): readonly string[] {
  const requirement = ADAPTER_RUNTIME_REQUIREMENTS[adapter];
  const commands: string[] = [];
  if ('unreachable' in target) {
    // No npm invocation reaches the resolved tree, so an install command here
    // would land somewhere else and look like it had worked. Name the manual
    // placement instead; the install-tree note explains why.
    for (const peer of requirement.peers) {
      commands.push(`place ${peer} in ${target.moduleRoot}`);
    }
  } else if (requirement.peers.length > 0) {
    // The peer SDK is resolved from cligent's own tree, and every peer
    // command names both the tree and the scope: a bare install follows
    // whatever prefix, project, and install scope the paste-time shell
    // resolves, which this process cannot witness, while npm's command line
    // outranks all three. Scope needs pinning on the command line too —
    // npm's globalness is `global || location === 'global'`, either operand
    // settable by environment, so a project command pins both operands
    // (`--global=false --location=project`) or an inherited
    // `npm_config_global`/`npm_config_location` would land the SDK in
    // `<prefix>/lib/node_modules` instead of the project tree; `-g` already
    // pins the global side, because a true operand wins the OR. The prefix
    // is a filesystem path: quote it, or a path with whitespace splits into
    // a bogus package spec when the printed command is run.
    commands.push(
      [
        'npm',
        'install',
        ...(target.scope === 'global'
          ? ['-g']
          : ['--global=false', '--location=project']),
        '--prefix',
        shellQuote(target.prefix),
        ...requirement.peers,
      ].join(' '),
    );
  }
  for (const cli of requirement.clis) {
    // An external CLI is found through PATH, not through cligent's tree, so
    // it belongs in whichever global prefix the user's shell already reads —
    // never pinned to cligent's.
    commands.push(`npm install -g ${cli}`);
  }
  commands.push(...requirement.steps);
  return commands;
}

export interface ResolveInstallTargetOptions {
  readonly packageRoot?: string;
  /** Injectable for tests; defaults to `fs.existsSync`. */
  readonly fileExists?: (path: string) => boolean;
}

/**
 * The tree the running cligent resolves adapter SDKs from, and the command
 * shape that provably installs into it.
 *
 * Classification is structural, never positional. A project install root
 * carries the `package.json` that made it one; a global prefix's `lib` does
 * not. Deciding by whether the working directory happens to sit inside the
 * tree misreports a project install invoked from anywhere else as global, and
 * the resulting `npm install -g` would put the SDK where that cligent cannot
 * reach it.
 *
 * Every expressible target is pinned. Where a bare install lands is a
 * property of the shell the command is pasted into — its npm environment,
 * which npm rewrites for every lifecycle child, and its working directory,
 * which need not be the launching one — so nothing observable here proves
 * it. `npm install [-g] --prefix P` targets P's tree in every context
 * (`P/lib/node_modules` for a global P on POSIX, `P/node_modules` on
 * Windows, P's own project tree for a local P), because npm's command line
 * outranks both its environment and its project discovery.
 */
export function resolveInstallTarget(
  options: ResolveInstallTargetOptions = {},
): InstallTarget {
  const packageRoot = options.packageRoot ?? cligentPackageRoot();
  const fileExists = options.fileExists ?? existsSync;
  const moduleRoot = resolveModuleRoot(packageRoot);
  const installRoot = resolveInstallRoot(packageRoot);

  // A project tree, identified by the manifest that defines it. `--prefix
  // <root>` is equivalent to running the install from inside the project, so
  // it is safe here — unlike against a prefix `lib`, which npm would treat as
  // a manifest-less project and prune cligent itself out of.
  if (fileExists(join(installRoot, 'package.json'))) {
    return { scope: 'local', moduleRoot, prefix: installRoot };
  }

  // A global tree: `npm install -g --prefix P` targets `P/lib/node_modules`
  // (`P/node_modules` on Windows) whatever the paste-time shell's npm
  // configuration says, so name P.
  const prefix = globalPrefixFor(installRoot);
  return prefix === undefined
    ? { scope: 'global', moduleRoot, unreachable: true }
    : { scope: 'global', moduleRoot, prefix };
}

/**
 * The `--prefix` value whose global root is this install root, or `undefined`
 * for a layout no `-g` command can express — a linked checkout, say — which
 * the install-tree note reports instead of a command that would not work.
 */
function globalPrefixFor(installRoot: string): string | undefined {
  if (process.platform === 'win32') {
    return installRoot;
  }
  return basename(installRoot) === 'lib' ? dirname(installRoot) : undefined;
}

/**
 * The directory whose `node_modules` holds this cligent — the tree its
 * adapters resolve packages from. A repository checkout has no enclosing
 * `node_modules`, so it is its own install root.
 */
export function resolveInstallRoot(packageRoot: string): string {
  const segments = resolve(packageRoot).split(sep);
  const index = segments.lastIndexOf('node_modules');
  if (index <= 0) {
    return resolve(packageRoot);
  }
  return segments.slice(0, index).join(sep) || sep;
}

/**
 * The `node_modules` directory the adapters' bare specifiers resolve from.
 */
export function resolveModuleRoot(packageRoot: string): string {
  return join(resolveInstallRoot(packageRoot), 'node_modules');
}

/**
 * The installed `@sublang/cligent` package root: this module sits at
 * `<root>/dist/app/tmux-play/readiness.js` once built.
 */
export function cligentPackageRoot(
  moduleUrl: string = import.meta.url,
): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', '..', '..');
}

export interface AdapterRoleUse {
  readonly adapter: PlayerAdapterName;
  /**
   * Why the adapter is unusable, when known. TMUX-089 requires a runtime
   * installed below its supported version to be reported as such rather than
   * as absent: the repair differs, and "not installed" sends a user looking
   * for something that is already there.
   */
  readonly detail?: string;
  /** Human-readable roles that use the adapter, e.g. `captain`, `player "claude"`. */
  readonly roles: readonly string[];
}

export interface ProbeAdapterRuntimesOptions {
  readonly adapterImports?: PlayerAdapterImports;
}

/**
 * Ask each named adapter whether its runtime is installed. Construction never
 * touches an SDK — the adapters import theirs lazily inside `run()` — so
 * `isAvailable()` is the only honest signal, and it is the same one the
 * adapter itself would fail on.
 */
export async function probeAdapterRuntimes(
  adapters: readonly PlayerAdapterName[],
  options: ProbeAdapterRuntimesOptions = {},
): Promise<Map<PlayerAdapterName, boolean>> {
  const adapterImports = options.adapterImports ?? DEFAULT_ADAPTER_IMPORTS;
  const distinct = [...new Set(adapters)];
  const results = await Promise.all(
    distinct.map(async (adapter) => {
      try {
        const AdapterClass = await adapterImports[adapter]();
        return [adapter, await new AdapterClass().isAvailable()] as const;
      } catch {
        return [adapter, false] as const;
      }
    }),
  );
  return new Map(results);
}

/**
 * Every adapter whose runtime is installed, in the canonical adapter order so
 * repeated probes of the same host produce the same answer.
 */
export async function readyAdapters(
  options: ProbeAdapterRuntimesOptions = {},
): Promise<PlayerAdapterName[]> {
  const ready = await probeAdapterRuntimes(KNOWN_PLAYER_ADAPTERS, options);
  return KNOWN_PLAYER_ADAPTERS.filter((adapter) => ready.get(adapter) === true);
}

export interface FormatNoRuntimeInstalledOptions {
  readonly target?: InstallTarget;
  readonly packageRoot?: string;
}

/**
 * The first-run failure text for a host where no agent runtime is installed
 * at all: the install command for every supported adapter, so the user picks
 * one and runs `tmux-play` again.
 */
export function formatNoRuntimeInstalled(
  options: FormatNoRuntimeInstalledOptions = {},
): string {
  const packageRoot = options.packageRoot ?? cligentPackageRoot();
  const target = options.target ?? resolveInstallTarget({ packageRoot });
  const lines = [
    'tmux-play found no agent runtime installed — install at least one, ' +
      'then run tmux-play again.',
    '',
  ];
  for (const adapter of KNOWN_PLAYER_ADAPTERS) {
    lines.push(`  ${adapter}`);
    for (const command of adapterRepairCommands(adapter, target)) {
      lines.push(`    ${command}`);
    }
  }
  lines.push('');
  lines.push(installTreeNote(target, packageRoot));
  return lines.join('\n');
}

export interface FormatMissingRuntimesOptions {
  readonly missing: readonly AdapterRoleUse[];
  readonly target: InstallTarget;
  readonly packageRoot: string;
  readonly configPath?: string;
}

/**
 * The launcher-mode failure text for configured roles whose adapter runtime is
 * not installed: what is missing, which roles need it, and the exact command
 * that repairs the installation the user is actually running.
 */
export function formatMissingRuntimes(
  options: FormatMissingRuntimesOptions,
): string {
  const { missing, target, packageRoot, configPath } = options;
  const subject =
    missing.length === 1
      ? `the ${missing[0]!.adapter} adapter has no usable runtime`
      : `${missing.length} configured adapters have no usable runtime`;
  const lines = [`tmux-play cannot run this config — ${subject}.`, ''];
  for (const entry of missing) {
    lines.push(
      `  ${entry.adapter} (${entry.roles.join(', ')})` +
        (entry.detail ? ` — ${entry.detail}` : ''),
    );
    for (const command of adapterRepairCommands(entry.adapter, target)) {
      lines.push(`    ${command}`);
    }
  }
  lines.push('');
  lines.push(installTreeNote(target, packageRoot));
  if (configPath) {
    lines.push(`Edit ${configPath} to use adapters you already have.`);
  }
  return lines.join('\n');
}

/**
 * The roles a loaded tmux-play config assigns to adapters. Structural so the
 * readiness gate stays independent of the config module that loads it.
 */
export interface ConfiguredAdapterRoles {
  readonly path?: string;
  readonly config: {
    readonly captain: { readonly adapter: PlayerAdapterName };
    readonly players: readonly {
      readonly id: string;
      readonly adapter: PlayerAdapterName;
    }[];
  };
}

export interface AssertConfiguredAdaptersReadyOptions
  extends ProbeAdapterRuntimesOptions {
  readonly packageRoot?: string;
  /** Injectable for tests; defaults to `fs.existsSync`. */
  readonly fileExists?: (path: string) => boolean;
}

/**
 * Which adapters a config uses, and for what, in configuration order.
 */
export function configuredAdapterRoles(
  loaded: ConfiguredAdapterRoles,
): AdapterRoleUse[] {
  const roles = new Map<PlayerAdapterName, string[]>();
  const use = (adapter: PlayerAdapterName, role: string): void => {
    const existing = roles.get(adapter);
    if (existing) {
      existing.push(role);
      return;
    }
    roles.set(adapter, [role]);
  };
  use(loaded.config.captain.adapter, 'captain');
  for (const player of loaded.config.players) {
    use(player.adapter, `player "${player.id}"`);
  }
  return [...roles].map(([adapter, adapterRoles]) => ({
    adapter,
    roles: adapterRoles,
  }));
}

/**
 * Why an adapter's runtime is unusable, when the reason is a version rather
 * than an absence. Returns `undefined` when nothing is installed, so the
 * caller's existing "not installed" wording stands.
 */
function unusableRuntimeDetail(
  adapter: PlayerAdapterName,
): string | undefined {
  // Every runtime the adapter needs, peer and CLI alike: skipping CLI
  // targets reported an installed-but-stale gemini, kimi, or opencode as
  // absent, which TMUX-089 forbids and which sends the user to install
  // something already present.
  for (const target of AGENT_RUNTIME_TARGETS[adapter] ?? []) {
    const installed = readRuntimeVersion(target);
    if (installed === undefined) continue;
    if (isBelowFloor(installed, target)) {
      return `${target.bundles ?? target.package} ${installed} is installed but this release requires >=${target.supportedFrom}`;
    }
  }
  return undefined;
}

/**
 * Fail before a session exists when a configured role's adapter runtime is
 * not installed, naming every missing runtime and its repair command.
 */
export async function assertConfiguredAdaptersReady(
  loaded: ConfiguredAdapterRoles,
  options: AssertConfiguredAdaptersReadyOptions = {},
): Promise<void> {
  const uses = configuredAdapterRoles(loaded);
  const ready = await probeAdapterRuntimes(
    uses.map((use) => use.adapter),
    options,
  );
  const missing: AdapterRoleUse[] = uses
    .filter((use) => ready.get(use.adapter) !== true)
    .map((use) => {
      // TMUX-089: an installed-but-unsupported runtime reports its versions,
      // so the user is not sent looking for something already present.
      const detail = unusableRuntimeDetail(use.adapter);
      return detail ? { ...use, detail } : use;
    });
  if (missing.length === 0) {
    return;
  }
  const packageRoot = options.packageRoot ?? cligentPackageRoot();
  throw new Error(
    formatMissingRuntimes({
      missing,
      target: resolveInstallTarget({
        packageRoot,
        ...(options.fileExists ? { fileExists: options.fileExists } : {}),
      }),
      packageRoot,
      ...(loaded.path ? { configPath: loaded.path } : {}),
    }),
  );
}

/**
 * Where resolution is actually anchored. Naming the tree keeps a layout no
 * canned command repairs — a linked checkout, a per-tool install prefix —
 * diagnosable rather than mysterious.
 */
function installTreeNote(target: InstallTarget, packageRoot: string): string {
  const note =
    `cligent runs from ${packageRoot} as ` +
    `${target.scope === 'global' ? 'a global' : 'a project'} install, and ` +
    `resolves adapter SDKs from ${target.moduleRoot}.`;
  if (!('unreachable' in target)) {
    return note;
  }
  // No canned command reaches this tree, so say so rather than print one that
  // would land somewhere else and look like it had worked.
  return (
    `${note} No npm install command targets that tree, so place the peer ` +
    `SDK in it yourself, or reinstall cligent where npm installs globally.`
  );
}
