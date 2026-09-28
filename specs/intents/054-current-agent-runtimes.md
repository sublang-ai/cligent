<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-054: Current Agent Runtimes

## Status

Completed (2026-09-28): every runtime follows [DR-027](../decisions/027-latest-models-oldest-serving-runtime.md); the deliverables were reviewed and merged into the release candidate.

## Intent

Move every built-in adapter's runtime conformance target to its latest published release once the adapter is verified against it, set each supported floor at the oldest release that serves the latest models its provider offers, and make every shipped default and example name current models, per [DR-013](../decisions/013-cligent-owned-runtime-compatibility.md), [DR-023](../decisions/023-provider-model-discovery.md), and [DR-027](../decisions/027-latest-models-oldest-serving-runtime.md).

## Deliverables

- [x] Claude Agent SDK `0.3.283`, Codex SDK `0.158.0` with Codex CLI `0.158.0`, Gemini CLI `0.61.0`, Kimi Code `2.1.1` paired with ACP SDK `1.4.0`, and OpenCode SDK and CLI `1.18.33` are the tested versions, repairs, development pins, and exact CI installs.
- [x] Claude's per-model `thinkingTokens` stays out of exact reasoning detail.
- [x] tmux-play's generated roles pin `claude-opus-5-5` and `gpt-6-sol` at `xhigh`.
- [x] DR-027 records the latest-model floor rule and amends the floor rules of DR-013 and DR-023.
- [x] Claude's floor rises to `0.3.280`, Codex's to `0.156.1`, OpenCode's SDK and CLI floors to `1.18.29`, and Gemini's to `0.61.0`, each with bisected evidence beside the descriptor target and matching peer floors.
- [x] Kimi's floor stays `0.28.1`, recording that serving the latest Kimi models does not depend on the CLI version.
- [x] Every remaining default and example names the latest model of its line.
- [x] OpenCode effort selects the variant the chosen model advertises in the server's catalog, else the nearest advertised one, so GPT-6's `max` reaches `max` and its `minimal` reaches `low`; the documented provider table remains the fallback.
- [x] Kimi `off` on a model that always thinks stops before the prompt with `KIMI_EFFORT_UNAVAILABLE`, read from the thinking values the session advertises.
- [x] Gemini effort reaches CLI `0.60.0` and later, which load system defaults only from root-owned paths, through a per-run user-settings home linked to the real home, with run-made changes reconciled back, and falls back to the concrete model where the workspace is the home or Gemini would sandbox.

## Tasks

1. Refresh the verified runtime targets with their manifests, lockfiles, CI installs, specs, docs, and changelog.
2. Pin tmux-play's generated Claude and Codex roles to current models.
3. Record DR-027 and its floor policy.
4. Raise the supported floors to the oldest releases serving the latest models.
5. Name the latest models in the remaining defaults and examples.
6. Stop Kimi `off` before the prompt on models that always think.
7. Select OpenCode variants from the server's model catalog.
8. Deliver Gemini effort through a per-run user-settings home and move Gemini to CLI `0.61.0`.

## Verification

- `npm run lint`, `npm run typecheck`, `npx spex lint`, and `npm run smoke:release` pass; `npm test` passes except one Codex trust-root case that assumes the checkout is not a linked Git worktree.
- `node scripts/verify-agent-targets.mjs` passes against Gemini `0.61.0`, Kimi `2.1.1`, and OpenCode `1.18.33`, including the credential-free Kimi ACP handshake.
- The real Kimi adapter ran fresh, model, thinking, resume, unknown-resume, auto-write, default-reject, abort, and no-credential cases against Kimi `0.39.1` and `2.1.1` through a local mock model endpoint, with identical normalized events.
- Credential-free acceptance passes the Codex sandbox profile, OpenCode CLI and inactivity, and Gemini argument probes.
- The real Kimi adapter ran `kimi-code/k3` with `off` and `on`, and `kimi-for-coding` with `off`, against Kimi `0.28.1`, `0.39.1`, and `2.1.1` through a local mock model endpoint: `off` on `k3` ended in `KIMI_EFFORT_UNAVAILABLE` with no model request, and the other runs sent the requested thinking.
- OpenCode `1.18.33`'s catalog lists GPT-6 Sol with variants `none` through `max` and no `minimal`, and Claude Opus 5.5 with `low` through `max`; the built adapter read a real `1.18.33` server's catalog, returning listed models' variants and no entry for unlisted or unconnected ones.
- Gemini CLI `0.61.0` through the built adapter against a local Gemini API stand-in requested `gemini-3.8-flash` with `thinkingLevel: LOW` and `gemini-2.5-flash` with `thinkingBudget: 24576`, resumed its session, and sent the concrete model without an overlay from the Gemini home, with no security warning; the former system-defaults route instead drew `Security Warning: Skipping` and requested `cligent-reasoning-effort`.
- An OAuth run through the overlay on this machine's real Gemini home wrote the refreshed credential through to the real file, registered the new project in the real registry, left the real settings byte-identical, and removed the overlay; Code Assist then rejected the account's tier as an unsupported client, with or without the overlay, so no model request was made.
- Live auto-mode create-then-resume-update runs pass for `claude-opus-5-5` and `gpt-6-sol` at `xhigh` and for a free OpenCode model; a Codex `max` plus fast-tier run completes.
