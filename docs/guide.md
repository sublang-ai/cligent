<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# cligent guide

## Install

```bash
npm install @sublang/cligent
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
import { Cligent } from '@sublang/cligent';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';

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
import { Cligent } from '@sublang/cligent';
import type { CligentOptions, RunOptions } from '@sublang/cligent';

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
// Per-call overrides win for scalars; permissions are merged by field;
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
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';
const agent = new Cligent(new ClaudeCodeAdapter());
```

**Codex CLI**

```ts
// SDK adapter — wraps @openai/codex-sdk.
import { CodexAdapter } from '@sublang/cligent/adapters/codex';
const agent = new Cligent(new CodexAdapter());
```

**Gemini CLI**

```ts
// Child-process adapter — spawns the gemini CLI and parses its NDJSON stream.
// No SDK peer dependency required.
import { GeminiAdapter } from '@sublang/cligent/adapters/gemini';
const agent = new Cligent(new GeminiAdapter());
```

**OpenCode**

```ts
// SDK adapter — wraps @opencode-ai/sdk.
import { OpenCodeAdapter } from '@sublang/cligent/adapters/opencode';
const agent = new Cligent(new OpenCodeAdapter());
```

## Effort

Set `effort` in constructor defaults or in a `run()` override. The portable
ladder, from least to greatest reasoning depth, is `minimal`, `low`, `medium`,
`high`, `xhigh`, and `max`. Provider-native values remain adapter-scoped:
Claude Code additionally accepts `ultracode`, while Codex additionally accepts
`ultra`. Gemini and OpenCode accept only the portable ladder. The TypeScript
API preserves this correlation, including heterogeneous parallel calls, so a
Claude-specific value is not accepted for a Codex adapter and vice versa.

```ts
import { Cligent } from '@sublang/cligent';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';
import { CodexAdapter } from '@sublang/cligent/adapters/codex';

const claude = new Cligent(new ClaudeCodeAdapter(), {
  effort: 'ultracode',
});
const codex = new Cligent(new CodexAdapter(), {
  effort: 'ultra',
});

// The same adapter-specific vocabulary is available per call.
for await (const event of claude.run('Review this change', {
  effort: 'high',
})) {
  // ...
}
```

The mappings have a few important qualifications:

- **Claude Code:** `ultracode` maps to SDK `effort: 'xhigh'` plus
  `settings.ultracode: true`. Every explicit portable value sets
  `settings.ultracode: false`, so a run can downgrade inherited ultracode
  configuration. `minimal` maps to Claude's lowest native tier, `low`.
  Ultracode requires compatible workflow support and an xhigh-capable model,
  account, and installed runtime. Its delegated workflow can increase token
  use, latency, cost, concurrency, and tool activity.
- **Codex:** `minimal` through `xhigh` use the SDK thread effort field. `max`
  and `ultra` pass through unchanged as `model_reasoning_effort` constructor
  configuration; `ultra` enables automatic delegation. Availability still
  depends on the selected model, account, and installed runtime, and delegation
  can increase token use, latency, cost, concurrency, and tool activity.
- **Gemini:** Effort is applied only for concrete `gemini-3*` or `gemini-2.5*`
  model IDs. Gemini 3 collapses `high`, `xhigh`, and `max` to `HIGH`; Gemini
  2.5 Flash and Flash Lite collapse `xhigh` and `max` to the same maximum
  budget. If the model is omitted, is a CLI alias such as `auto` or `flash`,
  or does not match those model families, the adapter preserves ordinary model
  forwarding and applies no effort override.
- **OpenCode:** Variant mappings depend on the `provider/model` prefix and can
  be lossy. Anthropic collapses `minimal` through `high` to `high` and
  `xhigh`/`max` to `max`; OpenAI collapses `max` to `xhigh`; Google collapses
  `minimal` through `medium` to `low` and `high` through `max` to `high`. An
  unknown provider or malformed or omitted model receives no variant override.

Omitting `effort` sets no effort, orchestration, generated alias, or variant
override and leaves applicable adapter, model, account, and user-configuration
defaults in control.

Use the deeply frozen `EFFORT_SUPPORT` metadata to build selectors or inspect
each built-in adapter's accepted `values`, provider-native
`orchestrationValues`, `modelDependent` flag, and explanatory `notes`.
`getEffortSupport`, `supportedEffortValues`, `isEffortSupported`, and
`assertSupportedEffort` provide matching lookup and validation helpers (`claude`
is accepted as an alias for `claude-code`):

```ts
import { EFFORT_SUPPORT, assertSupportedEffort } from '@sublang/cligent';

console.log(EFFORT_SUPPORT.codex.values);
const requestedEffort: unknown = process.env.CLIGENT_EFFORT;
assertSupportedEffort('codex', requestedEffort, 'effort');
```

This metadata describes values that Cligent can route; it does not guarantee
that a selected model, account, or installed provider runtime supports a value.
If the backend rejects a metadata-accepted value, Cligent surfaces that upstream
failure without substituting a different effort.

The former public option name `reasoningEffort` has been replaced by `effort`.
Programmatic callers must update the property name. Valid legacy tmux-play YAML
is accepted in memory only after the complete document validates. The loader
then makes a bounded best-effort update of direct legacy key tokens when the
source still matches. If the source changes or the write fails, the run keeps
the validated in-memory value and the launcher warns you to rename
`reasoningEffort` to `effort` manually. Conflicting keys, invalid legacy values,
or any other config error reject without writing.

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
import { Cligent } from '@sublang/cligent';
import type { PermissionPolicy } from '@sublang/cligent';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';
import { CodexAdapter } from '@sublang/cligent/adapters/codex';

// PermissionPolicy controls approval posture, broad capabilities, and
// additional workspace-relative writable paths.
//
// mode accepts 'auto' | 'bypass'.
// fileWrite / shellExecute / networkAccess each accept
// 'allow' | 'ask' | 'deny' (default: 'ask' when a policy is provided).
// writablePaths grants extra writable workspace subpaths where the adapter
// has a filesystem sandbox, or is satisfied by ambient workspace access
// otherwise. It is not a command allowlist or network grant.
//
// Adapters translate these to vendor-specific controls:
//   Claude Code  → permissions.allow / ask / deny
//   Codex        → default_permissions + approval_policy
//                  (+ SDK config.approvals_reviewer for mode: 'auto')
//                  (+ generated profile rules for writablePaths)
//                  (lossy: networkAccess 'allow' grants network only when
//                   the policy selects :danger-full-access)
//   Gemini       → coreTools / excludeTools
//   OpenCode     → permission map
const permissions: PermissionPolicy = {
  fileWrite: 'ask',       // prompt the user before creating or modifying files
  shellExecute: 'deny',   // block all shell command execution
  networkAccess: 'allow', // allow HTTP requests without prompting
};

// For a Codex-backed agent that should keep protected auto-mode but still
// run git commands that write metadata, grant the .git subtree explicitly.
const codexGitPermissions: PermissionPolicy = {
  mode: 'auto',
  writablePaths: ['.git'],
};

const codexAgent = new Cligent(new CodexAdapter(), {
  model: 'gpt-5.3-codex',
  permissions: codexGitPermissions,
});

// Set permissions as defaults, or override per-call.
const agent = new Cligent(new ClaudeCodeAdapter(), {
  model: 'claude-opus-4-6',
  permissions,
});

for await (const event of agent.run('Refactor auth module')) {
  // ...
}

// Per-call permissions are merged by field with constructor defaults, except
// writablePaths arrays replace the default array rather than merging items.
// This keeps mode: 'auto' but replaces ['.git'] with ['dist'] for this run.
for await (const event of codexAgent.run('Build release artifacts', {
  permissions: { writablePaths: ['dist'] },
})) {
  // ...
}
```

## Parallel execution

Run multiple `Cligent` instances side-by-side with `Cligent.parallel`:

```ts
import { Cligent } from '@sublang/cligent';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';
import { CodexAdapter } from '@sublang/cligent/adapters/codex';

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
import { runParallel } from '@sublang/cligent';

for await (const event of runParallel([
  {
    adapter: new ClaudeCodeAdapter(),
    prompt: 'Write unit tests',
    options: { model: 'claude-opus-4-6', effort: 'ultracode' },
  },
  {
    adapter: new CodexAdapter(),
    prompt: 'Write integration tests',
    options: { model: 'gpt-5.3-codex', effort: 'ultra' },
  },
])) {
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
