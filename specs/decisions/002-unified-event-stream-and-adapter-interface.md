<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-002: Unified Event Stream and Adapter Interface

## Status

Accepted

## Context

[DR-001](001-unified-cli-agent-interface-architecture.md) established the architectural direction: a TypeScript library with async generator interface across CLI agents. This decision defines the concrete interface design—event types, adapter contract, and permission model.

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
Adapter implementations should align with vendor CLI documentation and repositories for event mapping and option semantics (Claude Code [^1][^2], Codex CLI [^3][^4], Gemini CLI [^5], OpenCode [^6]).

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

type AgentType = 'claude-code' | 'codex' | 'gemini' | 'opencode' | string;

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

interface DonePayload {
  status: 'success' | 'error' | 'interrupted' | 'max_turns' | 'max_budget';
  result?: string;
  resumeToken?: string;  // backend-resumable session token, if supported (DR-003)
  usage: {
    inputTokens: number;
    outputTokens: number;
    toolUses: number;
    totalCostUsd?: number;
  };
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

### Unified Permission Model (UPM)

Capability-based primitives map to vendor-specific controls (not always 1:1):

| Capability | Description | Claude Code | Codex | Gemini | OpenCode |
| ---------- | ----------- | ----------- | ----- | ------ | -------- |
| `fileWrite` | Create/modify files | `permissions.allow/ask/deny` for `Write(...)` [^8] | `sandbox_mode` + `approval_policy` [^9] | `coreTools`/`excludeTools` (edit tools) [^10] | `permission` map for `edit` [^11] |
| `shellExecute` | Run shell commands | `permissions.allow/ask/deny` for `Bash(...)` [^8] | `sandbox_mode` + `approval_policy` [^9] | `coreTools`/`excludeTools` for `ShellTool` [^10] | `permission` map for `bash` [^11] |
| `networkAccess` | HTTP requests, external APIs | `permissions.allow/ask/deny` for `WebFetch` [^8] | `sandbox_mode` + `network_access` + `approval_policy` [^9] | `coreTools`/`excludeTools` for web tools [^10] | `permission` map for `webfetch` [^11] |

```typescript
type PermissionLevel = 'allow' | 'ask' | 'deny';

interface PermissionPolicy {
  fileWrite?: PermissionLevel;     // default: 'ask'
  shellExecute?: PermissionLevel;  // default: 'ask'
  networkAccess?: PermissionLevel; // default: 'ask'
}
```

Adapters translate these primitives to vendor-specific controls where supported (e.g., Claude Code `permissions.allow/ask/deny` [^8], Codex `sandbox_mode` + `approval_policy` with optional `network_access` [^9], Gemini `coreTools`/`excludeTools` [^10], OpenCode `permission` map [^11]). Omitted capabilities default to `'ask'`.

### Adapter Interface

```typescript
interface AgentAdapter {
  readonly agent: AgentType;

  /** Must be safe for concurrent calls on the same instance unless the
      adapter explicitly documents an environmental constraint (DR-003).
      Each call shall create fresh local state; run() shall not mutate
      adapter instance state. */
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
  resume?: string;             // backend session token for resumption
  abortSignal?: AbortSignal;
  allowedTools?: string[];     // whitelist: only these tools can be used
  disallowedTools?: string[];  // blacklist: these tools cannot be used
}
```

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
// Cligent.parallel() merges streams from multiple role-scoped instances.
// Events carry both agent (backend) and role (task) identity.
for await (const event of Cligent.parallel([
  { agent: coder, prompt: 'Fix lint errors' },
  { agent: reviewer, prompt: 'Review the fix' },
])) { /* event.agent, event.role */ }
```

## Consequences

- **Adapters** translate native events to UES; one adapter implementation per agent type, instantiate one or more adapter instances as needed; adapters are stateless and thread-safe for concurrent `run()` calls unless they document an environmental constraint ([DR-003](003-role-scoped-session-management.md#adapter-thread-safety))
- **`Cligent` class** is the primary API ([DR-003](003-role-scoped-session-management.md)) — wraps adapter with role config, session state, and protocol hardening
- **UPM** uses capability primitives (`fileWrite`, `shellExecute`, `networkAccess`) mapped by adapters to vendor controls
- **AbortSignal** standardizes interruption (no custom `interrupt()` method)
- **Session resumption** via `resumeToken` in `DonePayload`; `Cligent` auto-injects on subsequent calls; adapters that don't support resumption omit the token
- **Role attribution** via `role` field on `CligentEvent` (not `BaseEvent`), distinguishing multiple sessions on the same backend; adapters do not emit `role`
- **Interactive approvals** rely on adapter-native mechanisms; headless adapters may not support them
- **Tool filtering** via `allowedTools`/`disallowedTools` supported by all agents; implementation varies (CLI flags, permissions config, policy engine)
- **Budgeting**: `maxTurns` supported by Claude Code, OpenCode (`steps`), Gemini (`maxSessionTurns`); `maxBudgetUsd` only by Claude Code
- **MCP integration** deferred to adapter implementation [^7]
- **Extensibility** via namespaced events, `metadata`, and `capabilities` fields

## References

[^1]: Claude Code documentation: <https://code.claude.com/docs/en/overview>
[^2]: Claude Code GitHub repository: <https://github.com/anthropics/claude-code>
[^3]: OpenAI Codex CLI GitHub repository: <https://github.com/openai/codex>
[^4]: Codex CLI features: <https://developers.openai.com/codex/cli/features/>
[^5]: Gemini CLI GitHub repository: <https://github.com/google-gemini/gemini-cli>
[^6]: OpenCode GitHub repository: <https://github.com/anomalyco/opencode>
[^7]: MCP Specification: <https://modelcontextprotocol.io/specification/2025-11-25>
[^8]: Claude Code settings (permissions): <https://code.claude.com/docs/en/settings>
[^9]: Codex security and sandbox/approvals: <https://developers.openai.com/codex/security>
[^10]: Gemini CLI configuration: <https://geminicli.com/docs/cli/configuration/>
[^11]: OpenCode permissions: <https://opencode.ai/docs/permissions>
