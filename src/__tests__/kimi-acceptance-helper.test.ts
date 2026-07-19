// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createIsolatedKimiAcceptance,
  probeKimiCredential,
  resolveKimiAcceptance,
  withIsolatedKimiCodeHome,
  withKimiAcceptanceEnvironment,
} from './helpers/kimi-acceptance.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Kimi acceptance dependency resolution', () => {
  it('prefers the explicit home, environment home, then default home', () => {
    const root = makeTemporaryRoot();
    const explicitHome = createKimiHome(join(root, 'explicit'));
    const environmentHome = createKimiHome(join(root, 'environment'));
    const defaultHome = createKimiHome(join(root, '.kimi-code'));
    const available = (command: string): boolean => command.endsWith('/kimi');

    expect(
      resolveKimiAcceptance({
        env: {
          CLIGENT_KIMI_ACCEPTANCE_HOME: explicitHome,
          KIMI_CODE_HOME: environmentHome,
        },
        homeDirectory: root,
        probeCommand: available,
      }),
    ).toMatchObject({
      sourceHome: explicitHome,
      source: 'explicit',
      missing: [],
    });
    expect(
      resolveKimiAcceptance({
        env: { KIMI_CODE_HOME: environmentHome },
        homeDirectory: root,
        probeCommand: available,
      }),
    ).toMatchObject({
      sourceHome: environmentHome,
      source: 'environment',
      missing: [],
    });
    expect(
      resolveKimiAcceptance({
        env: {},
        homeDirectory: root,
        probeCommand: available,
      }),
    ).toMatchObject({
      sourceHome: defaultHome,
      source: 'default',
      missing: [],
    });
  });

  it('requires an explicit dedicated home under CI', () => {
    const root = makeTemporaryRoot();
    createKimiHome(join(root, '.kimi-code'));

    const context = resolveKimiAcceptance({
      env: { CI: 'true' },
      homeDirectory: root,
      probeCommand: () => false,
    });

    expect(context.source).toBe('missing');
    expect(context.sourceHome).toBeUndefined();
    expect(context.missing).toEqual([
      'CLIGENT_KIMI_ACCEPTANCE_HOME (dedicated source home authenticated by `kimi login`)',
      'kimi CLI on PATH or in the resolved Kimi Code home',
    ]);
  });

  it('uses PATH before falling back to the managed binary', () => {
    const root = makeTemporaryRoot();
    const sourceHome = createKimiHome(join(root, 'source'));
    const probes: string[] = [];
    const managedCommand = join(sourceHome, 'bin', 'kimi');

    const fromPath = resolveKimiAcceptance({
      env: { CLIGENT_KIMI_ACCEPTANCE_HOME: sourceHome },
      probeCommand(command) {
        probes.push(command);
        return command === 'kimi';
      },
    });
    expect(fromPath.cliCommand).toBe('kimi');
    expect(probes).toEqual(['kimi']);

    probes.length = 0;
    const fromManagedHome = resolveKimiAcceptance({
      env: { CLIGENT_KIMI_ACCEPTANCE_HOME: sourceHome },
      probeCommand(command) {
        probes.push(command);
        return command === managedCommand;
      },
    });
    expect(fromManagedHome.cliCommand).toBe(managedCommand);
    expect(probes).toEqual(['kimi', managedCommand]);
  });

  it('reports an invalid discovered home precisely', () => {
    const context = resolveKimiAcceptance({
      env: { KIMI_CODE_HOME: 'relative-home' },
      probeCommand: () => false,
    });

    expect(context.missing).toEqual([
      'absolute KIMI_CODE_HOME',
      'kimi CLI on PATH or in the resolved Kimi Code home',
    ]);
  });

  it('rejects a home without the Kimi OAuth credential file', () => {
    const root = makeTemporaryRoot();
    const sourceHome = createKimiHome(join(root, 'source'));
    rmSync(join(sourceHome, 'credentials', 'kimi-code.json'));

    const context = resolveKimiAcceptance({
      env: { CLIGENT_KIMI_ACCEPTANCE_HOME: sourceHome },
      probeCommand: () => true,
    });

    expect(context.missing).toEqual([
      'CLIGENT_KIMI_ACCEPTANCE_HOME/credentials/kimi-code.json',
    ]);
  });
});

describe('Kimi credential usability probe', () => {
  // The probe gates the whole Kimi acceptance suite from global setup, so it
  // must degrade to a reason string rather than throwing — a throw there would
  // abort every acceptance file, not just the Kimi legs.
  it('reports a reason instead of throwing for an unready context', async () => {
    await expect(
      probeKimiCredential({
        source: 'missing',
        missing: ['kimi CLI on PATH or in the resolved Kimi Code home'],
      }),
    ).resolves.toContain('not ready');
  });

  it('detects a spent credential that only fails at session/prompt', async () => {
    const root = makeTemporaryRoot();
    const home = createKimiHome(join(root, 'home'));
    // Reproduces the exact shape Kimi presents once its rotating refresh token
    // is spent: `session/new` still succeeds, because the CLI treats any
    // non-empty access token as authenticated without checking expiry, and the
    // rejection appears only when a model call is attempted.
    const stub = join(root, 'kimi-stub.mjs');
    writeFileSync(
      stub,
      `#!/usr/bin/env node
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') {
      reply({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (message.method === 'session/new') {
      reply({ id: message.id, result: { sessionId: 'probe-session' } });
    } else if (message.method === 'session/prompt') {
      reply({ id: message.id, error: { code: -32000, message: 'Authentication required' } });
    }
  }
});
function reply(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\\n');
}
`,
      { encoding: 'utf-8', mode: 0o755 },
    );

    const reason = await probeKimiCredential(
      {
        source: 'explicit',
        sourceHome: home,
        cliCommand: stub,
        missing: [],
      },
      10_000,
    );

    expect(reason).toBeDefined();
    expect(reason).toContain('kimi login');
    expect(reason).toContain('rotates its refresh token');
  });

  it('does not downgrade a non-authentication failure to a skip', async () => {
    const root = makeTemporaryRoot();
    const home = createKimiHome(join(root, 'home'));

    // `true` exits 0 immediately without an ACP handshake, standing in for a
    // broken CLI rather than a spent credential. Only an auth rejection means
    // "skip"; every other failure must still reach the suite so a real
    // regression fails the build instead of vanishing into a skip.
    await expect(
      probeKimiCredential(
        {
          source: 'explicit',
          sourceHome: home,
          cliCommand: '/usr/bin/true',
          missing: [],
        },
        5_000,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('Kimi acceptance credential isolation', () => {
  it('preserves refreshed credentials across sequential consumers', async () => {
    const root = makeTemporaryRoot();
    const sourceHome = createKimiHome(join(root, 'source'));
    const isolated = createIsolatedKimiAcceptance(
      {
        sourceHome,
        source: 'explicit',
        cliCommand: 'kimi',
        missing: [],
      },
      'cligent-kimi-shared-test-',
    );
    let sharedHome: string | undefined;

    try {
      await withKimiAcceptanceEnvironment(isolated.context, async () => {
        sharedHome = process.env.KIMI_CODE_HOME;
        writeFileSync(
          join(sharedHome!, 'credentials', 'kimi-code.json'),
          '{"token":"rotated"}\n',
        );
      });
      await withKimiAcceptanceEnvironment(isolated.context, async () => {
        expect(process.env.KIMI_CODE_HOME).toBe(sharedHome);
        expect(
          readFileSync(
            join(sharedHome!, 'credentials', 'kimi-code.json'),
            'utf8',
          ),
        ).toBe('{"token":"rotated"}\n');
      });
    } finally {
      isolated.cleanup();
    }

    expect(sharedHome && existsSync(sharedHome)).toBe(false);
    expect(
      readFileSync(join(sourceHome, 'credentials', 'kimi-code.json'), 'utf8'),
    ).toBe('{"token":"fixture"}\n');
  });

  it('copies and hardens auth while restoring the caller environment', async () => {
    const root = makeTemporaryRoot();
    const sourceHome = createKimiHome(join(root, 'source'));
    const cliCommand = join(sourceHome, 'bin', 'kimi');
    const sourceConfigMode = fileMode(join(sourceHome, 'config.toml'));
    const sourceCredentialMode = fileMode(
      join(sourceHome, 'credentials', 'kimi-code.json'),
    );
    const oldHome = process.env.KIMI_CODE_HOME;
    const oldPath = process.env.PATH;
    const oldModelName = process.env.KIMI_MODEL_NAME;
    process.env.KIMI_CODE_HOME = 'callers-home';
    process.env.PATH = '/callers/bin';
    process.env.KIMI_MODEL_NAME = 'callers-model';
    let isolatedHome: string | undefined;

    try {
      const result = await withIsolatedKimiCodeHome(
        {
          sourceHome,
          source: 'explicit',
          cliCommand,
          missing: [],
        },
        'cligent-kimi-helper-test-',
        async () => {
          isolatedHome = process.env.KIMI_CODE_HOME;
          expect(isolatedHome).not.toBe(sourceHome);
          expect(readFileSync(join(isolatedHome!, 'config.toml'), 'utf8')).toBe(
            'model = "kimi"\n',
          );
          expect(
            readFileSync(
              join(isolatedHome!, 'credentials', 'kimi-code.json'),
              'utf8',
            ),
          ).toBe('{"token":"fixture"}\n');
          expect(fileMode(isolatedHome!)).toBe(0o700);
          expect(fileMode(join(isolatedHome!, 'config.toml'))).toBe(0o600);
          expect(fileMode(join(isolatedHome!, 'credentials'))).toBe(0o700);
          expect(
            fileMode(join(isolatedHome!, 'credentials', 'kimi-code.json')),
          ).toBe(0o600);
          expect(existsSync(join(isolatedHome!, 'bin'))).toBe(false);
          expect(process.env.PATH?.split(delimiter)[0]).toBe(
            join(sourceHome, 'bin'),
          );
          expect(process.env.KIMI_MODEL_NAME).toBeUndefined();
          return 'ok';
        },
      );

      expect(result).toBe('ok');
      expect(process.env.KIMI_CODE_HOME).toBe('callers-home');
      expect(process.env.PATH).toBe('/callers/bin');
      expect(process.env.KIMI_MODEL_NAME).toBe('callers-model');
      expect(isolatedHome && existsSync(isolatedHome)).toBe(false);
      expect(fileMode(join(sourceHome, 'config.toml'))).toBe(sourceConfigMode);
      expect(fileMode(join(sourceHome, 'credentials', 'kimi-code.json'))).toBe(
        sourceCredentialMode,
      );
      expect(readFileSync(join(sourceHome, 'config.toml'), 'utf8')).toBe(
        'model = "kimi"\n',
      );
      expect(
        readFileSync(join(sourceHome, 'credentials', 'kimi-code.json'), 'utf8'),
      ).toBe('{"token":"fixture"}\n');
    } finally {
      restoreEnvironment('KIMI_CODE_HOME', oldHome);
      restoreEnvironment('PATH', oldPath);
      restoreEnvironment('KIMI_MODEL_NAME', oldModelName);
    }
  });

  it('restores and removes the isolated home when the probe throws', async () => {
    const root = makeTemporaryRoot();
    const sourceHome = createKimiHome(join(root, 'source'));
    const oldHome = process.env.KIMI_CODE_HOME;
    let isolatedHome: string | undefined;

    delete process.env.KIMI_CODE_HOME;
    try {
      await expect(
        withIsolatedKimiCodeHome(
          {
            sourceHome,
            source: 'explicit',
            cliCommand: 'kimi',
            missing: [],
          },
          'cligent-kimi-helper-error-',
          async () => {
            isolatedHome = process.env.KIMI_CODE_HOME;
            throw new Error('probe failed');
          },
        ),
      ).rejects.toThrow('probe failed');
      expect(process.env.KIMI_CODE_HOME).toBeUndefined();
      expect(isolatedHome && existsSync(isolatedHome)).toBe(false);
    } finally {
      restoreEnvironment('KIMI_CODE_HOME', oldHome);
    }
  });
});

function makeTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cligent-kimi-resolution-test-'));
  temporaryRoots.push(root);
  return root;
}

function createKimiHome(path: string): string {
  mkdirSync(join(path, 'credentials'), { recursive: true, mode: 0o755 });
  mkdirSync(join(path, 'bin'), { mode: 0o755 });
  writeFileSync(join(path, 'config.toml'), 'model = "kimi"\n', { mode: 0o644 });
  writeFileSync(
    join(path, 'credentials', 'kimi-code.json'),
    '{"token":"fixture"}\n',
    { mode: 0o644 },
  );
  writeFileSync(join(path, 'bin', 'kimi'), '#!/bin/sh\n', { mode: 0o755 });
  chmodSync(join(path, 'bin', 'kimi'), 0o755);
  return path;
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
