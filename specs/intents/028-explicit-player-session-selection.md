<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-028: Explicit Player Session Selection

## Status

Complete

## Intent

Let a tmux-play Captain select a player's backend session per call without exposing the runtime-owned `Cligent`.
An explicit opaque resume token shall override the player's stored automatic token, `false` shall force a fresh session, and omission shall retain the existing automatic continuity behavior.
Restore the Gemini adapter's documented `AgentOptions.resume` to `--resume` mapping so the shared continuation contract reaches the CLI.

## Deliverables

- [x] Amend [DR-004](../decisions/004-tmux-play-captain-architecture.md), [[tmux-play-16](../packages/tmux-play.md#tmux-play-16)], [[tmux-play-41](../packages/tmux-play.md#tmux-play-41)], and [[tmux-play-128](../packages/tmux-play.md#tmux-play-128)] with the optional per-call player session selector.
- [x] Export `CallPlayerOptions` from `@sublang/cligent/tmux-play` and forward its `resume?: string | false` value through the runtime to `Cligent.run()`.
- [x] Cover explicit-token override and forced-fresh behavior with runtime integration tests and pin the public type surface.
- [x] Forward `AgentOptions.resume` as Gemini CLI `--resume` and cover the command mapping with a focused unit test.
- [x] Update the public tmux-play guide and changelog.

## Tasks

1. [x] **Specify, implement, and verify explicit player session selection.**
   Amend the Captain contract and continuity specifications, add the optional API without changing omission behavior, forward the selector into the existing engine semantics, restore Gemini CLI resume forwarding, and add focused runtime, contract, and adapter coverage.

## Verification

- Given a persistent player with a stored automatic token, an explicit string passed through `CallPlayerOptions.resume` reaches the adapter instead of the stored token.
- Given a persistent player with a stored automatic token, `CallPlayerOptions.resume: false` reaches `Cligent.run()` and the adapter receives no resume token.
- Given `CallPlayerOptions.resume` is omitted, the existing stored-token auto-resume behavior remains unchanged.
- Given Gemini `AgentOptions.resume` is a non-empty string, `mapAgentOptionsToGeminiCommand()` places `--resume <token>` before the final positional prompt.
- `npm run build`, targeted tests, typecheck, and lint pass.
