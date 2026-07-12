// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  type Document,
  type Pair,
  type Scalar,
  type YAMLMap,
} from 'yaml';
import { assertSupportedEffort, type EffortForAgent } from '../../effort.js';
import { normalizeWritablePaths } from '../../permissions.js';
import {
  isKnownPlayerAdapter,
  validatePlayerConfigs,
  type PlayerAdapterName,
  type PlayerConfig,
} from './players.js';
import type { CatppuccinFlavor } from './player-colors.js';
import type { PermissionLevel, PermissionPolicy } from '../../types.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { [key: string]: JsonValue }
  | JsonValue[];

interface CaptainConfigBase {
  from: string;
  model?: string;
  instruction?: string;
  permissions?: PermissionPolicy;
  options: JsonValue;
}

type CaptainConfigByAdapter = {
  [A in PlayerAdapterName]: CaptainConfigBase & {
    adapter: A;
    effort?: EffortForAgent<A>;
  };
};

/** Captain configuration correlated to its selected built-in adapter. */
export type CaptainConfig<A extends PlayerAdapterName = PlayerAdapterName> =
  CaptainConfigByAdapter[A];

export type CatppuccinFlavorConfig = CatppuccinFlavor | 'auto';
export type { CatppuccinFlavor };

export const NOTIFICATION_EVENTS = [
  'player_finished',
  'turn_finished',
  'turn_aborted',
] as const;
export const NOTIFICATION_SINKS = ['off', 'bell', 'desktop'] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
export type NotificationSink = (typeof NOTIFICATION_SINKS)[number];
export type NotificationConfig = Record<NotificationEvent, NotificationSink>;

/**
 * Initial tmux session cell grid for {@link
 * https://github.com/charmbracelet/glow tmux} `new-session -x/-y` per
 * TMUX-035 and the pre-attach CSI 8 sequence per TMUX-043. Both axes
 * default independently (TMUX-064): a partial YAML `layout.window`
 * preserves any supplied sub-field verbatim while filling in any
 * missing sub-field from the full default.
 */
export interface LayoutWindowConfig {
  columns: number;
  rows: number;
}

/**
 * Resolved layout configuration per TMUX-064. The loader fills in
 * defaults at normalization time so the snapshot per TMUX-034 always
 * carries concrete values for session mode to consume.
 *
 * `initialVisible` (TMUX-080) is the resolved startup-visible player IDs
 * in pane order, defaulting to every configured player in `players`
 * order when `layout.initialVisible` is omitted. The visible-column
 * shape derives from this set's size, not the configured roster size.
 *
 * `singlePlayerColumnWeights` (length 2) and `multiPlayerColumnWeights`
 * (length 3) are the canonical shape-specific weights; both are always
 * resolved so the snapshot can render either visible-column shape. The
 * YAML `columnWeights` alias (a two-/three-element compatibility field)
 * and the shape defaults (`[1, 1]` / `[1, 1, 1]`) feed these per the
 * TMUX-064 resolution precedence: explicit canonical field, then the
 * matching alias, then the default.
 *
 * `columnWeights` is the active shape's resolved weights, selected here
 * by the resolved initial visible set size (one visible player ->
 * single, two or more -> multi). IR-027 Task 5 wires the launcher to
 * render that visible set; until then the launcher reads this field.
 */
export interface LayoutConfig {
  window: LayoutWindowConfig;
  initialVisible: string[];
  singlePlayerColumnWeights: number[];
  multiPlayerColumnWeights: number[];
  columnWeights: number[];
}

export interface TmuxPlayConfig {
  captain: CaptainConfig;
  players: PlayerConfig[];
  /**
   * Resolved notification sinks keyed by supported record type. Missing YAML
   * blocks and missing event keys normalize to `'off'`; snapshots carry the
   * concrete map so session mode never re-resolves it.
   */
  notifications: NotificationConfig;
  /**
   * Catppuccin flavor to apply to the session chrome. `'auto'` (default
   * when omitted) lets the launcher pick via OSC 11 terminal-background
   * detection, falling back to Mocha. The snapshot written by
   * {@link writeTmuxPlayConfigSnapshot} stores the resolved
   * (`'mocha' | 'latte'`) value so the session subprocess never re-detects.
   */
  theme?: CatppuccinFlavorConfig;
  /**
   * Resolved layout per TMUX-064. Always concrete after normalization
   * by {@link loadTmuxPlayConfig} (the loader fills in any missing
   * field with its default), so the launcher and snapshot consumers
   * never have to re-resolve.
   */
  layout: LayoutConfig;
}

export interface LoadedTmuxPlayConfig {
  path: string;
  config: TmuxPlayConfig;
}

export interface LoadTmuxPlayConfigOptions {
  cwd?: string;
  configPath?: string;
  configHome?: string;
  onDefaultConfigCreated?: (path: string) => void;
  onLegacyConfigIgnored?: (path: string) => void;
  onLegacyEffortDeprecated?: (result: LegacyEffortDeprecation) => void;
}

export interface LegacyEffortDeprecation {
  readonly configPath: string;
  readonly fieldPaths: readonly string[];
  readonly outcome: 'updated' | 'skipped';
}

export const TMUX_PLAY_CONFIG_FILE = 'tmux-play.config.yaml';
export const TMUX_PLAY_HOME_CONFIG = join('tmux-play', 'config.yaml');
export const TMUX_PLAY_CONFIG_SNAPSHOT = 'tmux-play.config.snapshot.json';

const SUPPORTED_EXTENSIONS = new Set(['.yaml']);
const LEGACY_CONFIG_FILES = [
  'tmux-play.config.mjs',
  'tmux-play.config.js',
  'tmux-play.config.json',
] as const;

const DEFAULT_TMUX_PLAY_CONFIG: TmuxPlayConfig = {
  theme: 'auto',
  notifications: {
    player_finished: 'bell',
    turn_finished: 'desktop',
    turn_aborted: 'off',
  },
  layout: {
    window: { columns: 174, rows: 49 },
    // Resolved startup-visible set (TMUX-080): all configured players in
    // order. `defaultHomeConfigValue` strips it so the authored YAML omits it
    // (every player visible by default).
    initialVisible: ['claude', 'codex'],
    // Canonical shape-specific weights (TMUX-064). The shipped multi-player
    // default is equal-thirds [1, 1, 1] (Boss/Captain and each player column
    // each take floor(W / 3), rightmost absorbing the remainder); the
    // single-player default [1, 1] is resolved too so the snapshot can render
    // either shape. `columnWeights` is the active (two-player roster -> multi)
    // resolved weights. `defaultHomeConfigValue` strips the resolved-only
    // fields so the authored YAML surfaces only `multiPlayerColumnWeights`
    // per TMUX-011.
    singlePlayerColumnWeights: [1, 1],
    multiPlayerColumnWeights: [1, 1, 1],
    columnWeights: [1, 1, 1],
  },
  captain: {
    from: '@sublang/cligent/captains/fanout',
    adapter: 'claude',
    model: 'claude-opus-4-8',
    effort: 'xhigh',
    instruction: 'Coordinate players and answer the Boss.',
    permissions: { mode: 'auto' },
    options: {},
  },
  players: [
    {
      id: 'claude',
      adapter: 'claude',
      model: 'claude-opus-4-8',
      effort: 'xhigh',
      instruction:
        'You are the claude player in a fanout Captain session. Provide an independent answer.',
      permissions: { mode: 'auto' },
    },
    {
      id: 'codex',
      adapter: 'codex',
      model: 'gpt-5.5',
      effort: 'xhigh',
      instruction:
        'You are the codex player in a fanout Captain session. Provide an independent answer.',
      permissions: { mode: 'auto' },
    },
  ],
};

export function findTmuxPlayConfig(
  cwd = process.cwd(),
  configHome = defaultConfigHome(),
): string | undefined {
  const cwdConfig = resolve(cwd, TMUX_PLAY_CONFIG_FILE);
  if (existsSync(cwdConfig)) {
    return cwdConfig;
  }

  const homeConfig = homeConfigPath(configHome);
  if (existsSync(homeConfig)) {
    return homeConfig;
  }

  return undefined;
}

interface LoadTmuxPlayConfigInternals {
  readonly beforeLegacyEffortUpdate?: () => void | Promise<void>;
}

export function loadTmuxPlayConfig(
  options?: LoadTmuxPlayConfigOptions,
): Promise<LoadedTmuxPlayConfig>;
export async function loadTmuxPlayConfig(
  options: LoadTmuxPlayConfigOptions = {},
  internals: LoadTmuxPlayConfigInternals = {},
): Promise<LoadedTmuxPlayConfig> {
  const cwd = options.cwd ?? process.cwd();
  const configHome = options.configHome ?? defaultConfigHome();
  const homeConfig = homeConfigPath(configHome);
  let configPath = options.configPath
    ? resolveConfigPath(cwd, options.configPath)
    : findTmuxPlayConfig(cwd, configHome);
  let createdDefaultConfig = false;

  if (!options.configPath && !existsSync(resolve(cwd, TMUX_PLAY_CONFIG_FILE))) {
    const legacyConfig = findLegacyTmuxPlayConfig(cwd);
    if (legacyConfig) {
      options.onLegacyConfigIgnored?.(legacyConfig);
    }
  }

  if (!configPath) {
    configPath = homeConfig;
    await writeDefaultTmuxPlayConfig(configPath);
    createdDefaultConfig = true;
    options.onDefaultConfigCreated?.(configPath);
  }

  const loadedDocument = await loadConfigDocument(configPath);
  const homeDefaultsChanged =
    !createdDefaultConfig &&
    !options.configPath &&
    resolve(configPath) === resolve(homeConfig)
      ? migrateHomeConfigSafeDefaults(loadedDocument.document)
      : false;
  const raw = configDocumentValue(loadedDocument.document, configPath);
  const config = normalizeTmuxPlayConfig(raw);
  assertJsonSerializable(config, 'config');
  const legacyEffortPaths = legacyEffortTargets(loadedDocument.document).map(
    (target) => target.fieldPath,
  );

  // Home safe-default/layout migration remains an independent required write.
  // The bounded best-effort legacy key update runs afterward.
  let currentSource = loadedDocument.source;
  if (homeDefaultsChanged) {
    currentSource = loadedDocument.document.toString({ lineWidth: 0 });
    assertSerializedConfigRoundTrip(currentSource, configPath, config);
    await writeFile(configPath, currentSource, 'utf8');
  }

  if (legacyEffortPaths.length > 0) {
    await internals.beforeLegacyEffortUpdate?.();
    const outcome = await tryUpdateLegacyEffortKeys(configPath, currentSource);
    options.onLegacyEffortDeprecated?.({
      configPath,
      fieldPaths: legacyEffortPaths,
      outcome,
    });
  }

  return { path: configPath, config };
}

export function createTmuxPlayConfigSnapshot(
  loaded: LoadedTmuxPlayConfig,
  resolvedFlavor?: CatppuccinFlavor,
): TmuxPlayConfig {
  const config = structuredCloneJson(loaded.config);
  config.captain.from = normalizeCaptainFrom(config.captain.from, loaded.path);
  if (resolvedFlavor !== undefined) {
    // Snapshot always stores a resolved flavor (mocha | latte) so the
    // session subprocess uses it directly without re-running detection.
    config.theme = resolvedFlavor;
  }
  return config;
}

export async function writeTmuxPlayConfigSnapshot(
  loaded: LoadedTmuxPlayConfig,
  workDir: string,
  resolvedFlavor?: CatppuccinFlavor,
): Promise<string> {
  const snapshotPath = join(workDir, TMUX_PLAY_CONFIG_SNAPSHOT);
  const snapshot = createTmuxPlayConfigSnapshot(loaded, resolvedFlavor);
  await mkdir(workDir, { recursive: true });
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n');
  return snapshotPath;
}

function resolveConfigPath(cwd: string, configPath: string): string {
  return isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
}

function defaultConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

function homeConfigPath(configHome: string): string {
  return join(configHome, TMUX_PLAY_HOME_CONFIG);
}

function findLegacyTmuxPlayConfig(cwd: string): string | undefined {
  for (const file of LEGACY_CONFIG_FILES) {
    const candidate = resolve(cwd, file);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function writeDefaultTmuxPlayConfig(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, stringify(defaultHomeConfigValue()));
}

function normalizeCaptainFrom(from: string, configPath: string): string {
  if (isFileUrl(from)) {
    return pathToFileURL(fileURLToPath(from)).href;
  }

  if (isLocalPathSpecifier(from)) {
    const absolutePath = isAbsolute(from)
      ? from
      : resolve(dirname(configPath), from);
    return pathToFileURL(absolutePath).href;
  }

  return from;
}

function isFileUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'file:';
  } catch {
    return false;
  }
}

function isLocalPathSpecifier(value: string): boolean {
  return (
    value === '.' ||
    value === '..' ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    isAbsolute(value)
  );
}

function structuredCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface LoadedConfigDocument {
  readonly document: Document.Parsed;
  readonly source: string;
}

async function loadConfigDocument(path: string): Promise<LoadedConfigDocument> {
  const ext = extname(path);
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported tmux-play config extension "${ext || '(none)'}". ` +
        'Supported extension: .yaml',
    );
  }

  try {
    const source = await readFile(path, 'utf8');
    const document = parseDocument(source);
    if (document.errors.length > 0) {
      throw document.errors[0];
    }
    return { document, source };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to parse tmux-play config ${path}: ${error.message}`);
    }
    throw error;
  }
}

function configDocumentValue(
  document: Document.Parsed,
  path: string,
): unknown {
  try {
    return document.toJS() as unknown;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to parse tmux-play config ${path}: ${error.message}`);
    }
    throw error;
  }
}

function assertSerializedConfigRoundTrip(
  source: string,
  path: string,
  expected: TmuxPlayConfig,
): void {
  try {
    const document = parseDocument(source);
    if (document.errors.length > 0) {
      throw document.errors[0];
    }
    const actual = normalizeTmuxPlayConfig(document.toJS() as unknown);
    assertJsonSerializable(actual, 'config');
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error('serialized migration changed the normalized config');
    }
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        `Failed to serialize tmux-play config ${path}: ${error.message}`,
      );
    }
    throw error;
  }
}

const ALLOWED_TOP_LEVEL_KEYS = new Set<string>([
  'captain',
  'players',
  'theme',
  'layout',
  'notifications',
]);

function normalizeTmuxPlayConfig(value: unknown): TmuxPlayConfig {
  const input = requireObject(value, 'config');
  // TMUX-008: reject unknown top-level fields so a typo like `layoutt:`
  // surfaces at load time instead of being silently ignored and falling
  // through to defaults. The peer scopes (`captain`, `players[i]`, the
  // `layout` block) already enforce this; the root scope was the only
  // gap and is closed here.
  rejectUnknownKeys(input, ALLOWED_TOP_LEVEL_KEYS, 'config');
  const captain = normalizeCaptainConfig(input.captain);
  const players = normalizePlayerConfigs(input.players);
  const theme = optionalThemeFlavor(input.theme, 'theme');
  const notifications = normalizeNotificationConfig(
    input.notifications,
    'notifications',
  );
  // TMUX-064 / TMUX-080: defaulting at load time so loaded.config.layout is
  // always concrete. The visible-column shape depends on the resolved initial
  // visible set size (1 → 2 columns, ≥2 → 3 columns); `layout.initialVisible`
  // is validated against the configured player ids.
  const layout = resolveLayoutConfig(
    input.layout,
    players.map((player) => player.id),
    'layout',
  );
  const config: TmuxPlayConfig = { captain, players, notifications, layout };
  if (theme !== undefined) config.theme = theme;
  return config;
}

const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  player_finished: 'off',
  turn_finished: 'off',
  turn_aborted: 'off',
};

const DEFAULT_HOME_NOTIFICATION_CONFIG = {
  player_finished: 'bell',
  turn_finished: 'desktop',
} satisfies Partial<NotificationConfig>;

export function defaultNotificationConfig(): NotificationConfig {
  return { ...DEFAULT_NOTIFICATION_CONFIG };
}

function normalizeNotificationConfig(
  value: unknown,
  path: string,
): NotificationConfig {
  if (value === undefined) {
    return defaultNotificationConfig();
  }

  const input = requireObject(value, path);
  rejectUnknownKeys(input, new Set(NOTIFICATION_EVENTS), path);

  const config = defaultNotificationConfig();
  for (const event of NOTIFICATION_EVENTS) {
    if (input[event] !== undefined) {
      config[event] = requireNotificationSink(input[event], `${path}.${event}`);
    }
  }
  return config;
}

const SINGLE_PLAYER_SHAPE_LENGTH = 2;
const MULTI_PLAYER_SHAPE_LENGTH = 3;
const DEFAULT_SINGLE_PLAYER_WEIGHTS: readonly number[] = [1, 1];
const DEFAULT_MULTI_PLAYER_WEIGHTS: readonly number[] = [1, 1, 1];

const DEFAULT_LAYOUT_WINDOW: LayoutWindowConfig = { columns: 174, rows: 49 };

// Active-shape weights keyed to the visible-column count (IR-027 Task 4): one
// visible player -> single-player shape, two or more -> multi-player shape.
function activeColumnWeights(
  visibleCount: number,
  single: readonly number[],
  multi: readonly number[],
): number[] {
  return visibleCount === 1 ? [...single] : [...multi];
}

function resolveLayoutConfig(
  value: unknown,
  playerIds: readonly string[],
  path: string,
): LayoutConfig {
  if (value === undefined) {
    return {
      window: { ...DEFAULT_LAYOUT_WINDOW },
      initialVisible: [...playerIds],
      singlePlayerColumnWeights: [...DEFAULT_SINGLE_PLAYER_WEIGHTS],
      multiPlayerColumnWeights: [...DEFAULT_MULTI_PLAYER_WEIGHTS],
      columnWeights: activeColumnWeights(
        playerIds.length,
        DEFAULT_SINGLE_PLAYER_WEIGHTS,
        DEFAULT_MULTI_PLAYER_WEIGHTS,
      ),
    };
  }

  const input = requireObject(value, path);
  const allowed = new Set([
    'window',
    'initialVisible',
    'singlePlayerColumnWeights',
    'multiPlayerColumnWeights',
    'columnWeights',
  ]);
  rejectUnknownKeys(input, allowed, path);

  const window = resolveLayoutWindow(input.window, `${path}.window`);
  const initialVisible = resolveInitialVisible(
    input.initialVisible,
    playerIds,
    `${path}.initialVisible`,
  );

  // Canonical shape-specific fields, each validated to its fixed length
  // (TMUX-064) independent of the configured player count.
  const explicitSingle = resolveCanonicalWeights(
    input.singlePlayerColumnWeights,
    SINGLE_PLAYER_SHAPE_LENGTH,
    `${path}.singlePlayerColumnWeights`,
  );
  const explicitMulti = resolveCanonicalWeights(
    input.multiPlayerColumnWeights,
    MULTI_PLAYER_SHAPE_LENGTH,
    `${path}.multiPlayerColumnWeights`,
  );

  // `columnWeights` is a two-/three-element alias selecting a shape by its
  // length (TMUX-064).
  let aliasSingle: number[] | undefined;
  let aliasMulti: number[] | undefined;
  if (input.columnWeights !== undefined) {
    const aliasWeights = parseWeightArray(
      input.columnWeights,
      `${path}.columnWeights`,
    );
    if (aliasWeights.length === SINGLE_PLAYER_SHAPE_LENGTH) {
      aliasSingle = aliasWeights;
    } else if (aliasWeights.length === MULTI_PLAYER_SHAPE_LENGTH) {
      aliasMulti = aliasWeights;
    } else {
      throw new Error(
        `${path}.columnWeights length must be 2 (aliasing singlePlayerColumnWeights) ` +
          `or 3 (aliasing multiPlayerColumnWeights), got ${aliasWeights.length}`,
      );
    }
  }

  // A `columnWeights` alias and the canonical field for the same shape are a
  // conflict the loader rejects rather than silently picking one (TMUX-064).
  if (aliasSingle && explicitSingle) {
    throw new Error(
      `${path}.columnWeights conflicts with ${path}.singlePlayerColumnWeights; ` +
        'set only one for the single-player shape',
    );
  }
  if (aliasMulti && explicitMulti) {
    throw new Error(
      `${path}.columnWeights conflicts with ${path}.multiPlayerColumnWeights; ` +
        'set only one for the multi-player shape',
    );
  }

  // Resolution precedence (TMUX-064): explicit canonical field, then the
  // matching alias, then the shape default.
  const singlePlayerColumnWeights =
    explicitSingle ?? aliasSingle ?? [...DEFAULT_SINGLE_PLAYER_WEIGHTS];
  const multiPlayerColumnWeights =
    explicitMulti ?? aliasMulti ?? [...DEFAULT_MULTI_PLAYER_WEIGHTS];

  return {
    window,
    initialVisible,
    singlePlayerColumnWeights,
    multiPlayerColumnWeights,
    columnWeights: activeColumnWeights(
      initialVisible.length,
      singlePlayerColumnWeights,
      multiPlayerColumnWeights,
    ),
  };
}

function resolveInitialVisible(
  value: unknown,
  playerIds: readonly string[],
  path: string,
): string[] {
  // TMUX-080: omitted -> every configured player visible, in `players` order.
  if (value === undefined) {
    return [...playerIds];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array of configured player ids`);
  }
  if (value.length === 0) {
    throw new Error(
      `${path} must name at least one player; tmux-play has no zero-player visible layout`,
    );
  }
  const known = new Set(playerIds);
  const seen = new Set<string>();
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const id: unknown = value[i];
    if (typeof id !== 'string') {
      throw new Error(`${path}[${i}] must be a string player id`);
    }
    if (!known.has(id)) {
      throw new Error(`${path}[${i}] "${id}" is not a configured player id`);
    }
    if (seen.has(id)) {
      throw new Error(`${path}[${i}] "${id}" is a duplicate player id`);
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

function resolveLayoutWindow(
  value: unknown,
  path: string,
): LayoutWindowConfig {
  // TMUX-064: missing sub-fields default independently — a partial
  // {columns: 200} resolves to {columns: 200, rows: 49}, not wholesale
  // back to the full default.
  if (value === undefined) {
    return { ...DEFAULT_LAYOUT_WINDOW };
  }
  const input = requireObject(value, path);
  const allowed = new Set(['columns', 'rows']);
  rejectUnknownKeys(input, allowed, path);

  const columns =
    optionalPositiveInteger(input.columns, `${path}.columns`) ??
    DEFAULT_LAYOUT_WINDOW.columns;
  const rows =
    optionalPositiveInteger(input.rows, `${path}.rows`) ??
    DEFAULT_LAYOUT_WINDOW.rows;
  return { columns, rows };
}

function parseWeightArray(value: unknown, path: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array of positive integers`);
  }
  const result: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const weight = value[i];
    // Positive-integer constraint (TMUX-064): the resize hook interpolates
    // each weight verbatim into POSIX shell arithmetic (`$((W * w / sum -
    // 1))`), which is integer-only. A decimal like `0.5` would emit a
    // malformed `$((…))` and silently break the post-creation resize
    // invariant. `Number.isInteger` already returns `false` for NaN /
    // Infinity / non-numbers, but the explicit `typeof` guard keeps the
    // closed-set rejection enumeration readable.
    if (
      typeof weight !== 'number' ||
      !Number.isInteger(weight) ||
      weight <= 0
    ) {
      throw new Error(`${path}[${i}] must be a positive integer`);
    }
    result.push(weight);
  }
  return result;
}

function resolveCanonicalWeights(
  value: unknown,
  expectedLength: number,
  path: string,
): number[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const weights = parseWeightArray(value, path);
  if (weights.length !== expectedLength) {
    throw new Error(
      `${path} length must be ${expectedLength}, got ${weights.length}`,
    );
  }
  return weights;
}

function optionalPositiveInteger(
  value: unknown,
  path: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new Error(`${path} must be a positive integer`);
  }
  return value;
}

function requireNotificationSink(
  value: unknown,
  path: string,
): NotificationSink {
  if (
    typeof value !== 'string' ||
    !(NOTIFICATION_SINKS as readonly string[]).includes(value)
  ) {
    throw new Error(`${path} must be one of: off, bell, desktop`);
  }
  return value as NotificationSink;
}

function defaultHomeConfigValue(): TmuxPlayConfig {
  const config = structuredCloneJson(DEFAULT_TMUX_PLAY_CONFIG);
  // The generated YAML documents the non-off defaults requested for first-run
  // users while omission of `turn_aborted` still normalizes to `off`.
  delete (config.notifications as Partial<NotificationConfig>).turn_aborted;
  // TMUX-011: the authored default YAML surfaces only the canonical
  // `multiPlayerColumnWeights`; the resolved single-player array and the
  // active `columnWeights` are filled back in on load, not written to disk.
  const layout = config.layout as Partial<LayoutConfig>;
  delete layout.initialVisible;
  delete layout.singlePlayerColumnWeights;
  delete layout.columnWeights;
  return config;
}

function migrateHomeConfigSafeDefaults(
  document: Document.Parsed,
): boolean {
  const config = document.contents;
  if (!isMap(config)) return false;
  let changed = false;

  if (!config.has('theme')) {
    addYamlMapValue(document, config, 'theme', 'auto');
    changed = true;
  }

  if (!config.has('layout')) {
    addYamlMapValue(document, config, 'layout', {
      window: { ...DEFAULT_LAYOUT_WINDOW },
      multiPlayerColumnWeights: [...DEFAULT_MULTI_PLAYER_WEIGHTS],
    });
    changed = true;
  } else {
    const layout = config.get('layout', true);
    if (isMap(layout) && !layout.has('window')) {
      addYamlMapValue(document, layout, 'window', { ...DEFAULT_LAYOUT_WINDOW });
      changed = true;
    } else if (isMap(layout)) {
      const window = layout.get('window', true);
      if (isMap(window) && !window.has('columns')) {
        addYamlMapValue(
          document,
          window,
          'columns',
          DEFAULT_LAYOUT_WINDOW.columns,
        );
        changed = true;
      }
      if (isMap(window) && !window.has('rows')) {
        addYamlMapValue(
          document,
          window,
          'rows',
          DEFAULT_LAYOUT_WINDOW.rows,
        );
        changed = true;
      }
    }

    // TMUX-010: rewrite a legacy `columnWeights` to its canonical shape field,
    // writing one final form that never holds both. Skip the rewrite when the
    // matching canonical field already exists (a conflict the loader rejects)
    // or the length is not 2/3 (also rejected on load); leave those for the
    // loader to surface. When a layout block carries no weight field at all,
    // add the shipped `multiPlayerColumnWeights` default.
    if (isMap(layout) && layout.has('columnWeights')) {
      const columnWeights = layout.get('columnWeights', true);
      const canonical =
        isSeq(columnWeights) &&
        columnWeights.items.length === SINGLE_PLAYER_SHAPE_LENGTH
          ? 'singlePlayerColumnWeights'
          : isSeq(columnWeights) &&
              columnWeights.items.length === MULTI_PLAYER_SHAPE_LENGTH
            ? 'multiPlayerColumnWeights'
            : undefined;
      if (canonical && !layout.has(canonical)) {
        const pair = findStringKeyPair(layout, 'columnWeights');
        if (pair !== undefined) {
          renameStringKey(pair, canonical);
          changed = true;
        }
      }
    } else if (
      isMap(layout) &&
      !layout.has('singlePlayerColumnWeights') &&
      !layout.has('multiPlayerColumnWeights')
    ) {
      addYamlMapValue(
        document,
        layout,
        'multiPlayerColumnWeights',
        [...DEFAULT_MULTI_PLAYER_WEIGHTS],
      );
      changed = true;
    }
  }

  const captain = config.get('captain', true);
  if (isMap(captain) && !captain.has('options')) {
    addYamlMapValue(document, captain, 'options', {});
    changed = true;
  }

  if (!config.has('notifications')) {
    addYamlMapValue(
      document,
      config,
      'notifications',
      { ...DEFAULT_HOME_NOTIFICATION_CONFIG },
    );
    changed = true;
  }

  return changed;
}

interface EffortKeyMap {
  readonly value: YAMLMap;
  readonly path: string;
}

interface LegacyEffortTarget {
  readonly fieldPath: string;
  readonly key: Scalar<string>;
}

function legacyEffortTargets(
  document: Document.Parsed,
): LegacyEffortTarget[] {
  const targets: LegacyEffortTarget[] = [];
  for (const target of effortKeyMaps(document)) {
    const legacy = findStringKeyPair(target.value, 'reasoningEffort');
    if (legacy === undefined) continue;
    targets.push({
      fieldPath: `${target.path}.reasoningEffort`,
      key: legacy.key,
    });
  }
  return targets;
}

function rewriteLegacyEffortKeyTokens(source: string): string | undefined {
  const document = parseDocument(source);
  if (document.errors.length > 0) return undefined;
  const edits: Array<{
    readonly start: number;
    readonly end: number;
    readonly value: string;
  }> = [];

  for (const target of legacyEffortTargets(document)) {
    const range = target.key.range;
    if (range === undefined || range === null) return undefined;
    const token = source.slice(range[0], range[1]);
    const replacement =
      token === 'reasoningEffort'
        ? 'effort'
        : token === "'reasoningEffort'"
          ? "'effort'"
          : token === '"reasoningEffort"'
            ? '"effort"'
            : undefined;
    if (replacement === undefined) return undefined;
    edits.push({ start: range[0], end: range[1], value: replacement });
  }

  if (edits.length === 0) return undefined;
  let rewritten = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    rewritten =
      rewritten.slice(0, edit.start) +
      edit.value +
      rewritten.slice(edit.end);
  }
  return rewritten;
}

async function tryUpdateLegacyEffortKeys(
  configPath: string,
  expectedSource: string,
): Promise<'updated' | 'skipped'> {
  const nextSource = rewriteLegacyEffortKeyTokens(expectedSource);
  if (nextSource === undefined || nextSource === expectedSource) return 'skipped';

  let tempPath: string | undefined;
  try {
    const resolvedPath = await realpath(configPath);
    const revision = await stat(resolvedPath);
    if ((await readFile(resolvedPath, 'utf8')) !== expectedSource) {
      return 'skipped';
    }

    tempPath = join(
      dirname(resolvedPath),
      `.${basename(resolvedPath)}.cligent-effort-${process.pid}-${randomUUID()}.tmp`,
    );
    await writeFile(tempPath, nextSource, {
      encoding: 'utf8',
      flag: 'wx',
      mode: revision.mode & 0o7777,
    });

    // One final optimistic byte check avoids an edit observed before rename.
    // The remaining check-to-rename race is intentionally not guaranteed.
    if ((await readFile(resolvedPath, 'utf8')) !== expectedSource) {
      return 'skipped';
    }
    await rename(tempPath, resolvedPath);
    tempPath = undefined;
    return 'updated';
  } catch {
    return 'skipped';
  } finally {
    if (tempPath !== undefined) {
      await unlink(tempPath).catch(() => undefined);
    }
  }
}

function effortKeyMaps(document: Document.Parsed): EffortKeyMap[] {
  const config = document.contents;
  if (!isMap(config)) return [];

  const targets: EffortKeyMap[] = [];
  const captain = config.get('captain', true);
  if (isMap(captain)) {
    targets.push({ value: captain, path: 'captain' });
  }
  const players = config.get('players', true);
  if (isSeq(players)) {
    for (let index = 0; index < players.items.length; index++) {
      const player = players.items[index];
      if (isMap(player)) {
        targets.push({ value: player, path: `players[${index}]` });
      }
    }
  }
  return targets;
}

function findStringKeyPair(
  map: YAMLMap,
  key: string,
): Pair<Scalar<string>, unknown> | undefined {
  for (const pair of map.items) {
    if (
      isScalar(pair.key) &&
      typeof pair.key.value === 'string' &&
      pair.key.value === key
    ) {
      return pair as Pair<Scalar<string>, unknown>;
    }
  }
  return undefined;
}

function addYamlMapValue(
  document: Document.Parsed,
  map: YAMLMap,
  key: string,
  value: unknown,
): void {
  map.add(document.createPair(key, value));
}

function renameStringKey(
  pair: Pair<Scalar<string>, unknown>,
  key: string,
): void {
  pair.key.value = key;
  pair.key.source = key;
}

const THEME_FLAVORS: ReadonlySet<CatppuccinFlavorConfig> = new Set([
  'mocha',
  'latte',
  'auto',
]);

function optionalThemeFlavor(
  value: unknown,
  path: string,
): CatppuccinFlavorConfig | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !THEME_FLAVORS.has(value as never)) {
    throw new Error(`${path} must be one of: mocha, latte, auto`);
  }
  return value as CatppuccinFlavorConfig;
}

function normalizeCaptainConfig(value: unknown): CaptainConfig {
  const input = requireObject(value, 'captain');
  const allowed = new Set([
    'from',
    'adapter',
    'model',
    'instruction',
    'permissions',
    'effort',
    'reasoningEffort',
    'options',
  ]);
  rejectUnknownKeys(input, allowed, 'captain');

  const from = requireString(input.from, 'captain.from');
  const adapter = requireAdapterName(input.adapter, 'captain.adapter');
  const model = optionalString(input.model, 'captain.model');
  const instruction = optionalString(input.instruction, 'captain.instruction');
  const permissions = optionalPermissionPolicy(
    input.permissions,
    'captain.permissions',
  );
  const options = input.options === undefined ? {} : input.options;
  const common: CaptainConfigBase = {
    from,
    options: options as JsonValue,
  };
  if (model !== undefined) common.model = model;
  if (instruction !== undefined) common.instruction = instruction;
  if (permissions !== undefined) common.permissions = permissions;
  const configuredEffort = configuredEffortValue(input, 'captain');

  switch (adapter) {
    case 'claude': {
      const effort = optionalEffort(
        configuredEffort.value,
        adapter,
        configuredEffort.path,
      );
      return effort === undefined
        ? { ...common, adapter }
        : { ...common, adapter, effort };
    }
    case 'codex': {
      const effort = optionalEffort(
        configuredEffort.value,
        adapter,
        configuredEffort.path,
      );
      return effort === undefined
        ? { ...common, adapter }
        : { ...common, adapter, effort };
    }
    case 'gemini': {
      const effort = optionalEffort(
        configuredEffort.value,
        adapter,
        configuredEffort.path,
      );
      return effort === undefined
        ? { ...common, adapter }
        : { ...common, adapter, effort };
    }
    case 'opencode': {
      const effort = optionalEffort(
        configuredEffort.value,
        adapter,
        configuredEffort.path,
      );
      return effort === undefined
        ? { ...common, adapter }
        : { ...common, adapter, effort };
    }
  }
}

function normalizePlayerConfigs(value: unknown): PlayerConfig[] {
  if (!Array.isArray(value)) {
    throw new Error('players must be a non-empty array');
  }
  if (value.length === 0) {
    throw new Error('players must contain at least one player');
  }

  const players = value.map((entry, index) => normalizePlayerConfig(entry, index));
  validatePlayerConfigs(players);
  return players;
}

function normalizePlayerConfig(value: unknown, index: number): PlayerConfig {
  const path = `players[${index}]`;
  const input = requireObject(value, path);
  const allowed = new Set([
    'id',
    'adapter',
    'model',
    'instruction',
    'permissions',
    'effort',
    'reasoningEffort',
  ]);
  rejectUnknownKeys(input, allowed, path);

  const id = requireString(input.id, `${path}.id`);
  const adapter = requireAdapterName(input.adapter, `${path}.adapter`);
  const model = optionalString(input.model, `${path}.model`);
  const instruction = optionalString(input.instruction, `${path}.instruction`);
  const permissions = optionalPermissionPolicy(
    input.permissions,
    `${path}.permissions`,
  );
  const common = {
    id,
    ...(model === undefined ? {} : { model }),
    ...(instruction === undefined ? {} : { instruction }),
    ...(permissions === undefined ? {} : { permissions }),
  };
  const configuredEffort = configuredEffortValue(input, path);

  switch (adapter) {
    case 'claude': {
      const effort = optionalEffort(
        configuredEffort.value,
        adapter,
        configuredEffort.path,
      );
      return effort === undefined
        ? { ...common, adapter }
        : { ...common, adapter, effort };
    }
    case 'codex': {
      const effort = optionalEffort(
        configuredEffort.value,
        adapter,
        configuredEffort.path,
      );
      return effort === undefined
        ? { ...common, adapter }
        : { ...common, adapter, effort };
    }
    case 'gemini': {
      const effort = optionalEffort(
        configuredEffort.value,
        adapter,
        configuredEffort.path,
      );
      return effort === undefined
        ? { ...common, adapter }
        : { ...common, adapter, effort };
    }
    case 'opencode': {
      const effort = optionalEffort(
        configuredEffort.value,
        adapter,
        configuredEffort.path,
      );
      return effort === undefined
        ? { ...common, adapter }
        : { ...common, adapter, effort };
    }
  }
}

function configuredEffortValue(
  input: Record<string, unknown>,
  objectPath: string,
): { readonly value: unknown; readonly path: string } {
  const hasEffort = Object.hasOwn(input, 'effort');
  const hasLegacy = Object.hasOwn(input, 'reasoningEffort');
  if (hasEffort && hasLegacy) {
    throw new Error(
      `${objectPath}.effort conflicts with deprecated ` +
        `${objectPath}.reasoningEffort; set only effort`,
    );
  }
  return hasLegacy
    ? {
        value: input.reasoningEffort,
        path: `${objectPath}.reasoningEffort`,
      }
    : { value: input.effort, path: `${objectPath}.effort` };
}

function requireObject(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${path} must be a string`);
  }
  return value;
}

function optionalPermissionPolicy(
  value: unknown,
  path: string,
): PermissionPolicy | undefined {
  if (value === undefined) return undefined;
  const input = requireObject(value, path);
  const allowed = new Set([
    'mode',
    'fileWrite',
    'shellExecute',
    'networkAccess',
    'writablePaths',
  ]);
  rejectUnknownKeys(input, allowed, path);

  const policy: PermissionPolicy = {};
  if (input.mode !== undefined) {
    policy.mode = requirePermissionMode(input.mode, `${path}.mode`);
  }
  if (input.fileWrite !== undefined) {
    policy.fileWrite = requirePermissionLevel(
      input.fileWrite,
      `${path}.fileWrite`,
    );
  }
  if (input.shellExecute !== undefined) {
    policy.shellExecute = requirePermissionLevel(
      input.shellExecute,
      `${path}.shellExecute`,
    );
  }
  if (input.networkAccess !== undefined) {
    policy.networkAccess = requirePermissionLevel(
      input.networkAccess,
      `${path}.networkAccess`,
    );
  }
  if (input.writablePaths !== undefined) {
    policy.writablePaths = normalizeWritablePaths(
      input.writablePaths,
      `${path}.writablePaths`,
    );
  }
  return policy;
}

const PERMISSION_MODES: ReadonlySet<NonNullable<PermissionPolicy['mode']>> =
  new Set(['auto', 'bypass']);
const PERMISSION_LEVELS: ReadonlySet<PermissionLevel> = new Set([
  'allow',
  'ask',
  'deny',
]);
function requirePermissionMode(
  value: unknown,
  path: string,
): NonNullable<PermissionPolicy['mode']> {
  if (typeof value !== 'string' || !PERMISSION_MODES.has(value as never)) {
    throw new Error(
      `${path} must be one of: auto, bypass`,
    );
  }
  return value as NonNullable<PermissionPolicy['mode']>;
}

function requirePermissionLevel(
  value: unknown,
  path: string,
): PermissionLevel {
  if (typeof value !== 'string' || !PERMISSION_LEVELS.has(value as never)) {
    throw new Error(`${path} must be one of: allow, ask, deny`);
  }
  return value as PermissionLevel;
}

function optionalEffort<A extends PlayerAdapterName>(
  value: unknown,
  adapter: A,
  path: string,
): EffortForAgent<A> | undefined {
  if (value === undefined) return undefined;
  assertSupportedEffort(adapter, value, path);
  return value;
}

function requireAdapterName(value: unknown, path: string): PlayerAdapterName {
  const adapter = requireString(value, path);
  if (!isKnownPlayerAdapter(adapter)) {
    throw new Error(
      `Unknown adapter "${adapter}" at ${path}. ` +
        'Valid adapters: claude, codex, gemini, opencode',
    );
  }
  return adapter;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown config field ${path}.${key}`);
    }
  }
}

function assertJsonSerializable(
  value: unknown,
  path: string,
  seen = new Set<object>(),
): void {
  if (value === null) return;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`${path} must be a finite number`);
      }
      return;
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      throw new Error(`${path} contains non-serializable ${typeof value}`);
    case 'object':
      break;
  }

  if (seen.has(value)) {
    throw new Error(`${path} contains a circular reference`);
  }

  if (Array.isArray(value)) {
    seen.add(value);
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        throw new Error(`${path}[${i}] contains non-serializable undefined`);
      }
      assertJsonSerializable(value[i], `${path}[${i}]`, seen);
    }
    seen.delete(value);
    return;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`${path} must contain only plain JSON objects`);
  }

  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    assertJsonSerializable(entry, `${path}.${key}`, seen);
  }
  seen.delete(value);
}
