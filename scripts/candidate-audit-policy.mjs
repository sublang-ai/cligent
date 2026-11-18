// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

export const CANDIDATE_ADVISORY =
  'https://github.com/advisories/GHSA-fc5q-39xc-vjpf';

// A recorded exception, never a claim that the development audit is clean.
export function auditDecision(report, { status, candidate, version, lock }) {
  if (candidate && !/^\d+\.\d+\.\d+-rc\.\d+$/.test(version))
    throw new Error('candidate audit requires an rc package version');
  const findings = report?.vulnerabilities;
  const total = report?.metadata?.vulnerabilities?.total;
  if (
    report?.auditReportVersion !== 2 ||
    report.error ||
    !findings ||
    typeof findings !== 'object' ||
    Array.isArray(findings) ||
    !Number.isInteger(total) ||
    total < 0 ||
    Object.keys(findings).length !== total ||
    ![0, 1].includes(status)
  )
    throw new Error('unusable dependency audit report');
  if (total === 0) {
    if (status !== 0)
      throw new Error('clean audit has a failing process status');
    return { outcome: 'clean', findings: 0 };
  }
  if (!candidate || status !== 1)
    throw new Error('dependency audit reported vulnerabilities');
  const checked = new Set();
  function visit(name, chain = new Set()) {
    if (checked.has(name)) return;
    const finding = findings[name];
    if (
      chain.has(name) ||
      !finding ||
      finding.name !== name ||
      finding.severity !== 'high' ||
      !Array.isArray(finding.nodes) ||
      finding.nodes.length === 0 ||
      !Array.isArray(finding.via) ||
      finding.via.length === 0
    )
      throw new Error('unresolved candidate audit finding: ' + name);
    for (const node of finding.nodes) {
      const entry = lock?.packages?.[node];
      if (
        typeof node !== 'string' ||
        !node.startsWith('node_modules/') ||
        !entry ||
        entry.dev !== true ||
        entry.devOptional === true ||
        entry.link === true
      )
        throw new Error(
          'candidate audit node is not development-only: ' + node,
        );
      if (name === 'picomatch' && entry.version !== '4.0.4')
        throw new Error(
          'candidate exception does not cover this matcher version',
        );
    }
    const next = new Set(chain).add(name);
    for (const via of finding.via) {
      if (typeof via === 'string') visit(via, next);
      else if (
        name !== 'picomatch' ||
        !via ||
        via.url !== CANDIDATE_ADVISORY ||
        via.name !== 'picomatch' ||
        via.dependency !== 'picomatch' ||
        via.severity !== 'high' ||
        via.range !== '<=4.0.7'
      )
        throw new Error('unapproved candidate advisory');
    }
    checked.add(name);
  }
  for (const name of Object.keys(findings)) visit(name);
  if (!checked.has('picomatch'))
    throw new Error('candidate audit lacks approved matcher finding');
  return {
    outcome: 'development-risk-exception',
    advisory: CANDIDATE_ADVISORY,
    matcherVersion: '4.0.4',
    findings: total,
    affectedDevelopmentPackages: [...checked].sort(),
    stableAndMergeReady: false,
  };
}
