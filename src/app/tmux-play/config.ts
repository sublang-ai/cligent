// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import {
  isKnownRoleAdapter,
  validateRoleConfigs,
  type RoleAdapterName,
  type RoleConfig,
} from './roles.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { [key: string]: JsonValue }
  | JsonValue[];

export interface CaptainConfig {
  from: string;
  adapter: RoleAdapterName;
  model?: string;
  instruction?: string;
  options: JsonValue;
}

export interface TmuxPlayConfig {
  captain: CaptainConfig;
  roles: RoleConfig[];
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
  captain: {
    from: '@sublang/cligent/captains/fanout',
    adapter: 'claude',
    model: 'claude-opus-4-7',
    instruction: 'Coordinate roles and answer the Boss.',
    options: { maxRoleOutputChars: 4000 },
  },
  roles: [
    {
      id: 'claude',
      adapter: 'claude',
      instruction:
        'You are the claude role in a fanout Captain session. Provide an independent answer.',
    },
    {
      id: 'codex',
      adapter: 'codex',
      instruction:
        'You are the codex role in a fanout Captain session. Provide an independent answer.',
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

export async function loadTmuxPlayConfig(
  options: LoadTmuxPlayConfigOptions = {},
): Promise<LoadedTmuxPlayConfig> {
  const cwd = options.cwd ?? process.cwd();
  const configHome = options.configHome ?? defaultConfigHome();
  let configPath = options.configPath
    ? resolveConfigPath(cwd, options.configPath)
    : findTmuxPlayConfig(cwd, configHome);

  if (!options.configPath && !existsSync(resolve(cwd, TMUX_PLAY_CONFIG_FILE))) {
    const legacyConfig = findLegacyTmuxPlayConfig(cwd);
    if (legacyConfig) {
      options.onLegacyConfigIgnored?.(legacyConfig);
    }
  }

  if (!configPath) {
    configPath = homeConfigPath(configHome);
    await writeDefaultTmuxPlayConfig(configPath);
    options.onDefaultConfigCreated?.(configPath);
  }

  const raw = await loadConfigValue(configPath);
  const config = normalizeTmuxPlayConfig(raw);
  assertJsonSerializable(config, 'config');

  return { path: configPath, config };
}

export function createTmuxPlayConfigSnapshot(
  loaded: LoadedTmuxPlayConfig,
): TmuxPlayConfig {
  const config = structuredCloneJson(loaded.config);
  config.captain.from = normalizeCaptainFrom(config.captain.from, loaded.path);
  return config;
}

export async function writeTmuxPlayConfigSnapshot(
  loaded: LoadedTmuxPlayConfig,
  workDir: string,
): Promise<string> {
  const snapshotPath = join(workDir, TMUX_PLAY_CONFIG_SNAPSHOT);
  const snapshot = createTmuxPlayConfigSnapshot(loaded);
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
  await writeFile(path, stringify(DEFAULT_TMUX_PLAY_CONFIG));
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

async function loadConfigValue(path: string): Promise<unknown> {
  const ext = extname(path);
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(
      `Unsupported tmux-play config extension "${ext || '(none)'}". ` +
        'Supported extension: .yaml',
    );
  }

  try {
    const source = await readFile(path, 'utf8');
    return parse(source) as unknown;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to parse tmux-play config ${path}: ${error.message}`);
    }
    throw error;
  }
}

function normalizeTmuxPlayConfig(value: unknown): TmuxPlayConfig {
  const input = requireObject(value, 'config');
  const captain = normalizeCaptainConfig(input.captain);
  const roles = normalizeRoleConfigs(input.roles);
  return { captain, roles };
}

function normalizeCaptainConfig(value: unknown): CaptainConfig {
  const input = requireObject(value, 'captain');
  const allowed = new Set(['from', 'adapter', 'model', 'instruction', 'options']);
  rejectUnknownKeys(input, allowed, 'captain');

  const from = requireString(input.from, 'captain.from');
  const adapter = requireAdapterName(input.adapter, 'captain.adapter');
  const model = optionalString(input.model, 'captain.model');
  const instruction = optionalString(input.instruction, 'captain.instruction');
  const options = input.options === undefined ? {} : input.options;

  const captain: CaptainConfig = {
    from,
    adapter,
    options: options as JsonValue,
  };
  if (model !== undefined) captain.model = model;
  if (instruction !== undefined) captain.instruction = instruction;
  return captain;
}

function normalizeRoleConfigs(value: unknown): RoleConfig[] {
  if (!Array.isArray(value)) {
    throw new Error('roles must be a non-empty array');
  }
  if (value.length === 0) {
    throw new Error('roles must contain at least one role');
  }

  const roles = value.map((entry, index) => normalizeRoleConfig(entry, index));
  validateRoleConfigs(roles);
  return roles;
}

function normalizeRoleConfig(value: unknown, index: number): RoleConfig {
  const path = `roles[${index}]`;
  const input = requireObject(value, path);
  const allowed = new Set(['id', 'adapter', 'model', 'instruction']);
  rejectUnknownKeys(input, allowed, path);

  const role: RoleConfig = {
    id: requireString(input.id, `${path}.id`),
    adapter: requireAdapterName(input.adapter, `${path}.adapter`),
  };

  const model = optionalString(input.model, `${path}.model`);
  const instruction = optionalString(input.instruction, `${path}.instruction`);
  if (model !== undefined) role.model = model;
  if (instruction !== undefined) role.instruction = instruction;
  return role;
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

function requireAdapterName(value: unknown, path: string): RoleAdapterName {
  const adapter = requireString(value, path);
  if (!isKnownRoleAdapter(adapter)) {
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
