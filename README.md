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
import { Cligent } from 'cligent';
import { ClaudeCodeAdapter } from 'cligent/adapters/claude-code';

// Cligent wraps an adapter with role identity, session continuity,
// option merging, and protocol hardening.
const agent = new Cligent(new ClaudeCodeAdapter(), {
  role: 'coder',
  model: 'claude-opus-4-6',
});

for await (const event of agent.run('Refactor auth module')) {
  if (event.type === 'text_delta') process.stdout.write(event.payload.delta);
  if (event.type === 'done') console.log('\nDone:', event.payload.status);
}

// Session continuity — the next run auto-resumes the previous session.
for await (const event of agent.run('Now add tests for it')) {
  // ...
}
```

## Supported agents

- **Claude Code** — via `@anthropic-ai/claude-agent-sdk`
- **Codex CLI** — via `@openai/codex-sdk`
- **Gemini CLI** — via child-process NDJSON
- **OpenCode** — via `@opencode-ai/sdk`

## Documentation

See [docs/guide.md](docs/guide.md) for the `Cligent` class, adapters, permissions, session continuity, parallel execution, and more.

## License

Apache-2.0
