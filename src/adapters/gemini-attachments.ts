// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareAttachments, readAttachment } from '../attachments.js';

const MAX_BYTES = 20 * 1024 * 1024;
const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/aiff': 'aiff',
  'video/mp4': 'mp4',
  'video/mpeg': 'mpeg',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

export interface GeminiAttachmentStage {
  prompt: string;
  directory?: string;
  cleanup(): Promise<void>;
}

/** Native @file ultimately treats an absolute path as a glob, not a literal. */
export function assertGeminiAttachmentContext(
  directory = tmpdir(),
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === 'win32') {
    throw new Error(
      'Gemini attachments require a POSIX host; native Windows attachment staging is unsupported',
    );
  }
  if (/[\\*?\[\]{}()!,\x00-\x1f\x7f]/.test(directory)) {
    throw new Error(
      'Gemini attachments require a temporary directory without control characters, backslashes, glob characters, or commas; configure TMPDIR to a compatible path',
    );
  }
}

export async function prepareGeminiAttachments(
  prompt: string,
  value: unknown,
  cwd?: string,
  signal?: AbortSignal,
): Promise<GeminiAttachmentStage> {
  const attachments = await prepareAttachments('gemini', value, cwd, signal);
  if (attachments.length === 0) return { prompt, async cleanup() {} };

  const parent = await realpath(tmpdir());
  assertGeminiAttachmentContext(parent);
  for (const [index, attachment] of attachments.entries()) {
    signal?.throwIfAborted();
    if ((await stat(attachment.path)).size > MAX_BYTES) {
      throw new Error(`attachments[${index}] for Gemini exceeds 20 MiB`);
    }
  }
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(parent, 'cligent-gemini-attachments-'));
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    }));
  try {
    const references: string[] = [];
    for (const [index, attachment] of attachments.entries()) {
      const bytes = await readAttachment(attachment, signal);
      if (bytes.length > MAX_BYTES)
        throw new Error(`attachments[${index}] for Gemini exceeds 20 MiB`);
      const extension = EXTENSIONS[attachment.mimeType];
      if (!extension)
        throw new Error(`Unsupported Gemini MIME: ${attachment.mimeType}`);
      const digest = createHash('sha256').update(bytes).digest('hex');
      const ordinal = String(index).padStart(
        String(attachments.length).length,
        '0',
      );
      const path = join(directory, `${ordinal}-${digest}.${extension}`);
      await writeFile(path, bytes, { mode: 0o600, signal });
      // Gemini's POSIX unescapePath removes backslash escapes, not quotes.
      const escaped = path.replace(/([ \t;|$`'"#&<>~@])/g, '\\$1');
      references.push(`@${escaped}`);
    }
    signal?.throwIfAborted();
    return {
      prompt: `${prompt}${prompt ? '\n' : ''}${references.join(' ')}`,
      directory,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
