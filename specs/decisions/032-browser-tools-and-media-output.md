<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-032: Browser Tools and Media Output

## Status

Accepted (2026-10-01).
Amends [DR-030](030-players-see-only-their-own-mcp-servers.md) and [DR-031](031-media-input-and-computer-use.md) by admitting caller-selected MCP servers, providing an opt-in managed browser, and exposing native media results.

## Context

Desktop agents supply their own browser and rendering integrations [[1]][[2]].
Those integrations are not automatically available in the headless coding runtimes: Codex's built-in browser is desktop-only [[1]], and Claude's built-in computer use does not support print mode [[3]].
Ordinary prompts can drive a configured MCP browser, but requiring every host to research and configure that server prevents a usable default experience.
Screenshot results also reach the model through native tool loops without necessarily reaching a host through the current normalized text-only event stream.

Claude's deliberate MCP confinement prevents unrelated account integrations from leaking into runs, but prohibiting caller-supplied tools is not necessary to retain that boundary.
Native MCP configuration and isolation semantics differ across adapters; a shared option must not claim stronger isolation than its transport supplies.

## Decision

- Add instance-default and per-call `mcpServers` maps of stdio or HTTP servers; a per-call map replaces the instance map, and each adapter documents its native admission limits.
- Preserve Claude's strict MCP confinement and disabled account connectors; admit only explicitly supplied servers, with scoped automatic approval for their tool names and existing denies intact.
- Refuse combinations that cannot honor existing explicit tool restrictions or safely admit servers in the selected runtime mode.
- Add `browser: true` as an opt-in browser capability, with `false` disabling an instance default; the host enables it once and its users invoke it with ordinary prompts.
- Supply a pinned Playwright MCP runtime [[4]] and automatically prepare its matching managed Chromium when the browser capability is first requested; use a separate temporary browser profile, no personal sessions, and no persistent agent configuration writes.
- Download only the managed browser when absent, using a bounded cancellable installer; do not install system packages, replace system browsers, or enable a global permission-bypass mode.
- Expose authentic native media through a typed `media` event alongside text and tool results; leave rendering to the host, and never read or fetch arbitrary model-written paths or links.
- Keep full operating-system control distinct: callers can supply a suitable desktop MCP server, subject to adapter support, native authorization, and operating-system access.

## Consequences

Browser setup belongs to the library's capability semantics rather than every application's custom MCP wiring.
Enabling it can require an initial browser download and host browser prerequisites; normal text calls and imports do not perform that work.
The selected agent retains its native model loop, screenshot reasoning, permissions, and provider limitations.
Hosts can render returned screenshots beside UX explanations without depending on opaque provider-specific payloads.
Native transports that omit media still cannot expose bytes they never send; their text and explicit native references remain available.
The browser runtime adds a deliberate exception to the minimal runtime-dependency policy.

## References

[1]: https://learn.chatgpt.com/docs/browser "Codex desktop browser"
[2]: https://code.claude.com/docs/en/desktop#preview-your-app "Claude Desktop app preview"
[3]: https://code.claude.com/docs/en/computer-use "Claude built-in computer use"
[4]: https://github.com/microsoft/playwright-mcp "Playwright MCP"
