<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# cligent guide

## Install

```bash
npm install cligent
```

Each adapter that uses an SDK has an optional peer dependency. Install only the ones you need:

```bash
npm install @anthropic-ai/claude-agent-sdk   # Claude Code
npm install @openai/codex-sdk                 # Codex CLI
npm install @opencode-ai/sdk                  # OpenCode
# Gemini CLI uses a child process — no SDK required
```

## Quick start

```ts
import { AdapterRegistry, runAgent } from 'cligent';
import { ClaudeCodeAdapter } from 'cligent/adapters/claude-code';

// AdapterRegistry — container that maps agent names to their adapter
// implementations. Register at least one adapter before calling runAgent.
const registry = new AdapterRegistry();
registry.register(new ClaudeCodeAdapter());

// runAgent(agent, prompt, options, registry) → AsyncGenerator<AgentEvent>
//   agent    — identifier matching a registered adapter (e.g. 'claude-code')
//   prompt   — the task description sent to the agent
//   options  — AgentOptions or undefined (pass undefined when no options needed)
//   registry — the AdapterRegistry that resolves the agent name
//
// The returned async generator yields AgentEvent values.
// Each event has a discriminated `type` field and a typed `payload`.
for await (const event of runAgent('claude-code', 'Fix the login bug', { model: 'claude-opus-4-6' }, registry)) {
  switch (event.type) {
    case 'text_delta':
      // Streaming token — concatenate deltas to build the full response.
      process.stdout.write(event.payload.delta);
      break;
    case 'tool_use':
      // The agent is invoking a tool (e.g. Bash, Read, Edit).
      console.log(`Tool: ${event.payload.toolName}`);
      break;
    case 'done':
      // Terminal event — always the last event in the stream.
      // status: 'success' | 'error' | 'interrupted' | 'max_turns' | 'max_budget'
      console.log(`\nFinished: ${event.payload.status}`);
      break;
  }
}
```

## Adapters

Register one or more adapters before calling `runAgent`.

**Claude Code**

```ts
// SDK adapter — wraps @anthropic-ai/claude-agent-sdk.
// Normalises SDKMessage objects into the Unified Event Stream.
import { ClaudeCodeAdapter } from 'cligent/adapters/claude-code';
registry.register(new ClaudeCodeAdapter());
```

**Codex CLI**

```ts
// SDK adapter — wraps @openai/codex-sdk.
import { CodexAdapter } from 'cligent/adapters/codex';
registry.register(new CodexAdapter());
```

**Gemini CLI**

```ts
// Child-process adapter — spawns the gemini CLI and parses its NDJSON stream.
// No SDK peer dependency required.
import { GeminiAdapter } from 'cligent/adapters/gemini';
registry.register(new GeminiAdapter());
```

**OpenCode**

```ts
// SDK adapter — wraps @opencode-ai/sdk.
import { OpenCodeAdapter } from 'cligent/adapters/opencode';
registry.register(new OpenCodeAdapter());
```

## Permissions

> Assumes `registry` and imports from [Quick start](#quick-start).

Control what the agent is allowed to do with `PermissionPolicy`:

```ts
import type { PermissionPolicy } from 'cligent';

// PermissionPolicy — three capability-based primitives that abstract over
// each agent's native permission system.
// Each accepts 'allow' | 'ask' | 'deny' (default: 'ask').
//
// Adapters translate these to vendor-specific controls:
//   Claude Code  → permissions.allow / ask / deny
//   Codex        → sandbox_mode + approval_policy + network_access
//                  (lossy: networkAccess 'ask' maps to networkAccessEnabled: false — no prompt-based network control)
//   Gemini       → coreTools / excludeTools
//   OpenCode     → permission map
const permissions: PermissionPolicy = {
  fileWrite: 'ask',       // prompt the user before creating or modifying files
  shellExecute: 'deny',   // block all shell command execution
  networkAccess: 'allow', // allow HTTP requests without prompting
};

for await (const event of runAgent('claude-code', 'Refactor auth module', { model: 'claude-opus-4-6', permissions }, registry)) {
  // ...
}
```

## Parallel execution

Run multiple agents side-by-side with `runParallel`:

```ts
import { runParallel } from 'cligent';
import type { ParallelTask } from 'cligent';
import { ClaudeCodeAdapter } from 'cligent/adapters/claude-code';
import { CodexAdapter } from 'cligent/adapters/codex';

// ParallelTask — describes one agent invocation in a parallel batch.
//   adapter — an AgentAdapter instance (not a name string)
//   prompt  — task description for this agent
//   options — optional per-task AgentOptions
const tasks: ParallelTask[] = [
  { adapter: new ClaudeCodeAdapter(), prompt: 'Write unit tests', options: { model: 'claude-opus-4-6' } },
  { adapter: new CodexAdapter(), prompt: 'Write integration tests', options: { model: 'gpt-5.3-codex' } },
];

// runParallel(tasks) → AsyncGenerator<AgentEvent>
// Merges the event streams from all tasks. Events are interleaved as they
// arrive. Use event.agent (e.g. 'claude-code', 'codex') to distinguish
// which agent produced each event.
for await (const event of runParallel(tasks)) {
  console.log(`[${event.agent}] ${event.type}`);
}
```

## Abort

> Assumes `registry` and imports from [Quick start](#quick-start).

Cancel a running agent with a standard `AbortController`:

```ts
// Pass an AbortSignal via the abortSignal option for cooperative cancellation.
const ac = new AbortController();
setTimeout(() => ac.abort(), 30_000); // cancel after 30 s

for await (const event of runAgent('claude-code', 'Fix the login bug', { model: 'claude-opus-4-6', abortSignal: ac.signal }, registry)) {
  // On abort the generator emits a final 'done' event with
  // status 'interrupted', then ends.
}
```

## Event types

Every event extends `BaseEvent` and carries a typed `payload`:

- `type` — discriminant tag (see table below, or a namespaced string like `'codex:file_change'`)
- `agent` — which adapter emitted the event (`'claude-code'`, `'codex'`, `'gemini'`, `'opencode'`, …)
- `timestamp` — Unix epoch milliseconds
- `sessionId` — groups all events within one `run()` / `runAgent()` call

| Type | Payload | Description |
| --- | --- | --- |
| `init` | `model`, `cwd`, `tools` | Session started |
| `text` | `content` | Complete text response |
| `text_delta` | `delta` | Streaming text chunk |
| `thinking` | `summary` | Agent reasoning |
| `tool_use` | `toolName`, `toolUseId`, `input` | Tool invocation |
| `tool_result` | `toolUseId`, `status`, `output` | Tool outcome |
| `permission_request` | `toolName`, `toolUseId`, `input` | Agent asks for permission |
| `error` | `code`, `message`, `recoverable` | Error |
| `done` | `status`, `usage`, `durationMs` | Terminal event — always the last event |
