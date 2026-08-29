// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

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
    expect(
      changelog
        .slice(unreleasedStart + '## [Unreleased]'.length, versionStart)
        .trim(),
    ).toBe('');

    const nextVersionStart = changelog.indexOf('\n## [', versionStart + 1);
    const versionSection = changelog.slice(
      versionStart,
      nextVersionStart === -1 ? undefined : nextVersionStart,
    );
    const allowedHeadings = [
      'Added',
      'Changed',
      'Deprecated',
      'Removed',
      'Fixed',
      'Security',
    ];
    const headingMatches = [...versionSection.matchAll(/^### (.+)$/gm)];
    const headings = headingMatches.map((match) => match[1] ?? '');
    expect(headings).toEqual(
      [...headings].sort(
        (left, right) =>
          allowedHeadings.indexOf(left) - allowedHeadings.indexOf(right),
      ),
    );
    expect(headings.every((heading) => allowedHeadings.includes(heading))).toBe(
      true,
    );

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
      } else if (row.evidence.includes('documentation commits')) {
        expect(row.evidence).toContain(
          `all ${String(classes.get('docs') ?? 0)} documentation commits in the audited digest`,
        );
      } else {
        expect(row.evidence).toContain('containing release-preparation commit');
      }
    }

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
      /^- \[x\] The release changes and this evidence are prepared for one release-preparation commit;/m,
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

  it('audits every tag-workflow publication gate (release-11)', () => {
    const workflow = read('.github/workflows/release.yml');
    const build = workflow.indexOf('- run: npm run build');
    const packageCheck = workflow.indexOf('- run: npm run test:package');
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
    expect(workflow).toContain('event=push&branch=main');
    expect(workflow).toContain('conclusion" = "success"');
    expect(build).toBeGreaterThanOrEqual(0);
    expect(packageCheck).toBeGreaterThan(build);
    expect(notes).toBeGreaterThan(packageCheck);
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
