<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# media: Native Media Output

## Intent

This package defines the normalized media payload emitted from native assistant and tool output, per [DR-032](../decisions/032-browser-tools-and-media-output.md).
It owns content representation and normalization, not tool execution, model vision, rendering, or resource access.

## External Behavior

### media-1

When a caller receives normalized media, its `MediaPayload` shall select its fields through this matrix:

| Field | Meaning |
| --- | --- |
| `mimeType` | native MIME type when available and syntactically valid, otherwise `application/octet-stream` |
| `source: { type: 'base64', data: string }` | native base64 bytes without decoding, re-encoding, or conversion |
| `source: { type: 'uri', uri: string }` | native resource URI, preserved without assuming host-local accessibility |
| `name` | native display name when supplied |
| `toolUseId` | correlated tool invocation identifier for a tool result, otherwise absent |

### media-2

When supported native content is normalized, the result shall follow this exhaustive mapping while retaining native block order:

| Native content | Normalized output |
| --- | --- |
| MCP or ACP `image` / `audio` with `data` | base64 source and `mimeType` |
| Anthropic `image` / `document` with `source.type: 'base64'` | base64 source and `source.media_type` |
| Anthropic `image` / `document` with `source.type: 'url'` | URI source |
| MCP or ACP `resource_link` | URI source and optional MIME type and name or title |
| MCP or ACP `resource` containing `resource.blob` | base64 source and optional resource MIME type |
| native file reference | URI source and supplied MIME type and filename |
| Kimi model-content `image_url`, `audio_url`, or `video_url` | corresponding camel-cased `imageUrl`, `audioUrl`, or `videoUrl` member's URL and optional name |
| base64 data URL | base64 source with its declared MIME type taking precedence |
| empty source, malformed base64, or unsupported content | no normalized media |

### media-3

When media normalization processes native output, it shall perform no file read, URI fetch, persistence, Markdown or arbitrary-object scanning, tool invocation, or mutation of the native content.

## Verification

### media-4

When native content travels through real adapter and engine normalization, integration checks shall verify exact source bytes and URI identity [[media-1](#media-1)], supported content and malformed-content selection [[media-2](#media-2)], and unchanged native text and opaque tool output without interpreting Markdown links [[media-3](#media-3)].
