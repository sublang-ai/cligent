<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-030: Gemini CLI 0.50 Compatibility

## Goal

Align the Gemini adapter with Gemini CLI 0.50 headless prompts, session arguments, Policy Engine permissions, and configuration precedence.

## Status

In Progress

The CLI 0.50 contract and joined headless/session arguments are implemented;
Policy Engine permissions and isolated live authentication remain open.

## Deliverables

- [x] Canonical Gemini user and acceptance items describe the CLI 0.50 contract.
- [x] Headless prompt, model, and resume arguments use forms that preserve arbitrary values.
- [ ] Per-run Policy Engine files replace deprecated tool-control surfaces without overriding administrator configuration.
- [ ] Focused tests cover arguments, policy precedence, temporary-file cleanup, and the installed CLI contract.
- [ ] Live Gemini acceptance uses an isolated CLI home with explicit API-key authentication and the CLI default model unless `GEMINI_MODEL` is set.

## Tasks

Each task is one commit and keeps build, typecheck, lint, unit, and smoke checks green at its boundary.

1. [x] **Specify the Gemini CLI 0.50 contract.**
   Amend the current Gemini user and acceptance items for headless arguments, Policy Engine behavior, native-default preservation, and configuration precedence.
2. [x] **Update headless and session arguments.**
   Forward prompt, model, and resume values in joined option tokens, omit unsupported turn-limit flags, and add focused argument and installed-CLI contract tests.
3. [ ] **Implement Policy Engine permissions.**
   Generate and clean up per-run User-tier policy files, preserve Admin-tier and system configuration authority, and cover allow, ask, deny, explicit-whitelist, and invalid-name behavior.
4. [ ] **Verify isolated live authentication.**
   Run Gemini live acceptance with a temporary `GEMINI_CLI_HOME`, explicit API-key gating, and no model override unless `GEMINI_MODEL` is set.

## Acceptance criteria

- Gemini CLI receives the prompt through one `--prompt=<value>` token and receives model and resume values through their joined option forms.
- Capability or tool-list restrictions emit a temporary non-interactive User-tier policy when they generate rules; mode-only and rule-free inputs do not. Runtime mapping does not use deprecated `--allowed-tools` or `tools.exclude` controls.
- Explicit allowlists remain closed under capability-level allows, disallow rules take precedence, and invalid wildcard or TOML string inputs are rejected before spawn.
- Generated files do not redirect system settings, system defaults are overlaid only when an effort alias is required, and administrator controls retain authority.
- Omitting permissions leaves Gemini's native defaults in effect.
- Live acceptance isolates user settings and OAuth state while leaving Gemini CLI's default `auto` model routing unchanged unless the environment explicitly selects a model.
