<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# capabilities: Host Capability Discovery

## Intent

This package defines contextual media/browser capability facts and explicit host browser preparation per [DR-033](../decisions/033-host-capabilities-and-browser-readiness.md).
Its public vocabulary is the project's `AgentCapabilities`, optional `AgentAdapter.getCapabilities`, `Cligent.getCapabilities`, and `Cligent.prepareBrowser` surface.
It owns host-visible discovery and preparation outcomes, leaving native transports and provider eligibility to adapters.

## External Behavior

### capabilities-1

When a host requests capabilities, the result shall describe attachment transport through the existing descriptor [[attachments-3](attachments.md#attachments-3)], browser admission as `supported`, `unsupported` with a stable code and diagnostic, or `unknown`, and normalized native media sources as `base64` and/or `uri`, with absent attachment/media facts denoting unknown and empty known sets denoting unsupported.

### capabilities-2

When `Cligent.getCapabilities` receives per-call options, it shall merge instance defaults through [[engine-3](engine.md#engine-3)] and call the adapter's optional discovery hook without installing, invoking a tool, launching a provider session, or changing continuity, returning unknown facts where the hook is absent regardless of the adapter's name.

### capabilities-3

When a built-in adapter reports browser admission, discovery shall apply the same contextual restrictions as a browser-enabled run without asserting installed-runtime, authentication, native policy, or model eligibility:

| Context | Result |
| --- | --- |
| host outside macOS/Linux/Windows on x64/arm64 | unsupported host |
| Claude with explicit `allowedTools` [[claude-code-74](adapters/claude-code.md#claude-code-74)] | unsupported tool restriction |
| OpenCode external server [[opencode-61](adapters/opencode.md#opencode-61)] | unsupported server mode |
| Gemini workspace equals its real home [[gemini-48](adapters/gemini.md#gemini-48)] | unsupported workspace context |
| Gemini native sandbox enabled [[gemini-48](adapters/gemini.md#gemini-48)] | unsupported native sandbox |
| native Windows Codex explicit permission isolation [[codex-31](adapters/codex.md#codex-31)] | unsupported permissions |
| other known rejected adapter options | unsupported option |
| supported transport with no known conflict | supported |

### capabilities-4

When `Cligent.prepareBrowser` runs, it shall explicitly prepare the effective browser context without changing defaults, run state, or resume state, refusing known admission conflicts and unavailable agent runtimes before browser work, then using the same host installation and launch proof as an ordinary browser-enabled call [[mcp-4](mcp.md#mcp-4)], [[mcp-11](mcp.md#mcp-11)].

### capabilities-5

When browser setup progresses or settles, the public preparation operation shall report truthful `checking`, `installing`, and `launching` stages and select one terminal result:

| Outcome | Result |
| --- | --- |
| successful host launch and screenshot followed by cleanup | `ready` with epoch-millisecond `checkedAt` |
| known restriction or operational failure | `not-ready` with stable code and bounded useful message |
| caller cancellation | `cancelled` |
| invalid preparation deadline or progress callback | reject as a programmer error |

### capabilities-6

When a host consumes a readiness result, `ready` shall describe only a point-in-time host browser launch and screenshot observation, without promising provider authentication, model vision, native authorization, target-app availability, arbitrary desktop control, or future readiness.

### capabilities-9

When a host requests approval capabilities, built-in adapters shall report live host-decision admission [[approvals-1](approvals.md#approvals-1)] as supported for Claude, Kimi, and OpenCode's current pending-registry transport, and unsupported with code `unsupported-transport` for Codex exec and Gemini NDJSON, with absent custom facts denoting unknown and no result promising native policy authorization.

## Verification

### capabilities-7

When real `Cligent` instances inspect built-in and custom adapters through default/per-call configurations, integration checks shall verify exact descriptor semantics [[capabilities-1](#capabilities-1)], option merging and unknown custom facts without side effects [[capabilities-2](#capabilities-2)], and contextual restrictions shared with execution [[capabilities-3](#capabilities-3)].

### capabilities-10

When real built-in and custom adapters are queried, integration checks shall verify exact supported, unsupported-transport, and unknown approval facts without provider work [[capabilities-9](#capabilities-9)].

### capabilities-8

When real setup operations execute against successful and failing host-runtime fixtures, integration checks shall verify pre-install refusal and unchanged session state [[capabilities-4](#capabilities-4)], progress and every terminal selection [[capabilities-5](#capabilities-5)], and launch/screenshot evidence without provider invocation [[capabilities-6](#capabilities-6)].
