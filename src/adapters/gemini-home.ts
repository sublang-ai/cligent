// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import {
  chmod,
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { materializeSkills, type PreparedSkill } from '../skills.js';

const GEMINI_DIR = '.gemini';
const SETTINGS_FILE = 'settings.json';
const REGISTRY_FILE = 'projects.json';
// gemini-51: the user-tier skills directory, a real directory in an overlay
// that carries a run's skills.
const SKILLS_DIR = 'skills';
const SKILL_FILE = 'SKILL.md';
// Temporary-name writes for the run's skills: in the overlay home, which no
// Gemini skill scan reaches, on the same filesystem as the skills directory.
const SKILL_STAGING = '.cligent-staging';
// Gemini CLI 0.61.0 skillLoader: the frontmatter block and the characters
// its loaded skill name replaces with `-`.
const SKILL_FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?/;
const SKILL_NAME_UNSAFE = /[:\\/<>*?"|]/g;
// Session and shell history the CLI writes during a run. Created in the real
// home before linking so the run writes them there directly.
const SHARED_STATE_DIRS = ['tmp', 'history'] as const;
// Gemini locks its project registry with proper-lockfile: a `<file>.lock`
// directory that a live holder refreshes, stale after 10 s untouched.
const REGISTRY_LOCK_STALE_MS = 10_000;
const REGISTRY_LOCK_WAIT_MS = 10_000;
const REGISTRY_LOCK_RETRY_MS = 100;
const REGISTRY_SLUG = /^[a-z0-9-]+$/;

/** What a per-run Gemini home carries beyond its user settings. */
export interface GeminiHomeOverlayOptions {
  /** gemini-51: the run's prepared skills, delivered as user-tier skills. */
  readonly skills?: readonly PreparedSkill[];
  /** Cancels skill materialization. */
  readonly signal?: AbortSignal;
}

/** A per-run Gemini home whose user settings differ from the real home's. */
export interface GeminiHomeOverlay {
  /** The directory the child receives as `GEMINI_CLI_HOME`. */
  readonly home: string;
  /** Reconciles the run's changes into the real home, then removes the overlay. */
  close(): Promise<void>;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * What makes an entry the link the overlay created: a symbolic link (or a
 * Windows junction) while it still names the real entry, and a hard link
 * while it is still the real file. An inode number alone cannot tell: a
 * filesystem may give a removed link's number to the entry replacing it.
 */
async function identity(path: string, stats: BigIntStats): Promise<string> {
  if (stats.isSymbolicLink()) return `link:${await readlink(path)}`;
  const type = stats.mode & BigInt(fsConstants.S_IFMT);
  return `${type}:${stats.dev}:${stats.ino}`;
}

async function lstatOrUndefined(
  path: string,
): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function isDirectoryEntry(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Links `path` to `target`. Windows needs no privilege for a directory
 * junction, and falls back to a hard link for a file where symbolic links are
 * not permitted.
 */
async function linkEntry(target: string, path: string): Promise<void> {
  if (process.platform !== 'win32') {
    await symlink(target, path);
    return;
  }
  if (await isDirectoryEntry(target)) {
    await symlink(target, path, 'junction');
    return;
  }
  try {
    await symlink(target, path, 'file');
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'EPERM' && code !== 'EACCES') throw error;
    await link(target, path);
  }
}

async function linkEntries(
  realDir: string,
  overlayDir: string,
  skip: ReadonlySet<string>,
  links: Map<string, string>,
): Promise<void> {
  for (const name of await readdir(realDir)) {
    if (skip.has(name)) continue;
    const path = join(overlayDir, name);
    await linkEntry(join(realDir, name), path);
    links.set(path, await identity(path, await lstat(path, { bigint: true })));
  }
}

/** Skill names compared as Gemini compares them: after lowercasing both. */
export function foldGeminiSkillName(name: string): string {
  return name.toLowerCase();
}

/**
 * Gemini's own frontmatter reading: YAML first, then its line-oriented
 * fallback, each requiring string `name` and `description` values.
 */
function parseSkillFrontmatter(content: string): string | undefined {
  try {
    const parsed: unknown = parseYaml(content, { logLevel: 'error' });
    if (typeof parsed === 'object' && parsed !== null) {
      const { name, description } = parsed as Record<string, unknown>;
      if (typeof name === 'string' && typeof description === 'string') {
        return name;
      }
    }
  } catch {
    // Gemini falls back to its simple parser when YAML parsing fails.
  }

  const lines = content.split(/\r?\n/);
  let name: string | undefined;
  let description: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const nameMatch = /^\s*name:\s*(.*)$/.exec(line);
    if (nameMatch) {
      name = nameMatch[1]!.trim();
      continue;
    }
    const descriptionMatch = /^\s*description:\s*(.*)$/.exec(line);
    if (descriptionMatch) {
      description = descriptionMatch[1]!.trim();
      while (index + 1 < lines.length && /^[ \t]+\S/.test(lines[index + 1]!)) {
        index += 1;
      }
    }
  }
  return name !== undefined && description !== undefined ? name : undefined;
}

function isSkillFileName(name: string): boolean {
  // Gemini's discovery glob matches case-insensitively where the platform's
  // filesystem does.
  return process.platform === 'darwin' || process.platform === 'win32'
    ? name.toLowerCase() === SKILL_FILE.toLowerCase()
    : name === SKILL_FILE;
}

/**
 * gemini-51: the name Gemini gives the skill an entry of its user skills
 * directory holds, or the entry name where none parses. Gemini loads
 * `SKILL.md` and `*\/SKILL.md` there.
 */
async function geminiSkillName(path: string, entry: string): Promise<string> {
  try {
    const stats = await stat(path);
    const file = stats.isDirectory()
      ? join(path, SKILL_FILE)
      : stats.isFile() && isSkillFileName(entry)
        ? path
        : undefined;
    if (!file) return entry;
    const match = SKILL_FRONTMATTER.exec(await readFile(file, 'utf8'));
    const name = match ? parseSkillFrontmatter(match[1]!) : undefined;
    return name === undefined ? entry : name.replace(SKILL_NAME_UNSAFE, '-');
  } catch {
    return entry;
  }
}

/**
 * gemini-51: links each real user skill whose entry name and Gemini skill
 * name both differ from every run skill's name, so none shadows a run skill.
 */
async function linkSkillEntries(
  realSkillsDir: string,
  overlaySkillsDir: string,
  runNames: ReadonlySet<string>,
  links: Map<string, string>,
): Promise<void> {
  let names: string[];
  try {
    if (!(await stat(realSkillsDir)).isDirectory()) return;
    names = await readdir(realSkillsDir);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw error;
  }
  const taken = new Set([...runNames].map(foldGeminiSkillName));
  for (const name of names) {
    if (taken.has(foldGeminiSkillName(name))) continue;
    const realPath = join(realSkillsDir, name);
    const skillName = await geminiSkillName(realPath, name);
    if (taken.has(foldGeminiSkillName(skillName))) continue;
    const path = join(overlaySkillsDir, name);
    await linkEntry(realPath, path);
    links.set(path, await identity(path, await lstat(path, { bigint: true })));
  }
}

/** A `.gemini` name that marks an unfinished or locked write, not state. */
function isTransientName(name: string): boolean {
  return (
    /\.tmp(?:\.|$)/.test(name) ||
    name.endsWith('.rollback') ||
    name.endsWith('.lock')
  );
}

async function replaceEntry(
  source: string,
  destination: string,
): Promise<void> {
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') throw error;
  }

  // Another filesystem: stage a copy beside the destination, then swap it in.
  const staging = join(
    dirname(destination),
    `.${basename(destination)}.cligent-${randomUUID()}.tmp`,
  );
  try {
    const stats = await lstat(source);
    if (stats.isSymbolicLink()) {
      await symlink(await readlink(source), staging);
    } else {
      await copyFile(source, staging, fsConstants.COPYFILE_EXCL);
      await chmod(staging, stats.mode & 0o7777);
    }
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
}

async function moveDirectory(
  source: string,
  destination: string,
): Promise<void> {
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') throw error;
  }
  await cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

interface ProjectRegistry {
  projects: Record<string, string>;
}

function parseRegistry(content: string): ProjectRegistry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  const projects = (parsed as { projects?: unknown } | null)?.projects;
  if (typeof projects !== 'object' || projects === null) return undefined;
  if (Array.isArray(projects)) return undefined;
  const entries = Object.entries(projects);
  if (
    !entries.every(
      ([, slug]) => typeof slug === 'string' && REGISTRY_SLUG.test(slug),
    )
  ) {
    return undefined;
  }
  return { projects: Object.fromEntries(entries) as Record<string, string> };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Takes the registry's proper-lockfile-compatible lock, or `undefined`. */
async function lockRegistry(
  registryPath: string,
): Promise<(() => Promise<void>) | undefined> {
  let lockTarget: string;
  try {
    lockTarget = await realpath(registryPath);
  } catch {
    lockTarget = join(
      await realpath(dirname(registryPath)),
      basename(registryPath),
    );
  }
  const lockPath = `${lockTarget}.lock`;
  const deadline = Date.now() + REGISTRY_LOCK_WAIT_MS;

  for (;;) {
    try {
      await mkdir(lockPath);
      return async () => {
        await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }

    const held = await stat(lockPath).catch(() => undefined);
    if (held && Date.now() - held.mtimeMs > REGISTRY_LOCK_STALE_MS) {
      await rm(lockPath, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) return undefined;
    await delay(REGISTRY_LOCK_RETRY_MS);
  }
}

/**
 * gemini-45: adds the project entries the run registered that the real
 * registry lacks. A registry the lock keeps busy is left to Gemini's own
 * ownership markers, which the run wrote through its linked state directories.
 */
async function mergeRegistry(
  overlayPath: string,
  realPath: string,
): Promise<void> {
  const ours = parseRegistry(await readFile(overlayPath, 'utf8'));
  if (!ours) return;

  const release = await lockRegistry(realPath);
  if (!release) return;
  try {
    let current: ProjectRegistry = { projects: {} };
    try {
      current = parseRegistry(await readFile(realPath, 'utf8')) ?? current;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const missing = Object.entries(ours.projects).filter(
      ([path]) => !Object.prototype.hasOwnProperty.call(current.projects, path),
    );
    if (missing.length === 0) return;

    const merged: ProjectRegistry = {
      projects: { ...current.projects, ...Object.fromEntries(missing) },
    };
    const staging = `${realPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(staging, JSON.stringify(merged, null, 2), 'utf8');
      await rename(staging, realPath);
    } catch (error) {
      await rm(staging, { force: true });
      throw error;
    }
  } finally {
    await release();
  }
}

interface ReconcileScope {
  /** The overlay's own entries, never reconciled. */
  skip: ReadonlySet<string>;
  /** Within Gemini's own state directory: its transient names are not state. */
  transient: boolean;
  /** Gemini's own state directory: its project registry merges. */
  registry: boolean;
  /**
   * gemini-45: the real user skills directory, created where only it is
   * missing; a missing real `.gemini` is never recreated.
   */
  createParent: boolean;
}

/** Creates `dir` unless it exists, never creating a missing parent. */
async function createDirectory(dir: string): Promise<void> {
  try {
    await mkdir(dir);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
}

async function reconcileEntries(
  overlayDir: string,
  realDir: string,
  scope: ReconcileScope,
  links: ReadonlyMap<string, string>,
  failures: Error[],
): Promise<void> {
  for (const name of await readdir(overlayDir)) {
    if (scope.skip.has(name)) continue;
    if (scope.transient && isTransientName(name)) continue;
    const path = join(overlayDir, name);
    const realPath = join(realDir, name);

    try {
      const stats = await lstatOrUndefined(path);
      if (!stats || links.get(path) === (await identity(path, stats))) continue;

      if (scope.registry && name === REGISTRY_FILE && stats.isFile()) {
        await mergeRegistry(path, realPath);
        continue;
      }

      const real = await lstatOrUndefined(realPath);
      // The real user skills directory may not exist before the run adds to it.
      if (!real && scope.createParent) await createDirectory(realDir);
      if (stats.isDirectory()) {
        if (!real) {
          await moveDirectory(path, realPath);
        } else if (await isDirectoryEntry(realPath)) {
          await cp(path, realPath, {
            recursive: true,
            errorOnExist: false,
            force: false,
            verbatimSymlinks: true,
          });
        }
        continue;
      }

      if (real?.isDirectory()) continue;
      await replaceEntry(path, realPath);
    } catch (error) {
      failures.push(
        new Error(
          `Unable to reconcile Gemini home entry ${realPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        ),
      );
    }
  }
}

async function removeOverlay(
  home: string,
  links: ReadonlyMap<string, string>,
): Promise<void> {
  // Unlink the links first so no removal can reach through one.
  for (const [path, linked] of links) {
    const stats = await lstatOrUndefined(path).catch(() => undefined);
    const current = stats
      ? await identity(path, stats).catch(() => undefined)
      : undefined;
    if (current === linked) {
      // A Windows directory junction is removed as a directory.
      await unlink(path).catch(() => rmdir(path));
    }
  }
  await rm(home, { recursive: true, force: true });
}

/**
 * gemini-34: builds a private home for one Gemini child whose user settings
 * are `settingsContent` and whose every other entry, in the home and in its
 * `.gemini`, links to the real home's. gemini-51: with skills, its
 * `.gemini/skills` is a real directory holding the run's skills, then links to
 * the real user skills that none of them shadows.
 */
export async function createGeminiHomeOverlay(
  realHome: string,
  settingsContent: string,
  options: GeminiHomeOverlayOptions = {},
): Promise<GeminiHomeOverlay> {
  const realGeminiDir = join(realHome, GEMINI_DIR);
  for (const name of SHARED_STATE_DIRS) {
    await mkdir(join(realGeminiDir, name), { recursive: true });
  }

  const skills = options.skills ?? [];
  const runSkillNames = new Set(skills.map((skill) => skill.name));
  const geminiSkip = new Set([SETTINGS_FILE]);
  if (skills.length > 0) geminiSkip.add(SKILLS_DIR);

  const home = await mkdtemp(join(tmpdir(), 'cligent-gemini-home-'));
  const links = new Map<string, string>();
  const overlayGeminiDir = join(home, GEMINI_DIR);
  const overlaySkillsDir = join(overlayGeminiDir, SKILLS_DIR);
  const realSkillsDir = join(realGeminiDir, SKILLS_DIR);
  try {
    await mkdir(overlayGeminiDir, { mode: 0o700 });
    if (skills.length > 0) {
      // The run's skills first, so no link can take one of their names.
      await mkdir(overlaySkillsDir, { mode: 0o700 });
      await materializeSkills(skills, {
        root: overlaySkillsDir,
        staging: join(home, SKILL_STAGING),
        signal: options.signal,
      });
    }
    await linkEntries(realHome, home, new Set([GEMINI_DIR]), links);
    await linkEntries(realGeminiDir, overlayGeminiDir, geminiSkip, links);
    if (skills.length > 0) {
      await linkSkillEntries(
        realSkillsDir,
        overlaySkillsDir,
        runSkillNames,
        links,
      );
    }
    await writeFile(join(overlayGeminiDir, SETTINGS_FILE), settingsContent, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    await removeOverlay(home, links);
    throw error;
  }

  let closing: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    const failures: Error[] = [];
    try {
      await reconcileEntries(
        home,
        realHome,
        {
          skip: new Set([GEMINI_DIR]),
          transient: false,
          registry: false,
          createParent: false,
        },
        links,
        failures,
      );
      await reconcileEntries(
        overlayGeminiDir,
        realGeminiDir,
        {
          skip: geminiSkip,
          transient: true,
          registry: true,
          createParent: false,
        },
        links,
        failures,
      );
      // gemini-45: the run's skills and the links beside them stay behind;
      // every other entry Gemini created there reaches the real skills.
      if (
        skills.length > 0 &&
        (await lstatOrUndefined(overlaySkillsDir))?.isDirectory()
      ) {
        await reconcileEntries(
          overlaySkillsDir,
          realSkillsDir,
          {
            skip: runSkillNames,
            transient: true,
            registry: false,
            createParent: true,
          },
          links,
          failures,
        );
      }
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await removeOverlay(home, links);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'Failed to reconcile the Gemini home overlay',
      );
    }
  };

  return {
    home,
    close: () => (closing ??= close()),
  };
}
