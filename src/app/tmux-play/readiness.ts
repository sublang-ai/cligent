// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    clis: ['@moonshot-ai/kimi-code@0.27.0'],
    steps: ['kimi login'],
  },
  opencode: { peers: ['@opencode-ai/sdk'], clis: ['opencode-ai'], steps: [] },
});

/**
 * The repair commands that make one adapter runnable, in the order a user
 * should run them.
 */
export function adapterRepairCommands(
  adapter: PlayerAdapterName,
  scope: InstallScope,
): readonly string[] {
  const requirement = ADAPTER_RUNTIME_REQUIREMENTS[adapter];
  const commands: string[] = [];
  if (requirement.peers.length > 0) {
    const flag = scope === 'global' ? '-g ' : '';
    commands.push(`npm install ${flag}${requirement.peers.join(' ')}`);
  }
  for (const cli of requirement.clis) {
    commands.push(`npm install -g ${cli}`);
  }
  commands.push(...requirement.steps);
  return commands;
}

/**
 * Which install tree the running cligent lives in, and therefore whether its
 * peers need `npm install -g`.
 *
 * Two signals, because neither covers every layout on its own. npm's default
 * global root is `<node prefix>/lib/node_modules` (`<prefix>/node_modules` on
 * Windows), which identifies a stock global install outright. A configured
 * `npm config set prefix` breaks that match, so an install whose tree does not
 * contain the directory the command was run from is global too: a project
 * install is always reachable from inside the project it belongs to.
 *
 * This deliberately uses the process working directory rather than `--cwd`,
 * which names the workspace the agents operate in and says nothing about where
 * cligent was installed.
 */
export function resolveInstallScope(
  options: { readonly packageRoot?: string; readonly cwd?: string } = {},
): InstallScope {
  const packageRoot = options.packageRoot ?? cligentPackageRoot();
  if (globalModuleRoots().includes(resolveModuleRoot(packageRoot))) {
    return 'global';
  }
  const installRoot = resolveInstallRoot(packageRoot);
  const cwd = resolve(options.cwd ?? process.cwd());
  return cwd === installRoot || cwd.startsWith(installRoot + sep)
    ? 'local'
    : 'global';
}

function globalModuleRoots(): string[] {
  const roots = new Set<string>();
  const prefixes = [
    dirname(dirname(process.execPath)),
    process.env.npm_config_prefix,
    process.env.NPM_CONFIG_PREFIX,
  ];
  for (const prefix of prefixes) {
    if (!prefix) continue;
    roots.add(
      process.platform === 'win32'
        ? join(prefix, 'node_modules')
        : join(prefix, 'lib', 'node_modules'),
    );
  }
  if (process.platform === 'win32') {
    roots.add(join(dirname(process.execPath), 'node_modules'));
  }
  return [...roots];
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
  readonly scope?: InstallScope;
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
  const scope = options.scope ?? resolveInstallScope({ packageRoot });
  const lines = [
    'tmux-play found no agent runtime installed — install at least one, ' +
      'then run tmux-play again.',
    '',
  ];
  for (const adapter of KNOWN_PLAYER_ADAPTERS) {
    lines.push(`  ${adapter}`);
    for (const command of adapterRepairCommands(adapter, scope)) {
      lines.push(`    ${command}`);
    }
  }
  lines.push('');
  lines.push(installTreeNote(scope, packageRoot));
  return lines.join('\n');
}

export interface FormatMissingRuntimesOptions {
  readonly missing: readonly AdapterRoleUse[];
  readonly scope: InstallScope;
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
  const { missing, scope, packageRoot, configPath } = options;
  const subject =
    missing.length === 1
      ? `the ${missing[0]!.adapter} adapter has no runtime installed`
      : `${missing.length} configured adapters have no runtime installed`;
  const lines = [`tmux-play cannot run this config — ${subject}.`, ''];
  for (const entry of missing) {
    lines.push(`  ${entry.adapter} (${entry.roles.join(', ')})`);
    for (const command of adapterRepairCommands(entry.adapter, scope)) {
      lines.push(`    ${command}`);
    }
  }
  lines.push('');
  lines.push(installTreeNote(scope, packageRoot));
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
  /**
   * The directory the command was run from, for install-scope detection per
   * {@link resolveInstallScope}. Defaults to the process working directory;
   * this is not the agent workspace that `--cwd` selects.
   */
  readonly cwd?: string;
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
  const missing = uses.filter((use) => ready.get(use.adapter) !== true);
  if (missing.length === 0) {
    return;
  }
  const packageRoot = options.packageRoot ?? cligentPackageRoot();
  throw new Error(
    formatMissingRuntimes({
      missing,
      scope: resolveInstallScope({
        packageRoot,
        ...(options.cwd ? { cwd: options.cwd } : {}),
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
function installTreeNote(scope: InstallScope, packageRoot: string): string {
  return (
    `cligent runs from ${packageRoot} as ${scope === 'global' ? 'a global' : 'a project'} ` +
    `install, and resolves adapter SDKs from ${resolveModuleRoot(packageRoot)}.`
  );
}
