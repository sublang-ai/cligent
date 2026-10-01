// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

/** A local file attached to this turn; relative paths use the run's cwd. */
export interface Attachment {
  readonly path: string;
  /** Inferred from a known extension when omitted; never content-sniffed. */
  readonly mimeType?: string;
}

export interface AttachmentSupport {
  /** MIME types or type/* patterns transported by this adapter. */
  readonly mimeTypes: readonly string[];
  readonly notes: string;
}

const IMAGES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Transport support, not a promise of model or account eligibility. */
export const ATTACHMENT_SUPPORT = Object.freeze({
  'claude-code': Object.freeze({
    mimeTypes: Object.freeze([...IMAGES, 'application/pdf']),
    notes:
      'Native image and PDF content blocks; model and runtime limits apply.',
  }),
  codex: Object.freeze({
    mimeTypes: IMAGES,
    notes: 'Native local-image inputs; model and runtime limits apply.',
  }),
  gemini: Object.freeze({
    mimeTypes: Object.freeze([] as string[]),
    notes:
      'Use native @file references in the text prompt for images, audio, video, PDF, and text. The attachments option is unsupported.',
  }),
  kimi: Object.freeze({
    mimeTypes: IMAGES,
    notes:
      'Native ACP image blocks require the runtime to advertise image prompt support. For video, ask its ReadMediaFile tool to read a path in the text prompt.',
  }),
  opencode: Object.freeze({
    mimeTypes: Object.freeze([
      'image/*',
      'audio/*',
      'video/*',
      'application/pdf',
      'text/plain',
    ]),
    notes:
      'Native file parts with inline data URLs, including on external servers. The selected provider and model determine eligibility and may replace unsupported media with an error message.',
  }),
}) satisfies Readonly<Record<string, AttachmentSupport>>;

export function getAttachmentSupport(
  agent: string,
): AttachmentSupport | undefined {
  const canonical = agent === 'claude' ? 'claude-code' : agent;
  return Object.hasOwn(ATTACHMENT_SUPPORT, canonical)
    ? ATTACHMENT_SUPPORT[canonical as keyof typeof ATTACHMENT_SUPPORT]
    : undefined;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp4': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
});

/** Internal normalized local-file identity, with no retained file contents. */
export interface PreparedAttachment {
  path: string;
  mimeType: string;
}

/** Validate the complete request before reading files or invoking a runtime. */
export async function prepareAttachments(
  agent: string,
  value: unknown,
  cwd?: string,
  signal?: AbortSignal,
): Promise<PreparedAttachment[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`attachments for adapter "${agent}" must be an array`);
  }
  if (value.length === 0) return [];
  signal?.throwIfAborted();
  const support = getAttachmentSupport(agent);
  if (!support || support.mimeTypes.length === 0) {
    throw new Error(
      `attachments are not supported for adapter "${agent}". ${support?.notes ?? ''}`.trim(),
    );
  }
  const normalized = Array.from(value, (entry: unknown, index) => {
    const field = `attachments[${index}] for adapter "${agent}"`;
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry) ||
      !('path' in entry) ||
      typeof entry.path !== 'string' ||
      entry.path.trim().length === 0 ||
      entry.path.includes('\0')
    ) {
      throw new Error(`${field}.path must be a non-blank local file path`);
    }
    const explicitMime = 'mimeType' in entry ? entry.mimeType : undefined;
    if (
      explicitMime !== undefined &&
      (typeof explicitMime !== 'string' ||
        !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(explicitMime))
    ) {
      throw new Error(
        `${field}.mimeType must be a MIME type without parameters`,
      );
    }
    const mimeType =
      typeof explicitMime === 'string'
        ? explicitMime.toLowerCase()
        : MIME_BY_EXTENSION[extname(entry.path).toLowerCase()];
    if (!mimeType) {
      throw new Error(
        `${field}.mimeType is required for an unknown file extension`,
      );
    }
    if (
      !support.mimeTypes.some(
        (type) =>
          type === mimeType ||
          (type.endsWith('/*') && mimeType.startsWith(type.slice(0, -1))),
      )
    ) {
      throw new Error(`${field}.mimeType "${mimeType}" is not supported`);
    }
    return { path: resolve(cwd ?? process.cwd(), entry.path), mimeType };
  });
  for (const [index, attachment] of normalized.entries()) {
    signal?.throwIfAborted();
    try {
      if (!(await stat(attachment.path)).isFile()) {
        throw new Error('not a regular file');
      }
      await access(attachment.path, constants.R_OK);
    } catch {
      throw new Error(
        `attachments[${index}].path for adapter "${agent}" must name a readable regular file: ${attachment.path}`,
      );
    }
  }
  signal?.throwIfAborted();
  return normalized;
}

export function readAttachment(
  attachment: PreparedAttachment,
  signal?: AbortSignal,
): Promise<Buffer> {
  return readFile(attachment.path, { signal });
}
