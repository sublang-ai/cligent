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
 * newer generation deliberately salvages malformed payloads. This adapter
 * keeps control fields strict per kimi-6, while failure-isolating optional
 * accounting per kimi-5 so bad telemetry cannot change a completed turn's
 * terminal status.
 *
 * These schemas therefore encode one rule: protocol structure the adapter
 * relies on and every field it consumes are validated strictly, while
 * everything else is ignored. Unknown keys are stripped rather than rejected,
 * so an agent may add fields — and, for the variant unions, whole cases —
 * without this client calling valid traffic malformed.
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
export const zAcpSessionConfigOption = z.union([
  // The adapter reads a select's current value to report the effective
  // model, so a select that omits it is malformed rather than unset.
  z.looseObject({
    id: z.string(),
    type: z.literal('select'),
    currentValue: z.string(),
  }),
  z
    .looseObject({ id: z.string(), type: z.string() })
    .refine((option) => option.type !== 'select', {
      message: 'a select config option must carry its currentValue',
    }),
]);

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
 * Token accounting structure used by the adapter. ACP's required total and
 * mapped counters are unsigned integers. Nullable optional counters remain
 * absent accounting; malformed mapped counters make the optional usage field
 * unavailable. Unconsumed details such as thoughtTokens remain loose extension
 * data.
 */
const zAcpTokenCounter = z.number().int().nonnegative();

export const zAcpUsage = z.looseObject({
  totalTokens: zAcpTokenCounter,
  inputTokens: zAcpTokenCounter,
  outputTokens: zAcpTokenCounter,
  cachedReadTokens: zAcpTokenCounter.nullish(),
  cachedWriteTokens: zAcpTokenCounter.nullish(),
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
  usage: zAcpUsage.nullish().catch(null),
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

/**
 * One item of a tool call's content. The adapter walks `content` items and
 * concatenates the text of every `content`-typed entry into the tool result,
 * so those entries are validated to the depth it reads; other item types
 * (diffs, terminals) are carried without inspection.
 */
const zAcpToolCallContent = z.union([
  z.looseObject({
    type: z.literal('content'),
    content: zAcpContentChunk,
  }),
  z.looseObject({ type: z.string() }).refine((item) => item.type !== 'content', {
    message: 'a content tool-call item must carry its content',
  }),
]);

/**
 * Plan payloads. The adapter reads no field off these — it forwards the whole
 * update as a `kimi:plan` event — which makes the entire payload consumed,
 * not exempt: a consumer receives whatever arrives here, and the SDK behind
 * the filter would rewrite an invalid plan into empty entries or drop the
 * update outright rather than reject it.
 */
const zAcpPlanEntry = z.looseObject({
  content: z.string(),
  priority: z.enum(['high', 'medium', 'low']),
  status: z.enum(['pending', 'in_progress', 'completed']),
});

const zAcpPlanUpdateContent = z.union([
  z.looseObject({
    type: z.literal('items'),
    planId: z.string(),
    entries: z.array(zAcpPlanEntry),
  }),
  z.looseObject({
    type: z.literal('file'),
    planId: z.string(),
    uri: z.string(),
  }),
  z.looseObject({
    type: z.literal('markdown'),
    planId: z.string(),
    content: z.string(),
  }),
]);

/** Update cases the adapter reads fields off, so it validates their shape. */
const CHUNK_UPDATES = [
  'agent_message_chunk',
  'agent_thought_chunk',
  'user_message_chunk',
] as const;
const TOOL_UPDATES = ['tool_call', 'tool_call_update'] as const;
/** Cases the adapter forwards whole, so the whole payload is validated. */
const PLAN_UPDATES = ['plan', 'plan_update', 'plan_removed'] as const;
/**
 * Every case this adapter acts on. A `session/update` naming anything else is
 * one the adapter would ignore, and the pinned SDK rejects it against its own
 * closed union, so the stream filter drops it rather than forwarding traffic
 * whose only effect would be an SDK error log.
 */
export const ACTED_ON_UPDATES = new Set<string>([
  ...CHUNK_UPDATES,
  ...TOOL_UPDATES,
  ...PLAN_UPDATES,
]);

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
    content: z.array(zAcpToolCallContent).nullish(),
  }),
  z.looseObject({
    sessionUpdate: z.literal('plan'),
    entries: z.array(zAcpPlanEntry),
  }),
  z.looseObject({
    sessionUpdate: z.literal('plan_update'),
    plan: zAcpPlanUpdateContent,
  }),
  z.looseObject({
    sessionUpdate: z.literal('plan_removed'),
    planId: z.string(),
  }),
  z
    .looseObject({ sessionUpdate: z.string() })
    .refine((update) => !ACTED_ON_UPDATES.has(update.sessionUpdate), {
      message: 'a session update the adapter acts on is missing its fields',
    }),
]);

/** `session/update` notification parameters. */
export const zAcpSessionNotification = z.object({
  sessionId: z.string(),
  update: zAcpSessionUpdate,
});

/**
 * `session/request_permission` request parameters. The adapter reports the
 * requesting tool and picks a rejection option by kind, id, and name, so all
 * three are required: a missing `name` would fault the selection, and an
 * unrecognized `kind` would silently fail to match any rejection.
 */
export const zAcpRequestPermissionRequest = z.looseObject({
  sessionId: z.string(),
  toolCall: z.looseObject({
    toolCallId: z.string(),
    title: z.string().nullish(),
    kind: z.string().nullish(),
  }),
  options: z.array(
    z.looseObject({
      optionId: z.string(),
      name: z.string(),
      kind: z.enum([
        'allow_once',
        'allow_always',
        'reject_once',
        'reject_always',
      ]),
    }),
  ),
});
