// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { auditDecision } from '../../scripts/development-audit-policy.mjs';
import {
  passingReleaseRun,
  authorizedCandidatePull,
  releaseChannel,
} from '../../scripts/release-source-guard.mjs';

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const report = read('./fixtures/candidate-audit-report.json');
const lock = read('../../package-lock.json');
const options = () => ({
  scope: 'full-development',
  version: '0.40.0-rc.3',
  status: 1,
  lock: structuredClone(lock),
});

describe('version-bounded development audit deferral', () => {
  it('records the retained real npm report against the actual locked dev-only graph', () => {
    expect(auditDecision(report, options())).toMatchObject({
      outcome: 'development-risk-exception',
      findings: 10,
      securityRemediated: false,
    });
  });
  it('admits this finding for current formal publication but never production scope', () => {
    expect(
      auditDecision(report, { ...options(), version: '0.40.0' }),
    ).toMatchObject({
      outcome: 'development-risk-exception',
      securityRemediated: false,
    });
    expect(() =>
      auditDecision(report, { ...options(), scope: 'production' }),
    ).toThrow();
  });
  it.each(['0.40.1-rc.0', '0.40.1', '0.41.0-rc.1', '0.39.0', '0.40.0-rc.01'])(
    'expires automatically for %s',
    (version) => {
      expect(() => auditDecision(report, { ...options(), version })).toThrow();
    },
  );
  it('accepts a genuinely clean audit with a successful status', () => {
    expect(
      auditDecision(
        {
          auditReportVersion: 2,
          vulnerabilities: {},
          metadata: { vulnerabilities: { total: 0 } },
        },
        { ...options(), status: 0 },
      ),
    ).toEqual({ outcome: 'clean', findings: 0 });
  });
  it.each([
    'production-node',
    'different-version',
    'new-advisory',
    'unresolved-edge',
    'cycle',
    'empty-nodes',
    'empty-via',
    'error',
    'wrong-total',
    'invalid-status',
  ])('rejects %s', (variant) => {
    const data = structuredClone(report);
    const config = options();
    switch (variant) {
      case 'production-node':
        config.lock.packages['node_modules/vitest'].dev = false;
        break;
      case 'different-version':
        config.lock.packages['node_modules/picomatch'].version = '4.0.7';
        break;
      case 'new-advisory':
        data.vulnerabilities.picomatch.via[0].url += '-other';
        break;
      case 'unresolved-edge':
        data.vulnerabilities.vitest.via.push('missing');
        break;
      case 'cycle':
        data.vulnerabilities.picomatch.via.push('vitest');
        break;
      case 'empty-nodes':
        data.vulnerabilities.picomatch.nodes = [];
        break;
      case 'empty-via':
        data.vulnerabilities.picomatch.via = [];
        break;
      case 'error':
        data.error = { code: 'ENETUNREACH' };
        break;
      case 'wrong-total':
        data.metadata.vulnerabilities.total = 0;
        break;
      case 'invalid-status':
        config.status = 2;
        break;
    }
    expect(() => auditDecision(data, config)).toThrow();
  });
});

const repo = 'sublang-ai/cligent';
const sha = 'f'.repeat(40);
const pr = {
  number: 101,
  state: 'open',
  base: { ref: 'main', repo: { full_name: repo } },
  head: { sha, ref: 'branch', repo: { full_name: repo } },
};
const run = {
  id: 1,
  head_sha: sha,
  head_repository: { full_name: repo },
  event: 'pull_request',
  head_branch: 'branch',
  pull_requests: [{ number: 101 }],
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-11-18T00:00:00Z',
  run_attempt: 1,
};
const context = { candidate: true, repo, sha, pr };

describe('unchanged whole-CI publication rule', () => {
  it('never falls back from a newer incomplete attempt to old success', () => {
    expect(
      passingReleaseRun(
        [run, { ...run, run_attempt: 2, status: 'queued', conclusion: null }],
        context,
      ),
    ).toBe(false);
    expect(
      passingReleaseRun([{ ...run, conclusion: 'failure' }], context),
    ).toBe(false);
    expect(passingReleaseRun([{ ...run, head_sha: 'other' }], context)).toBe(
      false,
    );
    expect(
      passingReleaseRun(
        [{ ...run, head_repository: { full_name: 'fork' } }],
        context,
      ),
    ).toBe(false);
  });
  it('requires open same-repository candidate identity and main CI for stable', () => {
    expect(authorizedCandidatePull([pr], repo, sha)).toBe(pr);
    expect(
      authorizedCandidatePull([{ ...pr, state: 'closed' }], repo, sha),
    ).toBeUndefined();
    expect(passingReleaseRun([run], { ...context, candidate: false })).toBe(
      false,
    );
    expect(
      passingReleaseRun([{ ...run, event: 'push', head_branch: 'main' }], {
        ...context,
        candidate: false,
      }),
    ).toBe(true);
    expect(releaseChannel('v0.40.0-rc.3', '0.40.0-rc.3')).toBe('rc-global-cli');
  });
});
