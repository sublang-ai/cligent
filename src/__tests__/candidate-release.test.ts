// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { auditDecision } from '../../scripts/candidate-audit-policy.mjs';
import {
  candidateChecksPassed,
  matchingReleaseRuns,
  passingReleaseRun,
  authorizedCandidatePull,
  releaseChannel,
} from '../../scripts/release-source-guard.mjs';

const read = (path: string) =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const report = read('./fixtures/candidate-audit-report.json');
const lock = read('../../package-lock.json');
const options = () => ({
  candidate: true,
  version: '0.40.0-rc.3',
  status: 1,
  lock: structuredClone(lock),
});

describe('bounded candidate dependency audit', () => {
  it('records the retained real npm report against the actual locked dev-only graph', () => {
    expect(auditDecision(report, options())).toMatchObject({
      outcome: 'development-risk-exception',
      findings: 10,
      stableAndMergeReady: false,
    });
  });
  it('does not admit the same report for normal production or stable readiness', () => {
    expect(() =>
      auditDecision(report, { ...options(), candidate: false }),
    ).toThrow();
    expect(() =>
      auditDecision(report, { ...options(), version: '0.40.0' }),
    ).toThrow();
  });
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

const names = [
  'ci (20)',
  'ci (22)',
  'ci (24)',
  'ci (25)',
  'browser (ubuntu-latest)',
  'browser (windows-latest)',
  'browser (macos-latest)',
];
const jobs = () => [
  ...names.map((name) => ({
    name,
    status: 'completed',
    conclusion: 'success',
  })),
  { name: 'distributable', status: 'completed', conclusion: 'failure' },
  { name: 'acceptance', status: 'completed', conclusion: 'skipped' },
];
const candidateJobs = () => [
  {
    name: 'candidate-distributable',
    status: 'completed',
    conclusion: 'success',
  },
];
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

describe('candidate publisher scope', () => {
  it('requires all seven ordinary jobs and complete replacement distributable, while normal CI stays red', () => {
    expect(candidateChecksPassed(jobs(), candidateJobs())).toBe(true);
    expect(
      passingReleaseRun([{ ...run, conclusion: 'failure' }], context),
    ).toBe(false);
    expect(releaseChannel('v0.40.0-rc.3', '0.40.0-rc.3')).toBe('rc-global-cli');
  });
  it.each([
    'missing',
    'duplicate',
    'failure',
    'skipped',
    'running',
    'unknown',
    'candidate-fail',
    'candidate-missing',
  ])('refuses %s checks', (variant) => {
    const ordinary = jobs();
    const candidate = candidateJobs();
    switch (variant) {
      case 'missing':
        ordinary.shift();
        break;
      case 'duplicate':
        ordinary[0].name = ordinary[1].name;
        break;
      case 'failure':
        ordinary[0].conclusion = 'failure';
        break;
      case 'skipped':
        ordinary[0].conclusion = 'skipped';
        break;
      case 'running':
        ordinary[0].status = 'in_progress';
        break;
      case 'unknown':
        ordinary.push({
          name: 'extra',
          status: 'completed',
          conclusion: 'success',
        });
        break;
      case 'candidate-fail':
        candidate[0].conclusion = 'failure';
        break;
      case 'candidate-missing':
        candidate.pop();
        break;
    }
    expect(candidateChecksPassed(ordinary, candidate)).toBe(false);
  });
  it('selects newest attempt before status rather than falling back to completed success', () => {
    const pending = {
      ...run,
      run_attempt: 2,
      status: 'queued',
      conclusion: null,
    };
    expect(matchingReleaseRuns([run, pending], context)[0]).toEqual(pending);
    expect(passingReleaseRun([run, pending], context)).toBe(false);
    expect(
      matchingReleaseRuns([{ ...run, head_sha: 'other' }], context),
    ).toEqual([]);
    expect(
      matchingReleaseRuns(
        [{ ...run, head_repository: { full_name: 'fork' } }],
        context,
      ),
    ).toEqual([]);
  });
  it('requires a still-current open same-repository PR and preserves stable main-CI selection', () => {
    expect(authorizedCandidatePull([pr], repo, sha)).toBe(pr);
    expect(
      authorizedCandidatePull([{ ...pr, state: 'closed' }], repo, sha),
    ).toBeUndefined();
    expect(
      authorizedCandidatePull(
        [{ ...pr, head: { ...pr.head, sha: 'moved' } }],
        repo,
        sha,
      ),
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
  });
});
