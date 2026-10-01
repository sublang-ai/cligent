<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Media and computer use

Cligent accepts local files on individual calls to supported adapters. Computer
use is requested in the text prompt where the selected adapter exposes a
configured browser or desktop tool. Setup is separate from invocation.

## Attach local files

```ts
import { Cligent, getAttachmentSupport } from '@sublang/cligent';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';

const agent = new Cligent(new ClaudeCodeAdapter(), { cwd: '/work/project' });
console.log(getAttachmentSupport(agent.agentType));

for await (const event of agent.run('Compare the screenshot with the brief.', {
  attachments: [
    { path: 'screenshots/home.png' },
    { path: 'brief.pdf' },
  ],
})) {
  if (event.type === 'text') console.log(event.payload.content);
}
```

`attachments` is available on `AgentOptions` and `RunOptions`, including direct
adapter calls, `runAgent`, `runParallel`, and `Cligent.parallel`. It is not an
instance default and is not sent again on a later turn. Existing conversation
history is still the runtime's responsibility.

An `Attachment` has a local `path` and optional `mimeType`. Relative paths use
the call's effective `cwd`; absolute paths work too. Common filename extensions
are recognized case-insensitively. For an extensionless file or an explicit
override, use `{ path: 'upload', mimeType: 'image/png' }`. Files must be readable
regular files. Cligent does not download URLs, sniff content, resize images,
extract video frames, or convert formats. The runtime applies its own size,
decoding, model, and account limits.

| Adapter | `attachments` transport | Other native input |
| --- | --- | --- |
| Claude Code | PNG, JPEG, GIF, WebP; PDF | Image/document blocks in one SDK user message |
| Codex | PNG, JPEG, GIF, WebP | SDK `local_image` parts become native `--image` inputs |
| Gemini | Use the text prompt instead | `@file` references for images, audio, video, PDFs, and text |
| Kimi | PNG, JPEG, GIF, WebP, when ACP advertises image support | Ask `ReadMediaFile` to read a local image/video path |
| OpenCode | `image/*`, `audio/*`, `video/*`, PDF, plain text | Inline native file parts, including with an external server |

`ATTACHMENT_SUPPORT` and `getAttachmentSupport()` describe transport acceptance,
not a selected model's abilities. For example, OpenCode can transport a video
but its selected provider/model may substitute an unsupported-media message.
Unsupported types fail on their own adapter; other parallel agents continue.
Custom adapters decide their own contract; an unknown adapter returns
`undefined` from `getAttachmentSupport()`.

For OpenCode video input:

```ts
import { OpenCodeAdapter } from '@sublang/cligent/adapters/opencode';

const videoAgent = new Cligent(new OpenCodeAdapter(), { cwd: '/work/project' });
for await (const event of videoAgent.run('Summarize this clip.', {
  attachments: [{ path: 'demo.mp4' }],
})) {
  // Choose an OpenCode provider/model that accepts video.
}
```

For Gemini, use its existing native syntax without an `attachments` option:

```ts
const events = geminiAgent.run('Summarize @./demo.mp4 and compare @./screen.png');
```

Gemini performs its own path parsing, file inclusion, and access checks. Follow
its native quoting rules for paths with spaces. A nonempty `attachments` list
on Gemini fails with guidance to use `@file`; omitted or empty lists preserve
text behavior. For Kimi video, an ordinary prompt such as
`Use ReadMediaFile to summarize /work/project/demo.mp4` lets the configured
agent use that tool. Kimi's ACP image support does not imply ACP audio, video,
or binary-document support.

The reference `tmux-play` composer remains text-based. Native Gemini `@file`
references and prompts asking agents to read local media work there too; the
structured attachment list is an SDK feature.

## Invoke computer use

Once the underlying runtime and adapter expose a browser/desktop tool, call it
through a normal prompt and consume the existing tool and text events the
adapter emits.
`tool_result` availability follows that adapter's existing event mapping.
No Cligent `computerUse` flag or separate control loop is required.

```ts
import { Cligent } from '@sublang/cligent';
import { CodexAdapter } from '@sublang/cligent/adapters/codex';

// Configure Codex MCP first; omit permissions to retain native configuration.
const browserAgent = new Cligent(new CodexAdapter());
for await (const event of browserAgent.run(
  'Use the configured browser tool to open http://localhost:3000 and report the page title.',
)) {
  if (event.type === 'text') console.log(event.payload.content);
  if (event.type === 'tool_use') console.log(event.payload.toolName);
  if (event.type === 'tool_result') console.log(event.payload.status);
}
```

| Adapter | Native setup and scope |
| --- | --- |
| Claude Code | The native runtime supports [MCP tools](https://code.claude.com/docs/en/mcp), but Cligent confines every run to explicitly supplied MCP servers and currently exposes no server option. It also disables account connectors. Native MCP/plugin setup alone therefore does **not** enable those tools through Cligent. |
| Codex | Configure a browser/desktop MCP server through [Codex MCP configuration](https://developers.openai.com/codex/mcp/). Cligent preserves native config when `permissions` is omitted; supplying a policy invokes its existing configuration isolation, so user-configured MCP tools are not assured. |
| Gemini | Enable the native [browser agent](https://geminicli.com/docs/core/subagents/#browser-agent) in Gemini settings or configure an MCP tool. The built-in agent controls a browser, not a general desktop. |
| Kimi | Install and authorize the native [Computer Use plugin](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins), or configure an MCP tool. ACP's empty client-supplied MCP list preserves native MCP configuration. |
| OpenCode | Configure a browser/desktop [MCP server](https://opencode.ai/docs/mcp-servers/) or custom tool on the server that executes the session. This may be a different machine in external mode. |

A fresh install does not provide ready-to-use computer control.
Cligent does not currently install tools or diagnose their readiness.

### First browser setup with Codex or OpenCode

For a browser-only starting point, [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp)
works with both runtimes. Install Node.js 18+ with npm/npx and Google Chrome on
the machine running the tools, and complete the agent's normal authentication.
The following opt-in recipe can download the MCP package on first use; pin a
tested version instead of `latest` for a reproducible deployment.

For Codex, register the tool in its native configuration:

```sh
codex mcp add playwright -- npx -y @playwright/mcp@latest --browser chrome --headless --isolated
codex mcp list
```

For OpenCode, merge this entry into `mcp` in the project's `opencode.json` or its
native global configuration, preserving existing entries:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "playwright": {
      "type": "local",
      "command": [
        "npx", "-y", "@playwright/mcp@latest",
        "--browser", "chrome", "--headless", "--isolated"
      ],
      "enabled": true,
      "timeout": 60000
    }
  }
}
```

Run `opencode mcp list` to inspect the native registration. For an external
OpenCode server, configure its host and working directory and restart the
server as needed. The longer startup timeout allows for a first-run package
download. These commands register a browser tool; a status listing
alone does not verify that Chrome can launch. Use the Cligent prompt example
above (with a running local page) to check navigation and the returned title.
For OpenCode, construct the agent with `new OpenCodeAdapter()` instead.

`--isolated` uses a temporary browser profile without personal login sessions;
`--headless` runs without a visible browser window. Neither option grants
permissions or controls other desktop applications. Codex CLI does not inherit
the desktop app's [built-in browser](https://learn.chatgpt.com/docs/browser).

### Native Gemini and Kimi tools

For Gemini, enable `agents.overrides.browser_agent.enabled` in its settings;
`agents.browser.sessionMode: "isolated"` selects an isolated browser session.
Then ask `Use browser_agent to open http://localhost:3000 and report the title`.
Chrome 144+ is required. Native `fill` and `fill_form` actions require
confirmation even in permissive approval modes, so unattended form completion
is not assured.

For Kimi, run the native CLI and use `/plugins` → Official → Kimi Computer Use.
Reload or start a new session after installing. Follow its OS-access setup; on
macOS that includes Accessibility and Screen Recording permissions and enabling
Kimi Code under “Connect local agents.” Restart Kimi Code as instructed before
invoking the configured tool through Cligent. Browser-only use can instead
install the Kimi Browser Extension plugin and its Chrome/Edge extension.
Cligent rejects ACP permission requests, so actions requiring confirmation can
stop even when a plugin is installed.

These routes invoke tools already available to the selected runtime. They do
not install a browser, provide OS access, or import desktop-app integrations
into a headless SDK. Native tool configuration, authentication, and permissions
remain in force. Keep restrictions appropriate to your deployment and verify
that the required tool is available under that configuration. Headless runs
cannot necessarily satisfy an interactive native confirmation.

## Investigation evidence

The implementation was checked against the repository's targeted transports:
Claude Agent SDK 0.3.284, Codex SDK 0.159.0, Gemini CLI 0.61.0, Kimi Code 2.1.1
with ACP 1.4.0, and OpenCode SDK/CLI 1.18.33. No runtime upgrade was required.

- [Claude SDK input modes](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode): direct image input requires streamed user-message content.
- [Codex SDK](https://developers.openai.com/codex/sdk/): structured text and local-image input; installed declarations and executable transport confirm the mapping.
- [Gemini headless processing](https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/nonInteractiveCli.ts) and [file handling](https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/utils/fileUtils.ts): native `@file` expansion already supplies multimedia parts.
- [Kimi ACP capabilities](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp) and [ReadMediaFile](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/tools.md): image blocks are supported; video is tool-directed.
- [OpenCode file processing](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/session/prompt.ts) and [model modality handling](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/provider/transform.ts): file parts carry media, with native model-dependent outcomes.

Tests cover exact file bytes and ordering across installed SDK serialization,
ACP negotiation, unsupported media, missing files, cancellation, resumed turns,
and parallel failure isolation. They establish transport behavior without
claiming that every model or account accepts every transported format.
