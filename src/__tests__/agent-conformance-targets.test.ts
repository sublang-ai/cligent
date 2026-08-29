// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { inspectClaudeSdkSelectedBinary } from '../../scripts/verify-agent-targets.mjs';

interface WorkflowStep {
  env?: Record<string, string>;
  name?: string;
  run?: string;
}

interface Workflow {
  jobs?: {
    acceptance?: {
      needs?: string | string[];
      steps?: WorkflowStep[];
    };
    distributable?: {
      steps?: WorkflowStep[];
    };
  };
}

describe('agent SDK and CLI conformance targets', () => {
  it('does not invent a Claude binary identity from anonymous SDK metadata', () => {
    expect(
      inspectClaudeSdkSelectedBinary(
        { claudeCodeVersion: 'reported-version' },
        { version: 'reported-version' },
      ),
    ).toEqual({
      identity: 'unreported',
      version: 'reported-version',
      consistency: 'verified',
    });
    expect(
      inspectClaudeSdkSelectedBinary(
        { claudeCodeVersion: 'reported-version' },
        {
          version: 'reported-version',
          platforms: {
            'linux-x64': { binary: 'claude' },
            'linux-x64-musl': { binary: 'different-binary' },
          },
        },
        { platform: 'linux', arch: 'x64' },
      ).identity,
    ).toBe('unreported');
  });

  it('rejects disagreeing Claude SDK-selected binary versions', () => {
    expect(() =>
      inspectClaudeSdkSelectedBinary(
        { claudeCodeVersion: 'package-version' },
        { version: 'manifest-version' },
      ),
    ).toThrow(
      'Claude SDK selected-binary manifest: expected package-version, received manifest-version',
    );
  });

  it('reports each absent Claude version datum without fabrication', () => {
    expect(
      inspectClaudeSdkSelectedBinary(
        { claudeCodeVersion: 'package-only' },
        {},
      ),
    ).toEqual({
      identity: 'unreported',
      version: 'package-only',
      consistency: 'unreported',
    });
    expect(
      inspectClaudeSdkSelectedBinary({}, { version: 'manifest-only' }),
    ).toEqual({
      identity: 'unreported',
      version: 'manifest-only',
      consistency: 'unreported',
    });
    expect(inspectClaudeSdkSelectedBinary({}, {})).toEqual({
      identity: 'unreported',
      version: 'unreported',
      consistency: 'unreported',
    });
  });

  it('verifies exact manifest, lock, and installed SDK versions', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/verify-agent-targets.mjs', '--sdk-only'],
      {
        cwd: new URL('../..', import.meta.url),
        encoding: 'utf8',
      },
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const claudeSdkManifest = JSON.parse(
      readFileSync(
        new URL(
          '../../node_modules/@anthropic-ai/claude-agent-sdk/package.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const claudeBinaryManifest = JSON.parse(
      readFileSync(
        new URL(
          '../../node_modules/@anthropic-ai/claude-agent-sdk/manifest.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const selectedBinary = inspectClaudeSdkSelectedBinary(
      claudeSdkManifest,
      claudeBinaryManifest,
    );
    expect(result.stdout).toContain(
      `Claude SDK selected binary: identity=${selectedBinary.identity}, version=${selectedBinary.version}, consistency=${selectedBinary.consistency}.`,
    );
    expect(result.stdout).toContain('Agent conformance targets verified.');
  });

  it('runs the executable verifier after installing exact CI CLIs', () => {
    const workflow = parse(
      readFileSync(
        new URL('../../.github/workflows/ci.yml', import.meta.url),
        'utf8',
      ),
    ) as Workflow;
    const steps = workflow.jobs?.acceptance?.steps ?? [];
    const installIndex = steps.findIndex(
      (step) => step.name === 'Install agent CLIs',
    );
    const verifyIndex = steps.findIndex(
      (step) => step.name === 'Verify agent CLI targets',
    );

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(steps[installIndex]?.run).toBe(
      'npm install -g @google/gemini-cli@0.53.1 @moonshot-ai/kimi-code@0.31.1 opencode-ai@1.18.13',
    );
    expect(verifyIndex).toBeGreaterThan(installIndex);
    expect(steps[verifyIndex]?.run).toBe(
      'node scripts/verify-agent-targets.mjs',
    );
  });

  it('gates acceptance on isolated distributable verification', () => {
    const workflow = parse(
      readFileSync(
        new URL('../../.github/workflows/ci.yml', import.meta.url),
        'utf8',
      ),
    ) as Workflow;
    const steps = workflow.jobs?.distributable?.steps ?? [];
    const installIndex = steps.findIndex(
      (step) => step.name === 'Install exact agent CLIs',
    );
    const verifyIndex = steps.findIndex(
      (step) => step.name === 'Verify distributable',
    );

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(steps[installIndex]?.run).toBe(
      'npm install -g @google/gemini-cli@0.53.1 @moonshot-ai/kimi-code@0.31.1 opencode-ai@1.18.13',
    );
    expect(verifyIndex).toBeGreaterThan(installIndex);
    expect(steps[verifyIndex]?.run).toBe('npm run test:distributable');
    expect(workflow.jobs?.acceptance?.needs).toEqual(['ci', 'distributable']);
  });

  it('does not treat an API key as Kimi ACP OAuth state', () => {
    const workflow = parse(
      readFileSync(
        new URL('../../.github/workflows/ci.yml', import.meta.url),
        'utf8',
      ),
    ) as Workflow;
    const step = workflow.jobs?.acceptance?.steps?.find(
      (candidate) => candidate.name === 'Run acceptance tests',
    );

    expect(step?.env).toMatchObject({
      MOONSHOT_API_KEY: '${{ secrets.MOONSHOT_API_KEY }}',
    });
    expect(step?.env).not.toHaveProperty('KIMI_CODE_HOME');
    expect(step?.env).not.toHaveProperty('KIMI_MODEL_API_KEY');
    expect(step?.env).not.toHaveProperty('KIMI_MODEL_BASE_URL');
    expect(step?.env).not.toHaveProperty('KIMI_MODEL_NAME');
    expect(step?.env).not.toHaveProperty('CLIGENT_KIMI_ACCEPTANCE_HOME');
  });

  it('materializes a dedicated Kimi OAuth fixture before acceptance', () => {
    const workflow = parse(
      readFileSync(
        new URL('../../.github/workflows/ci.yml', import.meta.url),
        'utf8',
      ),
    ) as Workflow;
    const steps = workflow.jobs?.acceptance?.steps ?? [];
    const setupIndex = steps.findIndex(
      (step) => step.name === 'Configure Kimi acceptance credentials',
    );
    const runIndex = steps.findIndex(
      (step) => step.name === 'Run acceptance tests',
    );
    const setup = steps[setupIndex];

    expect(setupIndex).toBeGreaterThanOrEqual(0);
    expect(runIndex).toBeGreaterThan(setupIndex);
    expect(setup?.env).toEqual({
      KIMI_CODE_CONFIG_TOML_B64: '${{ secrets.KIMI_CODE_CONFIG_TOML_B64 }}',
      KIMI_CODE_CREDENTIALS_JSON_B64:
        '${{ secrets.KIMI_CODE_CREDENTIALS_JSON_B64 }}',
    });
    expect(setup?.run).toContain(
      '${KIMI_CODE_CONFIG_TOML_B64:?missing KIMI_CODE_CONFIG_TOML_B64 secret}',
    );
    expect(setup?.run).toContain(
      '${KIMI_CODE_CREDENTIALS_JSON_B64:?missing KIMI_CODE_CREDENTIALS_JSON_B64 secret}',
    );
    expect(setup?.run).toContain('CLIGENT_KIMI_ACCEPTANCE_HOME=%s\\n');
    expect(setup?.run).toContain('>> "$GITHUB_ENV"');
  });
});
