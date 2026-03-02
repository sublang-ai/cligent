<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-003: Role-Scoped Session Management

## Status

Accepted

## Context

[DR-002](002-unified-event-stream-and-adapter-interface.md) defined the Unified Event Stream, adapter contract, and permission model. With those foundations in place, the remaining question is how callers invoke adapters and manage sessions. Production scenarios show a need for:

1. **Multi-instance support.** Two roles (e.g., coder, reviewer) may use the same agent type with different configs. Keying by agent-type string cannot represent this.
2. **Session continuity.** Multi-step workflows (code → lint → review) require resume tokens threaded across calls without manual plumbing.
3. **Role attribution.** When two sessions use the same backend, `event.agent` alone cannot distinguish them.

## Decision

### Cligent Class

A `Cligent` instance is the primary API surface. It wraps an adapter with role identity, default options, session state, and protocol hardening.

```text
┌────────────────────────────────────────────────────────┐
│                   User Application                     │
│                                                        │
│  ┌──────────┐   ┌──────────┐         Cligent instances │
│  │  Cligent  │   │  Cligent  │        hold role config  │
│  │  "coder"  │   │"reviewer" │        + session state   │
│  └─────┬─────┘   └─────┬─────┘                         │
└────────┼────────────────┼──────────────────────────────┘
         │  shared        │
    ┌────▼────────────────▼────┐
    │   ClaudeCodeAdapter      │     Stateless translator
    │   (one instance, shared) │     (thread-safe run())
    └──────────┬───────────────┘
               ▼
       claude-code (installed once)
```

```typescript
class Cligent {
  constructor(adapter: AgentAdapter, options?: CligentOptions);

  /** Yield events for one prompt. Merges instance defaults with per-call
      overrides, applies protocol hardening, injects role. */
  run(prompt: string, overrides?: RunOptions): AsyncGenerator<CligentEvent, void, void>;

  /** Merge and interleave events from multiple Cligent instances. */
  static parallel(
    tasks: Array<{ agent: Cligent; prompt: string; overrides?: RunOptions }>
  ): AsyncGenerator<CligentEvent, void, void>;
}

/** Instance-level defaults. Excludes call-scoped fields (abortSignal, resume). */
interface CligentOptions {
  role?: string;  // task-level identity (e.g. 'coder', 'reviewer')
  cwd?: string;
  model?: string;
  permissions?: PermissionPolicy;
  maxTurns?: number;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
}

/** Per-call overrides. Adds call-scoped fields to CligentOptions. */
interface RunOptions extends CligentOptions {
  abortSignal?: AbortSignal;
  resume?: string | false;  // string: explicit token, false: force fresh session
}
```

### Three-Layer Separation

| Layer | Responsibility | State | Shared? |
|-------|---------------|-------|---------|
| **Adapter** | Vendor translation (SDK/CLI ↔ `AgentEvent`) | Stateless; constructor holds only DI deps | Yes — one instance per agent type |
| **Cligent** | Role config, session continuity, protocol hardening, role attribution | `resumeToken`, `role`, default options | No — one per role |
| **`run()` call** | Single prompt execution | Per-call overrides (`abortSignal`, model) | N/A |

### Role Attribution

`BaseEvent.agent` is backend identity (`'claude-code'`). When two roles use the same backend, events are indistinguishable by `agent` alone. `Cligent` adds a top-level `role` field to emitted `CligentEvent` values (defined in [DR-002](002-unified-event-stream-and-adapter-interface.md#base-event)). `role` is `undefined` when `CligentOptions.role` is not set — backward-compatible with raw `AgentEvent` consumers.

### Single-Flight Enforcement

A `Cligent` instance allows at most one active `run()` at a time. Calling `run()` while a previous generator is still active shall throw. This prevents concurrent mutation of `resumeToken`. To run the same role concurrently, create separate `Cligent` instances.

### Session Continuity via Resume Token

`Cligent` tracks a `resumeToken` — a backend-resumable identifier distinct from `sessionId` (which is a transport-level correlation tag).

- Adapters that support resumption surface the token via `DonePayload.resumeToken`.
- On each completed `run()`, `Cligent` captures `resumeToken` from the `done` event if present.
- On subsequent `run()` calls, `Cligent` auto-injects `resume: resumeToken` into adapter options — unless the caller explicitly overrides `resume`.
- Adapters that do not support resumption simply never set `resumeToken`; auto-resume is a no-op.

No capability flag is needed. The presence or absence of `resumeToken` in `done` is sufficient.

### Option Merge Semantics

`run(prompt, overrides?)` merges `CligentOptions` instance defaults with per-call `RunOptions` overrides:

| Field | Merge rule |
|-------|-----------|
| `permissions` | Deep merge — per-call fields override matching defaults; unset fields inherit |
| `allowedTools`, `disallowedTools` | Replace — per-call array replaces default entirely |
| `abortSignal` | Per-call only (not in `CligentOptions`) |
| `resume` | Per-call only; explicit string overrides auto-inject; `false` forces fresh session; absent means auto-inject from `resumeToken` |
| All other scalar fields | Per-call wins if set; otherwise default |

### Adapter Thread Safety

Adapters shared across `Cligent` instances must be safe for concurrent `run()` calls: `run()` shall not mutate adapter instance state, and each call shall create fresh local state. Adapters that manage external resources (e.g., an adapter spawning a managed server on a fixed port) may have environmental constraints that prevent true concurrent execution; such adapters shall document this limitation. Callers needing concurrent sessions on constrained adapters should instantiate separate adapter instances with distinct resource configurations.

## Consequences

- **`Cligent` is the primary API** — wraps adapter + role config + session state
- **Adapters unchanged** — stateless translators, interface contract from [DR-002](002-unified-event-stream-and-adapter-interface.md) preserved
- **Protocol hardening** (abort racing, synthetic done/error, post-done suppression) moves into `Cligent.prototype.run()`
- **`Cligent.parallel()`** takes `Cligent` instances, interleaving `CligentEvent` streams
- **`CligentEvent` extends `AgentEvent`** with optional `role` field
- **`DonePayload` gains `resumeToken`** — adapters opt in by setting it
- **Single-flight** prevents session state corruption under concurrency
- **Deep merge for `permissions`** prevents accidental field loss
