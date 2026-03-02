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
import { Cligent } from 'cligent';
import { ClaudeCodeAdapter } from 'cligent/adapters/claude-code';

// Cligent — the primary API surface. Wraps an adapter with role identity,
// session continuity, option merging, and protocol hardening.
const agent = new Cligent(new ClaudeCodeAdapter(), {
  role: 'coder',
  model: 'claude-opus-4-6',
});

// agent.run(prompt, overrides?) → AsyncGenerator<CligentEvent>
// CligentEvent extends AgentEvent with an optional `role` field.
// Each event has a discriminated `type` field and a typed `payload`.
for await (const event of agent.run('Fix the login bug')) {
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

## Cligent class

`Cligent` is the recommended way to interact with adapters. It provides:

- **Role identity** — tag every event with a task-level role (e.g. `'coder'`, `'reviewer'`)
- **Session continuity** — automatically resume previous sessions via `resumeToken`
- **Option merging** — set defaults in the constructor, override per-call
- **Single-flight guard** — prevents concurrent `run()` calls on the same instance
- **Protocol hardening** — guarantees exactly one `done` event per call, synthesizes error/done on adapter failures, handles abort racing

```ts
import { Cligent } from 'cligent';
import type { CligentOptions, RunOptions } from 'cligent';

// Constructor: Cligent(adapter, options?)
// CligentOptions — instance-level defaults (no abortSignal, no resume).
const agent = new Cligent(adapter, {
  role: 'coder',        // injected into every event as event.role
  model: 'claude-opus-4-6',
  permissions: { fileWrite: 'allow', shellExecute: 'ask' },
  maxTurns: 10,
});

// run(prompt, overrides?) → AsyncGenerator<CligentEvent>
// RunOptions extends CligentOptions with abortSignal and resume.
// Per-call overrides win for scalars; permissions are deep-merged;
// allowedTools/disallowedTools arrays are replaced entirely.
for await (const event of agent.run('Fix the bug', {
  model: 'claude-sonnet-4-6', // overrides the default
  abortSignal: controller.signal,
})) {
  // event.role === 'coder' (always from constructor defaults)
}
```

## Adapters

Pass an adapter to the `Cligent` constructor (or to `runAgent` via a registry).

**Claude Code**

```ts
// SDK adapter — wraps @anthropic-ai/claude-agent-sdk.
// Normalises SDKMessage objects into the Unified Event Stream.
import { ClaudeCodeAdapter } from 'cligent/adapters/claude-code';
const agent = new Cligent(new ClaudeCodeAdapter());
```

**Codex CLI**

```ts
// SDK adapter — wraps @openai/codex-sdk.
import { CodexAdapter } from 'cligent/adapters/codex';
const agent = new Cligent(new CodexAdapter());
```

**Gemini CLI**

```ts
// Child-process adapter — spawns the gemini CLI and parses its NDJSON stream.
// No SDK peer dependency required.
import { GeminiAdapter } from 'cligent/adapters/gemini';
const agent = new Cligent(new GeminiAdapter());
```

**OpenCode**

```ts
// SDK adapter — wraps @opencode-ai/sdk.
import { OpenCodeAdapter } from 'cligent/adapters/opencode';
const agent = new Cligent(new OpenCodeAdapter());
```

## Session continuity

When an adapter's `done` event includes a `resumeToken`, `Cligent` stores it
and automatically injects it as the `resume` option on the next `run()` call.

```ts
// First run — adapter returns a resumeToken in the done payload.
for await (const event of agent.run('Refactor the auth module')) {
  // ...
}
console.log(agent.resumeToken); // e.g. 'session-abc-123'

// Second run — Cligent auto-injects resume: 'session-abc-123'.
// The agent picks up where it left off.
for await (const event of agent.run('Now add tests for it')) {
  // ...
}

// Override resume behavior per-call via RunOptions:
agent.run('Start fresh', { resume: false });       // force a new session
agent.run('Use this', { resume: 'other-token' });  // explicit token
```

## Permissions

> Assumes imports from [Quick start](#quick-start).

Control what the agent is allowed to do with `PermissionPolicy`:

```ts
import { Cligent } from 'cligent';
import type { PermissionPolicy } from 'cligent';
import { ClaudeCodeAdapter } from 'cligent/adapters/claude-code';

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

// Set permissions as defaults, or override per-call.
const agent = new Cligent(new ClaudeCodeAdapter(), {
  model: 'claude-opus-4-6',
  permissions,
});

for await (const event of agent.run('Refactor auth module')) {
  // ...
}
```

## Parallel execution

Run multiple `Cligent` instances side-by-side with `Cligent.parallel`:

```ts
import { Cligent } from 'cligent';
import { ClaudeCodeAdapter } from 'cligent/adapters/claude-code';
import { CodexAdapter } from 'cligent/adapters/codex';

const coder = new Cligent(new ClaudeCodeAdapter(), {
  role: 'coder',
  model: 'claude-opus-4-6',
});
const reviewer = new Cligent(new CodexAdapter(), {
  role: 'reviewer',
  model: 'gpt-5.3-codex',
});

// Cligent.parallel(tasks) → AsyncGenerator<CligentEvent>
// Each task's run() is fully hardened (error isolation, abort, exactly-one-done).
// Events are interleaved as they arrive. Use event.agent to identify the
// backend and event.role to identify the task.
for await (const event of Cligent.parallel([
  { agent: coder, prompt: 'Write unit tests' },
  { agent: reviewer, prompt: 'Review the auth module' },
])) {
  console.log(`[${event.role}/${event.agent}] ${event.type}`);
}
```

Each task can have its own `abortSignal` via `overrides`. A shared signal
aborts all tasks; per-task signals abort only that task.

### Low-level parallel (runParallel)

For adapter-level parallel execution without `Cligent` wrapping, use `runParallel`:

```ts
import { runParallel } from 'cligent';
import type { ParallelTask } from 'cligent';

const tasks: ParallelTask[] = [
  { adapter: new ClaudeCodeAdapter(), prompt: 'Write unit tests', options: { model: 'claude-opus-4-6' } },
  { adapter: new CodexAdapter(), prompt: 'Write integration tests', options: { model: 'gpt-5.3-codex' } },
];

for await (const event of runParallel(tasks)) {
  console.log(`[${event.agent}] ${event.type}`);
}
```

## Abort

> Assumes imports from [Quick start](#quick-start).

Cancel a running agent with a standard `AbortController`:

```ts
// Pass an AbortSignal via RunOptions for cooperative cancellation.
const ac = new AbortController();
setTimeout(() => ac.abort(), 30_000); // cancel after 30 s

for await (const event of agent.run('Fix the login bug', { abortSignal: ac.signal })) {
  // On abort the generator emits a final 'done' event with
  // status 'interrupted', then ends.
}
```

## Event types

`Cligent.run()` yields `CligentEvent` values, which extend `AgentEvent` with an optional `role` field. Every event carries a typed `payload`:

- `type` — discriminant tag (see table below, or a namespaced string like `'codex:file_change'`)
- `agent` — which adapter emitted the event (`'claude-code'`, `'codex'`, `'gemini'`, `'opencode'`, …)
- `role` — task-level identity from `CligentOptions.role` (undefined when not set)
- `timestamp` — Unix epoch milliseconds
- `sessionId` — groups all events within one `run()` call

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
| `done` | `status`, `resumeToken?`, `usage`, `durationMs` | Terminal event — always the last event |
