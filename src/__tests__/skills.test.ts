// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// skills-7 and skills-8: filesystem integration checks of the shared skill
// preparation, snapshot, and removal, and of skill discovery through the
// package entry point. Each adapter's carrier, its outcome selection on a
// removal failure, and the deferral of a held Kimi root to the last holding
// run are verified with that adapter.

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SKILL_CARRIER_CLEANUP_FAILED,
  SKILL_SUPPORT,
  getSkillSupport,
} from '../index.js';
import type { SkillSupport } from '../index.js';
import {
  carrierName,
  carrierSuffix,
  formatRemovalFailures,
  materializeSkills,
  prepareSkills,
  removeCarrierPaths,
} from '../skills.js';

// The real filesystem calls run unchanged; wrapping them lets a test observe
// each rename and simulate a host that cannot create symbolic links.
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    rename: vi.fn(original.rename),
    symlink: vi.fn(original.symlink),
  };
});

const actual =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const linksUnsupported = process.platform === 'win32';
const permissionsUnenforced =
  process.platform === 'win32' || process.getuid?.() === 0;

let base: string;
let library: string;

beforeEach(async () => {
  // Fixtures live under the resolved temporary directory so a skill's
  // lexical path and its resolved path agree.
  base = await realpath(await mkdtemp(join(tmpdir(), 'cligent-skills-')));
  library = join(base, 'library');
  await mkdir(library);
});

afterEach(async () => {
  vi.mocked(rename).mockReset();
  vi.mocked(rename).mockImplementation(actual.rename);
  vi.mocked(symlink).mockReset();
  vi.mocked(symlink).mockImplementation(actual.symlink);
  await rm(base, { recursive: true, force: true });
});

function skillText(name: string, description = `Use ${name} in tests.`) {
  return [
    '---',
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n');
}

async function makeSkill(
  name: string,
  options: { parent?: string; directoryName?: string; text?: string } = {},
): Promise<string> {
  const directory = join(
    options.parent ?? library,
    options.directoryName ?? name,
  );
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), options.text ?? skillText(name));
  return directory;
}

async function expectRejection(
  promise: Promise<unknown>,
  ...fragments: string[]
): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  for (const fragment of fragments) {
    expect((error as Error).message).toContain(fragment);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

/** Every entry below `root`, with links as their raw targets and files with their modes. */
async function listTree(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const listing: string[] = [];
  for (const entry of entries) {
    const path = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isSymbolicLink()) {
      listing.push(`${path} -> ${await readlink(join(root, path))}`);
    } else if (entry.isDirectory()) {
      listing.push(`${path}/`, ...(await listTree(root, path)));
    } else {
      listing.push(`${path} ${(await mode(join(root, path))).toString(8)}`);
    }
  }
  return listing;
}

const GUIDE = '# Guide\n\nRead me.\n';
const SCRIPT = '#!/bin/sh\necho alpha\n';

/** A skill with nested files of distinct modes and, where the host allows, links. */
async function richSkill(name = 'alpha'): Promise<string> {
  const directory = await makeSkill(name);
  await mkdir(join(directory, 'scripts'));
  await mkdir(join(directory, 'references'));
  await mkdir(join(directory, 'assets', 'data'), { recursive: true });
  await writeFile(join(directory, 'scripts', 'run.sh'), SCRIPT);
  await chmod(join(directory, 'scripts', 'run.sh'), 0o755);
  await writeFile(join(directory, 'references', 'guide.md'), GUIDE);
  await chmod(join(directory, 'references', 'guide.md'), 0o640);
  await writeFile(join(directory, 'assets', 'data', 'table.csv'), 'a,b\n');
  await chmod(join(directory, 'assets', 'data', 'table.csv'), 0o600);
  if (!linksUnsupported) {
    await symlink(join('scripts', 'run.sh'), join(directory, 'latest'));
    await symlink('references', join(directory, 'docs'));
    await symlink(
      join(directory, 'references', 'guide.md'),
      join(directory, 'pinned'),
    );
  }
  return directory;
}

interface ObservedRename {
  from: string;
  to: string;
  rootEntries: string[];
  sourceComplete: boolean;
}

/** Record each rename with the root's entries and the source's SKILL.md at that moment. */
function observeRenames(root: string): ObservedRename[] {
  const observed: ObservedRename[] = [];
  vi.mocked(rename).mockImplementation(async (from, to) => {
    const sourceComplete = (
      await stat(join(String(from), 'SKILL.md'))
    ).isFile();
    observed.push({
      from: String(from),
      to: String(to),
      rootEntries: (await readdir(root)).sort(),
      sourceComplete,
    });
    return actual.rename(from, to);
  });
  return observed;
}

// ---------------------------------------------------------------------------
// skills-1 and skills-2: preparation
// ---------------------------------------------------------------------------

describe('skill preparation', () => {
  it('selects no skills for an absent or empty list', async () => {
    expect(await prepareSkills('codex', undefined)).toEqual([]);
    expect(await prepareSkills('codex', [], library)).toEqual([]);
  });

  it.each([null, 'alpha', 7, { 0: 'alpha', length: 1 }])(
    'rejects the non-array %j with the adapter and skills path',
    async (value) => {
      await expectRejection(
        prepareSkills('kimi', value, library),
        'skills for adapter "kimi" must be an array',
      );
    },
  );

  it('rejects an entry that is not a non-blank NUL-free string at its index', async () => {
    await makeSkill('alpha');
    const holey: unknown[] = ['alpha'];
    holey.length = 2;
    const lists: unknown[][] = [
      ['alpha', 3],
      ['alpha', ''],
      ['alpha', ' \t '],
      ['alpha', 'alpha\0'],
      ['alpha', null],
      ['alpha', ['alpha']],
      ['alpha', { path: 'alpha' }],
      holey,
    ];
    for (const list of lists) {
      await expectRejection(
        prepareSkills('gemini', list, library),
        'skills[1] for adapter "gemini" must be a non-blank skill directory path',
      );
    }
  });

  it('resolves relative entries against the run cwd, otherwise the process cwd, and reads a SKILL.md path as its directory', async () => {
    const alpha = await makeSkill('alpha');
    const beta = await makeSkill('beta');
    const gamma = await makeSkill('gamma', { parent: join(base, 'elsewhere') });
    const input = Object.freeze([
      join(gamma, 'SKILL.md'),
      'alpha',
      'beta/SKILL.md',
    ]);
    const snapshot = [...input];

    expect(await prepareSkills('claude-code', input, library)).toEqual([
      {
        name: 'gamma',
        directory: gamma,
        description: 'Use gamma in tests.',
        path: join(gamma, 'SKILL.md'),
      },
      {
        name: 'alpha',
        directory: alpha,
        description: 'Use alpha in tests.',
        path: 'alpha',
      },
      {
        name: 'beta',
        directory: beta,
        description: 'Use beta in tests.',
        path: 'beta/SKILL.md',
      },
    ]);
    expect(input).toEqual(snapshot);

    const fromProcessCwd = relative(process.cwd(), alpha);
    expect(await prepareSkills('codex', [fromProcessCwd])).toEqual([
      expect.objectContaining({
        name: 'alpha',
        directory: alpha,
        path: fromProcessCwd,
      }),
    ]);

    for (const entry of ['alpha/', './alpha/.', 'beta/../alpha']) {
      expect(await prepareSkills('opencode', [entry], library)).toEqual([
        expect.objectContaining({
          name: 'alpha',
          directory: alpha,
          path: entry,
        }),
      ]);
    }
  });

  it('keeps the frontmatter description as written', async () => {
    await makeSkill('alpha', {
      text: '---\nname: alpha\ndescription: |\n  First line.\n  Second line.\n---\n',
    });
    const [skill] = await prepareSkills('kimi', ['alpha'], library);
    expect(skill?.description).toBe('First line.\nSecond line.\n');
  });

  it.skipIf(linksUnsupported)(
    'follows a linked skill path while naming it by the lexical path before link resolution',
    async () => {
      const alpha = await makeSkill('alpha');
      const links = join(base, 'links');
      await mkdir(links);
      await symlink(alpha, join(links, 'alpha'));
      await symlink(alpha, join(links, 'renamed'));

      expect(await prepareSkills('kimi', ['alpha/SKILL.md'], links)).toEqual([
        {
          name: 'alpha',
          directory: join(links, 'alpha'),
          description: 'Use alpha in tests.',
          path: 'alpha/SKILL.md',
        },
      ]);
      await expectRejection(
        prepareSkills('kimi', ['renamed'], links),
        'skills[0] for adapter "kimi"',
        'has a name "alpha" differing from its directory name "renamed"',
      );
    },
  );

  it('rejects a path naming neither a skill directory nor its SKILL.md', async () => {
    await makeSkill('alpha');
    await writeFile(join(library, 'README.md'), '# Not a skill\n');
    await writeFile(join(library, 'alpha', 'notes.md'), '# Notes\n');
    const entries = ['absent', 'README.md', join('alpha', 'notes.md')];
    if (!linksUnsupported) {
      await symlink(join(library, 'absent'), join(library, 'broken'));
      entries.push('broken');
    }
    for (const entry of entries) {
      await expectRejection(
        prepareSkills('opencode', ['alpha', entry], library),
        'skills[1] for adapter "opencode" must name a skill directory or its SKILL.md',
        join(library, entry),
      );
    }
  });

  it('rejects a directory without a regular SKILL.md', async () => {
    await mkdir(join(library, 'empty'));
    await mkdir(join(library, 'folder', 'SKILL.md'), { recursive: true });
    for (const entry of ['empty', 'folder']) {
      await expectRejection(
        prepareSkills('claude-code', [entry], library),
        'skills[0] for adapter "claude-code" must hold a regular SKILL.md',
        join(library, entry),
      );
    }
  });

  it.each([
    ['without an opening block', 'name: alpha\ndescription: d\n'],
    ['after a leading blank line', '\n---\nname: alpha\ndescription: d\n---\n'],
    ['without a closing delimiter', '---\nname: alpha\ndescription: d\n'],
    ['that is not YAML', '---\nname: [alpha\ndescription: d\n---\n'],
    ['that is not a mapping', '---\n- alpha\n- d\n---\n'],
    ['without a name', '---\ndescription: d\n---\n'],
    ['without a description', '---\nname: alpha\n---\n'],
    ['with a non-string name', '---\nname: 7\ndescription: d\n---\n'],
    [
      'with a non-string description',
      '---\nname: alpha\ndescription: [a, b]\n---\n',
    ],
  ])('rejects frontmatter %s', async (_label, text) => {
    const alpha = await makeSkill('alpha', { text });
    await expectRejection(
      prepareSkills('codex', ['alpha'], library),
      'skills[0] for adapter "codex" must open with a --- YAML frontmatter block mapping name and description to strings',
      join(alpha, 'SKILL.md'),
    );
  });

  it.each([
    'Alpha',
    'al_pha',
    '-alpha',
    'alpha-',
    'al--pha',
    'alpha.v2',
    'café',
    'a'.repeat(65),
  ])(
    'rejects the name %s outside the ASCII grammar or its length',
    async (name) => {
      await makeSkill(name);
      await expectRejection(
        prepareSkills('gemini', [name], library),
        `skills[0] for adapter "gemini" has a name "${name}" outside /^[a-z0-9]+(-[a-z0-9]+)*$/ or longer than 64 characters`,
      );
    },
  );

  it('rejects a name differing from its directory name, naming both', async () => {
    await makeSkill('beta', { directoryName: 'alpha' });
    await expectRejection(
      prepareSkills('codex', ['alpha'], library),
      'skills[0] for adapter "codex" has a name "beta" differing from its directory name "alpha"',
    );
  });

  it.each([
    ['empty', ''],
    ['over 1024 characters', 'd'.repeat(1025)],
  ])('rejects a description that is %s', async (_label, description) => {
    await makeSkill('alpha', { text: skillText('alpha', description) });
    await expectRejection(
      prepareSkills('kimi', ['alpha'], library),
      'skills[0] for adapter "kimi" has a description that is empty or longer than 1024 characters',
    );
  });

  it('accepts a 64-character name and a 1024-character description', async () => {
    const name = `${'a'.repeat(31)}-${'b'.repeat(32)}`;
    expect(name).toHaveLength(64);
    const description = 'd'.repeat(1024);
    await makeSkill(name, { text: skillText(name, description) });
    expect(await prepareSkills('opencode', [name], library)).toEqual([
      expect.objectContaining({ name, description }),
    ]);
  });

  it('rejects another SKILL.md below the skill, naming the nested file', async () => {
    const alpha = await makeSkill('alpha');
    const nested = await makeSkill('deep', {
      parent: join(alpha, 'references'),
    });
    await expectRejection(
      prepareSkills('claude-code', ['alpha'], library),
      `skills[0] for adapter "claude-code" holds another SKILL.md below the skill: ${join(nested, 'SKILL.md')}`,
    );
  });

  it.skipIf(linksUnsupported)(
    'follows a directory link to a nested SKILL.md',
    async () => {
      const alpha = await makeSkill('alpha');
      await makeSkill('nested', { parent: join(alpha, 'zz') });
      await symlink(join('zz', 'nested'), join(alpha, 'aa-link'));
      const error = await prepareSkills('gemini', ['alpha'], library).then(
        () => undefined,
        (reason: unknown) => reason as Error,
      );
      expect(error?.message).toContain(
        'skills[0] for adapter "gemini" holds another SKILL.md below the skill: ',
      );
      expect([
        join(alpha, 'aa-link', 'SKILL.md'),
        join(alpha, 'zz', 'nested', 'SKILL.md'),
      ]).toContain(error?.message.split('below the skill: ')[1]);
    },
  );

  it('accepts an owned carrier root below the skill and leaves it out of the copy', async () => {
    const alpha = await makeSkill('alpha');
    const carrierRoot = join(
      alpha,
      '.kimi-code',
      'skills',
      carrierName(carrierSuffix()),
    );
    await makeSkill('held', { parent: carrierRoot });
    await writeFile(join(alpha, 'notes.md'), '# Notes\n');

    const prepared = await prepareSkills('kimi', ['alpha'], library);
    expect(prepared).toEqual([expect.objectContaining({ name: 'alpha' })]);

    const root = join(base, 'carrier');
    await materializeSkills(prepared, { root, staging: join(base, 'staging') });
    const copy = join(root, 'alpha');
    expect(await listTree(copy)).toEqual([
      '.kimi-code/',
      join('.kimi-code', 'skills') + '/',
      `notes.md ${(await mode(join(alpha, 'notes.md'))).toString(8)}`,
      `SKILL.md ${(await mode(join(alpha, 'SKILL.md'))).toString(8)}`,
    ]);
    expect(await exists(join(copy, relative(alpha, carrierRoot)))).toBe(false);

    // Only an owned carrier root is exempt: an ordinary directory in the same
    // place, or a carrier-named one elsewhere, still holds a nested skill.
    const stray = await makeSkill('stray', {
      parent: join(alpha, '.kimi-code', 'skills'),
    });
    await expectRejection(
      prepareSkills('kimi', ['alpha'], library),
      `holds another SKILL.md below the skill: ${join(stray, 'SKILL.md')}`,
    );
    const beta = await makeSkill('beta');
    const misplaced = await makeSkill('held', {
      parent: join(beta, 'assets', carrierName(carrierSuffix())),
    });
    await expectRejection(
      prepareSkills('kimi', ['beta'], library),
      `holds another SKILL.md below the skill: ${join(misplaced, 'SKILL.md')}`,
    );
  });

  it.skipIf(linksUnsupported)(
    'rejects a link whose target lies outside the skill, naming the link',
    async () => {
      const outside = join(base, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'secret.md'), 'secret');
      const alpha = await makeSkill('alpha');
      await symlink(outside, join(alpha, 'shared'));
      const beta = await makeSkill('beta');
      await mkdir(join(beta, 'references'));
      await symlink(
        join('..', '..', '..', 'outside', 'secret.md'),
        join(beta, 'references', 'secret.md'),
      );
      const gamma = await makeSkill('gamma');
      await symlink(join('..', 'alpha'), join(gamma, 'sibling'));

      for (const [name, link] of [
        ['alpha', join(alpha, 'shared')],
        ['beta', join(beta, 'references', 'secret.md')],
        ['gamma', join(gamma, 'sibling')],
      ] as const) {
        await expectRejection(
          prepareSkills('codex', [name], library),
          `skills[0] for adapter "codex" holds a link whose target does not resolve or lies outside the skill: ${link}`,
        );
      }
    },
  );

  it('rejects a later entry repeating an earlier name', async () => {
    await makeSkill('alpha');
    await makeSkill('beta');
    const other = await makeSkill('alpha', { parent: join(base, 'other') });
    await expectRejection(
      prepareSkills('kimi', ['alpha', other], library),
      'skills[1] for adapter "kimi" repeats the name "alpha" of skills[0]',
    );
    await expectRejection(
      prepareSkills('kimi', ['beta', 'alpha', 'alpha/SKILL.md'], library),
      'skills[2] for adapter "kimi" repeats the name "alpha" of skills[1]',
    );
  });

  // Skill preparation cancels like attachment preparation (DR-036 amendments
  // of claude-code-73 and codex-69).
  it('honors a fired signal before reading any skill', async () => {
    await makeSkill('alpha');
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareSkills('codex', ['alpha'], library, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// ---------------------------------------------------------------------------
// skills-3: run-scoped snapshot
// ---------------------------------------------------------------------------

describe('skill snapshot', () => {
  it('writes each entry under a temporary name outside the root, renames it into place, and leaves no other entry', async () => {
    const alpha = await richSkill('alpha');
    const beta = await makeSkill('beta');
    const prepared = await prepareSkills('codex', [alpha, beta]);
    const root = join(base, 'carrier', 'skills');
    const staging = join(base, 'staging');
    const observed = observeRenames(root);

    const created = await materializeSkills(prepared, { root, staging });

    expect(created).toEqual([join(root, 'alpha'), join(root, 'beta')]);
    expect(observed.map(({ to }) => to)).toEqual(created);
    expect(observed.map(({ rootEntries }) => rootEntries)).toEqual([
      [],
      ['alpha'],
    ]);
    for (const [index, name] of ['alpha', 'beta'].entries()) {
      const { from, sourceComplete } = observed[index]!;
      expect(dirname(from)).toBe(staging);
      expect(basename(from)).toMatch(new RegExp(`^${name}-[0-9a-f]{20}$`));
      expect(sourceComplete).toBe(true);
    }
    expect((await readdir(root)).sort()).toEqual(['alpha', 'beta']);
    expect(await exists(staging)).toBe(false);
  });

  it('copies the tree with file modes, keeping relative links and rewriting absolute links inside the skill', async () => {
    const alpha = await richSkill('alpha');
    const prepared = await prepareSkills('claude-code', [alpha]);
    const root = join(base, 'plugin', 'skills');
    await materializeSkills(prepared, { root, staging: join(base, 'staging') });
    const copy = join(root, 'alpha');

    expect(await readFile(join(copy, 'SKILL.md'), 'utf8')).toBe(
      skillText('alpha'),
    );
    expect(await readFile(join(copy, 'scripts', 'run.sh'), 'utf8')).toBe(
      SCRIPT,
    );
    expect(await mode(join(copy, 'scripts', 'run.sh'))).toBe(0o755);
    expect(await mode(join(copy, 'references', 'guide.md'))).toBe(0o640);
    expect(await mode(join(copy, 'assets', 'data', 'table.csv'))).toBe(0o600);

    const source = await listTree(alpha);
    const copied = await listTree(copy);
    if (linksUnsupported) {
      expect(copied).toEqual(source);
      return;
    }
    const pinned = join('references', 'guide.md');
    expect(copied).toEqual(
      source.map((line) =>
        line.startsWith('pinned -> ') ? `pinned -> ${pinned}` : line,
      ),
    );
    expect(copied).toContain(`latest -> ${join('scripts', 'run.sh')}`);
    expect(copied).toContain('docs -> references');
    expect((await lstat(join(copy, 'pinned'))).isSymbolicLink()).toBe(true);
    expect(await realpath(join(copy, 'pinned'))).toBe(
      await realpath(join(copy, 'references', 'guide.md')),
    );
    expect(await readFile(join(copy, 'docs', 'guide.md'), 'utf8')).toBe(GUIDE);
    expect(isAbsolute(await readlink(join(alpha, 'pinned')))).toBe(true);
  });

  it.skipIf(linksUnsupported)(
    'copies a link target where the host cannot create a link',
    async () => {
      const alpha = await richSkill('alpha');
      const prepared = await prepareSkills('opencode', [alpha]);
      vi.mocked(symlink).mockRejectedValue(
        Object.assign(new Error('EPERM: operation not permitted, symlink'), {
          code: 'EPERM',
        }),
      );
      const root = join(base, 'carrier');
      await materializeSkills(prepared, {
        root,
        staging: join(base, 'staging'),
      });
      const copy = join(root, 'alpha');

      for (const [path, content, fileMode] of [
        ['latest', SCRIPT, 0o755],
        ['pinned', GUIDE, 0o640],
        [join('docs', 'guide.md'), GUIDE, 0o640],
      ] as const) {
        expect((await lstat(join(copy, path))).isFile()).toBe(true);
        expect(await readFile(join(copy, path), 'utf8')).toBe(content);
        expect(await mode(join(copy, path))).toBe(fileMode);
      }
      expect((await lstat(join(copy, 'docs'))).isDirectory()).toBe(true);
    },
  );

  it('reuses an entry already present in the root and creates only the absent ones', async () => {
    const skills = await prepareSkills('kimi', [
      await makeSkill('alpha'),
      await makeSkill('beta'),
      await makeSkill('gamma'),
    ]);
    const root = join(base, 'project', '.kimi-code', 'skills', 'carrier');
    await mkdir(join(root, 'alpha'), { recursive: true });
    await writeFile(join(root, 'alpha', 'marker'), 'held by another run');
    await mkdir(join(root, 'beta'));
    await writeFile(join(root, 'beta', 'marker'), 'already present');
    const observed = observeRenames(root);

    const created = await materializeSkills(skills, {
      root,
      staging: join(base, 'project', '.kimi-code', 'staging'),
      present: new Set(['alpha']),
    });

    expect(created).toEqual([join(root, 'gamma')]);
    expect(observed.map(({ to }) => to)).toEqual(created);
    expect((await readdir(root)).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(await readdir(join(root, 'alpha'))).toEqual(['marker']);
    expect(await readdir(join(root, 'beta'))).toEqual(['marker']);
    expect(await readFile(join(root, 'gamma', 'SKILL.md'), 'utf8')).toBe(
      skillText('gamma'),
    );
  });
});

// ---------------------------------------------------------------------------
// skills-4: removal mechanics
// ---------------------------------------------------------------------------

describe('skill carrier removal', () => {
  async function workspaceCarrier() {
    const project = join(base, 'project');
    const kimiCode = join(project, '.kimi-code');
    const skillsDir = join(kimiCode, 'skills');
    const carrierRoot = join(skillsDir, carrierName(carrierSuffix()));
    await mkdir(project);
    await materializeSkills(
      await prepareSkills('kimi', [
        await richSkill('alpha'),
        await makeSkill('beta'),
      ]),
      { root: carrierRoot, staging: join(base, 'staging') },
    );
    return { project, kimiCode, skillsDir, carrierRoot };
  }

  it('removes a carrier root with its entries and each created parent while empty', async () => {
    const { project, kimiCode, skillsDir, carrierRoot } =
      await workspaceCarrier();

    expect(
      await removeCarrierPaths([carrierRoot], [skillsDir, kimiCode]),
    ).toEqual([]);
    expect(await exists(kimiCode)).toBe(false);
    expect(await readdir(project)).toEqual([]);
  });

  it('removes listed entries and keeps a created parent that is no longer empty', async () => {
    const { kimiCode, skillsDir, carrierRoot } = await workspaceCarrier();
    const userSkill = await makeSkill('user-skill', { parent: skillsDir });

    expect(
      await removeCarrierPaths(
        [join(carrierRoot, 'alpha'), join(carrierRoot, 'beta')],
        [carrierRoot, skillsDir, kimiCode],
      ),
    ).toEqual([]);
    expect(await exists(carrierRoot)).toBe(false);
    expect(await readdir(skillsDir)).toEqual(['user-skill']);
    expect(await readFile(join(userSkill, 'SKILL.md'), 'utf8')).toBe(
      skillText('user-skill'),
    );
    expect(
      await removeCarrierPaths([join(base, 'gone')], [join(base, 'gone-too')]),
    ).toEqual([]);
  });

  it.skipIf(permissionsUnenforced)(
    'reports a forced removal failure without throwing and still attempts every removal',
    async () => {
      const locked = join(base, 'locked');
      const stuck = await makeSkill('stuck', { parent: locked });
      const lockedParent = join(locked, 'created-parent');
      await mkdir(lockedParent);
      const free = await makeSkill('free', { parent: join(base, 'open') });
      await chmod(locked, 0o500);
      try {
        const failures = await removeCarrierPaths(
          [stuck, free],
          [lockedParent],
        );
        expect(failures.map(({ path }) => path)).toEqual([stuck, lockedParent]);
        for (const { error } of failures) {
          expect(error).toBeInstanceOf(Error);
          expect(['EACCES', 'EPERM']).toContain(
            (error as NodeJS.ErrnoException).code,
          );
        }
        expect(await exists(free)).toBe(false);
        expect(formatRemovalFailures(failures)).toBe(
          failures
            .map(({ path, error }) => `${path}: ${error.message}`)
            .join('; '),
        );
        // The adapter attaches this code when it reports such a failure
        // before the terminal of an otherwise successful run.
        expect(SKILL_CARRIER_CLEANUP_FAILED).toBe(
          'SKILL_CARRIER_CLEANUP_FAILED',
        );
      } finally {
        await chmod(locked, 0o700);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// skills-8: discovery through the package entry point
// ---------------------------------------------------------------------------

describe('skill support metadata', () => {
  const matrix: Record<
    string,
    { carrier: string; namespace?: string; notes: string[] }
  > = {
    'claude-code': {
      carrier: 'run-private',
      namespace: 'cligent',
      notes: [
        'local plugin',
        'Skill tool',
        'disallowedTools',
        'cligent:<name>',
        'allowed-tools',
        'allowManagedPermissionRulesOnly',
        'disableSideloadFlags',
        'plugin named cligent collides',
      ],
    },
    codex: {
      carrier: 'run-private',
      namespace: 'cligent',
      notes: [
        'plugin cache',
        'No delivery evidence before the first model turn',
        'silently absent',
        'plugin named cligent collides',
      ],
    },
    gemini: {
      carrier: 'run-private',
      notes: [
        'settings home',
        'activate_skill',
        'real home',
        'sandbox',
        'shadows',
        'No delivery evidence before the first model turn',
      ],
    },
    kimi: {
      carrier: 'workspace',
      notes: [
        '.kimi-code/skills',
        'version control',
        'ACP command list',
        'operating-system home',
        'shadows',
        'creation-time model listing',
      ],
    },
    opencode: {
      carrier: 'run-private',
      notes: [
        'Managed server only',
        'skills.paths',
        'skill list',
        'External mode rejects a non-empty list',
      ],
    },
  };

  it('exposes the deeply frozen descriptor matrix', () => {
    expect(Object.keys(SKILL_SUPPORT).sort()).toEqual(
      Object.keys(matrix).sort(),
    );
    expect(Object.isFrozen(SKILL_SUPPORT)).toBe(true);
    for (const [agent, expected] of Object.entries(matrix)) {
      const descriptor: SkillSupport =
        SKILL_SUPPORT[agent as keyof typeof SKILL_SUPPORT];
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(descriptor.carrier).toBe(expected.carrier);
      if (expected.namespace === undefined) {
        expect('namespace' in descriptor).toBe(false);
      } else {
        expect(descriptor.namespace).toBe(expected.namespace);
      }
      expect(descriptor.notes).toEqual(expect.stringMatching(/\S/));
      for (const phrase of expected.notes) {
        expect(descriptor.notes).toContain(phrase);
      }
    }
    expect(() => {
      (SKILL_SUPPORT as Record<string, unknown>).custom = {};
    }).toThrow(TypeError);
    expect(() => {
      (SKILL_SUPPORT.kimi as { carrier: string }).carrier = 'run-private';
    }).toThrow(TypeError);
    expect(SKILL_SUPPORT.kimi.carrier).toBe('workspace');
  });

  it('looks up canonical names, the claude alias, and unknown adapters', () => {
    for (const agent of Object.keys(matrix)) {
      expect(getSkillSupport(agent)).toBe(
        SKILL_SUPPORT[agent as keyof typeof SKILL_SUPPORT],
      );
    }
    expect(getSkillSupport('claude')).toBe(SKILL_SUPPORT['claude-code']);
    for (const unknown of [
      'custom',
      'Claude-Code',
      'codex ',
      '',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
    ]) {
      expect(getSkillSupport(unknown)).toBeUndefined();
    }
  });
});

describe('absolute links through a linked ancestor (skills-3)', () => {
  it('rewrites an absolute in-skill link so it resolves inside the copy even when the skill path spells a linked ancestor differently', async () => {
    const {
      mkdtemp,
      mkdir,
      writeFile,
      symlink,
      realpath,
      readlink,
      readFile,
      rm,
    } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join, dirname, resolve } = await import('node:path');
    const { prepareSkills, materializeSkills } = await import('../skills.js');
    const base = await mkdtemp(join(tmpdir(), 'cligent-skills-abs-'));
    // A linked ancestor: the skill is reached through `via`, a link to `real`.
    const real = join(base, 'real');
    const via = join(base, 'via');
    await mkdir(join(real, 'linked', 'refs'), { recursive: true });
    await symlink(real, via);
    const skill = join(via, 'linked');
    await writeFile(
      join(skill, 'SKILL.md'),
      '---\nname: linked\ndescription: d\n---\n',
    );
    await writeFile(join(skill, 'refs', 'doc.md'), 'doc');
    // The absolute link target is written with the real spelling.
    await symlink(
      join(await realpath(skill), 'refs', 'doc.md'),
      join(skill, 'doc-link'),
    );
    const prepared = await prepareSkills('kimi', [skill]);
    const root = join(base, 'carrier');
    await materializeSkills(prepared, {
      root,
      staging: join(base, '.staging'),
    });
    expect(await readlink(join(root, 'linked', 'doc-link'))).toBe(
      join('refs', 'doc.md'),
    );
    expect(
      await readFile(
        resolve(
          dirname(join(root, 'linked', 'doc-link')),
          await readlink(join(root, 'linked', 'doc-link')),
        ),
        'utf8',
      ),
    ).toBe('doc');
    await rm(base, { recursive: true, force: true });
  });
});

describe('amended skills-2 rows and per-entry cancellation', () => {
  it('rejects a whitespace-only description, a dangling link, and a named pipe, and stops a copy between entries on abort', async () => {
    const { mkdtemp, mkdir, writeFile, symlink, rm, readdir } =
      await import('node:fs/promises');
    const { execFileSync } = await import('node:child_process');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { prepareSkills, materializeSkills } = await import('../skills.js');
    const base = await mkdtemp(join(tmpdir(), 'cligent-skills-amend-'));
    const make = async (name: string, description: string) => {
      const dir = join(base, name);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n`,
      );
      return dir;
    };
    const blank = await make('blank', '   \t ');
    await expect(prepareSkills('kimi', [blank])).rejects.toThrow(
      /description that is empty/,
    );
    const dangling = await make('dangling', 'd');
    await symlink('missing-target', join(dangling, 'dangling-link'));
    await expect(prepareSkills('kimi', [dangling])).rejects.toThrow(
      /does not resolve or lies outside the skill: .*dangling-link/,
    );
    const fifo = await make('fifo', 'd');
    execFileSync('mkfifo', [join(fifo, 'pipe')]);
    await expect(prepareSkills('kimi', [fifo])).rejects.toThrow(
      /neither a regular file, a directory, nor a symbolic link: .*pipe/,
    );
    // Cancellation between copied entries: abort fires once the first file is written.
    const big = await make('big', 'd');
    for (let i = 0; i < 20; i += 1)
      await writeFile(join(big, `f${i}.txt`), 'x');
    const prepared = await prepareSkills('kimi', [big]);
    const controller = new AbortController();
    const root = join(base, 'carrier');
    const staging = join(base, '.staging');
    setTimeout(() => controller.abort(), 0);
    await expect(
      materializeSkills(prepared, { root, staging, signal: controller.signal }),
    ).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
    expect(await readdir(base)).not.toContain('.staging');
    await rm(base, { recursive: true, force: true });
  });
});

describe('read-only directories and aliased sources (skills-3)', () => {
  it('copies a read-only directory tree, keeps file modes, makes directories removable, and re-expresses a link written through the physical alias', async () => {
    const {
      mkdtemp,
      mkdir,
      writeFile,
      symlink,
      chmod,
      stat,
      readlink,
      readFile,
      rm,
    } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join, dirname, resolve } = await import('node:path');
    const { prepareSkills, materializeSkills, removeCarrierPaths } =
      await import('../skills.js');
    const base = await mkdtemp(join(tmpdir(), 'cligent-skills-ro-'));
    // The accepted path is an alias whose physical basename differs.
    const store = join(base, 'store', 'version123');
    await mkdir(join(store, 'assets'), { recursive: true });
    await mkdir(join(store, 'nested'), { recursive: true });
    await writeFile(
      join(store, 'SKILL.md'),
      '---\nname: foo\ndescription: d\n---\n',
    );
    await writeFile(join(store, 'assets', 'a.txt'), 'A');
    await writeFile(join(store, 'nested', 'n.txt'), 'N', { mode: 0o444 });
    // A relative link that reaches its target through the physical parent name.
    await symlink(
      join('..', 'version123', 'assets'),
      join(store, 'assets-link'),
    );
    await symlink(store, join(base, 'foo'));
    await chmod(join(store, 'nested'), 0o555);
    await chmod(store, 0o555);
    try {
      const prepared = await prepareSkills('kimi', [join(base, 'foo')]);
      const root = join(base, 'carrier');
      const created = await materializeSkills(prepared, {
        root,
        staging: join(base, '.staging'),
      });
      const copy = join(root, 'foo');
      expect(created).toEqual([copy]);
      expect((await stat(join(copy, 'nested', 'n.txt'))).mode & 0o777).toBe(
        0o444,
      );
      expect((await stat(join(copy, 'nested'))).mode & 0o700).toBe(0o700);
      expect((await stat(copy)).mode & 0o700).toBe(0o700);
      expect(await readlink(join(copy, 'assets-link'))).toBe('assets');
      expect(
        await readFile(
          resolve(
            dirname(join(copy, 'assets-link')),
            await readlink(join(copy, 'assets-link')),
            'a.txt',
          ),
          'utf8',
        ),
      ).toBe('A');
      expect(await removeCarrierPaths(created, [root])).toEqual([]);
      await expect(stat(root)).rejects.toThrow();
    } finally {
      await chmod(store, 0o755).catch(() => undefined);
      await chmod(join(store, 'nested'), 0o755).catch(() => undefined);
      await rm(base, { recursive: true, force: true });
    }
  });
});
describe('links through a linked segment (skills-3)', () => {
  it.skipIf(linksUnsupported)(
    'resolves a link whose text steps out of a linked segment through the filesystem, not lexically',
    async () => {
      const { mkdtemp, mkdir, writeFile, symlink, readlink, readFile, rm } =
        await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join, dirname, resolve, sep } = await import('node:path');
      const { prepareSkills, materializeSkills } = await import('../skills.js');
      const base = await mkdtemp(join(tmpdir(), 'cligent-skills-jump-'));
      const skill = join(base, 'jumpy');
      await mkdir(join(skill, 'assets', 'inner'), { recursive: true });
      await writeFile(
        join(skill, 'SKILL.md'),
        '---\nname: jumpy\ndescription: d\n---\n',
      );
      await writeFile(join(skill, 'assets', 'data.txt'), 'inside assets');
      // A root-level decoy that a lexical collapse of `jump/../data.txt` would select.
      await writeFile(join(skill, 'data.txt'), 'decoy at root');
      await symlink(join('assets', 'inner'), join(skill, 'jump'));
      // The link text keeps its `..` (path.join would collapse it lexically).
      await symlink(['jump', '..', 'data.txt'].join(sep), join(skill, 'doc'));
      expect(await readlink(join(skill, 'doc'))).toBe(
        ['jump', '..', 'data.txt'].join(sep),
      );
      const prepared = await prepareSkills('kimi', [skill]);
      const root = join(base, 'carrier');
      await materializeSkills(prepared, {
        root,
        staging: join(base, '.staging'),
      });
      const copiedDoc = join(root, 'jumpy', 'doc');
      expect(await readlink(copiedDoc)).toBe(join('assets', 'data.txt'));
      expect(
        await readFile(
          resolve(dirname(copiedDoc), await readlink(copiedDoc)),
          'utf8',
        ),
      ).toBe('inside assets');
      await rm(base, { recursive: true, force: true });
    },
  );
});
describe('links to an ancestor (skills-3)', () => {
  it.skipIf(linksUnsupported)(
    'keeps a link to an ancestor as a link, and rejects it where the host creates no links',
    async () => {
      const { mkdir, writeFile, readlink } = await import('node:fs/promises');
      const { existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { prepareSkills, materializeSkills } = await import('../skills.js');
      const skill = join(base, 'loopy');
      await mkdir(join(skill, 'z'), { recursive: true });
      await writeFile(join(skill, 'SKILL.md'), skillText('loopy'));
      await symlink('.', join(skill, 'self'));
      await symlink('..', join(skill, 'z', 'up'));
      const prepared = await prepareSkills('kimi', [skill]);

      const linked = join(base, 'linked');
      await materializeSkills(prepared, {
        root: linked,
        staging: join(base, 'staging-linked'),
      });
      expect(await readlink(join(linked, 'loopy', 'self'))).toBe('.');
      expect(await readlink(join(linked, 'loopy', 'z', 'up'))).toBe('..');

      // A copy of the target would hold the link, and so itself, without end.
      vi.mocked(symlink).mockRejectedValue(
        Object.assign(new Error('EPERM: operation not permitted, symlink'), {
          code: 'EPERM',
        }),
      );
      await expect(
        materializeSkills(prepared, {
          root: join(base, 'copied'),
          staging: join(base, 'staging-copied'),
        }),
      ).rejects.toThrow(
        new RegExp(
          `^skill link .*self cannot be copied because the host creates no links and a copy of its target .*loopy would contain the link$`,
        ),
      );
      expect(existsSync(join(base, 'staging-copied'))).toBe(false);
    },
  );
});
describe('links through each other (skills-3)', () => {
  it.skipIf(linksUnsupported)(
    'rejects links whose directories reach each other where the host creates no links',
    async () => {
      const { mkdir, writeFile, readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const { prepareSkills, materializeSkills } = await import('../skills.js');
      const skill = join(base, 'mutual');
      await mkdir(join(skill, 'a'), { recursive: true });
      await mkdir(join(skill, 'b'));
      await writeFile(join(skill, 'SKILL.md'), skillText('mutual'));
      await writeFile(join(skill, 'b', 'note.md'), 'in b');
      await symlink(join('..', 'b'), join(skill, 'a', 'l1'));
      await symlink(join('..', 'a'), join(skill, 'b', 'l2'));
      const prepared = await prepareSkills('kimi', [skill]);

      const linked = join(base, 'linked');
      await materializeSkills(prepared, {
        root: linked,
        staging: join(base, 'staging-linked'),
      });
      expect(
        await readFile(join(linked, 'mutual', 'a', 'l1', 'note.md'), 'utf8'),
      ).toBe('in b');

      // Neither directory holds the other's link, yet a copy of `a` would
      // reach l2 through l1's copy of `b`.
      vi.mocked(symlink).mockRejectedValue(
        Object.assign(new Error('EPERM: operation not permitted, symlink'), {
          code: 'EPERM',
        }),
      );
      await expect(
        materializeSkills(prepared, {
          root: join(base, 'copied'),
          staging: join(base, 'staging-copied'),
        }),
      ).rejects.toThrow(
        new RegExp(
          `^skill link .*${['mutual', 'b', 'l2'].join('[\\\\/]')} cannot be copied because the host creates no links and a copy of its target .*${['mutual', 'a'].join('[\\\\/]')} would contain the link$`,
        ),
      );
    },
  );
});
