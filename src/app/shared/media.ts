// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  mediaFromKimiContent,
  mediaFromMcpContent,
  mediaFromUri,
} from '../../media.js';
import type { MediaPayload } from '../../types.js';

export function formatMediaSummary(media: MediaPayload): string {
  const name = media.name ? ` ${JSON.stringify(media.name)}` : '';
  const source =
    media.source.type === 'uri'
      ? JSON.stringify(media.source.uri)
      : '[inline media]';
  return `${media.mimeType}${name} ${source}`;
}

/** Presentation-only redaction; raw event payloads retain the native bytes. */
export function mediaJsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return value;
  const block = value as Record<string, unknown>;
  let media: MediaPayload | undefined =
    mediaFromMcpContent(block)[0] ?? mediaFromKimiContent([block])[0];
  if (!media && block.type === 'file' && typeof block.url === 'string') {
    media = mediaFromUri(block.url, {
      mimeType: typeof block.mime === 'string' ? block.mime : undefined,
      name: typeof block.filename === 'string' ? block.filename : undefined,
    });
  }
  return media ? formatMediaSummary(media) : value;
}
