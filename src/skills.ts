// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Caller-supplied Agent Skills directories: validation (skills-2), the
// run-scoped snapshot (skills-3), removal (skills-4), and transport discovery
// (skills-5, skills-6), per DR-036. Each adapter owns the native carrier that
// makes a snapshot discoverable; this module owns everything the carriers
// share, including the carrier name form every adapter's stale sweep parses.

import { randomBytes } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { parse as parseYaml } from 'yaml';

/** How an adapter carries a run's skills to its runtime. */
export type SkillCarrier = 'run-private' | 'workspace';

export interface SkillSupport {
  readonly carrier: SkillCarrier;
  /** The prefix the runtime puts before each skill name, where it adds one. */
  readonly namespace?: string;
  readonly notes: string;
}

/** Transport delivery, not a promise that a model selects a skill or that a runtime policy admits it. */
export const SKILL_SUPPORT = Object.freeze({
  'claude-code': Object.freeze({
    carrier: 'run-private',
    namespace: 'cligent',
    notes:
      "Per-run local plugin checked at initialization. The Skill tool must stay in any explicit allowlist and out of disallowedTools, as must a Skill(cligent:<name>) or Skill(cligent:*) deny rule; the model lists cligent:<name> and resolves the bare name while it is unique. A run skill's allowed-tools widens the run's permissions while it is active. Under a managed allowManagedPermissionRulesOnly the run's grants are ignored, so a skill setting allowed-tools, disallowed-tools, or hooks asks and is denied unless the permission mode or an approver admits the ask; a managed disableSideloadFlags makes the run fail at start. Another enabled plugin named cligent collides.",
  }),
  codex: Object.freeze({
    carrier: 'run-private',
    namespace: 'cligent',
    notes:
      'Per-run plugin under the Codex home plugin cache. No delivery evidence before the first model turn, so a runtime, or another Codex process sharing the home, that drops the cache entry or disables plugins leaves the skills silently absent. Another enabled plugin named cligent collides.',
  }),
  gemini: Object.freeze({
    carrier: 'run-private',
    notes:
      "User-tier skills in the per-run settings home with an activate_skill allow rule and the runtime's merged policy sources beside a skills-only policy. Rejects a working directory equal to the real home, a native sandbox, user settings disabling skills, or a tool list excluding activate_skill. A same-named skill in the user's .agents/skills or a trusted workspace shadows a run skill, an extension skill whose name differs only in case captures its activation, and another settings scope's skill disables can suppress it. The carrier is removed with the settings overlay under that overlay's own cleanup contract. No delivery evidence before the first model turn.",
  }),
  kimi: Object.freeze({
    carrier: 'workspace',
    notes:
      "A process-shared directory under the project root's .kimi-code/skills, visible to version control, to every concurrent Kimi run of the process whatever its own list, and to other Kimi processes, held until the process's last Kimi run with skills under any project root whose .kimi-code/skills resolves to that directory ends, checked through the ACP command list. Rejects a project root that is the operating-system home, a .kimi-code/skills resolving into the user's skill roots, a run skill containing that directory, and a run supplying another directory under a present entry's name, while a .kimi-code/skills aliasing a configured extra skill directory goes undetected; a worker thread of the process holds its own carrier, which the sweep leaves alone. A same-named skill registered earlier under .kimi-code/skills shadows a run skill, which that check catches only when the descriptions differ. A resumed session keeps its creation-time model listing.",
  }),
  opencode: Object.freeze({
    carrier: 'run-private',
    notes:
      "Managed server only, through inline configuration skill paths that replace configured skills.paths for the run, checked through the server's skill list, which a same-named skill discovered elsewhere can fail. External mode rejects a non-empty list.",
  }),
}) satisfies Readonly<Record<string, SkillSupport>>;

export function getSkillSupport(agent: string): SkillSupport | undefined {
  const canonical = agent === 'claude' ? 'claude-code' : agent;
  return Object.hasOwn(SKILL_SUPPORT, canonical)
    ? SKILL_SUPPORT[canonical as keyof typeof SKILL_SUPPORT]
    : undefined;
}

/** The error code a carrier removal failure reports before the terminal (skills-4). */
export const SKILL_CARRIER_CLEANUP_FAILED = 'SKILL_CARRIER_CLEANUP_FAILED';

/** One validated skill: its name, source directory, and raw frontmatter description. */
export interface PreparedSkill {
  readonly name: string;
  /** Absolute, lexically normalized, before any link resolution. */
  readonly directory: string;
  /** The frontmatter value verbatim; runtimes normalize it themselves. */
  readonly description: string;
  /** The caller's entry, unchanged. */
  readonly path: string;
}

const SKILL_FILE = 'SKILL.md';
const NAME_GRAMMAR = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;

function fail(field: string, message: string): never {
  throw new Error(`${field} ${message}`);
}

function parseFrontmatter(
  text: string,
): { name: string; description: string } | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line === '---');
  if (end === -1) return undefined;
  let data: unknown;
  try {
    data = parseYaml(lines.slice(1, end).join('\n'));
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return undefined;
  }
  const { name, description } = data as Record<string, unknown>;
  if (typeof name !== 'string' || typeof description !== 'string') {
    return undefined;
  }
  return { name, description };
}

async function statOrUndefined(path: string) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

/** Resolve a path, following symbolic links, or return undefined when it cannot be resolved. */
async function realpathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Walk a skill directory, following links to directories, reporting the
 * first nested SKILL.md outside an owned carrier root and the first link
 * whose resolved target escapes the skill. Cycles end at a directory already
 * seen by real path.
 */
async function inspectTree(
  directory: string,
): Promise<{ nested?: string; escaping?: string; special?: string }> {
  const root = (await realpathOrUndefined(directory)) ?? directory;
  const seen = new Set<string>([root]);
  const queue: string[] = [directory];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpathOrUndefined(path);
        if (target === undefined || !isWithin(root, target)) {
          return { escaping: path };
        }
        const targetStats = await stat(target);
        if (targetStats.isDirectory()) {
          if (isOwnedCarrierRoot(path)) continue;
          if (!seen.has(target)) {
            seen.add(target);
            queue.push(path);
          }
        } else if (
          entry.name === SKILL_FILE &&
          current !== directory &&
          targetStats.isFile()
        ) {
          return { nested: path };
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (isOwnedCarrierRoot(path)) continue;
        const real = (await realpathOrUndefined(path)) ?? path;
        if (!seen.has(real)) {
          seen.add(real);
          queue.push(path);
        }
      } else if (!entry.isFile()) {
        // A FIFO, socket, or device would block or fail the copy.
        return { special: path };
      } else if (entry.name === SKILL_FILE && current !== directory) {
        return { nested: path };
      }
    }
  }
  return {};
}

/** Validate the complete request before any provider work (skills-2). */
export async function prepareSkills(
  agent: string,
  value: unknown,
  cwd?: string,
  signal?: AbortSignal,
): Promise<PreparedSkill[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`skills for adapter "${agent}" must be an array`);
  }
  if (value.length === 0) return [];
  signal?.throwIfAborted();
  const prepared: PreparedSkill[] = [];
  const byName = new Map<string, number>();
  for (const [index, entry] of (value as unknown[]).entries()) {
    const field = `skills[${index}] for adapter "${agent}"`;
    if (
      typeof entry !== 'string' ||
      entry.trim().length === 0 ||
      entry.includes('\0')
    ) {
      fail(field, 'must be a non-blank skill directory path');
    }
    signal?.throwIfAborted();
    const given = resolve(cwd ?? process.cwd(), entry);
    const stats = await statOrUndefined(given);
    let directory: string;
    if (stats?.isFile() && basename(given) === SKILL_FILE) {
      directory = dirname(given);
    } else if (stats?.isDirectory()) {
      directory = given;
    } else {
      fail(field, `must name a skill directory or its ${SKILL_FILE}: ${given}`);
    }
    const skillFile = join(directory, SKILL_FILE);
    const fileStats = await statOrUndefined(skillFile);
    if (!fileStats?.isFile()) {
      fail(field, `must hold a regular ${SKILL_FILE}: ${directory}`);
    }
    const frontmatter = parseFrontmatter(await readFile(skillFile, 'utf8'));
    if (!frontmatter) {
      fail(
        field,
        `must open with a --- YAML frontmatter block mapping name and description to strings: ${skillFile}`,
      );
    }
    const { name, description } = frontmatter;
    if (!NAME_GRAMMAR.test(name) || name.length > NAME_MAX) {
      fail(
        field,
        `has a name "${name}" outside ${NAME_GRAMMAR} or longer than ${NAME_MAX} characters`,
      );
    }
    if (name !== basename(directory)) {
      fail(
        field,
        `has a name "${name}" differing from its directory name "${basename(directory)}"`,
      );
    }
    if (
      description.trim().length === 0 ||
      description.length > DESCRIPTION_MAX
    ) {
      fail(
        field,
        `has a description that is empty or longer than ${DESCRIPTION_MAX} characters`,
      );
    }
    signal?.throwIfAborted();
    const { nested, escaping, special } = await inspectTree(directory);
    if (nested) {
      fail(field, `holds another ${SKILL_FILE} below the skill: ${nested}`);
    }
    if (escaping) {
      fail(
        field,
        `holds a link whose target does not resolve or lies outside the skill: ${escaping}`,
      );
    }
    if (special) {
      fail(
        field,
        `holds an entry that is neither a regular file, a directory, nor a symbolic link: ${special}`,
      );
    }
    const earlier = byName.get(name);
    if (earlier !== undefined) {
      fail(field, `repeats the name "${name}" of skills[${earlier}]`);
    }
    byName.set(name, index);
    prepared.push({ name, directory, description, path: entry });
  }
  signal?.throwIfAborted();
  return prepared;
}

// ---------------------------------------------------------------------------
// Carrier names: `cligent-<host>-<pid>-<suffix>`, shared by every adapter that
// writes into a location other processes also use, so each adapter's stale
// sweep parses one form.

const CARRIER_PREFIX = 'cligent';
const SUFFIX_BYTES = 10;
const CARRIER_NAME = /^cligent-(.+)-(\d+)-([0-9a-f]{20})$/;

/** The operating-system host name with each character outside ASCII letters, digits, and `-` replaced by `-`. */
export function carrierHostToken(): string {
  return hostname().replace(/[^A-Za-z0-9-]/g, '-');
}

/** A random 20-lowercase-hex-character suffix. */
export function carrierSuffix(): string {
  return randomBytes(SUFFIX_BYTES).toString('hex');
}

// Kept on globalThis so two copies of this module loaded into one process
// (two installed versions of the package) share one suffix, or each copy's
// stale sweep would take the other's live carrier for a dead one's.
const PROCESS_SUFFIX_KEY = Symbol.for('@sublang/cligent.processCarrierSuffix');

/** The suffix chosen once per process, for carriers a process shares between its runs. */
export function processCarrierSuffix(): string {
  const holder = globalThis as { [PROCESS_SUFFIX_KEY]?: string };
  holder[PROCESS_SUFFIX_KEY] ??= carrierSuffix();
  return holder[PROCESS_SUFFIX_KEY];
}

export function carrierName(suffix: string): string {
  return `${CARRIER_PREFIX}-${carrierHostToken()}-${process.pid}-${suffix}`;
}

export interface ParsedCarrierName {
  readonly host: string;
  readonly pid: number;
  readonly suffix: string;
}

/** Parse a carrier name from the right, or return undefined for any other name. */
export function parseCarrierName(name: string): ParsedCarrierName | undefined {
  const match = CARRIER_NAME.exec(name);
  if (!match) return undefined;
  return { host: match[1]!, pid: Number(match[2]), suffix: match[3]! };
}

/** Whether the operating system reports the process as running on this host. */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Whether a carrier name carries this host's token and names a process the
 * operating system reports as not running. A carrier of this process's own
 * identifier is never stale: worker threads share the identifier but not
 * this module's state, so another thread's live carrier looks like one of
 * this process with another suffix.
 */
export function isStaleCarrierName(name: string): boolean {
  const parsed = parseCarrierName(name);
  if (!parsed || parsed.host !== carrierHostToken()) return false;
  if (parsed.pid === process.pid) return false;
  return !isProcessRunning(parsed.pid);
}

/** Whether a path is a carrier root an adapter of this package owns inside a workspace. */
export function isOwnedCarrierRoot(path: string): boolean {
  return (
    parseCarrierName(basename(path)) !== undefined &&
    basename(dirname(path)) === 'skills' &&
    basename(dirname(dirname(path))) === '.kimi-code'
  );
}

// ---------------------------------------------------------------------------
// Snapshot (skills-3)

async function copyTree(
  source: string,
  target: string,
  skillRoot: string,
  signal?: AbortSignal,
) {
  const sourceStats = await lstat(source);
  // Populate first: a read-only source directory would otherwise refuse its
  // own children. Owner read, write, and search stay set on the copy so the
  // snapshot remains removable.
  await mkdir(target);
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    signal?.throwIfAborted();
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isSymbolicLink()) {
      await copyLink(from, to, skillRoot, signal);
    } else if (entry.isDirectory()) {
      if (isOwnedCarrierRoot(from)) continue;
      await copyTree(from, to, skillRoot, signal);
    } else {
      const stats = await lstat(from);
      await copyFile(from, to);
      await chmod(to, stats.mode & 0o777);
    }
  }
  await chmod(target, (sourceStats.mode & 0o777) | 0o700);
}

async function copyLink(
  from: string,
  to: string,
  skillRoot: string,
  signal?: AbortSignal,
) {
  const raw = await readlink(from);
  // Every link is re-expressed relative to its copied location through its
  // resolved target, on real paths for both sides: the skill may be reached
  // through a linked ancestor (macOS /var is /private/var) or through an
  // alias whose physical name differs, and a link written against either
  // spelling would otherwise climb out of the copy or miss inside it.
  // skills-2 already rejected targets outside the skill.
  const realDir = await realpath(dirname(from));
  const target = await realpath(resolve(realDir, raw));
  const link = relative(realDir, target) || '.';
  try {
    await symlink(link, to);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EPERM' && code !== 'ENOSYS' && code !== 'EACCES') throw error;
  }
  // The host cannot create a link: copy the resolved target's content instead.
  const targetStats = await stat(target);
  if (targetStats.isDirectory()) {
    await copyTree(target, to, skillRoot, signal);
  } else {
    await copyFile(target, to);
    await chmod(to, targetStats.mode & 0o777);
  }
}

export interface MaterializeOptions {
  /** The carrier root the entries are renamed into. */
  readonly root: string;
  /** A directory outside every runtime-scanned location, on the root's filesystem, for temporary-name writes. */
  readonly staging: string;
  /** Entry names already present in the root, which are reused rather than written. */
  readonly present?: ReadonlySet<string>;
  readonly signal?: AbortSignal;
}

/**
 * Create exactly one entry per skill not already present in the root, each
 * written under a temporary name in `staging` and renamed into place.
 * Returns the paths of the entries this call created, in order.
 */
export async function materializeSkills(
  skills: readonly PreparedSkill[],
  options: MaterializeOptions,
): Promise<string[]> {
  const created: string[] = [];
  await mkdir(options.root, { recursive: true });
  await mkdir(options.staging, { recursive: true });
  try {
    for (const skill of skills) {
      options.signal?.throwIfAborted();
      if (options.present?.has(skill.name)) continue;
      const target = join(options.root, skill.name);
      if (await statOrUndefined(target)) continue;
      const temporary = join(
        options.staging,
        `${skill.name}-${carrierSuffix()}`,
      );
      await copyTree(
        skill.directory,
        temporary,
        skill.directory,
        options.signal,
      );
      await rename(temporary, target);
      created.push(target);
    }
  } finally {
    await rm(options.staging, { recursive: true, force: true });
  }
  return created;
}

// ---------------------------------------------------------------------------
// Removal (skills-4)

export interface RemovalFailure {
  readonly path: string;
  readonly error: Error;
}

/**
 * Remove each path recursively, then each parent only while it is empty,
 * attempting every removal and reporting the failures rather than throwing.
 * A parent that is absent or no longer empty is not a failure.
 */
export async function removeCarrierPaths(
  paths: readonly string[],
  parents: readonly string[] = [],
): Promise<RemovalFailure[]> {
  const failures: RemovalFailure[] = [];
  for (const path of paths) {
    try {
      await rm(path, { recursive: true, force: true });
    } catch (error) {
      failures.push({ path, error: toError(error) });
    }
  }
  for (const parent of parents) {
    try {
      await rmdir(parent);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'ENOENT' || code === 'EEXIST')
        continue;
      failures.push({ path: parent, error: toError(error) });
    }
  }
  return failures;
}

export function formatRemovalFailures(
  failures: readonly RemovalFailure[],
): string {
  return failures
    .map((failure) => `${failure.path}: ${failure.error.message}`)
    .join('; ');
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Whether `child` lies at or below `parent`, both compared lexically. */
export function isPathWithin(parent: string, child: string): boolean {
  return (
    isWithin(parent, child) ||
    child === parent ||
    child.startsWith(parent + sep)
  );
}
