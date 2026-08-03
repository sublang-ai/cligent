// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { z } from 'zod';

/**
 * Wire schemas for the Agent Client Protocol subset the Kimi adapter depends
 * on, owned here rather than imported from the protocol SDK.
 *
 * The SDK generates a complete set of zod schemas but publishes them only
 * inside `dist/`, which was reachable while the package shipped no `exports`
 * map and became unreachable the moment it did — a dependency on a build
 * artifact, not on an interface. The generated schemas also validate the whole
 * protocol, while the adapter reads a small, stable subset of it, and their
 * newer generation deliberately salvages malformed payloads (dropping an
 * invalid `usage` rather than rejecting it) where this adapter must reject:
 * per [KIMI-006](../../specs/user/adapters/kimi.md) malformed traffic is an
 * actionable error, not something to repair silently.
 *
 * These schemas therefore encode one rule: every field the adapter actually
 * consumes is validated strictly, and everything else is ignored. Unknown keys
 * are stripped rather than rejected, so an agent may add fields — and, for the
 * variant unions, whole cases — without this client calling valid traffic
 * malformed.
 */

/** A JSON-RPC 2.0 error object, as carried on an ACP error response. */
export const zAcpError = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

/** `initialize` result; the adapter enforces the negotiated version itself. */
export const zAcpInitializeResponse = z.object({
  protocolVersion: z.number(),
});

/**
 * One session configuration option. The adapter reads the current value of
 * `select` options (model and thinking control); other option types are
 * carried through untouched, so they need only their discriminant.
 */
export const zAcpSessionConfigOption = z.looseObject({
  id: z.string(),
  type: z.string(),
  currentValue: z.string().optional(),
});

/**
 * A session configuration option as this adapter reads it — deliberately
 * narrower than the protocol's full union, which carries per-type fields the
 * adapter never touches.
 */
export type AcpSessionConfigOption = z.infer<typeof zAcpSessionConfigOption>;

const zAcpConfigOptions = z
  .array(zAcpSessionConfigOption)
  .nullish();

/** `session/new` result. An empty id is rejected by the adapter, not here. */
export const zAcpNewSessionResponse = z.object({
  sessionId: z.string(),
  configOptions: zAcpConfigOptions,
});

/** `session/load` (resume) result. */
export const zAcpResumeSessionResponse = z.object({
  configOptions: zAcpConfigOptions,
});

/** `session/set_config_option` result. */
export const zAcpSetSessionConfigOptionResponse = z.object({
  configOptions: zAcpConfigOptions,
});

/**
 * Token accounting. Cached counters are optional; the adapter folds them into
 * the reported input total.
 */
export const zAcpUsage = z.looseObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedReadTokens: z.number().nullish(),
  cachedWriteTokens: z.number().nullish(),
});

/** Token accounting as this adapter reads it. */
export type AcpUsage = z.infer<typeof zAcpUsage>;

/**
 * `session/prompt` result. `stopReason` drives the terminal `done` status, so
 * it is pinned to the protocol's closed set: an unrecognized reason must not
 * be silently reported as a successful turn.
 */
export const zAcpPromptResponse = z.object({
  stopReason: z.enum([
    'end_turn',
    'max_tokens',
    'max_turn_requests',
    'refusal',
    'cancelled',
  ]),
  usage: zAcpUsage.nullish(),
});

/**
 * Content the adapter renders as assistant text. A `text` chunk must carry
 * its text: the adapter concatenates that field, so a chunk that omits it is
 * malformed rather than empty. Other content types are read only for their
 * discriminant.
 */
const zAcpContentChunk = z.union([
  z.looseObject({ type: z.literal('text'), text: z.string() }),
  z.looseObject({ type: z.string() }).refine((c) => c.type !== 'text', {
    message: 'a text content chunk must carry its text',
  }),
]);

/**
 * Tool-call content and status as the adapter stores them. Both feed the
 * emitted `tool_result`, so both are validated where present.
 */
const zAcpToolCallStatus = z.enum([
  'pending',
  'in_progress',
  'completed',
  'failed',
]);

/** Update cases the adapter reads fields off, so it validates their shape. */
const CHUNK_UPDATES = [
  'agent_message_chunk',
  'agent_thought_chunk',
  'user_message_chunk',
] as const;
const TOOL_UPDATES = ['tool_call', 'tool_call_update'] as const;
const HANDLED_UPDATES = new Set<string>([...CHUNK_UPDATES, ...TOOL_UPDATES]);

/**
 * A `session/update` payload. The cases the adapter reads must carry the
 * fields it reads — a handled case missing them is malformed, not something
 * to wave through — while any case the adapter does not handle passes on its
 * discriminant alone, so protocol growth is never reported as malformed.
 */
const zAcpSessionUpdate = z.union([
  z.looseObject({
    sessionUpdate: z.literal(CHUNK_UPDATES),
    content: zAcpContentChunk,
  }),
  z.looseObject({
    sessionUpdate: z.literal(TOOL_UPDATES),
    toolCallId: z.string(),
    // Every field below is read into the tool state that produces the
    // emitted tool_use / tool_result, so each is validated where present.
    // `rawInput` and `rawOutput` are opaque payloads the adapter forwards
    // without interpreting, so they carry no shape requirement.
    title: z.string().nullish(),
    kind: z.string().nullish(),
    status: zAcpToolCallStatus.nullish(),
    content: z.array(z.looseObject({ type: z.string() })).nullish(),
  }),
  z
    .looseObject({ sessionUpdate: z.string() })
    .refine((update) => !HANDLED_UPDATES.has(update.sessionUpdate), {
      message: 'handled session update is missing its required fields',
    }),
]);

/** `session/update` notification parameters. */
export const zAcpSessionNotification = z.object({
  sessionId: z.string(),
  update: zAcpSessionUpdate,
});

/** `session/request_permission` request parameters. */
export const zAcpRequestPermissionRequest = z.looseObject({
  sessionId: z.string(),
  options: z.array(
    z.looseObject({
      optionId: z.string(),
      kind: z.string(),
    }),
  ),
});
