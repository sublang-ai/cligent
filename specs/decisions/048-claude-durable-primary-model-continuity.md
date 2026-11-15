<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-048: Native Claude model selection on resume

## Status

Accepted (2026-11-14).
Corrects the resumed-model behavior described for 0.38.0.

## Context

An assistant reply identifies the model that answered. Replaying that name as
the next selection can replace a user alias, a context-window modifier, or a
gateway's request identifier.

## Decision

On resume, pass the session token and any explicit model to Claude Code.
When the caller omits the model, omit the SDK option and let Claude Code
select it under [[claude-code-6](../packages/adapters/claude-code.md#claude-code-6)].

## Consequences

Claude Code normally keeps the session model across restarts and changes to
the top-level settings `model`. An `ANTHROPIC_MODEL` in the environment or
settings `env` takes precedence on an omitted-model resume. Fresh sessions
use current defaults. The adapter reads no conversation history to select a
model. The native request matrix verifies both environment sources and the
settings model with a service that reports a different model name
[[claude-code-93](../packages/adapters/claude-code.md#claude-code-93)].
