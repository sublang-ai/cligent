<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-054: Current Agent Runtimes

## Status

In progress (2026-09-28): every deliverable except Gemini CLI `0.61.0` is complete; Gemini awaits an owner decision on effort delivery.

## Intent

Move every built-in adapter's runtime conformance target to its latest published release once the adapter is verified against it, and make tmux-play's shipped model pins name current models, per [DR-013](../decisions/013-cligent-owned-runtime-compatibility.md) and [DR-023](../decisions/023-provider-model-discovery.md).

## Deliverables

- [x] Claude Agent SDK `0.3.283` is the tested version, repair, and development pin; the `0.3.219` floor is unchanged.
- [x] Codex SDK `0.158.0`, selecting Codex CLI `0.158.0`, is the tested version, repair, and development pin; the `0.144.0` floor is unchanged.
- [x] Kimi Code `2.1.1` is the tested version, repair, and exact CI install, paired with ACP SDK `1.4.0`; the `0.28.1` floor is unchanged, and Kimi source references follow the native ACP server `2.1.1` runs.
- [x] OpenCode SDK and CLI `1.18.33` are the paired tested versions, repairs, development pin, and exact CI install; the `1.18.12` floors are unchanged.
- [ ] Gemini CLI `0.61.0` is not adopted: `0.60.0` and later load system defaults only from root-owned paths, so the per-run effort alias cannot load; `0.57.0` stays tested until effort delivery is decided.
- [x] tmux-play's generated roles pin `claude-opus-5-5` and `gpt-6-sol` at `xhigh`.
- [x] Claude's per-model `thinkingTokens` stays out of exact reasoning detail.

## Tasks

1. Refresh the verified runtime targets with their manifests, lockfiles, CI installs, specs, docs, and changelog.
2. Pin tmux-play's generated Claude and Codex roles to current models.

## Verification

- `npm run lint`, `npm run typecheck`, `npx spex lint`, and `npm run smoke:release` pass; `npm test` passes except one Codex trust-root case that assumes the checkout is not a linked Git worktree.
- `node scripts/verify-agent-targets.mjs` passes against Gemini `0.57.0`, Kimi `2.1.1`, and OpenCode `1.18.33`, including the credential-free Kimi ACP handshake.
- The real Kimi adapter ran fresh, model, thinking, resume, unknown-resume, auto-write, default-reject, abort, and no-credential cases against Kimi `0.39.1` and `2.1.1` through a local mock model endpoint, with identical normalized events.
- Credential-free acceptance passes the Codex sandbox profile, OpenCode CLI and inactivity, and Gemini argument probes.
- Live auto-mode create-then-resume-update runs pass for `claude-opus-5-5` and `gpt-6-sol` at `xhigh` and for a free OpenCode model; a Codex `max` plus fast-tier run completes.
