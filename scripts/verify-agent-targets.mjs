// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk';

export const EXPECTED_SDK_VERSIONS = Object.freeze({
  '@anthropic-ai/claude-agent-sdk': '0.3.207',
  '@openai/codex-sdk': '0.144.5',
  '@opencode-ai/sdk': '1.17.18',
});

export const EXPECTED_PROTOCOL_VERSIONS = Object.freeze({
  '@agentclientprotocol/sdk': '0.23.0',
});

export const EXPECTED_CLI_VERSIONS = Object.freeze({
  gemini: '0.50.0',
  kimi: '0.27.0',
  opencode: '1.17.18',
});

export const EXPECTED_BUNDLED_AGENT_VERSIONS = Object.freeze({
  claudeCode: '2.1.207',
  codex: '0.144.5',
});

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const KIMI_ACP_EXIT_GRACE_MS = 1_000;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${expected}, received ${String(actual)}`,
    );
  }
}

export function verifySdkTargets() {
  const manifest = readJson(join(repoRoot, 'package.json'));
  const lock = readJson(join(repoRoot, 'package-lock.json'));

  for (const [packageName, expected] of Object.entries(EXPECTED_SDK_VERSIONS)) {
    assertEqual(
      manifest.devDependencies?.[packageName],
      expected,
      `package.json ${packageName}`,
    );
    assertEqual(
      lock.packages?.['']?.devDependencies?.[packageName],
      expected,
      `package-lock root ${packageName}`,
    );
    assertEqual(
      lock.packages?.[`node_modules/${packageName}`]?.version,
      expected,
      `package-lock resolved ${packageName}`,
    );
    assertEqual(
      readJson(join(repoRoot, 'node_modules', packageName, 'package.json'))
        .version,
      expected,
      `installed ${packageName}`,
    );
  }

  for (const [packageName, expected] of Object.entries(
    EXPECTED_PROTOCOL_VERSIONS,
  )) {
    assertEqual(
      manifest.dependencies?.[packageName],
      expected,
      `package.json ${packageName}`,
    );
    assertEqual(
      lock.packages?.['']?.dependencies?.[packageName],
      expected,
      `package-lock root ${packageName}`,
    );
    assertEqual(
      lock.packages?.[`node_modules/${packageName}`]?.version,
      expected,
      `package-lock resolved ${packageName}`,
    );
    assertEqual(
      readJson(join(repoRoot, 'node_modules', packageName, 'package.json'))
        .version,
      expected,
      `installed ${packageName}`,
    );
  }

  assertEqual(
    EXPECTED_SDK_VERSIONS['@opencode-ai/sdk'],
    EXPECTED_CLI_VERSIONS.opencode,
    'OpenCode SDK/CLI target alignment',
  );

  const claudeManifest = readJson(
    join(
      repoRoot,
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
      'package.json',
    ),
  );
  assertEqual(
    claudeManifest.claudeCodeVersion,
    EXPECTED_BUNDLED_AGENT_VERSIONS.claudeCode,
    'Claude Code bundled target',
  );
  assertEqual(
    readJson(
      join(
        repoRoot,
        'node_modules',
        '@anthropic-ai',
        'claude-agent-sdk',
        'manifest.json',
      ),
    ).version,
    EXPECTED_BUNDLED_AGENT_VERSIONS.claudeCode,
    'Claude Code bundled manifest',
  );

  const codexSdkManifest = readJson(
    join(repoRoot, 'node_modules', '@openai', 'codex-sdk', 'package.json'),
  );
  assertEqual(
    codexSdkManifest.dependencies?.['@openai/codex'],
    EXPECTED_BUNDLED_AGENT_VERSIONS.codex,
    'Codex SDK bundled CLI declaration',
  );
  assertEqual(
    readJson(join(repoRoot, 'node_modules', '@openai', 'codex', 'package.json'))
      .version,
    EXPECTED_BUNDLED_AGENT_VERSIONS.codex,
    'installed Codex CLI package',
  );
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error) {
    throw new Error(`${command} could not start: ${result.error.message}`);
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${String(result.status)}: ${output.trim()}`,
    );
  }
  return output;
}

export function verifyCliTargets() {
  assertEqual(
    commandOutput('gemini', ['--version']).trim(),
    EXPECTED_CLI_VERSIONS.gemini,
    'Gemini CLI version',
  );
  assertEqual(
    commandOutput('kimi', ['--version']).trim(),
    EXPECTED_CLI_VERSIONS.kimi,
    'Kimi Code CLI version',
  );
  assertEqual(
    commandOutput('opencode', ['--version']).trim(),
    EXPECTED_CLI_VERSIONS.opencode,
    'OpenCode CLI version',
  );

  const help = commandOutput('opencode', ['serve', '--help']);
  for (const flag of ['--hostname', '--port']) {
    if (!help.includes(flag)) {
      throw new Error(`OpenCode serve help is missing ${flag}`);
    }
  }
}

function waitForProcessClose(closePromise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    void closePromise.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function endProcessInput(child) {
  try {
    child.stdin.end();
  } catch {
    // The process may already have closed its input stream.
  }
}

function signalProcess(child, signal) {
  try {
    child.kill(signal);
  } catch {
    // Ignore shutdown races and rely on the bounded close wait below.
  }
}

async function shutdownKimiAcp(child, closePromise) {
  endProcessInput(child);
  if (await waitForProcessClose(closePromise, KIMI_ACP_EXIT_GRACE_MS)) return;

  signalProcess(child, 'SIGTERM');
  if (await waitForProcessClose(closePromise, KIMI_ACP_EXIT_GRACE_MS)) return;

  signalProcess(child, 'SIGKILL');
  if (await waitForProcessClose(closePromise, KIMI_ACP_EXIT_GRACE_MS)) return;

  throw new Error(
    'process did not exit after stdin closed, SIGTERM, and SIGKILL',
  );
}

function failureMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function verifyKimiAcpInitialize() {
  const kimiCodeHome = mkdtempSync(join(tmpdir(), 'cligent-kimi-target-'));
  let child;
  let closePromise;
  let stderr = '';
  let timeout;
  let failure;

  try {
    child = spawn('kimi', ['acp'], {
      env: { ...process.env, KIMI_CODE_HOME: kimiCodeHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    closePromise = new Promise((resolve) => child.once('close', resolve));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const started = new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    await started;
    const connection = new ClientSideConnection(
      () => ({
        async requestPermission() {
          return { outcome: { outcome: 'cancelled' } };
        },
        async sessionUpdate() {},
      }),
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
    );
    const initialized = await Promise.race([
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      }),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('timed out after 10 seconds')),
          10_000,
        );
      }),
    ]);
    assertEqual(
      initialized.protocolVersion,
      PROTOCOL_VERSION,
      'Kimi ACP protocol version',
    );
  } catch (error) {
    failure = `initialize failed: ${failureMessage(error)}`;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (child && closePromise) {
      try {
        await shutdownKimiAcp(child, closePromise);
      } catch (error) {
        const teardownFailure = `teardown failed: ${failureMessage(error)}`;
        failure = failure ? `${failure}; ${teardownFailure}` : teardownFailure;
      }
    }
    try {
      rmSync(kimiCodeHome, { force: true, recursive: true });
    } catch (error) {
      const cleanupFailure = `isolated-home cleanup failed: ${failureMessage(error)}`;
      failure = failure ? `${failure}; ${cleanupFailure}` : cleanupFailure;
    }
  }

  if (failure) {
    const diagnostic = stderr.trim();
    throw new Error(
      `Kimi ACP verification failed: ${failure}${
        diagnostic ? `; stderr: ${diagnostic}` : ''
      }`,
    );
  }
}

function isMainModule() {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  verifySdkTargets();
  if (!process.argv.includes('--sdk-only')) {
    verifyCliTargets();
    await verifyKimiAcpInitialize();
  }
  process.stdout.write('Agent conformance targets verified.\n');
}
