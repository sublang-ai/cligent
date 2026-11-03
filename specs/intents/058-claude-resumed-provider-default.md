<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-058: Claude Resumed Provider-Default Model

## Status

Implemented and verified locally; review and integration pending.

## Intent

Admit a resumed Claude call whose model selects the provider default, omitting the model as on a fresh call.
The rejection rested on the premise that Claude Code restores the transcript's model when no model is passed; that premise does not hold for Claude Code 2.1.284.
Probes against a loopback Messages fixture, through `claude -p --resume`, the SDK `query({ resume })` and the real adapter, showed every resume without a model requesting the default current at that resume: `ANTHROPIC_MODEL` from the environment or the settings `env`, else the settings `model`, else the built-in default.
Embedding hosts that run Claude on a third-party provider select the provider default for every role, so every workflow step resuming a Claude session failed.

## Deliverables

- [x] [[tmux-play-93](../packages/tmux-play.md#tmux-play-93)] admits a resumed Claude provider-default model and [[tmux-play-196](../packages/tmux-play.md#tmux-play-196)] no longer expects its rejection.
- [x] [[claude-code-6](../packages/adapters/claude-code.md#claude-code-6)] records Claude Code's resumed-default selection, and [[claude-code-93](../packages/adapters/claude-code.md#claude-code-93)] verifies it against the real runtime for every default source.
- [x] The runtime, its tests, the tmux-play guide and the changelog follow.

## Tasks

1. [x] Amend the specs.
2. [x] Remove the Claude rejection, admit the call with the model omitted, and add the acceptance check.

## Verification

- The [[claude-code-93](../packages/adapters/claude-code.md#claude-code-93)] acceptance check passes 3/3 on Claude Code 2.1.284 (SDK 0.3.284): every case keeps one resume token and each resume requests `probe-default-a`, then `probe-default-b`, never `probe-explicit`.
- The tmux-play runtime suite passes 98/98, with the former rejection case now asserting admission and an omitted model and effort.
- `npm test` passes 2,298/2,298; `npm run lint`, `npm run typecheck` and `spex lint` pass.
