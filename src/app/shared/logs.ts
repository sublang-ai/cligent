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

export function closeLogStreams(streams: Iterable<LogCloser>): void {
  for (const stream of streams) {
    stream.end();
  }
}

export function writeBossPrompt(
  streams: Iterable<LogWriter>,
  prompt: string,
): void {
  for (const stream of streams) {
    stream.write(`boss> ${prompt}\n\n`);
  }
}
