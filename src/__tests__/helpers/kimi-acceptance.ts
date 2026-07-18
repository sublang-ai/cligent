// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

const KIMI_ACCEPTANCE_HOME_KEY = 'CLIGENT_KIMI_ACCEPTANCE_HOME';
const KIMI_MODEL_ENV_KEYS = [
  'KIMI_MODEL_API_KEY',
  'KIMI_MODEL_BASE_URL',
  'KIMI_MODEL_NAME',
  'KIMI_MODEL_PROVIDER_TYPE',
] as const;

export interface KimiAcceptanceContext {
  readonly sourceHome?: string;
  readonly source: 'explicit' | 'environment' | 'default' | 'missing';
  readonly cliCommand?: string;
  readonly missing: readonly string[];
}

export interface IsolatedKimiAcceptance {
  readonly context: KimiAcceptanceContext;
  cleanup(): void;
}

declare module 'vitest' {
  interface ProvidedContext {
    kimiAcceptance: KimiAcceptanceContext;
  }
}

export interface ResolveKimiAcceptanceOptions {
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly homeDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly probeCommand?: (command: string) => boolean;
}

export function resolveKimiAcceptance(
  options: ResolveKimiAcceptanceOptions = {},
): KimiAcceptanceContext {
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const platform = options.platform ?? process.platform;
  const probeCommand = options.probeCommand ?? commandIsAvailable;
  const explicitHome = nonEmpty(env[KIMI_ACCEPTANCE_HOME_KEY]);
  const configuredHome = nonEmpty(env.KIMI_CODE_HOME);

  let sourceHome: string | undefined;
  let source: KimiAcceptanceContext['source'];
  const missing: string[] = [];

  if (env.CI) {
    sourceHome = explicitHome;
    source = explicitHome ? 'explicit' : 'missing';
    if (!sourceHome) {
      missing.push(
        `${KIMI_ACCEPTANCE_HOME_KEY} (dedicated source home authenticated by \`kimi login\`)`,
      );
    }
  } else if (explicitHome) {
    sourceHome = explicitHome;
    source = 'explicit';
  } else if (configuredHome) {
    sourceHome = configuredHome;
    source = 'environment';
  } else {
    sourceHome = join(homeDirectory, '.kimi-code');
    source = 'default';
  }

  if (sourceHome) {
    const sourceLabel =
      source === 'explicit'
        ? KIMI_ACCEPTANCE_HOME_KEY
        : source === 'environment'
          ? 'KIMI_CODE_HOME'
          : 'default Kimi Code home';
    if (!isAbsolute(sourceHome)) {
      missing.push(`absolute ${sourceLabel}`);
    } else {
      if (!isFile(join(sourceHome, 'config.toml'))) {
        missing.push(`${sourceLabel}/config.toml`);
      }
      const credentialsDirectory = join(sourceHome, 'credentials');
      if (!isDirectory(credentialsDirectory)) {
        missing.push(`${sourceLabel}/credentials`);
      } else if (!isFile(join(credentialsDirectory, 'kimi-code.json'))) {
        missing.push(`${sourceLabel}/credentials/kimi-code.json`);
      }
    }
  }

  let cliCommand: string | undefined;
  if (probeCommand('kimi')) {
    cliCommand = 'kimi';
  } else if (sourceHome && isAbsolute(sourceHome)) {
    const executable = platform === 'win32' ? 'kimi.exe' : 'kimi';
    const managedCommand = join(sourceHome, 'bin', executable);
    if (probeCommand(managedCommand)) cliCommand = managedCommand;
  }
  if (!cliCommand) {
    missing.push('kimi CLI on PATH or in the resolved Kimi Code home');
  }

  return { sourceHome, source, cliCommand, missing };
}

export function createIsolatedKimiAcceptance(
  context: KimiAcceptanceContext,
  prefix: string,
): IsolatedKimiAcceptance {
  assertKimiAcceptanceReady(context);

  const isolatedHome = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(isolatedHome, 0o700);
  let cleaned = false;

  try {
    cpSync(
      join(context.sourceHome!, 'config.toml'),
      join(isolatedHome, 'config.toml'),
      { dereference: true },
    );
    cpSync(
      join(context.sourceHome!, 'credentials'),
      join(isolatedHome, 'credentials'),
      { dereference: true, recursive: true },
    );
    hardenKimiAuthCopy(isolatedHome);
  } catch (error) {
    rmSync(isolatedHome, { recursive: true, force: true });
    throw error;
  }

  return {
    context: { ...context, sourceHome: isolatedHome },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      rmSync(isolatedHome, { recursive: true, force: true });
    },
  };
}

export async function withKimiAcceptanceEnvironment<T>(
  context: KimiAcceptanceContext,
  run: () => Promise<T>,
): Promise<T> {
  assertKimiAcceptanceReady(context);
  const previousHome = process.env.KIMI_CODE_HOME;
  const pathKey = environmentPathKey(process.env);
  const previousPath = process.env[pathKey];
  const previousModelEnv = new Map<string, string | undefined>(
    KIMI_MODEL_ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  process.env.KIMI_CODE_HOME = context.sourceHome;
  if (context.cliCommand !== 'kimi') {
    const cliDirectory = dirname(context.cliCommand!);
    process.env[pathKey] = previousPath
      ? `${cliDirectory}${delimiter}${previousPath}`
      : cliDirectory;
  }
  for (const key of KIMI_MODEL_ENV_KEYS) delete process.env[key];

  try {
    return await run();
  } finally {
    restoreEnvironmentValue('KIMI_CODE_HOME', previousHome);
    restoreEnvironmentValue(pathKey, previousPath);
    for (const [key, value] of previousModelEnv) {
      restoreEnvironmentValue(key, value);
    }
  }
}

export async function withIsolatedKimiCodeHome<T>(
  context: KimiAcceptanceContext,
  prefix: string,
  run: () => Promise<T>,
): Promise<T> {
  const isolated = createIsolatedKimiAcceptance(context, prefix);
  try {
    return await withKimiAcceptanceEnvironment(isolated.context, run);
  } finally {
    isolated.cleanup();
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function commandIsAvailable(command: string): boolean {
  try {
    execFileSync(command, ['--version'], {
      stdio: 'ignore',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

function assertKimiAcceptanceReady(
  context: KimiAcceptanceContext,
): asserts context is KimiAcceptanceContext & {
  readonly sourceHome: string;
  readonly cliCommand: string;
} {
  if (
    !context.sourceHome ||
    !context.cliCommand ||
    context.missing.length > 0
  ) {
    throw new Error(
      `Missing Kimi acceptance dependencies: ${context.missing.join(', ')}`,
    );
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hardenKimiAuthCopy(home: string): void {
  chmodSync(join(home, 'config.toml'), 0o600);
  hardenKimiCredentialTree(join(home, 'credentials'));
}

function hardenKimiCredentialTree(path: string): void {
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) {
      hardenKimiCredentialTree(entryPath);
    } else if (entry.isFile()) {
      chmodSync(entryPath, 0o600);
    } else {
      throw new Error(
        `Unsupported entry in copied Kimi credentials: ${entry.name}`,
      );
    }
  }
}

function environmentPathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
}

function restoreEnvironmentValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
