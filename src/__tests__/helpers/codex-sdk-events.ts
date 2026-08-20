// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Canonical Codex SDK event fixtures (codex-201). This helper is included
// in `npm run typecheck`, which resolves the real installed
// `@openai/codex-sdk` declarations (the minimal ambient codex-sdk.d.ts is
// excluded there), so every fixture below is typed against the SDK's
// canonical exported event and item shapes — an invented field or a drifted
// upstream shape fails the typecheck instead of silently driving the
// adapter tests. Only type imports are used; at runtime the fixtures are
// plain objects and the unit tests stay independent of the installed SDK.

import type {
  AgentMessageItem,
  CommandExecutionItem,
  FileChangeItem,
  McpToolCallItem,
  ThreadEvent,
  Usage,
} from '@openai/codex-sdk';

export type { ThreadEvent };

export const CANONICAL_THREAD_ID = 'thread-canonical';

export const canonicalUsage: Usage = {
  input_tokens: 33,
  cached_input_tokens: 12,
  cache_write_input_tokens: 5,
  output_tokens: 44,
  reasoning_output_tokens: 6,
};

export const canonicalCommand: CommandExecutionItem = {
  id: 'item_cmd',
  type: 'command_execution',
  command: 'ls -la /repo',
  aggregated_output: '',
  status: 'in_progress',
};

export const canonicalCommandCompleted: CommandExecutionItem = {
  ...canonicalCommand,
  aggregated_output: 'file.txt\n',
  exit_code: 0,
  status: 'completed',
};

// In-progress shapes are built without exit_code / error: the SDK sets
// exit_code only when the command exits and error only on failed calls, so
// carrying them on an in_progress item would be off-canonical even though
// the fields are optional in the type.
export const canonicalFailingCommandStart: CommandExecutionItem = {
  id: 'item_cmd_failed',
  type: 'command_execution',
  command: 'nope --version',
  aggregated_output: '',
  status: 'in_progress',
};

export const canonicalCommandFailed: CommandExecutionItem = {
  ...canonicalFailingCommandStart,
  aggregated_output: 'sh: nope: command not found\n',
  exit_code: 127,
  status: 'failed',
};

export const canonicalMcpCall: McpToolCallItem = {
  id: 'item_mcp',
  type: 'mcp_tool_call',
  server: 'files',
  tool: 'read',
  arguments: { path: '/repo/file.txt' },
  status: 'in_progress',
};

export const canonicalMcpResult: NonNullable<McpToolCallItem['result']> = {
  content: [{ type: 'text', text: 'file contents' }],
  structured_content: { ok: true },
};

export const canonicalMcpCompleted: McpToolCallItem = {
  ...canonicalMcpCall,
  status: 'completed',
  result: canonicalMcpResult,
};

export const canonicalFailingMcpStart: McpToolCallItem = {
  id: 'item_mcp_failed',
  type: 'mcp_tool_call',
  server: 'files',
  tool: 'write',
  arguments: { path: '/repo/out.txt', contents: 'x' },
  status: 'in_progress',
};

export const canonicalMcpFailed: McpToolCallItem = {
  ...canonicalFailingMcpStart,
  status: 'failed',
  error: { message: 'files server unreachable' },
};

export const canonicalAgentMessage: AgentMessageItem = {
  id: 'item_msg',
  type: 'agent_message',
  text: 'All done',
};

export const canonicalFileChange: FileChangeItem = {
  id: 'item_fc',
  type: 'file_change',
  changes: [
    { path: '/repo/file.txt', kind: 'update' },
    { path: '/repo/new.ts', kind: 'add' },
  ],
  status: 'completed',
};

// One full canonical turn: a shell command and an MCP call running
// concurrently through their lifecycles, an assistant message, and a file
// change, closed by turn.completed. The command's item.updated and the
// non-tool agent_message's item.started must add no unified lifecycle
// event.
export const canonicalToolLifecycleEvents: ThreadEvent[] = [
  { type: 'thread.started', thread_id: CANONICAL_THREAD_ID },
  { type: 'turn.started' },
  { type: 'item.started', item: canonicalCommand },
  {
    type: 'item.updated',
    item: { ...canonicalCommand, aggregated_output: 'fi' },
  },
  { type: 'item.started', item: canonicalMcpCall },
  { type: 'item.completed', item: canonicalCommandCompleted },
  { type: 'item.completed', item: canonicalMcpCompleted },
  { type: 'item.started', item: canonicalAgentMessage },
  { type: 'item.completed', item: canonicalAgentMessage },
  { type: 'item.completed', item: canonicalFileChange },
  { type: 'turn.completed', usage: canonicalUsage },
];

// The lifecycle observed from item.updated onward: the tool_use must be
// announced on the update, not deferred to completion.
export const updateFirstEvents: ThreadEvent[] = [
  {
    type: 'item.updated',
    item: { ...canonicalCommand, aggregated_output: 'fi' },
  },
  { type: 'item.completed', item: canonicalCommandCompleted },
  { type: 'turn.completed', usage: canonicalUsage },
];

// A stream that ends after tool lifecycle items without any turn.* event.
export const toolThenStreamEndEvents: ThreadEvent[] = [
  { type: 'item.started', item: canonicalCommand },
  { type: 'item.completed', item: canonicalCommandCompleted },
];

// Repeated item.updated events for one command item.
export const repeatedUpdateEvents: ThreadEvent[] = [
  { type: 'item.started', item: canonicalCommand },
  {
    type: 'item.updated',
    item: { ...canonicalCommand, aggregated_output: 'fi' },
  },
  {
    type: 'item.updated',
    item: { ...canonicalCommand, aggregated_output: 'file.tx' },
  },
  { type: 'item.completed', item: canonicalCommandCompleted },
  { type: 'turn.completed', usage: canonicalUsage },
];

// A terminal item whose item.started / item.updated were never observed.
export const missedStartEvents: ThreadEvent[] = [
  { type: 'item.completed', item: canonicalCommandCompleted },
  { type: 'turn.completed', usage: canonicalUsage },
];

// Failed terminals for both tool item types.
export const failedCommandEvents: ThreadEvent[] = [
  { type: 'item.started', item: canonicalFailingCommandStart },
  { type: 'item.completed', item: canonicalCommandFailed },
  { type: 'turn.completed', usage: canonicalUsage },
];

export const failedMcpEvents: ThreadEvent[] = [
  { type: 'item.started', item: canonicalFailingMcpStart },
  { type: 'item.completed', item: canonicalMcpFailed },
  { type: 'turn.completed', usage: canonicalUsage },
];

// Two concurrent command items whose lifecycles interleave and complete in
// reverse start order.
export const interleavedCommandA: CommandExecutionItem = {
  id: 'item_cmd_a',
  type: 'command_execution',
  command: 'sleep 2 && echo a',
  aggregated_output: '',
  status: 'in_progress',
};

export const interleavedCommandB: CommandExecutionItem = {
  id: 'item_cmd_b',
  type: 'command_execution',
  command: 'echo b',
  aggregated_output: '',
  status: 'in_progress',
};

export const interleavedParallelEvents: ThreadEvent[] = [
  { type: 'item.started', item: interleavedCommandA },
  { type: 'item.started', item: interleavedCommandB },
  {
    type: 'item.completed',
    item: {
      ...interleavedCommandB,
      aggregated_output: 'b\n',
      exit_code: 0,
      status: 'completed',
    },
  },
  {
    type: 'item.completed',
    item: {
      ...interleavedCommandA,
      aggregated_output: 'a\n',
      exit_code: 0,
      status: 'completed',
    },
  },
  { type: 'turn.completed', usage: canonicalUsage },
];

// The same terminal event delivered twice for one item id.
export const duplicatedCompletionEvents: ThreadEvent[] = [
  { type: 'item.started', item: canonicalCommand },
  { type: 'item.completed', item: canonicalCommandCompleted },
  { type: 'item.completed', item: canonicalCommandCompleted },
  { type: 'turn.completed', usage: canonicalUsage },
];

// A tool item observed before the turn fails.
export const toolThenTurnFailedEvents: ThreadEvent[] = [
  { type: 'item.started', item: canonicalCommand },
  { type: 'item.completed', item: canonicalCommandCompleted },
  {
    type: 'turn.failed',
    error: { message: 'model stream disconnected' },
  },
];
