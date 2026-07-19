// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync, spawn } from 'node:child_process';
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
import { Readable, Writable } from 'node:stream';

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk';

const KIMI_ACCEPTANCE_HOME_KEY = 'CLIGENT_KIMI_ACCEPTANCE_HOME';
/** ACP `RequestError.authRequired()` — Kimi's spent-credential rejection. */
const KIMI_AUTH_REQUIRED_CODE = -32000;
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
  /**
   * Set when the credential is present and well-formed but no longer usable —
   * Kimi's rotating refresh token was already spent by an earlier run.
   *
   * Distinct from `missing`, which reports an absent fixture that a CI runner
   * is expected to supply. An absent fixture is a misconfiguration worth
   * failing on; a spent token is a property of Kimi's OAuth design that no
   * amount of CI configuration can prevent, so consumers self-skip on it even
   * under `CI` rather than reporting a false regression.
   */
  readonly unusable?: string;
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

/**
 * Confirm the cloned OAuth credential can still open an ACP session.
 *
 * Kimi Code 0.27 rotates the refresh token on every refresh and persists the
 * replacement into whichever home performed it. A credential copied into an
 * immutable store (a CI secret) is therefore spent the first time any run
 * refreshes it: the next run's refresh returns `invalid_grant`, the CLI writes
 * a revoked tombstone into the home, and every later `session/new` fails with
 * `Authentication required`. File presence cannot detect that state, so probe
 * the credential the same way the suite will use it.
 *
 * The probe deliberately runs against the SHARED clone, so the refresh it may
 * trigger is the one refresh the suite was going to perform anyway rather than
 * an extra rotation.
 *
 * Returns `undefined` when the credential is usable, or a human-readable
 * reason when it is not. Never throws and never surfaces credential material.
 */
export async function probeKimiCredential(
  context: KimiAcceptanceContext,
  timeoutMs = 20_000,
): Promise<string | undefined> {
  if (!context.sourceHome || !context.cliCommand) {
    return 'Kimi acceptance context is not ready';
  }

  const probeCwd = mkdtempSync(join(tmpdir(), 'cligent-kimi-probe-'));
  const child = spawn(context.cliCommand, ['acp'], {
    cwd: probeCwd,
    env: { ...process.env, KIMI_CODE_HOME: context.sourceHome },
    shell: false,
    stdio: 'pipe',
  });
  child.stderr?.resume();

  let timer: NodeJS.Timeout | undefined;
  try {
    const connection = new ClientSideConnection(
      () => ({
        async requestPermission() {
          return { outcome: { outcome: 'cancelled' as const } };
        },
        async sessionUpdate() {},
      }),
      ndJsonStream(
        Writable.toWeb(child.stdin!),
        Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
      ),
    );

    await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const { sessionId } = await connection.newSession({
      cwd: probeCwd,
      mcpServers: [],
    });

    // `session/new` is not a credential test: the CLI treats any non-empty
    // access token as authenticated without checking its expiry, so it
    // succeeds on a stale token and the rejection only appears once a model
    // call is made. Send a minimal prompt and watch for the auth rejection.
    //
    // The prompt need not finish — surviving a short window without an auth
    // error is enough to prove the credential works, so race a timer and
    // cancel rather than paying for a whole completion.
    const settled = new Promise<'usable'>((resolve) => {
      timer = setTimeout(() => resolve('usable'), timeoutMs);
    });

    await Promise.race([
      connection
        .prompt({
          sessionId,
          prompt: [{ type: 'text', text: 'hi' }],
        })
        .then(() => 'usable' as const),
      settled,
    ]);

    try {
      await connection.cancel({ sessionId });
    } catch {
      // Cancellation is best effort; the child is killed below regardless.
    }
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: unknown } | undefined)?.code;
    // Only an authentication rejection means "spent credential". Anything
    // else (network, protocol, CLI defect) must still fail the suite loudly
    // rather than being silently downgraded to a skip.
    if (code !== KIMI_AUTH_REQUIRED_CODE && !/auth/i.test(message)) {
      return undefined;
    }
    return `Kimi OAuth credential is not usable (${message}) — Kimi rotates its refresh token on every refresh, so a credential restored from an immutable secret is spent once any earlier run refreshed it; re-run \`kimi login\` and refresh the acceptance source`;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      child.stdin?.end();
    } catch {
      // The child may already have closed its input stream.
    }
    try {
      child.kill('SIGKILL');
    } catch {
      // Ignore shutdown races with a process that already exited.
    }
    rmSync(probeCwd, { force: true, recursive: true });
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
