<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# tmux-play

`tmux-play` is a reference application built on the `@sublang/cligent`
SDK. The Boss chats with a Captain in the wide left pane; the Captain
coordinates per-role `Cligent` instances whose output streams into
read-only panes on the right.

```bash
npx tmux-play                                 # auto-discover config
npx tmux-play --config ./tmux-play.config.json
```

[`tmux`](https://github.com/tmux/tmux/wiki/Installing) must be installed,
and each configured adapter must work the same way it would for direct
`Cligent` use (see [guide.md](guide.md)).

## Config

Discovery in the cwd: `tmux-play.config.mjs`, `.js`, `.json`. JS configs
may import helpers but must default-export a JSON-serializable object.

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
    { id: 'coder', adapter: 'codex', instruction: 'Implement code changes.' },
    { id: 'reviewer', adapter: 'claude', instruction: 'Review the result.' },
  ],
});
```

- Adapters: `claude`, `codex`, `gemini`, `opencode`.
- Role IDs match `^[a-z][a-z0-9_-]*$`, are unique, and may not be `captain`. Multiple roles may share an adapter or model.
- `captain.from` is a local path (`./captains/router.mjs`) or a package subpath. The runtime owns every `Cligent`; the Captain just orchestrates.
- `captain.options` is opaque to the runtime and forwarded to the factory.

## Layout

Boss/Captain occupies the wide left pane; roles fill the right in config
order. With ≥2 roles `tmux-play` uses two columns, putting
`ceil(roleCount / 2)` roles in the first column from top to bottom.

## Snapshot and work directory

The launcher validates the config and writes
`tmux-play.config.snapshot.json` into a `tmux-play-*` work directory under
`os.tmpdir()`, then re-execs itself in session mode with `--work-dir` set.
Local `captain.from` paths are rewritten to absolute `file://` URLs
relative to the original config file; package specifiers pass through
unchanged. The session reads the snapshot, so user config JS is not
re-executed inside tmux.

## Custom Captains

A Captain module default-exports a factory. Captains call roles via
`context`, and may retain the `CaptainSession` from `init()` to
`emitStatus`/`emitTelemetry` from `init`, during turns, or between turns.

```js
export default function createCaptain(options = {}) {
  return {
    async init(session) {
      await session.emitStatus('Captain ready', { roles: session.roles.length });
      await session.emitTelemetry({ topic: 'captain.ready', payload: { options } });
    },

    // Minimal example: real Captains usually frame prompts per role.
    async handleBossTurn(turn, context) {
      const results = await Promise.all(
        context.roles.map((r) => context.callRole(r.id, turn.prompt)),
      );
      const summary = results
        .map((r) => `${r.roleId}: ${r.finalText ?? r.error ?? '(no final text)'}`)
        .join('\n\n');
      await context.callCaptain(`Boss:\n${turn.prompt}\n\nRoles:\n${summary}`);
    },

    async dispose() {},
  };
}
```

Built-in `fanout` (`@sublang/cligent/captains/fanout`) uses this same
contract — third-party Captains aren't second-class.
