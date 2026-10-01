// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { MediaPayload } from './types.js';

interface MediaDetails {
  mimeType?: string;
  name?: string;
  toolUseId?: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function mime(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:;[^\x00-\x1f\x7f]*)?$/.test(value)
    ? value
    : undefined;
}

function metadata(
  details: MediaDetails,
): Pick<MediaPayload, 'name' | 'toolUseId'> {
  return {
    ...(details.name ? { name: details.name } : {}),
    ...(details.toolUseId ? { toolUseId: details.toolUseId } : {}),
  };
}

function fromBase64(
  data: unknown,
  details: MediaDetails,
): MediaPayload | undefined {
  if (typeof data !== 'string' || data.length === 0) return undefined;
  const compact = data.replace(/\s/g, '');
  if (
    compact.length === 0 ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
  ) {
    return undefined;
  }
  return {
    mimeType: mime(details.mimeType) ?? 'application/octet-stream',
    source: { type: 'base64', data },
    ...metadata(details),
  };
}

/** Preserve native references; never fetch a URL, read a path, or parse prose. */
export function mediaFromUri(
  uri: string,
  details: MediaDetails = {},
): MediaPayload | undefined {
  if (uri.length === 0) return undefined;
  if (/^data:/i.test(uri)) {
    const match = /^data:([^,]*);base64,([\s\S]*)$/i.exec(uri);
    if (!match) return undefined;
    return fromBase64(match[2], {
      ...details,
      mimeType: mime(match[1]) ?? details.mimeType,
    });
  }
  return {
    mimeType: mime(details.mimeType) ?? 'application/octet-stream',
    source: { type: 'uri', uri },
    ...metadata(details),
  };
}

/** MCP/ACP content blocks and Anthropic's equivalent image/document sources. */
export function mediaFromMcpContent(
  value: unknown,
  toolUseId?: string,
): MediaPayload[] {
  const blocks = Array.isArray(value) ? value : [value];
  return blocks.flatMap((value): MediaPayload[] => {
    const block = record(value);
    const details: MediaDetails = {
      mimeType: mime(block.mimeType),
      name: nonempty(block.name) ?? nonempty(block.title),
      toolUseId,
    };
    let media: MediaPayload | undefined;
    if (
      block.type === 'image' ||
      block.type === 'audio' ||
      block.type === 'document'
    ) {
      const source = record(block.source);
      if (source.type === 'base64') {
        media = fromBase64(source.data, {
          ...details,
          mimeType: mime(source.media_type),
        });
      } else if (source.type === 'url' && typeof source.url === 'string') {
        media = mediaFromUri(source.url, details);
      } else if (block.type !== 'document') {
        media = fromBase64(block.data, details);
      }
    } else if (
      block.type === 'resource_link' &&
      typeof block.uri === 'string'
    ) {
      media = mediaFromUri(block.uri, details);
    } else if (block.type === 'resource') {
      const resource = record(block.resource);
      if (typeof resource.blob === 'string') {
        media = fromBase64(resource.blob, {
          ...details,
          mimeType: mime(resource.mimeType),
        });
      }
    }
    return media ? [media] : [];
  });
}

/** Kimi's ACP rawOutput uses its native camel-cased model-content parts. */
export function mediaFromKimiContent(
  value: unknown,
  toolUseId?: string,
): MediaPayload[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((value): MediaPayload[] => {
    const part = record(value);
    const key =
      part.type === 'image_url'
        ? 'imageUrl'
        : part.type === 'audio_url'
          ? 'audioUrl'
          : part.type === 'video_url'
            ? 'videoUrl'
            : undefined;
    if (!key) return [];
    const source = record(part[key]);
    if (typeof source.url !== 'string') return [];
    const media = mediaFromUri(source.url, {
      name: nonempty(source.name),
      toolUseId,
    });
    return media ? [media] : [];
  });
}
