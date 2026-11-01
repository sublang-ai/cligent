<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-040: Direct native Codex through the official SDK

## Status

Revised 2026-11-01 by the PR #88 architecture review. Supersedes the earlier Node-hook/supervisor design and DR-033's Windows permission refusal.

## Context

The former implementation inserted `--ignore-user-config` for every supplied permission policy. That required a wrapper and suppressed user providers and MCP configuration. A Windows runtime carrier, IPC supervisor, lifecycle records, forced MXC, and command guidance compounded that design. None is necessary to pass the supported permission controls through the SDK's public configuration API.

## Decision

Use Cligent → official `@openai/codex-sdk` → platform-native Codex on both systems. Ordinary callers retain SDK executable selection. An ASAR host may override the path only to the actual unpacked native binary. Preserve public permission mapping and validation while inheriting user configuration; explicit settings use SDK options/config/configOverrides and native precedence. Never ignore or rewrite the whole user configuration to resolve a conflict. Native managed-policy/configuration errors remain errors.

Delete script generation, Node hooks, intermediary/supervisor processes and their temporary lifecycle files. Preserve adapter abort, iterator-finalization, resume-lock and skill-resource cleanup. Do not inject a sandbox backend, command instructions, or PowerShell cache policy.

## Consequences

The SDK owns process lifecycle. Its public iterator does not expose an awaited native-close handle; integration probes observe native child exit, rather than claiming an adapter-level process-tree guarantee. Tool descendants are outside this claim.

Removing the transport also removes U+2028/U+2029 rewriting. Raw separators can fail in the pinned SDK parser on either platform. This is an explicitly accepted limitation of this review, not a Windows startup failure or a claim that all output encodings pass. No compatibility wrapper is retained.

Real native configuration precedence and filesystem effects, inherited providers/MCP, account-authenticated short tasks, and isolated APP hosts are separate validation layers; recording executable tests alone do not prove them.
