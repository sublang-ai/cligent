<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# cligent

[![npm version](https://img.shields.io/npm/v/@sublang/cligent)](https://www.npmjs.com/package/@sublang/cligent)
[![Node.js](https://img.shields.io/node/v/@sublang/cligent)](https://nodejs.org/)
[![CI](https://github.com/sublang-ai/cligent/actions/workflows/ci.yml/badge.svg)](https://github.com/sublang-ai/cligent/actions/workflows/ci.yml)

Unified TypeScript SDK for AI coding agent CLIs (Claude Code, Codex CLI, Gemini CLI, OpenCode, and more).

Register an adapter, send a prompt, and consume a single async event stream — regardless of which agent runs underneath.

## Install

```bash
npm install @sublang/cligent
```

## Quick start

```ts
import { Cligent } from '@sublang/cligent';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';

// Cligent wraps an adapter with role identity, session continuity,
// option merging, and protocol hardening.
const agent = new Cligent(new ClaudeCodeAdapter(), {
  role: 'coder',
  model: 'claude-opus-4-7',
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

## tmux-play

`tmux-play` is a reference application built on `Cligent` — a working
showcase of what you can compose with the SDK. You chat with a **Captain**
on the left pane; the Captain dispatches work to **roles** (coder,
reviewer, planner, …), each a `Cligent` on its own adapter and model,
streaming live into its own pane on the right.

```bash
npx tmux-play                                 # auto-discover config
npx tmux-play --config ./tmux-play.config.json
```

**The Captain is the extension point.** `tmux-play` owns role
orchestration, panes, and event streaming; you write a Captain to decide
*how* roles collaborate — fanout, planner/router, debate protocol, an
XState graph, anything. The built-in `fanout` Captain runs every role in
parallel and synthesizes their answers; swap it for your own using the
same contract.

See [docs/guide.md#tmux-play](docs/guide.md#tmux-play) for config, layout,
and writing a Captain.

## Documentation

See [docs/guide.md](docs/guide.md) for the `Cligent` class, adapters, permissions, session continuity, parallel execution, tmux-play, and more.

## Contributing

We welcome contributions of all kinds. If you'd like to help:

- 🌟 Star our repo if you find cligent useful.
- [Open an issue](https://github.com/sublang-ai/cligent/issues) for bugs or feature requests.
- [Open a PR](https://github.com/sublang-ai/cligent/pulls) for fixes or improvements.
- Discuss on [Discord](https://discord.gg/XxTPjNqy9g) for support or new ideas.

## License

Apache-2.0
