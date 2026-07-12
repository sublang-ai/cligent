// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
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
      'npm install -g @google/gemini-cli@0.50.0 opencode-ai@1.17.18',
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
      'npm install -g @google/gemini-cli@0.50.0 opencode-ai@1.17.18',
    );
    expect(verifyIndex).toBeGreaterThan(installIndex);
    expect(steps[verifyIndex]?.run).toBe('npm run test:distributable');
    expect(workflow.jobs?.acceptance?.needs).toEqual(['ci', 'distributable']);
  });
});
