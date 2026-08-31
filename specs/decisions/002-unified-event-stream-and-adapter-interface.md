<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-002: Unified Event Stream and Adapter Interface

## Status

Accepted

## Context

[DR-001](001-unified-cli-agent-interface-architecture.md) established the architectural direction: a TypeScript library with async generator interface across CLI agents. This decision defines the concrete interface design—event types, adapter contract, and permission model.
OpenCode 1.18.25's prompt schema exposes no per-run `steps` member; its step ceiling is persistent agent configuration, so an undeclared prompt member is ineffective and mutating the agent would escape one run's scope [[13]].

## Decision

### Driver-Adapter Architecture

```text
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Cligent   │────▶│   Adapter    │────▶│   Agent     │
│    Core     │◀────│   (Driver)   │◀────│  (Backend)  │
└─────────────┘     └──────────────┘     └─────────────┘
       │                                        │
       ▼                                        ▼
  AgentEvent                              Native Events
```

The core normalizes heterogeneous agent outputs into a **Unified Event Stream (UES)**.
Adapter implementations should align with vendor CLI documentation and repositories for event mapping and option semantics (Claude Code [[1]][[2]], Codex CLI [[3]][[4]], Gemini CLI [[5]], Kimi Code [[12]], OpenCode [[6]]).

### Unified Event Stream

Nine event types cover the agent lifecycle:

| Event | Purpose |
| ----- | ------- |
| `init` | Session start, capabilities |
| `text` | Complete assistant message |
| `text_delta` | Streaming token |
| `tool_use` | Tool invocation request |
| `tool_result` | Tool execution outcome |
| `thinking` | Reasoning summary (if exposed) |
| `error` | Recoverable/fatal errors |
| `permission_request` | Approval needed |
| `done` | Session end with usage stats |

**Extensibility:** Adapters may emit additional namespaced event types (e.g., `opencode:step_start`, `codex:file_change`, `codex:plan_update`). Consumers should ignore unknown types. If `thinking` is emitted, it should be a safe summary rather than raw chain-of-thought.

#### Base Event

```typescript
type AgentEventType =
  | 'init' | 'text' | 'text_delta' | 'tool_use' | 'tool_result'
  | 'thinking' | 'error' | 'permission_request' | 'done';

type AgentType =
  | 'claude-code' | 'codex' | 'gemini' | 'kimi' | 'opencode' | string;

interface BaseEvent {
  type: AgentEventType | string;  // string allows namespaced extensions
  agent: AgentType;
  timestamp: number;
  sessionId: string;
  metadata?: Record<string, unknown>;  // vendor-specific fields
}

// CligentEvent adds role attribution (DR-003); adapters emit AgentEvent only.
type CligentEvent = AgentEvent & {
  role?: string;  // injected by Cligent, not by adapters
};
```

Adapters emit `AgentEvent`; the `Cligent` layer ([DR-003](003-role-scoped-session-management.md)) wraps these as `CligentEvent` with optional `role` injection.

#### Key Payloads

```typescript
interface InitPayload {
  model: string;
  cwd: string;
  tools: string[];
  capabilities?: Record<string, unknown>;  // feature discovery
}

interface TextPayload {
  content: string;
}

interface TextDeltaPayload {
  delta: string;
}

interface ThinkingPayload {
  summary: string;
}

interface ErrorPayload {
  code?: string;
  message: string;
  recoverable: boolean;
}

interface PermissionRequestPayload {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  reason?: string;
}

interface ToolUsePayload {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  description?: string;
}

interface ToolResultPayload {
  toolUseId: string;
  toolName: string;
  status: 'success' | 'error' | 'denied';
  output: unknown;
  durationMs?: number;
}

interface TokenUsage {
  input: {
    total: number;           // inclusive of cache reads and writes
    uncached?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  output: {
    total: number;           // inclusive of reasoning or thinking
    visible?: number;
    reasoning?: number;
  };
}

interface UsageCost {
  amount: number;
  currency: 'USD';
  source: 'agent-estimate' | 'provider-reported' | 'account-estimate';
}

interface UsageRecord {
  model?: string;
  provider?: string;
  requests?: number;
  tokens: TokenUsage;
  cost?: UsageCost;
  pricedUnits?: Array<{ name: string; quantity: number }>;
}

interface DoneUsage {
  toolUses: number;
  tokens?: {
    coverage: 'complete' | 'partial';
    totals: TokenUsage;
    records?: UsageRecord[];
  };
  cost?: UsageCost;
}

interface DonePayload {
  status: 'success' | 'error' | 'interrupted' | 'max_turns' | 'max_budget';
  result?: string;
  resumeToken?: string;  // backend-resumable session token, if supported (DR-003)
  usage: DoneUsage;
  durationMs: number;
}

type AgentEvent =
  | (BaseEvent & { type: 'init'; payload: InitPayload })
  | (BaseEvent & { type: 'text'; payload: TextPayload })
  | (BaseEvent & { type: 'text_delta'; payload: TextDeltaPayload })
  | (BaseEvent & { type: 'tool_use'; payload: ToolUsePayload })
  | (BaseEvent & { type: 'tool_result'; payload: ToolResultPayload })
  | (BaseEvent & { type: 'thinking'; payload: ThinkingPayload })
  | (BaseEvent & { type: 'error'; payload: ErrorPayload })
  | (BaseEvent & { type: 'permission_request'; payload: PermissionRequestPayload })
  | (BaseEvent & { type: 'done'; payload: DonePayload })
  | (BaseEvent & { type: `${string}:${string}`; payload: unknown });
```

Adapters should emit `init` first when possible to establish capabilities.

`DoneUsage.tokens` is the optional authentic accounting report defined by
[DR-014](014-unified-token-usage-breakdown.md).
Its input and output totals are inclusive, its cache and reasoning details are
exact subsets, and its coverage states whether all causally owned requests in
the invocation are represented.
An absent report or detail is unavailable, while a present zero is measured;
no producer shall emit a numeric placeholder or allocate an unexplained
residual by estimation.
`DoneUsage.cost`, where present, is a provenance-bearing value supplied by the
runtime rather than a price Cligent calculated.
`toolUses` remains independently meaningful and shall preserve the count of
normalized tool calls the adapter observed even when token and cost reports are
absent.

### Unified Permission Model (UPM)

Capability-based primitives map to vendor-specific controls (not always 1:1):

| Capability | Description | Claude Code | Codex | Gemini | Kimi | OpenCode |
| ---------- | ----------- | ----------- | ----- | ------ | ---- | -------- |
| `fileWrite` | Create/modify files | `permissions.allow/ask/deny` for `Write(...)` [[8]] | `sandbox_mode` + `approval_policy` [[9]] | Policy Engine rules for `replace` / `write_file` [[10]] | no deterministic ACP mapping; reject a no-mode provided policy [[12]] | `permission` map for `edit` [[11]] |
| `shellExecute` | Run shell commands | `permissions.allow/ask/deny` for `Bash(...)` [[8]] | `sandbox_mode` + `approval_policy` [[9]] | Policy Engine rules for `run_shell_command` [[10]] | no deterministic ACP mapping; reject a no-mode provided policy [[12]] | `permission` map for `bash` [[11]] |
| `networkAccess` | HTTP requests, external APIs | `permissions.allow/ask/deny` for `WebFetch` [[8]] | `sandbox_mode` + `network_access` + `approval_policy` [[9]] | Policy Engine rules for `google_web_search` / `web_fetch` [[10]] | no deterministic ACP mapping; reject a no-mode provided policy [[12]] | `permission` map for `webfetch` [[11]] |

```typescript
type PermissionLevel = 'allow' | 'ask' | 'deny';

interface PermissionPolicy {
  fileWrite?: PermissionLevel;     // default: 'ask'
  shellExecute?: PermissionLevel;  // default: 'ask'
  networkAccess?: PermissionLevel; // default: 'ask'
}

/** Reasoning depth, ordered least → greatest. Adapters whose SDK lacks a tier
    collapse lossy per their own spec (see engine-42). */
type ReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';
```

Adapters translate these primitives to vendor-specific controls where supported.
Omitted capability fields default to `'ask'` inside a provided policy; omitting the policy leaves adapter-native defaults in effect per [DR-005](005-per-adapter-permission-configuration.md).
An adapter whose vendor protocol cannot enforce a provided policy shall reject before backend invocation rather than weaken it; Kimi's exact boundary is [[kimi-7](../packages/adapters/kimi.md#kimi-7)].

### Adapter Interface

```typescript
interface AgentAdapter {
  readonly agent: AgentType;

  /** Must be safe for concurrent calls on the same instance unless the
      adapter explicitly documents an environmental constraint (DR-003).
      Each call shall create fresh run-local state except for the cumulative
      accounting state narrowly permitted by engine-37 and engine-38. */
  run(
    prompt: string,
    options?: AgentOptions
  ): AsyncGenerator<AgentEvent, void, void>;

  isAvailable(): Promise<boolean>;
}

interface AgentOptions {
  cwd?: string;
  model?: string;
  permissions?: PermissionPolicy;
  maxTurns?: number;
  maxBudgetUsd?: number;
  reasoningEffort?: ReasoningEffort;  // adapter-mapped per engine-20
  resume?: string;             // backend session token for resumption
  abortSignal?: AbortSignal;
  allowedTools?: string[];     // whitelist: only these tools can be used
  disallowedTools?: string[];  // blacklist: these tools cannot be used
}
```

The OpenCode adapter shall reject an explicitly supplied `maxTurns`, including zero, before SDK loading or backend work rather than claim an ineffective prompt limit or mutate persistent agent configuration.

Tool filtering: if `allowedTools` is set, only listed tools are available; `disallowedTools` further excludes from that set. Tool names are exact identifiers unless an adapter explicitly documents pattern support. Adapters should emit `permission_request` when user decision is required and handle approvals via adapter-native mechanisms (SDK callbacks, CLI prompts). Headless adapters may not support interactive approvals.

Callers interact with adapters through `Cligent` instances ([DR-003](003-role-scoped-session-management.md)), which handle protocol hardening, session continuity, role attribution, and option merging.

### Session Control

Interruption via `AbortSignal`, passed as a per-call override through `Cligent.run()` ([DR-003](003-role-scoped-session-management.md)):

```typescript
const controller = new AbortController();
const stream = agent.run(prompt, { abortSignal: controller.signal });

// Soft interrupt
controller.abort();
```

### Parallel Execution

```typescript
// Cligent.parallel() merges streams from multiple Cligent instances.
// Events always carry agent identity and carry role when it is configured.
for await (const event of Cligent.parallel([
  { agent: coder, prompt: 'Fix lint errors' },
  { agent: reviewer, prompt: 'Review the fix' },
])) { /* event.agent, event.role */ }
```

## Consequences

- **Adapters** translate native events to UES; one adapter implementation per agent type, instantiate one or more adapter instances as needed; adapters are run-local and thread-safe for concurrent `run()` calls under [[engine-18](../packages/engine.md#engine-18)] unless they retain [[engine-37](../packages/engine.md#engine-37)]'s cumulative baseline and [[engine-38](../packages/engine.md#engine-38)]'s ordering queue or document an environmental constraint ([DR-003](003-role-scoped-session-management.md))
- **`Cligent` class** is the primary API ([DR-003](003-role-scoped-session-management.md)) — wraps adapter with role config, session state, and protocol hardening
- **UPM** uses capability primitives (`fileWrite`, `shellExecute`, `networkAccess`) mapped by adapters to vendor controls
- **AbortSignal** standardizes interruption (no custom `interrupt()` method)
- **Session resumption** via `resumeToken` in `DonePayload`; `Cligent` auto-injects on subsequent calls; adapters that don't support resumption omit the token
- **Role attribution** via the optional `role` field on `CligentEvent` (not `BaseEvent`) when configured, distinguishing multiple sessions on the same backend; every event retains backend `agent`, and adapters do not emit `role`
- **Interactive approvals** rely on adapter-native mechanisms; headless adapters may not support them
- **Tool filtering** via `allowedTools`/`disallowedTools` is fail-closed; adapters with no exact registry-control surface reject explicit restrictions
- **Budgeting**: Claude Code supports `maxTurns` and `maxBudgetUsd`; OpenCode rejects explicit `maxTurns` because its pinned runtime exposes no exact per-run control and maps no `maxBudgetUsd` member
- **MCP integration** deferred to adapter implementation [[7]]
- **Extensibility** via namespaced events, `metadata`, and `capabilities` fields
- **Token accounting** is explicitly reported or unavailable; measured zero is
  distinct from missing totals, and tool-call counts remain independent

## References

[1]: https://code.claude.com/docs/en/overview "Claude Code documentation"
[2]: https://github.com/anthropics/claude-code "Claude Code GitHub repository"
[3]: https://github.com/openai/codex "OpenAI Codex CLI GitHub repository"
[4]: https://developers.openai.com/codex/cli/features/ "Codex CLI features"
[5]: https://github.com/google-gemini/gemini-cli "Gemini CLI GitHub repository"
[6]: https://github.com/anomalyco/opencode "OpenCode GitHub repository"
[7]: https://modelcontextprotocol.io/specification/2025-11-25 "MCP Specification"
[8]: https://code.claude.com/docs/en/settings "Claude Code settings (permissions)"
[9]: https://developers.openai.com/codex/security "Codex security and sandbox/approvals"
[10]: https://geminicli.com/docs/reference/policy-engine/ "Gemini CLI Policy Engine"
[11]: https://opencode.ai/docs/permissions "OpenCode permissions"
[12]: https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html "Kimi Code ACP reference"
[13]: https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/session/prompt.ts "OpenCode 1.18.25 prompt schema and agent step limit"
