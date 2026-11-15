<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-048: Claude durable primary-model continuity

## Status

Accepted (2026-11-14).
Supersedes the resumed-model selection shipped in 0.38.0.

## Context

Native Claude resumes without an explicit model can select changed environment or settings defaults.
The owner requires omitted-model resumes to retain the last actual primary model used in the session, including across adapter and process lifetimes.
The historical 0.38.0 implementation selected the current native default on each omitted-model resume.

## Decision

Resolve omitted resumed models from durable primary assistant observations under [[claude-code-6](../packages/adapters/claude-code.md#claude-code-6)].
An explicit model can switch the session; later omission follows the new actual primary observation.
Fresh omission continues to use current native defaults.
Subagent observations and synthetic identifiers do not establish a primary model.
If the SDK returns no actual primary model, preserve native resume on the same token without fabricating an identifier.
Propagate history read errors surfaced by the SDK rather than starting a new session.

## Consequences

Changing environment or settings defaults does not switch an observed session's primary model.
The adapter needs no process-local model cache.
The real SDK/CLI acceptance flow verifies fresh defaults, durable continuity, and explicit switching for environment, settings environment, and settings model defaults under [[claude-code-93](../packages/adapters/claude-code.md#claude-code-93)].
The revised flow passes 3/3 with SDK 0.3.325 and 3/3 with floor SDK 0.3.321.
