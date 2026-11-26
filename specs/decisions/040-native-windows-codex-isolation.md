<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-040: Direct native Codex through the official SDK

## Status

Accepted (2026-11-01).
Amends [DR-005](005-per-adapter-permission-configuration.md), [DR-032](032-browser-tools-and-media-output.md), [DR-033](033-host-capabilities-and-browser-readiness.md).

## Context

The former implementation inserted `--ignore-user-config` for every supplied permission policy. That required a wrapper and suppressed user providers and MCP configuration. A Windows runtime carrier, IPC supervisor, lifecycle records, forced MXC, and command guidance compounded that design. None is necessary to pass the supported permission controls through the SDK's public configuration API.

A native Windows acceptance role showed PowerShell 5.1 writing its module-analysis cache beneath the working directory when `LOCALAPPDATA` was absent from the shell environment, which the write-boundary gate rejected [[1]].
That evidence came through the removed wrapper and forced backend, so it justifies no universal adapter override.

## Decision

This replaces the earlier Node-hook and supervisor design, and amends [DR-005](005-per-adapter-permission-configuration.md), [DR-032](032-browser-tools-and-media-output.md) and [DR-033](033-host-capabilities-and-browser-readiness.md): Codex inherits user configuration, and native Windows Codex no longer refuses MCP configuration or permission isolation.

Use Cligent → official `@openai/codex-sdk` → platform-native Codex on both systems. Ordinary callers retain SDK executable selection. An ASAR host may override the path only to the actual unpacked native binary. Preserve public permission mapping and validation while inheriting user configuration; explicit settings use SDK options/config/configOverrides and native precedence. Never ignore or rewrite the whole user configuration to resolve a conflict. Native managed-policy/configuration errors remain errors.

Delete script generation, Node hooks, intermediary/supervisor processes and their temporary lifecycle files. Preserve adapter abort, iterator-finalization, resume-lock and skill-resource cleanup. Do not inject a sandbox backend, command instructions, or PowerShell cache policy such as `PSModuleAnalysisCachePath`; shell environment and cache policy stay with user and native Codex configuration, and the direct SDK path is tested before any separate shell-cache fix is proposed.

## Consequences

The SDK owns process lifecycle. Its public iterator does not expose an awaited native-close handle; integration probes observe native child exit, rather than claiming an adapter-level process-tree guarantee. Tool descendants are outside this claim.

Removing the transport also removes U+2028/U+2029 rewriting. Raw separators can fail in the pinned SDK parser on either platform. This is an explicitly accepted limitation of this review, not a Windows startup failure or a claim that all output encodings pass. No compatibility wrapper is retained.

Real native configuration precedence and filesystem effects, inherited providers/MCP, account-authenticated short tasks, and isolated APP hosts are separate validation layers; recording executable tests alone do not prove them.

PowerShell module lookup may repeat instead of persisting a cache; explicit caller cache paths remain supported, with no permission or environment-inheritance expansion.

## References

[1]: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_windows_powershell_5.1 "Microsoft PowerShell 5.1 cache location and PSModuleAnalysisCachePath"
