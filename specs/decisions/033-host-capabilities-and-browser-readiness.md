<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-033: Host Capabilities and Browser Readiness

## Status

Accepted (2026-10-01).
Amends [DR-032](032-browser-tools-and-media-output.md) for contextual host discovery, browser launch proof, and owned browser artifacts.
Amends [DR-031](031-media-input-and-computer-use.md) for verified structured Gemini attachment translation.

## Context

A desktop host must distinguish adapter transport support, browser installation, and actual host launch readiness without reproducing adapter rules.
Electron's executable requires Node mode to execute owned JavaScript children, while native browser artifacts can otherwise appear in the user's working directory.
An installed browser alone does not prove that its host libraries or launch environment work.
The pinned Playwright `launchServer` can remain pending before returning a process handle; an owned child process permits bounded cancellation while preserving the host signal handlers.

## Decision

- Add contextual capability discovery through an optional adapter hook and the same effective option merge as a run; missing custom-adapter facts remain unknown.
- Reuse attachment descriptors and expose the native media sources the adapter can return, independently of model eligibility.
- Add explicit cancellable browser preparation with typed progress and outcomes, proving an isolated host launch and screenshot without a provider prompt.
- Use the same preparation for ordinary browser-enabled runs, keeping runtime installation, model access, and native policy outcomes distinct.
- Invoke owned JavaScript children through the embedding runtime in Node mode without depending on a global Node executable or mutating the host environment.
- Keep automatic browser artifacts in a run-owned temporary directory and release it after stream consumption; explicit native filename requests remain subject to native access rules rather than a claimed filesystem confinement.
- Keep browser and MCP tools in tmux-play’s complete per-call settings: omission in an explicit replacement disables them, while omission of the replacement restores role defaults.
- Carry local attachments only on individual player or Captain calls, preserving the prompt and detaching their descriptors before asynchronous dispatch; durable assets remain a host concern.
- Use the Codex SDK's public raw configuration overrides for MCP entries; retain explicit permission isolation and reject an unsupported native Windows isolation route without weakening it.

- Translate structured Gemini attachments into ordered run-owned byte snapshots with MIME-canonical filenames, native `@file` references, and scoped include directories.
  Original user paths never enter the prompt.
  The format set and 20 MiB file limit follow exact Gemini 0.61.0 provider-boundary proof on representable POSIX temporary paths; native Windows remains unsupported until proved.

## Consequences

Hosts can present supported controls and setup failures without selecting behavior by agent name.
Browser readiness is a point-in-time observation of host execution, not authentication, model vision, full desktop control, or target-application availability.
Consumers persist media while consuming the stream before its owned temporary resources are released.
Electron packaging remains responsible for an executable runtime layout and must be tested as a packaged host.
