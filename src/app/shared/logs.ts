// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WriteStream } from 'node:fs';

interface LogWriter {
  write(value: string): unknown;
}

interface LogCloser {
  end(): unknown;
  once?(event: 'close' | 'error', listener: () => void): unknown;
  destroyed?: boolean;
  closed?: boolean;
}

export function logFilePath(workDir: string, name: string): string {
  return join(workDir, `${name}.log`);
}

export function prepareLogDirectory(
  workDir: string,
  names: readonly string[],
  markerFile: string,
  markerContent: string,
): void {
  mkdirSync(workDir, { recursive: true });
  for (const name of names) {
    writeFileSync(logFilePath(workDir, name), '');
  }
  writeFileSync(join(workDir, markerFile), markerContent);
}

export function openAppendLogStreams(
  workDir: string,
  names: readonly string[],
  onError?: (name: string, error: Error) => void,
): Map<string, WriteStream> {
  const streams = new Map<string, WriteStream>();
  for (const name of names) {
    const stream = createWriteStream(logFilePath(workDir, name), { flags: 'a' });
    stream.on('error', (error) => {
      onError?.(name, error);
    });
    streams.set(name, stream);
  }
  return streams;
}

export function closeLogStreams(streams: Iterable<LogCloser>): Promise<void> {
  return Promise.all([...streams].map(closeLogStream)).then(() => undefined);
}

function closeLogStream(stream: LogCloser): Promise<void> {
  return new Promise<void>((resolve) => {
    // Plain closers (tests) and already-finished streams have nothing to
    // await: end them and resolve synchronously.
    if (typeof stream.once !== 'function' || stream.destroyed || stream.closed) {
      stream.end();
      resolve();
      return;
    }
    // Resolve only once the file descriptor is closed and buffered writes
    // are flushed, so a following work-dir removal cannot race a pending
    // lazy write and fail with ENOTEMPTY. Stream errors are surfaced via
    // the handler installed in openAppendLogStreams.
    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    stream.once('close', finish);
    stream.once('error', finish);
    stream.end();
  });
}

export function writeBossPrompt(
  streams: Iterable<LogWriter>,
  prompt: string,
): void {
  for (const stream of streams) {
    stream.write(`boss> ${prompt}\n\n`);
  }
}
