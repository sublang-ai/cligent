<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Media and computer use

Cligent accepts local files on individual calls to supported adapters. Computer
use is requested in an ordinary prompt after the host enables `browser: true`
or supplies a suitable tool server. Native media is returned in typed events.

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

## Inspect an app with an isolated browser

Enable `browser: true` once on the agent. End users then make ordinary requests
such as “Open my app, take a screenshot, and explain its UX problems.” They do
not need to choose or configure an MCP server.

```ts
import { Cligent } from '@sublang/cligent';
import { ClaudeCodeAdapter } from '@sublang/cligent/adapters/claude-code';

const agent = new Cligent(new ClaudeCodeAdapter(), {
  cwd: '/work/project',
  browser: true,
});

for await (const event of agent.run(
  'Open http://localhost:3000, take a screenshot, and explain the layout problems.',
)) {
  if (event.type === 'text') console.log(event.payload.content);
  if (event.type === 'media') {
    // Pass this typed payload to your UI, or save its inline bytes to a file.
    console.log(event.payload.mimeType, event.payload.toolUseId);
  }
}
```

The app's development server must be running. The managed browser needs
`URL.canParse` (available in Node 18.17+ and Node 20+); ordinary Cligent calls
retain the Node 18.3.0 floor. Cligent supplies its pinned
Playwright MCP runtime and downloads the matching managed Chromium on first
use if needed. Subsequent calls reuse the installed browser. Preparation is
cancellable and bounded; offline downloads or missing host prerequisites fail
with a diagnostic. Cligent does not install system libraries or replace a
system browser. Plain text calls and importing the library install nothing.

Preparation verifies the Node requirement, native installation completion, and
executable presence. It does not launch a browser as a readiness probe. Ubuntu
Server needs no desktop or display for this headless browser, but still needs
Chromium's system libraries. Missing libraries can pass installation with a
native warning and fail when the first browser tool launches Chromium. Hosts
should treat `browser: true` as a requested capability, not a readiness result,
and show the resulting setup or tool diagnostic to the user. An administrator
must install missing system dependencies; Cligent does not run `sudo` for them.

Every browser process uses an isolated temporary profile. It has no personal
browser logins and does not import the desktop application's tabs or plugins.
Existing native policy precedence still applies; no global permission bypass
is enabled. Supplying a tool
server authorizes its tools within that run; Cligent uses scoped approval
rather than enabling every tool. See adapter limitations below.

`browser` is also available on per-call options, including direct and parallel
calls. `{ browser: false }` disables an instance default for one call. In the
bundled `tmux-play` YAML configuration, a player or Captain can set `browser: true`.

## Return figures alongside an explanation

The agent's native loop receives screenshot tool results and can reason about
them. Cligent separately emits a `media` event so the host can present the same
figure alongside the agent's `text` events. The event contains:

- `mimeType` and `source: { type: 'base64', data }` for inline bytes, or
  `source: { type: 'uri', uri }` for a native resource reference;
- optional `name` and `toolUseId` for display and correlation with tool activity.

`done.result` remains text. A host that only consumes the final result must also
listen for `media` events to show figures. Existing opaque `tool_result.output`
is preserved. Media is emitted from native assistant/tool content, never
inferred by reading files or fetching URLs mentioned in generated prose.

For example, a web host can render an inline screenshot with this handler:

```ts
import type { MediaPayload } from '@sublang/cligent';

function showScreenshot(media: MediaPayload, container: HTMLElement) {
  if (media.source.type !== 'base64') return;
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(media.mimeType)) return;
  const image = document.createElement('img');
  image.src = `data:${media.mimeType};base64,${media.source.data}`;
  image.alt = media.name ?? 'Agent screenshot';
  container.append(image);
}
```

A Node host can save an inline PNG using
`await writeFile(chosenPath, Buffer.from(media.source.data, 'base64'), { flag: 'wx' })`
after checking the source and MIME type. The host chooses the destination.
Native URIs may point at a remote runtime or an application-specific resource;
the host decides whether and how to resolve them. Cligent does not fetch them.
The terminal presenter shows concise media notices and references; it does not
render image pixels or dump base64 into the conversation. Raw event payloads
remain intact for a host or observer to render or persist; `tmux-play` does not
automatically save the media bytes.

## Supply other tools or desktop control

For an existing browser service or full operating-system control, pass a
`mcpServers` map. A per-call map replaces the instance default map; it does not
merge individual entries. The managed browser is added separately when enabled.

```ts
const agent = new Cligent(new ClaudeCodeAdapter(), {
  mcpServers: {
    desktop: {
      type: 'stdio',
      command: '/absolute/path/to/your-desktop-mcp-server',
      args: [],
    },
    remote: {
      type: 'http',
      url: 'https://your-service.example/mcp',
      headers: { Authorization: 'Bearer YOUR_TOKEN' },
    },
  },
});
```

A stdio server supports `command`, optional `args`, and optional `env`; an HTTP
server supports `url` and optional `headers`. Authentication and operating-system
permissions must already be available to those tools. The name `cligent_browser`
is reserved when the managed browser is enabled. No persistent native agent
configuration is changed. Ambient configuration follows each runtime's existing
semantics; this API does not promise universal MCP isolation.

| Adapter | Admission and output |
| --- | --- |
| Claude Code | Only supplied servers are admitted; account connectors remain disabled. Their tools receive scoped approval, with `disallowedTools` retained. A supplied server or managed browser together with an explicit `allowedTools` list is rejected because that combination cannot preserve Cligent's exact tool-availability contract. Native tool-result screenshots produce correlated `media` events. |
| Codex | Supplied servers are passed as runtime configuration, including under existing permission-policy isolation. Native MCP image/resource results produce `media`. MCP/browser configuration is unsupported on native Windows in this release because its configuration wrapper cannot be launched by the SDK there; use a Linux or macOS host for this capability. |
| Gemini | Supplied servers use a temporary native settings overlay. Unsupported overlay contexts fail explicitly. The CLI exposes text-only tool display output, so the model can use screenshots while screenshot bytes are unavailable to Cligent; use the runtime's saved-file references where needed. |
| Kimi | Servers are supplied through ACP, with HTTP capability negotiation. Run-specific server names keep scoped approvals separate from ambient tools. Native rules naming the original server do not match those aliases; use applicable wildcard rules or the exposed native names. Native image/tool content produces `media`. |
| OpenCode | Supplied servers are admitted into the run's managed server. External shared servers reject caller MCP/browser options because changing their tool registry affects other sessions; configure those servers independently. Native file and completed-tool attachments produce `media`. |

Other agents and parallel runs remain usable when one adapter rejects a mode.
The selected model must support the visual reasoning you request. Native policy
decisions, managed organization controls, and unavailable tools can still prevent
a browser or desktop action.

## How this compares with the desktop applications

[Claude Desktop's preview](https://code.claude.com/docs/en/desktop#preview-your-app)
provides a host-managed browser for inspecting the app under development.
Claude's separate built-in [computer use](https://code.claude.com/docs/en/computer-use)
is unavailable in headless print mode. [Codex Desktop's browser](https://learn.chatgpt.com/docs/browser)
is included with the desktop app but is unavailable in Codex CLI. Its full
[computer-use integration](https://learn.chatgpt.com/docs/computer-use) also has
installation and operating-system access requirements.

Those desktop products combine a tool runtime, model loop, and visual renderer.
Cligent now supplies the browser setup and media transport needed for the same
web-app inspection workflow through supported headless runtimes. Your host UI
renders the figures. Full desktop control remains a separate tool capability;
a browser option does not grant control over arbitrary native applications.

Claude's isolation remains deliberate: it keeps unrelated auto-fetched account
connectors out of each run. The former missing piece was explicit tool admission,
which `mcpServers` and the managed browser now provide.

## Investigation evidence

The implementation was checked against the repository's targeted transports:
Claude Agent SDK 0.3.284, Codex SDK 0.159.0, Gemini CLI 0.61.0, Kimi Code 2.1.1
with ACP 1.4.0, and OpenCode SDK/CLI 1.18.33. Browser setup pins Playwright MCP
0.0.77 and its matching Chromium; this is the latest MCP release whose complete
runtime dependency tree retains Node 18 support. No agent runtime upgrade was
required.

- [Claude SDK input modes](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode): direct image input requires streamed user-message content.
- [Codex SDK](https://developers.openai.com/codex/sdk/): structured text and local-image input; installed declarations and executable transport confirm the mapping.
- [Gemini headless processing](https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/cli/src/nonInteractiveCli.ts) and [file handling](https://github.com/google-gemini/gemini-cli/blob/v0.61.0/packages/core/src/utils/fileUtils.ts): native `@file` expansion already supplies multimedia parts.
- [Kimi ACP capabilities](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp) and [ReadMediaFile](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/tools.md): image blocks are supported; video is tool-directed.
- [OpenCode file processing](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/session/prompt.ts) and [model modality handling](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/provider/transform.ts): file parts carry media, with native model-dependent outcomes.

Tests cover exact file bytes and ordering across installed SDK serialization,
ACP negotiation, unsupported media, missing files, cancellation, resumed turns,
and parallel failure isolation. They establish transport behavior without
claiming that every model or account accepts every transported format.

For the 0.31.0 milestone, automated CI covers Ubuntu with Node 20, 22, and 24,
including a separate real browser/MCP job on Node 22. Local macOS verification
also exercises browser screenshots and native Claude/Codex loops. Automated
macOS/Windows coverage and a browser launch preflight are follow-up work; this
release does not claim that those environments have equivalent CI coverage.
