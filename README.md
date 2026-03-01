<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# cligent

Unified TypeScript interface for CLI-based AI coding agents.

Register an adapter, send a prompt, and consume a single async event stream — regardless of which agent runs underneath.

## Install

```bash
npm install cligent
```

## Quick start

```ts
import { AdapterRegistry, runAgent } from 'cligent';
import { ClaudeCodeAdapter } from 'cligent/adapters/claude-code';

// Register at least one adapter to map agent names to implementations.
const registry = new AdapterRegistry();
registry.register(new ClaudeCodeAdapter());

// runAgent returns an async generator of AgentEvent objects.
// Switch on event.type to handle streaming tokens, tool calls, errors, etc.
for await (const event of runAgent('claude-code', 'Refactor auth module', { model: 'claude-opus-4-6' }, registry)) {
  if (event.type === 'text_delta') process.stdout.write(event.payload.delta);
  if (event.type === 'done') console.log('\nDone:', event.payload.status);
}
```

## Supported agents

- **Claude Code** — via `@anthropic-ai/claude-agent-sdk`
- **Codex CLI** — via `@openai/codex-sdk`
- **Gemini CLI** — via child-process NDJSON
- **OpenCode** — via `@opencode-ai/sdk`

## Documentation

See [docs/guide.md](docs/guide.md) for adapters, permissions, parallel execution, and more.

## License

Apache-2.0
