// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import {
  lstat,
  open,
  readlink,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const CONFIG_MIGRATION_TEMP_MARKER = '.cligent-migrate-';

interface FileRevision {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface PathObservation {
  readonly revision: FileRevision;
  readonly symbolicLink: boolean;
  readonly linkTarget?: string;
  readonly resolvedPath: string;
}

export interface ObservedConfigFile {
  readonly configPath: string;
  readonly resolvedPath: string;
  readonly source: Buffer;
  readonly path: PathObservation;
  readonly target: FileRevision;
}

export interface AtomicConfigReplaceOptions {
  /** Deterministic seam for concurrency tests; production callers omit it. */
  readonly beforeFinalCheck?: (tempPath: string) => void | Promise<void>;
}

export async function observeConfigFile(
  configPath: string,
): Promise<ObservedConfigFile> {
  const pathBefore = await observePath(configPath);
  const targetRead = await readStableFile(pathBefore.resolvedPath);
  const targetAtPath = revisionOf(
    await stat(pathBefore.resolvedPath, { bigint: true }),
  );
  const pathAfter = await observePath(configPath);

  if (
    !samePathObservation(pathBefore, pathAfter) ||
    !targetRead.stable ||
    !sameRevision(targetRead.revision, targetAtPath)
  ) {
    throw migrationRetryError(configPath);
  }

  return {
    configPath,
    resolvedPath: pathBefore.resolvedPath,
    source: targetRead.source,
    path: pathBefore,
    target: targetRead.revision,
  };
}

export async function replaceObservedConfigFile(
  observed: ObservedConfigFile,
  nextSource: string,
  options: AtomicConfigReplaceOptions = {},
): Promise<void> {
  const targetDirectory = dirname(observed.resolvedPath);
  const tempPath = join(
    targetDirectory,
    `.${basename(observed.resolvedPath)}${CONFIG_MIGRATION_TEMP_MARKER}` +
      `${process.pid}-${randomUUID()}.tmp`,
  );
  const permissionBits = Number(observed.target.mode & 0o7777n);
  let tempHandle: Awaited<ReturnType<typeof open>> | undefined;
  let replaced = false;

  try {
    tempHandle = await open(tempPath, 'wx', 0o600);
    await tempHandle.writeFile(nextSource, 'utf8');
    // Publish the observed permission bits only after the complete contents
    // are durable in the private temporary file.
    await tempHandle.chmod(permissionBits);
    await tempHandle.sync();
    await tempHandle.close();
    tempHandle = undefined;

    await options.beforeFinalCheck?.(tempPath);
    await assertObservationUnchanged(observed);
    await rename(tempPath, observed.resolvedPath);
    replaced = true;
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    if (tempHandle !== undefined) {
      await tempHandle.close().catch((cleanupError: unknown) => {
        cleanupFailures.push(cleanupError);
      });
    }
    if (!replaced) {
      await unlink(tempPath).catch((cleanupError: unknown) => {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          cleanupFailures.push(cleanupError);
        }
      });
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        'tmux-play config migration failed and could not clean its temporary file',
      );
    }
    throw error;
  }
}

async function assertObservationUnchanged(
  observed: ObservedConfigFile,
): Promise<void> {
  try {
    const pathBefore = await observePath(observed.configPath);
    const targetRead = await readStableFile(observed.resolvedPath);
    const targetAtPath = revisionOf(
      await stat(observed.resolvedPath, { bigint: true }),
    );
    const pathAfter = await observePath(observed.configPath);

    if (
      !samePathObservation(observed.path, pathBefore) ||
      !samePathObservation(observed.path, pathAfter) ||
      !targetRead.stable ||
      !sameRevision(observed.target, targetRead.revision) ||
      !sameRevision(observed.target, targetAtPath) ||
      !targetRead.source.equals(observed.source)
    ) {
      throw migrationRetryError(observed.configPath);
    }
  } catch {
    throw migrationRetryError(observed.configPath);
  }
}

async function readStableFile(path: string): Promise<{
  readonly source: Buffer;
  readonly revision: FileRevision;
  readonly stable: boolean;
}> {
  const handle = await open(path, 'r');
  try {
    const before = revisionOf(await handle.stat({ bigint: true }));
    const source = await handle.readFile();
    const after = revisionOf(await handle.stat({ bigint: true }));
    return {
      source,
      revision: before,
      stable: sameRevision(before, after),
    };
  } finally {
    await handle.close();
  }
}

async function observePath(configPath: string): Promise<PathObservation> {
  const stats = await lstat(configPath, { bigint: true });
  const symbolicLink = stats.isSymbolicLink();
  const linkTarget = symbolicLink ? await readlink(configPath) : undefined;
  const resolvedPath = await realpath(configPath);
  return {
    revision: revisionOf(stats),
    symbolicLink,
    ...(linkTarget === undefined ? {} : { linkTarget }),
    resolvedPath,
  };
}

function revisionOf(stats: BigIntStats): FileRevision {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    nlink: stats.nlink,
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function samePathObservation(
  left: PathObservation,
  right: PathObservation,
): boolean {
  return (
    left.symbolicLink === right.symbolicLink &&
    left.linkTarget === right.linkTarget &&
    left.resolvedPath === right.resolvedPath &&
    sameRevision(left.revision, right.revision)
  );
}

function sameRevision(left: FileRevision, right: FileRevision): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function migrationRetryError(configPath: string): Error {
  return new Error(
    `tmux-play config changed during migration; retry loading ${configPath}`,
  );
}
