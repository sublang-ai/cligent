<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# cligent

[![npm version](https://img.shields.io/npm/v/@sublang/cligent)](https://www.npmjs.com/package/@sublang/cligent)
[![Node.js](https://img.shields.io/node/v/@sublang/cligent)](https://nodejs.org/)
[![CI](https://github.com/sublang-ai/cligent/actions/workflows/ci.yml/badge.svg)](https://github.com/sublang-ai/cligent/actions/workflows/ci.yml)

Unified TypeScript SDK for AI coding agent CLIs (Claude Code, Codex CLI, Gemini CLI, Kimi Code, OpenCode, and more).

Register an adapter, send a prompt, and consume a single async event stream — regardless of which agent runs underneath.

## Install

```bash
npm install @sublang/cligent
```

The agent SDKs are optional peer dependencies — add the one(s) for the
adapters you use:

```bash
npm install @anthropic-ai/claude-agent-sdk   # Claude Code
npm install @openai/codex-sdk                # Codex
npm install @opencode-ai/sdk                 # OpenCode
# Gemini needs no SDK — the adapter drives the installed `gemini` CLI
# Kimi needs its CLI — see the separately pinned install below
```

The Kimi adapter targets the maintained Kimi Code CLI through ACP. Install
the exact conformance target. The external Kimi CLI itself requires Node.js
22.19 or newer to install and run, then authenticate once:

```bash
npm install -g @moonshot-ai/kimi-code@0.27.0
kimi login
```

Adapters reuse each vendor's own authentication from your environment —
a signed-in CLI (e.g. `claude`, `codex`) or its API-key variable
(e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). Kimi Code 0.27 ACP specifically
requires the OAuth credential created by `kimi login`; provider configuration
can still select a model after that login.
Cligent stores no credentials and never starts an authentication flow itself.

Runtime and declaration requirements:

- Node.js 18.3.0 or newer for Cligent itself; using the Kimi adapter also
  requires the external Kimi CLI to run under Node.js 22.19 or newer.
- TypeScript 5.4 or newer when consuming the package declarations.

## Quick start

```ts
import { Cligent } from '@sublang/cligent';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';

// Cligent wraps an adapter with role identity, session continuity,
// option merging, and protocol hardening.
const agent = new Cligent(new ClaudeCodeAdapter(), {
  role: 'coder',
  model: 'claude-opus-4-8',
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
- **Kimi Code** — via one short-lived `kimi acp` process per run
- **OpenCode** — via `@opencode-ai/sdk`

## tmux-play

`tmux-play` is a reference application built on `Cligent` — a working
showcase of what you can compose with the SDK. You chat with a **Captain**
on the left pane; the Captain dispatches work to **players**, each a
`Cligent` on its own adapter and model, streaming live into its own pane
on the right.

```bash
npm install -g @sublang/cligent
tmux-play                                # discover or create config
tmux-play --config ./tmux-play.config.yaml
```

On first run, if neither the cwd nor the home config exists, `tmux-play`
creates `${XDG_CONFIG_HOME:-~/.config}/tmux-play/config.yaml` and starts
with the built-in `fanout` Captain plus a `claude` and a `codex` player.

Requirements:

- [`tmux`](https://github.com/tmux/tmux/wiki/Installing).
- [`glow`](https://github.com/charmbracelet/glow#installation) — Markdown renderer used by the in-pane output pipeline; the launcher fails fast if it is missing.
- Credentials and any out-of-process CLIs for the adapters you use:
  [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview),
  [Codex CLI](https://github.com/openai/codex),
  [Gemini CLI](https://github.com/google-gemini/gemini-cli),
  [Kimi Code](https://github.com/MoonshotAI/kimi-code),
  [OpenCode](https://opencode.ai).

**The Captain is the extension point.** `tmux-play` owns player
orchestration, panes, and event streaming; you write a Captain to decide
_how_ players collaborate — fanout, planner/router, debate protocol, an
XState graph, anything. The built-in `fanout` Captain runs every player in
parallel and synthesizes their answers; swap it for your own using the
same contract.

See [docs/tmux-play.md](docs/tmux-play.md) for config, layout,
notifications, and writing a Captain.

## Documentation

- [docs/guide.md](docs/guide.md) — `Cligent` class, adapters, permissions, session continuity, parallel execution, event types.
- [docs/tmux-play.md](docs/tmux-play.md) — `tmux-play` config, layout, notifications, snapshot, and writing custom Captains.

## Contributing

We welcome contributions of all kinds. If you'd like to help:

- 🌟 Star our repo if you find cligent useful.
- [Open an issue](https://github.com/sublang-ai/cligent/issues) for bugs or feature requests.
- [Open a PR](https://github.com/sublang-ai/cligent/pulls) for fixes or improvements.
- Discuss on [Discord](https://discord.gg/XxTPjNqy9g) for support or new ideas.

Live Kimi acceptance automatically discovers a local `~/.kimi-code` login
and its managed `bin/kimi` when no override is set. CI reconstructs a
dedicated, disposable Kimi source home from the base64 repository secrets
`KIMI_CODE_CONFIG_TOML_B64` (`config.toml`) and
`KIMI_CODE_CREDENTIALS_JSON_B64` (`credentials/kimi-code.json`). The harness
copies those files into an owner-only temporary home and never runs against the
source directly. If a cloned run rotates the OAuth refresh credential, repeat
`kimi login` for an affected local source. For the dedicated CI account, repeat
the login and replace both repository secrets.

## License

[Apache-2.0](LICENSE)
