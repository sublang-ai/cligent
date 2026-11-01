<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-040: Native Windows Codex Isolation

## Status

Accepted (2026-10-30).
Amends [DR-033](033-host-capabilities-and-browser-readiness.md)'s native Windows isolation refusal.

## Context

The Codex SDK public launch options select an executable and its environment but cannot insert `--ignore-user-config` into `exec` arguments.
POSIX shell wrappers cannot run through native Windows process creation.
Removing the permission policy would allow user configuration to replace the caller's permission profile.
Windows forcibly terminates a killed SDK-facing process, so POSIX signal forwarding alone cannot establish native-child shutdown.

## Decision

- Preserve the permission mapping, isolated configuration, authentication and session home on both platforms.
- Bounded Windows permission profiles prefer the native MXC sandbox backend and carry native command-shell guidance; neither preference changes the chosen permission profile or approval policy.
- Use the embedding Node/Electron runtime through the SDK's public launch options on Windows, with no global Node, shell, WSL, SDK patch or system configuration change.
- Require Node 18.19 or later on Windows for its public import startup hook.
- Reuse the existing transport supervisor and atomic lifecycle evidence, with an inherited IPC connection cancelling its exact native child when the SDK-facing process disappears.
- Preserve the caller's native environment after the owned runtime launch; scope startup hooks to the owned carrier.
- Retain an unproven carrier as a cleanup failure instead of claiming successful termination.

## Consequences

Native Windows permission-managed calls become supported without changing SPEX workflow semantics or weakening caller policy.
The Windows startup and forced-termination paths require real Windows integration and packaged Electron acceptance evidence.
Intentional tool descendants remain outside the transport's native-child shutdown claim.
