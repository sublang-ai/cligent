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
# Kimi Code uses an external CLI — no Kimi-specific SDK required
```

For Kimi, install the maintained Kimi Code CLI at Cligent's exact conformance
target. The external Kimi CLI itself requires Node.js 22.19 or newer to install
and run, even though Cligent and its other adapter surfaces support Node.js
18.3:

```bash
npm install -g @moonshot-ai/kimi-code@0.27.0
kimi --version
kimi login
```

`kimi login` performs the one-time Kimi Code OAuth flow required by the exact
0.27 ACP target. Kimi's [provider
configuration](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/providers.html)
can select a Kimi or third-party model after login, but an API-key provider
alone does not satisfy the [0.27 ACP session
gate](https://github.com/MoonshotAI/kimi-code/blob/5cc194956f6f9752d172aa4994385d2d2e7a066f/packages/acp-adapter/src/server.ts#L107-L116).
The adapter inherits the CLI's configuration and credentials; Cligent neither
stores credentials nor launches login for you.

## Quick start

```ts
import { Cligent } from '@sublang/cligent';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';

// Cligent — the primary API surface. Wraps an adapter with role identity,
// session continuity, option merging, and protocol hardening.
const agent = new Cligent(new ClaudeCodeAdapter(), {
  role: 'coder',
  model: 'claude-opus-4-8',
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
  role: 'coder', // injected into every event as event.role
  model: 'claude-opus-4-8',
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

Pass an adapter to the `Cligent` constructor (or to the lower-level
`runAgent` helper).

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

**Kimi Code**

```ts
// ACP adapter — spawns one short-lived `kimi acp` child for each run.
import { KimiAdapter } from '@sublang/cligent/adapters/kimi';
const agent = new Cligent(new KimiAdapter(), {
  effort: 'on',
  permissions: { mode: 'auto' },
});
```

Cligent uses Kimi Code's structured ACP mode rather than print mode, a
persistent server, or a Kimi-specific SDK. The maintained product exposes ACP
as a public integration surface, while the published Kimi agent SDK targets
the retired Python CLI and the successor's Node SDK is not public. ACP preserves
structured text, tool lifecycle, permission requests, cancellation, and the
backend session ID without keeping a resident service.

A fresh run creates an ACP session with `session/new`. A non-empty `resume`
token uses `session/resume`; Cligent does not replay Kimi history as new output.
The backend session ID becomes `DonePayload.resumeToken`, so the next run on the
same `Cligent` instance resumes automatically. Raw Kimi thought chunks are not
included in the Unified Event Stream.

## Effort

Set `effort` in constructor defaults or in a `run()` override. The portable
ladder, from least to greatest reasoning depth, is `minimal`, `low`, `medium`,
`high`, `xhigh`, and `max`. Provider-native values remain adapter-scoped:
Claude Code additionally accepts `ultracode`, while Codex additionally accepts
`ultra`. Gemini and OpenCode accept only the portable ladder. Kimi instead
accepts its provider-native binary values `off` and `on`; those values are not
aliases for portable depth tiers. The TypeScript API preserves this
correlation, including heterogeneous parallel calls, so an adapter-specific
value is not accepted for a different adapter.

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
- **Kimi:** `off` and `on` pass directly to ACP's `thinking` configuration
  option. `on` enables the selected model's native default thinking behavior;
  it does not select a portable Cligent effort tier. When both `model` and
  `effort` are provided, the model is selected before thinking is toggled.

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
agent.run('Start fresh', { resume: false }); // force a new session
agent.run('Use this', { resume: 'other-token' }); // explicit token
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
//   Claude Code  → SDK permissionMode, plus a canUseTool callback
//                  for mixed allow/deny policies
//   Codex        → default_permissions + approval_policy
//                  (+ SDK config.approvals_reviewer for mode: 'auto')
//                  (+ generated profile rules for writablePaths)
//                  (lossy: networkAccess 'allow' grants network only when
//                   the policy selects :danger-full-access)
//   Gemini       → Policy Engine rules via --policy + --approval-mode
//   Kimi         → ACP mode configuration (native default or auto only)
//   OpenCode     → permission map
const permissions: PermissionPolicy = {
  fileWrite: 'ask', // prompt the user before creating or modifying files
  shellExecute: 'deny', // block all shell command execution
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
  model: 'claude-opus-4-8',
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

Kimi has a deliberately narrower headless permission surface:

- Omit `permissions` to preserve the Kimi CLI's native configured rules.
- Use `permissions: { mode: 'auto' }` to select Kimi's native `auto` mode.
  Valid `writablePaths` may accompany `auto`, but the adapter reports them as
  ambient access; it does not enforce them with a filesystem sandbox or turn
  them into additional grants.
- Kimi rejects `mode: 'bypass'` because the CLI's `yolo` mode is not equivalent
  to Cligent's unchecked bypass contract. It also rejects any supplied policy
  without `mode`, including an empty policy or per-capability fields, because
  ACP cannot deterministically replace Kimi's earlier native rule decisions.
- Explicit `allowedTools` or `disallowedTools` values are unsupported and fail
  before spawn, including empty arrays. `maxTurns` and `maxBudgetUsd` likewise
  fail before spawn because Kimi ACP has no matching per-run controls.

If Kimi still sends an ACP permission request, the headless adapter emits a
`permission_request` event for observability and rejects the operation.

## Parallel execution

Run multiple `Cligent` instances side-by-side with `Cligent.parallel`:

```ts
import { Cligent } from '@sublang/cligent';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';
import { CodexAdapter } from '@sublang/cligent/adapters/codex';

const coder = new Cligent(new ClaudeCodeAdapter(), {
  role: 'coder',
  model: 'claude-opus-4-8',
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
    options: { model: 'claude-opus-4-8', effort: 'ultracode' },
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

for await (const event of agent.run('Fix the login bug', {
  abortSignal: ac.signal,
})) {
  // On abort the generator emits a final 'done' event with
  // status 'interrupted', then ends.
}
```

## Event types

`Cligent.run()` yields `CligentEvent` values, which extend `AgentEvent` with an optional `role` field. Every event carries a typed `payload`:

- `type` — discriminant tag (see table below, or a namespaced string like `'codex:file_change'`)
- `agent` — which adapter emitted the event (`'claude-code'`, `'codex'`, `'gemini'`, `'kimi'`, `'opencode'`, …)
- `role` — task-level identity from `CligentOptions.role` (undefined when not set)
- `timestamp` — Unix epoch milliseconds
- `sessionId` — groups all events within one `run()` call

| Type                 | Payload                                         | Description                            |
| -------------------- | ----------------------------------------------- | -------------------------------------- |
| `init`               | `model`, `cwd`, `tools`                         | Session started                        |
| `text`               | `content`                                       | Complete text response                 |
| `text_delta`         | `delta`                                         | Streaming text chunk                   |
| `thinking`           | `summary`                                       | Agent reasoning                        |
| `tool_use`           | `toolName`, `toolUseId`, `input`                | Tool invocation                        |
| `tool_result`        | `toolUseId`, `status`, `output`                 | Tool outcome                           |
| `permission_request` | `toolName`, `toolUseId`, `input`                | Agent asks for permission              |
| `error`              | `code`, `message`, `recoverable`                | Error                                  |
| `done`               | `status`, `resumeToken?`, `usage`, `durationMs` | Terminal event — always the last event |
