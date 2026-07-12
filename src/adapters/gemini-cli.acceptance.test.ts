// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const available = isExecutableAvailable();
const acceptanceIt = available || process.env.CI ? it : it.skip;

describe('Gemini CLI 0.50 argument contract (TADAPT-025)', () => {
  acceptanceIt(
    'parses joined headless and session values without credentials',
    () => {
      expect(commandOutput(['--version']).trim()).toBe('0.50.0');

      const home = mkdtempSync(join(tmpdir(), 'cligent-gemini-parser-'));
      try {
        const env = isolatedEnvironment(home);
        const policyPath = join(home, 'cligent-policy.toml');
        writeFileSync(
          policyPath,
          [
            '[[rule]]',
            'toolName = "run_shell_command"',
            'decision = "deny"',
            'priority = 999',
            'interactive = false',
            '',
          ].join('\n'),
          'utf8',
        );
        const result = spawnSync(
          'gemini',
          [
            '--prompt=--cligent-leading-prompt',
            '--model=--cligent-leading-model',
            '--resume=--cligent-leading-resume',
            `--policy=${policyPath}`,
            '--output-format=cligent-parser-probe',
          ],
          {
            encoding: 'utf8',
            env,
            timeout: 10_000,
          },
        );

        if (result.error) throw result.error;
        const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

        // The invalid output format stops immediately after argv parsing, so
        // this exercises the installed parser without authentication or a
        // model request. Leading-dash values must remain option values.
        expect(result.status, output).toBe(1);
        expect(output).toContain('Argument: output-format');
        expect(output).toContain('Given: "cligent-parser-probe"');
        expect(output).not.toContain('Unknown argument');
        expect(output).toContain('--prompt');
        expect(output).toContain('--model');
        expect(output).toContain('--resume');
        expect(output).toContain('--policy');
        expect(output).not.toContain('--max-session-turns');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

function commandOutput(args: readonly string[]): string {
  const result = spawnSync('gemini', [...args], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `gemini ${args.join(' ')} exited ${String(result.status)}: ` +
        `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    );
  }
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GEMINI_CLI_HOME: home,
    GEMINI_CLI_NO_RELAUNCH: 'true',
    HOME: home,
    NO_COLOR: '1',
  };

  for (const key of [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_GENAI_USE_GCA',
    'GOOGLE_GENAI_USE_VERTEXAI',
  ]) {
    delete env[key];
  }

  return env;
}

function isExecutableAvailable(): boolean {
  const result = spawnSync('gemini', ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return (result.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT';
}
