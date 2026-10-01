<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# attachments: Local-file Input

## Intent

This package defines local-file attachments and their transport discovery and preparation, per [DR-030](../decisions/030-media-input-and-computer-use.md).
Its project-specific vocabulary is the public `Attachment`, `AttachmentSupport`, `ATTACHMENT_SUPPORT`, and `getAttachmentSupport` API.
It owns input validation and local-file identity, leaving native request serialization and selected-model eligibility to each adapter.

## External Behavior

### attachments-1

The public `Attachment` type shall describe one local file with readonly `path: string` and optional readonly `mimeType: string`, without remote fetching, inline-data inputs, or automatic media conversion.

### attachments-2

When a built-in adapter prepares an attachment list, preparation shall select this result before any provider prompt:

| Input | Result |
| --- | --- |
| absent or empty array | no attached content |
| non-array | reject with the adapter and `attachments` validation path |
| nonempty list on an adapter with no structured attachment transport | reject with the adapter and `attachments` path; Gemini's diagnostic directs callers to native `@file` prompt references |
| entry lacking a non-blank string path, containing NUL, or not an object | reject with its adapter and indexed validation path |
| relative path | resolve against the effective run `cwd`, otherwise the process cwd |
| absolute path | retain its local-file identity |
| explicit MIME type | require a nonempty `type/subtype` without parameters or wildcards, normalize to lowercase, and use it instead of extension inference |
| omitted MIME type | infer case-insensitively from the extension table below; reject an unknown extension with a request for `mimeType` |
| MIME outside the selected adapter's transport set [[attachments-3](#attachments-3)] | reject with its adapter and indexed validation path before filesystem access |
| missing, unreadable, or non-regular file | reject with its adapter and indexed path; follow ordinary filesystem symlinks |
| accepted list | preserve order and caller objects without mutation |
| cancellation during preparation or content reads | stop preparation and use the adapter's ordinary interruption outcome |

| Extensions | MIME types, respectively |
| --- | --- |
| `png`, `jpg`/`jpeg`, `gif`, `webp`, `avif`, `bmp`, `svg`, `tif`/`tiff` | `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`, `image/bmp`, `image/svg+xml`, `image/tiff` |
| `mp3`, `wav`, `flac`, `ogg`, `m4a`, `aac` | `audio/mpeg`, `audio/wav`, `audio/flac`, `audio/ogg`, `audio/mp4`, `audio/aac` |
| `mp4`, `mpeg`/`mpg`, `mov`, `webm` | `video/mp4`, `video/mpeg`, `video/quicktime`, `video/webm` |
| `pdf`, `txt` | `application/pdf`, `text/plain` |

### attachments-3

The exported `ATTACHMENT_SUPPORT` shall expose deeply frozen `AttachmentSupport` descriptors with readonly `mimeTypes` arrays and explanatory `notes` through this matrix, describing transport acceptance without promising model, account, provider, or installed-runtime eligibility:

| Adapter | MIME transport set | Notes |
| --- | --- | --- |
| `claude-code` | `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `application/pdf` | native image and document blocks [[claude-code-46](adapters/claude-code.md#claude-code-46)] |
| `codex` | `image/png`, `image/jpeg`, `image/gif`, `image/webp` | native local-image inputs [[codex-67](adapters/codex.md#codex-67)] |
| `gemini` | empty | native `@file` text-prompt references already accept media; the structured option is unsupported [[gemini-46](adapters/gemini.md#gemini-46)] |
| `kimi` | `image/png`, `image/jpeg`, `image/gif`, `image/webp` | ACP image capability required [[kimi-40](adapters/kimi.md#kimi-40)]; video can be requested through a plain-prompt ReadMediaFile invocation |
| `opencode` | `image/*`, `audio/*`, `video/*`, `application/pdf`, `text/plain` | inline data URLs work across local and external servers; unsupported model modalities may become upstream error text [[opencode-58](adapters/opencode.md#opencode-58)] |

### attachments-4

When `getAttachmentSupport(agent)` is called, it shall return the matching frozen descriptor [[attachments-3](#attachments-3)], map `claude` to `claude-code`, and return `undefined` for any unknown adapter, leaving custom adapters responsible for their own attachment contract.

## Verification

### attachments-5

When filesystem integration tests prepare local fixtures through accepted and rejected adapter paths, they shall verify the local-file shape [[attachments-1](#attachments-1)] and every preparation outcome [[attachments-2](#attachments-2)], including exact byte reads, relative and absolute paths, MIME override and inference, preserved ordering, invalid dynamic inputs, inaccessible or non-regular paths, and cancellation.

### attachments-6

When a consumer imports attachment discovery through the package entry point, the integration check shall verify the descriptor matrix and nested immutability [[attachments-3](#attachments-3)] and canonical, alias, and unknown lookup results [[attachments-4](#attachments-4)].
