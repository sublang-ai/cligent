<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-042: Windows PowerShell module-analysis cache

## Status

Withdrawn from the default adapter path, 2026-11-01, by [DR-040](040-native-windows-codex-isolation.md). The original observation remains below.

## Context

A native Windows SPEX acceptance role completed its real CLI debug, but PowerShell 5.1 wrote Microsoft/Windows/PowerShell/ModuleAnalysisCache beneath the working directory when LOCALAPPDATA was absent from the shell environment. The existing write-boundary gate correctly rejected the attempt.

## Decision

Leave shell environment and cache policy to user/native Codex configuration. The previous evidence was collected through the removed wrapper and forced backend, so it does not independently justify a universal adapter override. The direct SDK path must be tested before proposing any separate shell-cache fix.

## Consequences

Module lookup may repeat instead of persisting a cache. Explicit caller cache paths remain supported; no permission or environment-inheritance expansion is introduced.

## Reference

[Microsoft PowerShell 5.1 cache location and PSModuleAnalysisCachePath](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_windows_powershell_5.1).
