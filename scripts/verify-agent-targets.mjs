// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_SDK_VERSIONS = Object.freeze({
  '@anthropic-ai/claude-agent-sdk': '0.3.207',
  '@openai/codex-sdk': '0.144.1',
  '@opencode-ai/sdk': '1.17.18',
});

export const EXPECTED_CLI_VERSIONS = Object.freeze({
  gemini: '0.50.0',
  opencode: '1.17.18',
});

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

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

  assertEqual(
    EXPECTED_SDK_VERSIONS['@opencode-ai/sdk'],
    EXPECTED_CLI_VERSIONS.opencode,
    'OpenCode SDK/CLI target alignment',
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

function isMainModule() {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  verifySdkTargets();
  if (!process.argv.includes('--sdk-only')) {
    verifyCliTargets();
  }
  process.stdout.write('Agent conformance targets verified.\n');
}
