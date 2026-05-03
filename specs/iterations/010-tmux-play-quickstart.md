<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-010: tmux-play YAML Quickstart

## Goal

Implement [DR-004 §Configuration](../decisions/004-tmux-play-captain-architecture.md#configuration) as updated: YAML-only configs, cwd → `~/.config/tmux-play/config.yaml` discovery, and first-run auto-create.

## Status

Proposed

## Scope

In scope:

- Replace `.mjs`/`.js`/`.json` discovery with `tmux-play.config.yaml` in cwd.
- Add `${XDG_CONFIG_HOME:-~/.config}/tmux-play/config.yaml` as a fallback after cwd.
- Auto-create the home default on first run when neither location holds a file.
- Add `yaml` runtime dep.
- Drop the `.mjs`/`.js`/`.json` loader paths and `defineConfig`. The snapshot writer's `captain.from` local-path rewriting is format-independent and stays.

Out of scope: see [DR-004 §Out of Scope](../decisions/004-tmux-play-captain-architecture.md#out-of-scope).

## Deliverables

- [ ] `package.json` — add `yaml` to `dependencies`.
- [ ] `src/app/tmux-play/config.ts` — YAML loader, cwd→home discovery, first-run auto-create with stdout notice; remove the JS/JSON loader paths.
- [ ] `src/app/tmux-play/index.ts` — drop `defineConfig`. The snapshot writer's `captain.from` rewriting stays unchanged.
- [ ] Tests: loader round-trips YAML; cwd wins over home; auto-create writes the default; existing home file is preserved across runs; malformed YAML hard-errors with file context; local `captain.from` paths in cwd configs resolve correctly via the snapshot.
- [ ] Docs: README pitch reflects the one-command flow; `docs/tmux-play.md` shows YAML, discovery order, and auto-create behavior.

## Tasks

Each task is one commit.

1. Replace JS/JSON config discovery with the YAML loader (cwd + home fallback + first-run auto-create); add `yaml` dep; drop the JS/JSON loader code and `defineConfig`; preserve the snapshot writer's `captain.from` rewriting; tests included.
2. Update README and `docs/tmux-play.md` for the YAML/auto-create flow.

## Verification

- `npm run build` and `npm test` pass.
- `tmux-play` from a fresh `$HOME` writes `~/.config/tmux-play/config.yaml`, prints a one-line notice, and runs.
- A subsequent run uses the existing file without overwriting.
- `tmux-play.config.yaml` in cwd takes precedence over the home file.
- Malformed YAML in either location aborts with a parse error naming the file.
