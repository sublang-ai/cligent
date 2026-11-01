<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-042: Windows PowerShell module-analysis cache

## Status

Accepted, 2026-10-31.

## Context

A native Windows SPEX acceptance role completed its real CLI debug, but PowerShell 5.1 wrote Microsoft/Windows/PowerShell/ModuleAnalysisCache beneath the working directory when LOCALAPPDATA was absent from the shell environment. The existing write-boundary gate correctly rejected the attempt.

## Decision

Use the official Codex shell_environment_policy.set configuration to carry only PSModuleAnalysisCachePath on Windows. Preserve an explicitly inherited nonempty value; otherwise use Microsoft's documented NUL cache suppression. Do not inherit all host environment variables, change permissions, ignore generated files or expand workflow write roots. Retain the original failed role and cache evidence.

## Consequences

Module lookup may repeat instead of persisting a cache. Explicit caller cache paths remain supported; no permission or environment-inheritance expansion is introduced.

## Reference

[Microsoft PowerShell 5.1 cache location and PSModuleAnalysisCachePath](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_windows_powershell_5.1).
