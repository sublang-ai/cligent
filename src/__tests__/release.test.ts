// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const allowedChangelogHeadings = [
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
];

function read(relativePath: string): string {
  return readFileSync(join(projectRoot, relativePath), 'utf8');
}

function evidenceField(evidence: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = evidence.match(
    new RegExp('^- ' + escaped + ': `([^`]+)`$', 'm'),
  );
  if (!match?.[1]) throw new Error(`release evidence is missing ${label}`);
  return match[1];
}

function orderedAuditLog(
  repository: string,
  previousTag: string,
  auditedHead: string,
): string {
  return execFileSync(
    'git',
    ['log', '--reverse', '--format=%H%x09%s', `${previousTag}..${auditedHead}`],
    {
      cwd: repository,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function resolveCommit(
  repository: string,
  revision: string,
): string | undefined {
  try {
    return execFileSync(
      'git',
      ['rev-parse', '--verify', `${revision}^{commit}`],
      {
        cwd: repository,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  } catch {
    return undefined;
  }
}

function isAncestor(
  repository: string,
  ancestor: string,
  descendant: string,
): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: repository,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

function commitFile(
  repository: string,
  revision: string,
  relativePath: string,
): string | undefined {
  try {
    return execFileSync('git', ['show', `${revision}:${relativePath}`], {
      cwd: repository,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return undefined;
  }
}

function commitChangesPath(
  repository: string,
  commit: string,
  relativePath: string,
): boolean {
  const parent = soleParent(repository, commit);
  return (
    parent !== undefined &&
    commitFile(repository, parent, relativePath) !==
      commitFile(repository, commit, relativePath)
  );
}

function soleParent(repository: string, commit: string): string | undefined {
  const parent = resolveCommit(repository, `${commit}^`);
  if (
    parent === undefined ||
    resolveCommit(repository, `${commit}^2`) !== undefined
  ) {
    return undefined;
  }
  return parent;
}

function workingPathChanged(repository: string, relativePath: string): boolean {
  return (
    execFileSync('git', ['status', '--porcelain=v1', '--', relativePath], {
      cwd: repository,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim() !== ''
  );
}

function auditPreparationBoundary(
  repository: string,
  version: string,
  auditedHead: string,
  evidencePath: string,
): void {
  const head = resolveCommit(repository, 'HEAD');
  if (head === undefined) throw new Error('release audit cannot resolve HEAD');

  const taggedCommit = resolveCommit(repository, `v${version}`);
  if (taggedCommit !== undefined) {
    expect(isAncestor(repository, taggedCommit, head)).toBe(true);
    expect(soleParent(repository, taggedCommit)).toBe(auditedHead);
    expect(commitChangesPath(repository, taggedCommit, evidencePath)).toBe(
      true,
    );
    const taggedEvidence = commitFile(repository, taggedCommit, evidencePath);
    expect(evidenceField(taggedEvidence ?? '', 'Audited head')).toBe(
      auditedHead,
    );
    return;
  }

  expect(isAncestor(repository, auditedHead, head)).toBe(true);
  if (workingPathChanged(repository, evidencePath)) {
    expect(auditedHead).toBe(head);
  }
}

function changelogUnreleasedSection(
  changelog: string,
  version: string,
): string | undefined {
  const unreleasedHeader = '## [Unreleased]';
  const unreleasedStart = changelog.indexOf(unreleasedHeader);
  const versionStart = changelog.indexOf(
    `## [${version}] - `,
    unreleasedStart + unreleasedHeader.length,
  );
  if (unreleasedStart < 0 || versionStart < 0) return undefined;
  return changelog.slice(
    unreleasedStart + unreleasedHeader.length,
    versionStart,
  );
}

function preparationCommitAfter(
  repository: string,
  auditedHead: string,
  headCommit: string,
  evidencePath: string,
): string | undefined {
  if (!isAncestor(repository, auditedHead, headCommit)) return undefined;
  const output = execFileSync(
    'git',
    [
      'rev-list',
      '--reverse',
      '--ancestry-path',
      `${auditedHead}..${headCommit}`,
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
  const candidates = (output === '' ? [] : output.split('\n')).filter(
    (commit) => {
      if (
        soleParent(repository, commit) !== auditedHead ||
        !commitChangesPath(repository, commit, evidencePath)
      ) {
        return false;
      }
      const evidence = commitFile(repository, commit, evidencePath);
      if (evidence === undefined) return false;
      try {
        return evidenceField(evidence, 'Audited head') === auditedHead;
      } catch {
        return false;
      }
    },
  );
  if (candidates.length > 1) {
    throw new Error('release history contains multiple preparation commits');
  }
  return candidates[0];
}

function isLaterReleaseTree(
  repository: string,
  version: string,
  auditedHead: string,
  evidencePath: string,
  workingChangelog: string,
): boolean {
  const taggedCommit = resolveCommit(repository, `v${version}`);
  const headCommit = resolveCommit(repository, 'HEAD');
  if (headCommit === undefined) return false;

  if (taggedCommit === undefined) {
    const preparationCommit = preparationCommitAfter(
      repository,
      auditedHead,
      headCommit,
      evidencePath,
    );
    if (preparationCommit === undefined) return false;
    const preparedChangelog = commitFile(
      repository,
      preparationCommit,
      'CHANGELOG.md',
    );
    const preparedUnreleased =
      preparedChangelog === undefined
        ? undefined
        : changelogUnreleasedSection(preparedChangelog, version);
    if (preparedUnreleased === undefined) {
      throw new Error(
        `release ${version} does not contain an auditable prepared changelog`,
      );
    }
    if (preparedUnreleased.trim() !== '') {
      throw new Error(
        `release ${version} does not contain an empty prepared Unreleased section`,
      );
    }
    if (preparationCommit !== headCommit) return true;
    return preparedChangelog !== workingChangelog;
  }

  if (!isAncestor(repository, taggedCommit, headCommit)) return false;

  const taggedChangelog = commitFile(repository, taggedCommit, 'CHANGELOG.md');
  if (taggedChangelog === undefined) {
    throw new Error(
      `v${version} does not contain an auditable prepared changelog`,
    );
  }
  const taggedUnreleased = changelogUnreleasedSection(taggedChangelog, version);
  if (taggedUnreleased === undefined) {
    throw new Error(
      `v${version} does not contain an auditable prepared changelog`,
    );
  }
  if (taggedUnreleased.trim() !== '') {
    throw new Error(
      `v${version} does not contain an empty prepared Unreleased section`,
    );
  }
  if (taggedCommit !== headCommit) return true;
  return taggedChangelog !== workingChangelog;
}

function orderedChangelogHeadingMatches(section: string): RegExpMatchArray[] {
  const matches = [...section.matchAll(/^### (.+)$/gm)];
  const headings = matches.map((match) => match[1] ?? '');
  expect(headings.length).toBeGreaterThan(0);
  expect(headings).toEqual(
    [...headings].sort(
      (left, right) =>
        allowedChangelogHeadings.indexOf(left) -
        allowedChangelogHeadings.indexOf(right),
    ),
  );
  expect(
    headings.every((heading) => allowedChangelogHeadings.includes(heading)),
  ).toBe(true);
  return matches;
}

function auditUnreleasedSection(
  repository: string,
  version: string,
  auditedHead: string,
  evidencePath: string,
  changelog: string,
  section: string,
): void {
  if (
    !isLaterReleaseTree(
      repository,
      version,
      auditedHead,
      evidencePath,
      changelog,
    )
  ) {
    expect(section.trim()).toBe('');
    return;
  }
  if (section.trim() !== '') orderedChangelogHeadingMatches(section);
}

interface WorkflowStep {
  run?: unknown;
  uses?: unknown;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

function repositoryWorkflowJobs(): Array<{
  id: string;
  steps: WorkflowStep[];
}> {
  const workflowDirectory = '.github/workflows';
  return readdirSync(join(projectRoot, workflowDirectory))
    .filter((filename) => /\.ya?ml$/.test(filename))
    .sort()
    .flatMap((filename) => {
      const workflow = parse(read(`${workflowDirectory}/${filename}`)) as {
        jobs?: Record<string, WorkflowJob>;
      };
      return Object.entries(workflow.jobs ?? {}).map(([jobName, job]) => ({
        id: `${workflowDirectory}/${filename}#${jobName}`,
        steps: Array.isArray(job.steps) ? job.steps : [],
      }));
    });
}

function expectedVersion(previous: string, level: string): string {
  const parts = previous.split('.').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
    throw new Error(`invalid previous version: ${previous}`);
  }
  const [major, minor, patch] = parts as [number, number, number];
  switch (level) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`invalid change level: ${level}`);
  }
}

describe('release preparation', () => {
  it('audits the real prepared range, version, changelog, and checklist (release-15)', () => {
    const manifest = JSON.parse(read('package.json')) as { version: string };
    const evidencePath = `docs/releases/${manifest.version}-preparation.md`;
    const evidence = read(evidencePath);
    const previousTag = evidenceField(evidence, 'Previous tag');
    const auditedHead = evidenceField(evidence, 'Audited head');
    const commitCount = Number(evidenceField(evidence, 'Commit count'));
    const expectedDigest = evidenceField(evidence, 'Ordered log SHA-256');
    const subjectClasses = evidenceField(evidence, 'Subject classes');
    const previousVersion = evidenceField(evidence, 'Previous version');
    const chosenVersion = evidenceField(evidence, 'Chosen version');
    const releaseDate = evidenceField(evidence, 'Release date');
    const changeLevel = evidenceField(evidence, 'Change level');
    expect(evidenceField(evidence, 'Containing changes attestation')).toBe(
      'complete',
    );
    auditPreparationBoundary(
      projectRoot,
      chosenVersion,
      auditedHead,
      evidencePath,
    );

    const orderedLog = orderedAuditLog(projectRoot, previousTag, auditedHead);
    const commits = orderedLog.trimEnd().split('\n');
    const classes = new Map<string, number>();
    for (const entry of commits) {
      const subject = entry.split('\t', 2)[1] ?? '';
      const kind = subject.split(/[(:]/, 1)[0] ?? '';
      classes.set(kind, (classes.get(kind) ?? 0) + 1);
    }
    const actualClasses = [...classes.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([kind, count]) => `${count} ${kind}`)
      .join('; ');

    expect(commits).toHaveLength(commitCount);
    expect(createHash('sha256').update(orderedLog).digest('hex')).toBe(
      expectedDigest,
    );
    expect(actualClasses).toBe(subjectClasses);
    expect(evidenceField(evidence, 'Review command')).toBe(
      `git log ${previousTag}..${auditedHead}`,
    );
    expect(evidence).toContain('- Review attestation: `complete`');
    expect(previousTag).toBe(`v${previousVersion}`);
    expect(chosenVersion).toBe(expectedVersion(previousVersion, changeLevel));
    expect(chosenVersion).toBe(manifest.version);

    const changelog = read('CHANGELOG.md');
    const unreleasedStart = changelog.indexOf('## [Unreleased]');
    const versionHeader = `## [${chosenVersion}] - ${releaseDate}`;
    const versionStart = changelog.indexOf(versionHeader);
    expect(unreleasedStart).toBeGreaterThanOrEqual(0);
    expect(versionStart).toBeGreaterThan(unreleasedStart);
    const unreleasedSection = changelog.slice(
      unreleasedStart + '## [Unreleased]'.length,
      versionStart,
    );
    auditUnreleasedSection(
      projectRoot,
      chosenVersion,
      auditedHead,
      evidencePath,
      changelog,
      unreleasedSection,
    );

    const nextVersionStart = changelog.indexOf('\n## [', versionStart + 1);
    const versionSection = changelog.slice(
      versionStart,
      nextVersionStart === -1 ? undefined : nextVersionStart,
    );
    const headingMatches = orderedChangelogHeadingMatches(versionSection);

    const changelogGroups = new Map(
      headingMatches.map((match, index) => {
        const start = (match.index ?? 0) + match[0].length;
        const end = headingMatches[index + 1]?.index ?? versionSection.length;
        return [match[1] ?? '', versionSection.slice(start, end)];
      }),
    );
    const reconciliationTable = evidence.slice(
      evidence.indexOf('| Heading | Changelog key'),
      evidence.indexOf('\n\nThe table accounts for'),
    );
    const reconciliationDataRows = reconciliationTable
      .split('\n')
      .filter((line) => /^\| (?!Heading|[- ]+\|)/.test(line));
    const reconciliationRows = [
      ...evidence.matchAll(
        /^\| (Added|Changed|Deprecated|Removed|Fixed|Security)\s+\| `([^`]+)`\s+\| (.+?)\s+\|$/gm,
      ),
    ].map((match) => ({
      heading: match[1] ?? '',
      key: match[2] ?? '',
      evidence: match[3] ?? '',
    }));
    expect(reconciliationRows.length).toBeGreaterThan(0);
    expect(reconciliationRows).toHaveLength(reconciliationDataRows.length);
    expect(new Set(reconciliationRows.map((row) => row.key)).size).toBe(
      reconciliationRows.length,
    );

    const auditedCommits = commits.map(
      (entry) => entry.split('\t', 1)[0] ?? '',
    );
    for (const row of reconciliationRows) {
      const group = changelogGroups.get(row.heading) ?? '';
      expect(group.replaceAll('`', '').split(row.key)).toHaveLength(2);

      const citedCommits = [
        ...row.evidence.matchAll(/`([0-9a-f]{7,40})`/g),
      ].map((match) => match[1] ?? '');
      if (citedCommits.length > 0) {
        for (const cited of citedCommits) {
          expect(
            auditedCommits.some((commit) => commit.startsWith(cited)),
          ).toBe(true);
        }
      }

      const citedSubjectGroups = [
        ...row.evidence.matchAll(
          /all (\d+) ([a-z][a-z0-9-]*) commits in the audited digest/g,
        ),
      ];
      for (const group of citedSubjectGroups) {
        const count = Number(group[1]);
        const subjectClass = group[2] ?? '';
        expect(classes.has(subjectClass)).toBe(true);
        expect(count).toBe(classes.get(subjectClass));
      }

      if (citedCommits.length === 0 && citedSubjectGroups.length === 0) {
        expect(row.evidence).toContain('containing release-preparation commit');
      }
    }

    const reconciliationSection = evidence.slice(
      evidence.indexOf('## Notable-change reconciliation'),
      evidence.indexOf('## Pre-tag checklist'),
    );
    expect(reconciliationSection).toContain(
      'containing release-preparation commit',
    );

    expect(changelog).toContain(
      `[Unreleased]: https://github.com/sublang-ai/cligent/compare/v${chosenVersion}...HEAD`,
    );
    expect(changelog).toContain(
      `[${chosenVersion}]: https://github.com/sublang-ai/cligent/compare/${previousTag}...v${chosenVersion}`,
    );
    const lockfile = JSON.parse(read('package-lock.json')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(lockfile.version).toBe(chosenVersion);
    expect(lockfile.packages['']?.version).toBe(chosenVersion);
    expect(evidence).toMatch(/^- \[x\] All unit tests pass — `npm test`:/m);
    expect(evidence).toMatch(
      /^- \[x\] `npm run smoke:release` passes locally:/m,
    );
    expect(evidence).toMatch(
      /^- \[x\] All release changes through the audited head are committed;/m,
    );
    expect(evidence).toMatch(
      /^- \[ \] Push the release-preparation commit to `main`/m,
    );
    expect(evidence).toMatch(/^- \[ \] Create and push tag `v[^`]+`/m);

    const unitTestJobs = repositoryWorkflowJobs().filter((job) =>
      job.steps.some(
        (step) =>
          typeof step.run === 'string' && step.run.trim() === 'npm test',
      ),
    );
    expect(unitTestJobs.map((job) => job.id)).toEqual([
      '.github/workflows/ci.yml#ci',
      '.github/workflows/release.yml#release',
    ]);
    for (const job of unitTestJobs) {
      const testIndex = job.steps.findIndex(
        (step) =>
          typeof step.run === 'string' && step.run.trim() === 'npm test',
      );
      const checkoutIndexes = job.steps
        .map((step, index) =>
          typeof step.uses === 'string' &&
          step.uses.startsWith('actions/checkout@')
            ? index
            : -1,
        )
        .filter((index) => index >= 0);
      expect(checkoutIndexes).toHaveLength(1);
      const checkoutIndex = checkoutIndexes[0] ?? -1;
      const checkout = job.steps[checkoutIndex];
      expect(checkoutIndex).toBeLessThan(testIndex);
      expect(String(checkout?.with?.['fetch-depth'])).toBe('0');
      expect(String(checkout?.with?.['fetch-tags'])).toBe('true');
    }
  });

  it('fails closed when the recorded Git history is unavailable (release-15)', () => {
    const manifest = JSON.parse(read('package.json')) as { version: string };
    const evidence = read(`docs/releases/${manifest.version}-preparation.md`);
    const previousTag = evidenceField(evidence, 'Previous tag');
    const auditedHead = evidenceField(evidence, 'Audited head');
    const scratch = mkdtempSync(join(tmpdir(), 'cligent-release-audit-'));

    try {
      execFileSync('git', ['init', '--quiet'], { cwd: scratch });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Release Audit',
          '-c',
          'user.email=release-audit@example.invalid',
          'commit',
          '--quiet',
          '--allow-empty',
          '--no-gpg-sign',
          '--no-verify',
          '-m',
          'fixture checkout',
        ],
        { cwd: scratch },
      );
      expect(() => orderedAuditLog(scratch, previousTag, 'HEAD')).toThrow();
      execFileSync('git', ['-c', 'tag.gpgSign=false', 'tag', previousTag], {
        cwd: scratch,
      });
      expect(() =>
        orderedAuditLog(scratch, previousTag, auditedHead),
      ).toThrow();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('permits untagged descendants and binds the tagged preparation boundary (release-15)', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cligent-release-boundary-'));
    const evidencePath = 'release-evidence.md';
    const absoluteEvidencePath = join(scratch, evidencePath);

    try {
      execFileSync('git', ['init', '--quiet'], { cwd: scratch });
      execFileSync('git', ['config', 'user.name', 'Release Audit'], {
        cwd: scratch,
      });
      execFileSync(
        'git',
        ['config', 'user.email', 'release-audit@example.invalid'],
        { cwd: scratch },
      );
      writeFileSync(absoluteEvidencePath, '- Audited head: `pending`\n');
      execFileSync('git', ['add', evidencePath], { cwd: scratch });
      execFileSync(
        'git',
        ['commit', '--quiet', '--no-gpg-sign', '-m', 'audited changes'],
        { cwd: scratch },
      );
      const auditedHead = resolveCommit(scratch, 'HEAD');
      if (auditedHead === undefined) {
        throw new Error('scratch audited head could not be resolved');
      }

      writeFileSync(
        absoluteEvidencePath,
        `- Audited head: \`${auditedHead}\`\n`,
      );
      expect(() =>
        auditPreparationBoundary(scratch, '1.2.3', auditedHead, evidencePath),
      ).not.toThrow();

      execFileSync('git', ['add', evidencePath], { cwd: scratch });
      execFileSync(
        'git',
        ['commit', '--quiet', '--no-gpg-sign', '-m', 'prepare release'],
        { cwd: scratch },
      );
      const preparationCommit = resolveCommit(scratch, 'HEAD');
      if (preparationCommit === undefined) {
        throw new Error('scratch preparation commit could not be resolved');
      }
      expect(() =>
        auditPreparationBoundary(scratch, '1.2.3', auditedHead, evidencePath),
      ).not.toThrow();

      execFileSync(
        'git',
        [
          'commit',
          '--quiet',
          '--allow-empty',
          '--no-gpg-sign',
          '-m',
          'pre-tag follow-up',
        ],
        { cwd: scratch },
      );
      expect(() =>
        auditPreparationBoundary(scratch, '1.2.3', auditedHead, evidencePath),
      ).not.toThrow();

      execFileSync(
        'git',
        ['-c', 'tag.gpgSign=false', 'tag', 'v1.2.3', preparationCommit],
        { cwd: scratch },
      );
      expect(() =>
        auditPreparationBoundary(scratch, '1.2.3', auditedHead, evidencePath),
      ).not.toThrow();

      execFileSync('git', ['-c', 'tag.gpgSign=false', 'tag', 'v1.2.4'], {
        cwd: scratch,
      });
      expect(() =>
        auditPreparationBoundary(scratch, '1.2.4', auditedHead, evidencePath),
      ).toThrow();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('permits an untagged merge but rejects it as the tagged preparation (release-15)', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cligent-release-merge-'));
    const evidencePath = 'release-evidence.md';

    try {
      execFileSync('git', ['init', '--quiet'], { cwd: scratch });
      execFileSync('git', ['config', 'user.name', 'Release Audit'], {
        cwd: scratch,
      });
      execFileSync(
        'git',
        ['config', 'user.email', 'release-audit@example.invalid'],
        { cwd: scratch },
      );
      writeFileSync(join(scratch, evidencePath), '- Audited head: `pending`\n');
      execFileSync('git', ['add', evidencePath], { cwd: scratch });
      execFileSync(
        'git',
        ['commit', '--quiet', '--no-gpg-sign', '-m', 'audited changes'],
        { cwd: scratch },
      );
      const auditedHead = resolveCommit(scratch, 'HEAD');
      if (auditedHead === undefined) {
        throw new Error('scratch audited head could not be resolved');
      }

      execFileSync('git', ['checkout', '--quiet', '-b', 'unaudited'], {
        cwd: scratch,
      });
      writeFileSync(join(scratch, 'unaudited.txt'), 'unaudited history\n');
      execFileSync('git', ['add', 'unaudited.txt'], { cwd: scratch });
      execFileSync(
        'git',
        ['commit', '--quiet', '--no-gpg-sign', '-m', 'unaudited changes'],
        { cwd: scratch },
      );
      execFileSync('git', ['checkout', '--quiet', '--detach', auditedHead], {
        cwd: scratch,
      });
      execFileSync('git', ['merge', '--no-ff', '--no-commit', 'unaudited'], {
        cwd: scratch,
      });
      writeFileSync(
        join(scratch, evidencePath),
        `- Audited head: \`${auditedHead}\`\n`,
      );
      execFileSync('git', ['add', evidencePath], { cwd: scratch });
      execFileSync(
        'git',
        ['commit', '--quiet', '--no-gpg-sign', '-m', 'merge preparation'],
        { cwd: scratch },
      );
      const mergePreparation = resolveCommit(scratch, 'HEAD');
      if (mergePreparation === undefined) {
        throw new Error('scratch merge preparation could not be resolved');
      }
      expect(resolveCommit(scratch, `${mergePreparation}^2`)).toBeDefined();
      expect(() =>
        auditPreparationBoundary(scratch, '1.2.5', auditedHead, evidencePath),
      ).not.toThrow();

      execFileSync(
        'git',
        ['-c', 'tag.gpgSign=false', 'tag', 'v1.2.5', mergePreparation],
        { cwd: scratch },
      );
      expect(() =>
        auditPreparationBoundary(scratch, '1.2.5', auditedHead, evidencePath),
      ).toThrow();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('scopes Unreleased emptiness to the prepared release lifecycle (release-15)', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cligent-release-state-'));
    const changelogPath = join(scratch, 'CHANGELOG.md');
    const evidencePath = 'release-evidence.md';
    const absoluteEvidencePath = join(scratch, evidencePath);
    const emptyChangelog = '## [Unreleased]\n\n## [1.2.0] - 2026-08-31\n';
    const laterChangelog = [
      '## [Unreleased]',
      '',
      '### Added',
      '',
      '- A later feature.',
      '',
      '### Fixed',
      '',
      '- A later fix.',
      '',
      '## [1.2.0] - 2026-08-31',
      '',
    ].join('\n');
    const nonemptyTaggedChangelog = laterChangelog.replace(
      '## [1.2.0]',
      '## [1.3.0]',
    );
    const malformedTaggedChangelog = '## [1.4.0] - 2026-08-31\n';
    const laterSection = laterChangelog.slice(
      laterChangelog.indexOf('## [Unreleased]') + '## [Unreleased]'.length,
      laterChangelog.indexOf('## [1.2.0]'),
    );

    try {
      execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
        cwd: scratch,
      });
      execFileSync('git', ['config', 'user.name', 'Release Audit'], {
        cwd: scratch,
      });
      execFileSync(
        'git',
        ['config', 'user.email', 'release-audit@example.invalid'],
        { cwd: scratch },
      );
      writeFileSync(changelogPath, emptyChangelog);
      writeFileSync(absoluteEvidencePath, '- Audited head: `pending`\n');
      execFileSync('git', ['add', 'CHANGELOG.md', evidencePath], {
        cwd: scratch,
      });
      execFileSync(
        'git',
        ['commit', '--quiet', '--no-gpg-sign', '-m', 'audited changes'],
        { cwd: scratch },
      );
      const auditedHead = resolveCommit(scratch, 'HEAD');
      if (auditedHead === undefined) {
        throw new Error('scratch audited head could not be resolved');
      }

      execFileSync('git', ['switch', '--quiet', '-c', 'bad-preparation'], {
        cwd: scratch,
      });
      writeFileSync(
        absoluteEvidencePath,
        `- Audited head: \`${auditedHead}\`\n`,
      );
      writeFileSync(changelogPath, laterChangelog);
      execFileSync('git', ['add', 'CHANGELOG.md', evidencePath], {
        cwd: scratch,
      });
      execFileSync(
        'git',
        ['commit', '--quiet', '--no-gpg-sign', '-m', 'bad preparation'],
        { cwd: scratch },
      );
      expect(() =>
        auditUnreleasedSection(
          scratch,
          '1.2.0',
          auditedHead,
          evidencePath,
          laterChangelog,
          laterSection,
        ),
      ).toThrow(/empty prepared Unreleased section/);

      execFileSync('git', ['switch', '--quiet', 'main'], { cwd: scratch });
      writeFileSync(
        absoluteEvidencePath,
        `- Audited head: \`${auditedHead}\`\n`,
      );

      expect(() =>
        auditUnreleasedSection(
          scratch,
          '1.2.0',
          auditedHead,
          evidencePath,
          emptyChangelog,
          '',
        ),
      ).not.toThrow();
      writeFileSync(changelogPath, laterChangelog);
      expect(() =>
        auditUnreleasedSection(
          scratch,
          '1.2.0',
          auditedHead,
          evidencePath,
          laterChangelog,
          laterSection,
        ),
      ).toThrow();

      writeFileSync(changelogPath, emptyChangelog);
      execFileSync('git', ['add', 'CHANGELOG.md', evidencePath], {
        cwd: scratch,
      });
      execFileSync(
        'git',
        ['commit', '--quiet', '--no-gpg-sign', '-m', 'prepare release'],
        { cwd: scratch },
      );
      const preparedCommit = resolveCommit(scratch, 'HEAD');
      if (preparedCommit === undefined) {
        throw new Error('scratch preparation commit could not be resolved');
      }
      expect(() =>
        auditUnreleasedSection(
          scratch,
          '1.2.0',
          auditedHead,
          evidencePath,
          emptyChangelog,
          '',
        ),
      ).not.toThrow();

      writeFileSync(changelogPath, laterChangelog);
      expect(() =>
        auditUnreleasedSection(
          scratch,
          '1.2.0',
          auditedHead,
          evidencePath,
          laterChangelog,
          laterSection,
        ),
      ).not.toThrow();
      writeFileSync(changelogPath, emptyChangelog);

      execFileSync('git', ['switch', '--quiet', '-c', 'topic'], {
        cwd: scratch,
      });
      writeFileSync(join(scratch, 'topic.txt'), 'topic work\n');
      execFileSync('git', ['add', 'topic.txt'], { cwd: scratch });
      execFileSync(
        'git',
        ['commit', '--quiet', '--no-gpg-sign', '-m', 'topic work'],
        { cwd: scratch },
      );
      execFileSync('git', ['switch', '--quiet', 'main'], { cwd: scratch });
      writeFileSync(changelogPath, laterChangelog);
      execFileSync('git', ['add', 'CHANGELOG.md'], { cwd: scratch });
      execFileSync(
        'git',
        ['commit', '--quiet', '--no-gpg-sign', '-m', 'add later notes'],
        { cwd: scratch },
      );
      expect(() =>
        auditUnreleasedSection(
          scratch,
          '1.2.0',
          auditedHead,
          evidencePath,
          laterChangelog,
          laterSection,
        ),
      ).not.toThrow();
      execFileSync(
        'git',
        ['merge', '--quiet', '--no-ff', '--no-gpg-sign', '--no-edit', 'topic'],
        { cwd: scratch },
      );
      expect(resolveCommit(scratch, 'HEAD^2')).toBeDefined();
      expect(() =>
        auditUnreleasedSection(
          scratch,
          '1.2.0',
          auditedHead,
          evidencePath,
          laterChangelog,
          laterSection,
        ),
      ).not.toThrow();

      expect(() =>
        auditUnreleasedSection(
          scratch,
          '1.2.0',
          auditedHead,
          evidencePath,
          laterChangelog,
          '### Fixed\n\n- Fixed first.\n\n### Added\n\n- Added second.\n',
        ),
      ).toThrow();

      execFileSync(
        'git',
        ['-c', 'tag.gpgSign=false', 'tag', 'v1.2.0', preparedCommit],
        { cwd: scratch },
      );
      expect(() =>
        auditUnreleasedSection(
          scratch,
          '1.2.0',
          auditedHead,
          evidencePath,
          laterChangelog,
          laterSection,
        ),
      ).not.toThrow();

      execFileSync('git', ['switch', '--quiet', '--detach', preparedCommit], {
        cwd: scratch,
      });
      execFileSync(
        'git',
        [
          'commit',
          '--quiet',
          '--allow-empty',
          '--no-gpg-sign',
          '-m',
          'unrelated release',
        ],
        { cwd: scratch },
      );
      execFileSync('git', ['-c', 'tag.gpgSign=false', 'tag', 'v9.9.9'], {
        cwd: scratch,
      });
      execFileSync('git', ['switch', '--quiet', 'main'], { cwd: scratch });
      expect(() =>
        auditUnreleasedSection(
          scratch,
          '9.9.9',
          auditedHead,
          evidencePath,
          laterChangelog,
          laterSection,
        ),
      ).toThrow();

      writeFileSync(changelogPath, nonemptyTaggedChangelog);
      execFileSync('git', ['add', 'CHANGELOG.md'], { cwd: scratch });
      execFileSync(
        'git',
        ['commit', '--quiet', '--no-gpg-sign', '-m', 'tag malformed notes'],
        { cwd: scratch },
      );
      execFileSync('git', ['-c', 'tag.gpgSign=false', 'tag', 'v1.3.0'], {
        cwd: scratch,
      });
      expect(() =>
        auditUnreleasedSection(
          scratch,
          '1.3.0',
          auditedHead,
          evidencePath,
          nonemptyTaggedChangelog,
          laterSection,
        ),
      ).toThrow(/empty prepared Unreleased section/);

      writeFileSync(changelogPath, malformedTaggedChangelog);
      execFileSync('git', ['add', 'CHANGELOG.md'], { cwd: scratch });
      execFileSync(
        'git',
        ['commit', '--quiet', '--no-gpg-sign', '-m', 'tag malformed structure'],
        { cwd: scratch },
      );
      execFileSync('git', ['-c', 'tag.gpgSign=false', 'tag', 'v1.4.0'], {
        cwd: scratch,
      });
      expect(() =>
        auditUnreleasedSection(
          scratch,
          '1.4.0',
          auditedHead,
          evidencePath,
          malformedTaggedChangelog,
          '',
        ),
      ).toThrow(/auditable prepared changelog/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('audits every tag-workflow publication gate (release-11)', () => {
    const workflow = read('.github/workflows/release.yml');
    const tagVersion = workflow.indexOf(
      '- name: Verify tag matches package.json version',
    );
    const ciRequirement = workflow.indexOf(
      '- name: Require passing CI for this commit',
    );
    const build = workflow.indexOf('- run: npm run build');
    const packageCheck = workflow.indexOf('- run: npm run test:package');
    const unitTest = workflow.indexOf('- run: npm test');
    const notes = workflow.indexOf(
      '- name: Extract release notes from CHANGELOG.md',
    );
    const publish = workflow.indexOf(
      '- run: npm publish --provenance --access public',
    );
    const githubRelease = workflow.indexOf('- name: Create GitHub Release');

    expect(workflow).toContain("tags: ['v[0-9]*']");
    expect(workflow).toContain(
      'if ! [[ "$TAG" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]',
    );
    expect(workflow).toContain(
      'Tag $TAG does not match package.json version $PKG_VERSION',
    );
    expect(tagVersion).toBeGreaterThanOrEqual(0);
    expect(ciRequirement).toBeGreaterThan(tagVersion);
    expect(workflow).toContain('event=push&branch=main');
    expect(workflow).toContain('conclusion" = "success"');
    expect(build).toBeGreaterThan(ciRequirement);
    expect(packageCheck).toBeGreaterThan(build);
    expect(unitTest).toBeGreaterThan(packageCheck);
    expect(notes).toBeGreaterThan(unitTest);
    expect(workflow).toContain('No release notes found for version $VERSION');
    expect(publish).toBeGreaterThan(notes);
    expect(githubRelease).toBeGreaterThan(publish);
    expect(workflow).toMatch(/^\s+id-token: write$/m);
    expect(workflow).not.toMatch(/\b(?:NODE_AUTH_TOKEN|NPM_TOKEN)\b/);
    expect(workflow).toContain(
      'gh release create "$GITHUB_REF_NAME" --title "$GITHUB_REF_NAME" --notes-file /tmp/release-notes.md',
    );
  });

  it('keeps one ordered local release-smoke entry point (release-12)', () => {
    const manifest = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts['smoke:release']).toBe(
      'npm run build && npm run test:package && npm run test:distributable && npm run test:smoke',
    );
  });
});

interface CiJob {
  if?: string;
  'runs-on'?: string;
  strategy?: { matrix?: Record<string, unknown> };
}

interface CiWorkflow {
  on: {
    push?: { branches?: string[] };
    pull_request?: { branches?: string[] };
    schedule?: Array<{ cron?: string }>;
  };
  concurrency?: { group?: string; 'cancel-in-progress'?: string };
  jobs: Record<string, CiJob>;
}

type CiEvent = 'pull_request' | 'push' | 'schedule';

/** The jobs a pull request's run holds (release-19), its required checks (release-16). */
const requiredChecks = [
  'ci (20)',
  'ci (22)',
  'ci (24)',
  'ci (25)',
  'distributable',
  'browser (ubuntu-latest)',
  'browser (macos-latest)',
  'browser (windows-latest)',
];

function ciWorkflow(): CiWorkflow {
  return parse(read('.github/workflows/ci.yml')) as CiWorkflow;
}

function jobRunsFor(job: CiJob, event: CiEvent): boolean {
  if (job.if === undefined) return true;
  if (job.if === "github.event_name != 'pull_request'") {
    return event !== 'pull_request';
  }
  throw new Error(`the merge-gate audit does not know the job rule ${job.if}`);
}

/** The check runs an event starts: each job's matrix legs, named as GitHub names them. */
function ciChecks(
  workflow: CiWorkflow,
  event: CiEvent,
): Array<{ name: string; runner: string }> {
  return Object.entries(workflow.jobs).flatMap(([id, job]) => {
    if (!jobRunsFor(job, event)) return [];
    const matrix = job.strategy?.matrix ?? {};
    if ('include' in matrix || 'exclude' in matrix) {
      throw new Error(`the merge-gate audit does not expand ${id}'s matrix`);
    }
    let legs: Array<Record<string, string>> = [{}];
    for (const [key, values] of Object.entries(matrix)) {
      legs = legs.flatMap((leg) =>
        (values as unknown[]).map((value) => ({
          ...leg,
          [key]: String(value),
        })),
      );
    }
    return legs.map((leg) => {
      const values = Object.values(leg);
      const runner = (job['runs-on'] ?? '').replace(
        /^\$\{\{ matrix\.([\w-]+) \}\}$/,
        (_, key: string) => leg[key] ?? '',
      );
      return {
        name: values.length === 0 ? id : `${id} (${values.join(', ')})`,
        runner,
      };
    });
  });
}

describe('merge gate', () => {
  it('runs one run per pull-request head, never cancelling main (release-22)', () => {
    const workflow = ciWorkflow();
    expect(workflow.on.push?.branches).toEqual(['main']);
    expect(workflow.on.pull_request?.branches).toEqual(['main']);
    expect(workflow.concurrency?.group).toBe(
      'ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}',
    );
    expect(workflow.concurrency?.['cancel-in-progress']).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
  });

  it('narrows a pull request to one macOS job and runs all on main and nightly (release-22)', () => {
    const workflow = ciWorkflow();
    expect(workflow.on.schedule).toHaveLength(1);
    expect(workflow.on.schedule?.[0]?.cron).toMatch(/^\S+ \S+ \* \* \*$/);

    const pullRequest = ciChecks(workflow, 'pull_request');
    expect(pullRequest.map((check) => check.name).sort()).toEqual(
      [...requiredChecks].sort(),
    );
    expect(
      pullRequest
        .filter((check) => check.runner.startsWith('macos-'))
        .map((check) => check.name),
    ).toEqual(['browser (macos-latest)']);
    for (const runner of ['ubuntu-latest', 'windows-latest']) {
      expect(pullRequest.map((check) => check.runner)).toContain(runner);
    }

    const full = [...requiredChecks, 'acceptance'].sort();
    for (const event of ['push', 'schedule'] as const) {
      expect(
        ciChecks(workflow, event)
          .map((check) => check.name)
          .sort(),
      ).toEqual(full);
    }
  });

  it('refuses a tree holding a conflict marker before the lints (release-22)', () => {
    const manifest = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts['prepush']).toBe('bash scripts/prepush.sh');

    const scratch = mkdtempSync(join(tmpdir(), 'cligent-prepush-'));
    try {
      execFileSync('git', ['init', '-q', scratch]);
      mkdirSync(join(scratch, 'scripts'));
      writeFileSync(
        join(scratch, 'scripts/prepush.sh'),
        read('scripts/prepush.sh'),
      );
      writeFileSync(
        join(scratch, 'left.ts'),
        'const a = 1;\n<<<<<<< HEAD\nconst b = 2;\n=======\nconst b = 3;\n>>>>>>> origin/main\n',
      );
      execFileSync('git', ['add', '-A'], { cwd: scratch });
      const run = spawnSync('bash', [join(scratch, 'scripts/prepush.sh')], {
        encoding: 'utf8',
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(
        'prepush: conflict markers left in the tree',
      );
      expect(run.stderr).toContain('left.ts:2:<<<<<<< HEAD');
      expect(run.stderr).toContain('left.ts:4:=======');
      expect(run.stderr).toContain('left.ts:6:>>>>>>> origin/main');
      expect(run.stdout).toBe('');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
