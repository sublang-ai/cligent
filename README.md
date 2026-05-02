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

`tmux-play` is the bundled multi-agent terminal app. The Boss talks to a
Captain in the left tmux pane, and the Captain coordinates role-specific
`Cligent` instances whose logs stream in read-only panes on the right.

From a project with `@sublang/cligent` installed:

```bash
npx tmux-play
npx tmux-play --config ./tmux-play.config.json
```

`tmux` must be installed, and each configured adapter must be available in the
same way it would be for direct `Cligent` usage.

Default discovery checks `tmux-play.config.mjs`, `tmux-play.config.js`, then
`tmux-play.config.json` in the current directory. JavaScript configs can import
helpers and must default-export a JSON-serializable config object. JSON configs
use the same shape without imports:

```js
import { defineConfig } from '@sublang/cligent/tmux-play';

export default defineConfig({
  captain: {
    from: '@sublang/cligent/captains/fanout',
    adapter: 'claude',
    model: 'claude-opus-4-7',
    instruction: 'Coordinate the roles and answer the Boss.',
    options: { maxRoleOutputChars: 4000 },
  },
  roles: [
    {
      id: 'coder',
      adapter: 'codex',
      instruction: 'Implement the requested code changes.',
    },
    {
      id: 'reviewer',
      adapter: 'claude',
      instruction: 'Review the result for bugs and missing tests.',
    },
  ],
});
```

Supported adapters are `claude`, `codex`, `gemini`, and `opencode`. Role IDs
must match `^[a-z][a-z0-9_-]*$`, be unique, and cannot be `captain`. Multiple
roles may share an adapter or model.

When launched, `tmux-play` validates the config and writes
`tmux-play.config.snapshot.json` into its work directory. Local
`captain.from` paths are rewritten to absolute `file://` URLs relative to the
original config file; package specifiers such as
`@sublang/cligent/captains/fanout` pass through unchanged. The tmux session
reads that snapshot, so user config JavaScript is not re-executed inside tmux.
By default, the launcher creates a `tmux-play-*` work directory under Node's
`os.tmpdir()`; the internal session process receives the exact path through
`--work-dir`.

The tmux layout is Boss/Captain on the wide left pane and role panes on the
right in config order. With two or more roles, tmux-play uses two role columns;
the first column receives `ceil(roleCount / 2)` roles from top to bottom.

### Custom Captains

A Captain module default-exports a factory. The runtime owns the role and
Captain `Cligent` instances. Captains call roles through the provided context,
and may keep `CaptainSession` from `init()` to emit human status or structured
telemetry from `init()`, during turns, or between turns.

```js
export default function createCaptain(options = {}) {
  return {
    async init(session) {
      await session.emitStatus('Captain ready', { roles: session.roles.length });
      await session.emitTelemetry({
        topic: 'captain.ready',
        payload: { options },
      });
    },

    async handleBossTurn(turn, context) {
      // Minimal example: real Captains usually frame prompts per role.
      const results = await Promise.all(
        context.roles.map((role) => context.callRole(role.id, turn.prompt)),
      );

      const summary = results
        .map((result) => {
          const text = result.finalText ?? result.error ?? '(no final text)';
          return `${result.roleId}: ${text}`;
        })
        .join('\n\n');

      await context.callCaptain(
        `The Boss asked:\n${turn.prompt}\n\nRole results:\n${summary}`,
      );
    },

    async dispose() {
      // Release session-scoped resources here.
    },
  };
}
```

Point `captain.from` at a local module such as `./captains/router.mjs`, or at a
package subpath. Built-in `fanout` is just the first shipped Captain and uses
the same contract as custom Captains.

## Documentation

See [docs/guide.md](docs/guide.md) for the `Cligent` class, adapters, permissions, session continuity, parallel execution, and more.

## Contributing

We welcome contributions of all kinds. If you'd like to help:

- 🌟 Star our repo if you find cligent useful.
- [Open an issue](https://github.com/sublang-ai/cligent/issues) for bugs or feature requests.
- [Open a PR](https://github.com/sublang-ai/cligent/pulls) for fixes or improvements.
- Discuss on [Discord](https://discord.gg/XxTPjNqy9g) for support or new ideas.

## License

Apache-2.0
