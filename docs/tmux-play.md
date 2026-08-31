<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# tmux-play

`tmux-play` is a reference application built on the `@sublang/cligent`
SDK. The Boss (you, the human) chats with a Captain agent in the left
pane; the Captain coordinates per-player `Cligent` instances whose
output streams into read-only panes on the right.

```bash
tmux-play                                 # discover or create config
tmux-play --config ./tmux-play.config.yaml
```

Requirements:

- [`tmux`](https://github.com/tmux/tmux/wiki/Installing) 3.3 or newer.
- [`glow`](https://github.com/charmbracelet/glow#installation) — Markdown renderer used by the in-pane output pipeline; the launcher fails fast if it is missing.
- An installed runtime for every adapter your config uses — the optional peer
  SDK the adapter imports, plus any CLI it spawns — installed wherever the
  running cligent resolves packages. For a global cligent installation, that
  means globally. See [guide.md](guide.md#install) for the per-adapter packages.
- Credentials for each of those adapters:
  [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview),
  [Codex CLI](https://github.com/openai/codex),
  [Gemini CLI](https://github.com/google-gemini/gemini-cli),
  [Kimi Code](https://github.com/MoonshotAI/kimi-code),
  [OpenCode](https://opencode.ai).

Each configured adapter behaves the same way it would for direct
`Cligent` use. The launcher checks that each configured adapter's runtime is
installed and fails before creating a session when one is not, naming the
adapter, the roles that use it, and the commands that install it — so a
missing runtime is a message on your terminal rather than an error on your
first prompt inside tmux. Credentials are not part of that check: they are
each vendor's own state and surface when a turn runs. Kimi in particular
needs one of its ACP authentication routes after its pinned CLI is
installed: `kimi login`, a configured default model whose provider holds
non-OAuth credentials, or `KIMI_MODEL_NAME` plus `KIMI_MODEL_API_KEY`.

## Config

Discovery order:

1. `tmux-play.config.yaml` in the cwd.
2. `${XDG_CONFIG_HOME:-~/.config}/tmux-play/config.yaml`.

If neither file exists and `--config` is not set, `tmux-play` creates the
home config with the default `fanout` Captain and one player per installed
adapter — taking up to two, in the order `claude`, `codex`, `gemini`,
`kimi`, `opencode` — prints a one-line notice naming the path and those
adapters, and continues. With no agent runtime installed it creates nothing
and prints the install commands instead, so the generated config never names
a role that cannot run. The file is yours to edit afterwards; installing
another provider later does not rewrite it. Existing home config values are
preserved, and a cwd config takes precedence over the home file.
`--config <path>` points at a specific YAML file and disables discovery and
auto-create behavior.

When an older home config is loaded through fallback discovery, `tmux-play`
adds only missing safe defaults to that home YAML: `theme: auto`, resolved
layout defaults, `captain.options: {}`, and the notification defaults shown
below. It preserves existing values and does not add model, instruction,
permissions, or an `effort` default to old files.

Legacy cwd configs named `tmux-play.config.mjs`, `tmux-play.config.js`, or
`tmux-play.config.json` are ignored; when one is present without a cwd YAML
config, `tmux-play` prints a warning to rename or convert it.

```yaml
theme: auto
notifications:
  player_finished: bell
  turn_finished: desktop
captain:
  from: '@sublang/cligent/captains/fanout'
  adapter: claude
  model: claude-opus-4-8
  effort: xhigh
  instruction: Coordinate the players and answer the Boss.
  permissions:
    mode: auto
  options: {}
players:
  - id: claude
    adapter: claude
    effort: xhigh
    permissions:
      mode: auto
  - id: codex
    adapter: codex
    effort: xhigh
    permissions:
      mode: auto
```

The top-level `theme` field selects the Catppuccin flavor applied to the
session chrome (status bar, pane-border row, accent colors). Accepted
values are `mocha` (dark terminals), `latte` (light terminals), and
`auto` (default; the launcher probes the terminal's background color
via an OSC 11 query and falls back to Mocha when the terminal does not
answer — run `tmux-play --theme-diagnostics` to see how the flavor was
resolved). A managed launch prepared for later native attachment performs the
same probe before writing its snapshot; a public `attach: false` launch does
not probe and uses the fallback unless a concrete flavor is set. The presenter
inside each pane uses the same resolved flavor for speaker prefixes,
status lines, and tool lifecycle, so the `boss>` prompt and per-player
text stay readable on the host terminal's background.

The optional top-level `notifications` map accepts only these record keys:
`player_finished`, `turn_finished`, and `turn_aborted`. Each key accepts one
sink: `off`, `bell`, or `desktop`. Omitting the block disables
notifications. The generated home config plays a sound cue after every player
finishes without writing terminal BEL (`\x07`) or requesting desktop badging,
and sends a desktop notification when the full Boss turn finishes. On macOS,
turn completion also writes one terminal BEL (`\x07`) so tmux can forward the
turn-completion bell to the outer terminal for Dock/badge handling; users with
audible bell enabled may hear a terminal or system bell. Other desktop
notification events do not write terminal BEL or notification escape bytes.
`turn_aborted` is off by default; when enabled, user cancellations such as ESC,
SIGHUP, SIGINT, SIGTERM, EOF, and runtime disposal stay silent. Sound cues are
best-effort: Hero via `afplay` on macOS, the freedesktop `complete` cue on
Linux, the Windows generic notification sound on Windows, and no-op elsewhere.
Desktop notifications are best-effort: `osascript` on macOS, `notify-send` on
Linux, and no-op elsewhere.

The shipped default applies `permissions: { mode: 'auto' }` to the Captain and both players.
That selects each adapter/provider's native auto posture, whose protection and approval semantics are adapter-specific, reducing routine permission prompts during a session.
Claude's `auto` still blocks high-risk actions and falls back to prompts after repeated denies, and Codex's `on-request + :workspace + auto_review` keeps the same network limits while routing eligible approval requests to a reviewer agent.
OpenCode retains configured rules but may answer permission asks that survive rule evaluation `once` without a human, which OpenCode labels dangerous.
Remove the blocks to fall back to each adapter's SDK default; cligent itself ships no project-wide permission posture.

- Adapters: `claude`, `codex`, `gemini`, `kimi`, `opencode`.
- Player IDs match `^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$`, are unique, and may not be `captain`. Dot-delimited IDs such as `dev.coder` provide namespacing. Multiple players may share an adapter or model; `players: []` selects the Boss/Captain-only form.
- `captain.from` is a local path (`./captains/router.mjs`) or a package subpath. The runtime owns every `Cligent`; the Captain just orchestrates.
- `captain.options` is opaque to the runtime and forwarded to the factory. The built-in `fanout` captain accepts no options — YAML keys under `captain.options` are forwarded but inert. Each player's full `finalText` is included in the summary prompt verbatim; the Captain instruction ("do not copy raw player logs wholesale") is the soft check, and cligent imposes no hard cap on player output length. Workloads that need a cap should wrap the fanout captain or write a custom one.

### Effort

The Captain and each player accept an optional `effort` value. The selected
`adapter` determines the accepted vocabulary; provider-native terms are kept
intact instead of being treated as cross-provider aliases.

```yaml
captain:
  from: '@sublang/cligent/captains/fanout'
  adapter: claude
  effort: ultracode
  options: {}
players:
  - id: coder
    adapter: codex
    effort: ultra
```

| Adapter    | Accepted values                                                 | Provider transport and qualifications                                                                                                                                                                                                                                                        |
| ---------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`   | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultracode` | Portable values use the Claude SDK `effort` field and explicitly set `settings.ultracode: false`. `minimal` maps lossily to `low`. `ultracode` maps to SDK `effort: xhigh` plus `settings.ultracode: true`; it is an exact user-facing Claude term, not a literal single-field pass-through. |
| `codex`    | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`     | `minimal` through `xhigh` use SDK thread `modelReasoningEffort`. `max` and `ultra` pass through unchanged as constructor `config.model_reasoning_effort`, leaving the thread field unset.                                                                                                    |
| `gemini`   | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`              | A concrete `gemini-3*` model gets a temporary settings alias with `thinkingLevel`; a concrete `gemini-2.5*` model gets `thinkingBudget`. An unset model, a CLI alias, or an unmatched model gets no effort override.                                                                         |
| `opencode` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`              | The value maps to the v2 prompt body's `variant`, selected from the `provider/model` prefix. An unknown provider or an omitted or malformed model gets no effort override.                                                                                                                   |
| `kimi`     | `off`, `on`                                                     | Provider-native binary thinking control through ACP. `on` enables the selected model's native default thinking behavior; it is not a portable effort tier. When both are configured, the adapter selects `model` before toggling thinking.                                                   |

Gemini's model-specific mappings are:

| `effort`  | Gemini 3 `thinkingLevel` | Gemini 2.5 `thinkingBudget`                       |
| --------- | ------------------------ | ------------------------------------------------- |
| `minimal` | `MINIMAL`                | `1024`                                            |
| `low`     | `LOW`                    | `4096`                                            |
| `medium`  | `MEDIUM`                 | `8192`                                            |
| `high`    | `HIGH`                   | `16384`                                           |
| `xhigh`   | `HIGH`                   | `24576`                                           |
| `max`     | `HIGH`                   | `32768` for Pro; `24576` for Flash and Flash Lite |

Gemini CLI aliases such as `auto`, `pro`, `flash`, and `flash-lite` are not
resolved by cligent because their target can change between CLI versions.
They receive no effort override, while ordinary `model` forwarding remains
unchanged.

OpenCode's provider-specific prompt variants are:

| `effort`  | Anthropic | OpenAI    | Google |
| --------- | --------- | --------- | ------ |
| `minimal` | `high`    | `minimal` | `low`  |
| `low`     | `high`    | `low`     | `low`  |
| `medium`  | `high`    | `medium`  | `low`  |
| `high`    | `high`    | `high`    | `high` |
| `xhigh`   | `max`     | `xhigh`   | `high` |
| `max`     | `max`     | `xhigh`   | `high` |

Omitting `effort` sets no provider effort, orchestration, alias, or variant
override and leaves the applicable adapter, model, account, runtime, and user
configuration defaults in control. A value accepted here means cligent knows
how to transport or map it; it does not guarantee that the selected model,
account, or installed agent version makes it available. Backend rejection is
reported through the adapter's normal error path without silently choosing a
different value.

`ultracode` and `ultra` may increase token use, latency, cost, concurrency,
and tool activity because they enable provider-native delegation. Selecting
either one does not change the independently configured `permissions` block.

The loader validates `captain.effort` and every `players[N].effort` before the
runtime starts. An unsupported value fails startup with an error naming the
offending path, adapter, and that adapter's allowed values; for example,
Claude rejects `ultra`, while Codex rejects `ultracode`, and Gemini and
OpenCode reject both. Kimi rejects every portable value and accepts only
`off` or `on`.

### Legacy `reasoningEffort` compatibility

During the compatibility period, every discovered home config, cwd config, or
explicit `--config` YAML can still use direct `captain.reasoningEffort` and
`players[N].reasoningEffort` keys. The loader accepts their values in memory
only after the complete document validates, then makes a bounded best-effort
attempt to change those exact parsed key tokens to `effort`. Other occurrences,
including comments, instructions, and opaque `captain.options`, are not changed.

If one Captain or player contains both names (even with equal values), if a
legacy value is invalid for that object's adapter, or if any other part of the
document is invalid, loading fails without writing and preserves the source
byte-for-byte.

If the source no longer matches what was validated, or any read, temporary
write, or replacement step fails, tmux-play skips the disk update and continues
with the validated in-memory `effort`. The launcher warns with the config path
and affected fields and asks you to rename the key manually. An observed newer
source is not overwritten.

This is a small upgrade convenience, not a lossless migration contract. A
successful attempt changes only the direct key tokens, but users should not
rely on preservation of symlink targets, permission metadata, or every
concurrent-writer race. Rename the keys manually when those properties matter.

### Permissions

Captain and each player accept an optional `permissions` block that tmux-play
retains as a runtime-held call default and supplies at the `Cligent.run()`
boundary, where it reaches the adapter's SDK knobs. The runtime-owned
`Cligent` itself carries no permission default, so a complete per-call
`settings` replacement can omit the YAML policy rather than inherit it.
The field is typed; arbitrary adapter-specific knobs are not
settable from YAML.

```yaml
captain:
  from: '@sublang/cligent/captains/fanout'
  adapter: claude
  options: {}
  permissions:
    mode: auto # session-wide automation posture
players:
  - id: coder
    adapter: codex
    permissions:
      mode: auto
      writablePaths:
        - .git # allow git metadata writes under mode: auto
  - id: reviewer
    adapter: claude
    permissions:
      fileWrite: ask # per-capability levels
      shellExecute: deny
      networkAccess: deny
  - id: kimi-coder
    adapter: kimi
    permissions:
      mode: auto # Kimi's native ACP auto mode
```

- `mode: 'auto'` selects each adapter/provider's native automation posture,
  whose protection and approval semantics are adapter-specific (claude
  `permissionMode: auto`, codex `approval_policy:
on-request + default_permissions: :workspace + approvals_reviewer:
auto_review` with user config ignored for that managed run, gemini
  `--approval-mode yolo`, kimi ACP `mode: auto`; opencode retains configured
  rules and answers surviving asks `once`, which OpenCode labels dangerous).
  For OpenCode, explicitly supplied capability fields compose with auto while
  omitted fields preserve provider and user rules.
  `mode: 'bypass'` selects each adapter's
  unchecked-bypass mode where the SDK supports one; the
  opencode adapter rejects `bypass` because the cligent opencode path
  drives `opencode serve` via the SDK rather than `opencode run`; Kimi also
  rejects it because its `yolo` mode does not satisfy Cligent's unchecked
  bypass contract.
- When `mode` is unset, adapters other than Kimi derive an effective posture
  from `fileWrite` / `shellExecute` / `networkAccess`. Kimi rejects any
  supplied no-mode policy, including an empty block or per-capability fields,
  because ACP cannot replace permission decisions made by the CLI's native
  rules before the client is consulted.
- `writablePaths` lists additional workspace-relative paths that should be
  writable for the run. Use `writablePaths: ['.git']` when a Codex player
  running with `mode: auto` needs git metadata writes such as `git add` or
  `git commit`; the `.git` directory entry covers `.git/index`,
  `.git/objects`, `.git/refs`, and the rest of that subtree. The field does
  not approve commands or grant network access.
- `writablePaths` entries must stay inside the workspace. Valid examples
  include `.git`, `.git/objects`, and `generated/cache`; invalid examples
  include `.`, `./`, absolute paths, paths containing `..`, globs such as
  `.git/**`, and shell expansions.
- Omitting `permissions` leaves the adapter on its SDK default; cligent
  imposes no project-wide policy.
- Kimi accepts `writablePaths` only alongside `mode: auto`; paths are validated
  and reported as `ambient`, not sandbox-enforced or converted into extra
  grants. Any permission request that reaches the headless ACP client is
  surfaced as an event and rejected.

## Layout

Boss/Captain occupies the left pane; the visible players fill the right in
order. Sessions start on a 174×49 grid. The visible columns derive from the
_visible_ player set (see `layout.initialVisible` below), not the full
roster: an empty roster uses one full-width Boss/Captain column, one visible
player uses two columns, and two or more use three. The first player column
holds `ceil(visibleCount / 2)` players from top to bottom.

The optional top-level `layout` block tunes the window grid, the per-column
weights, and which players are visible at startup:

```yaml
layout:
  window:
    columns: 174 # initial cell grid (default 174 × 49)
    rows: 49
  multiPlayerColumnWeights: [1, 1, 1] # Boss + 2 player columns (3-column shape)
  singlePlayerColumnWeights: [1, 1] # Boss + 1 player column (2-column shape)
  initialVisible: # panes shown at startup (default: all, in order)
    - claude
    - codex
```

- `window.columns` / `window.rows` set the initial tmux grid (default
  `174 × 49`); each defaults independently when only one is supplied.
- `singlePlayerColumnWeights` (length 2) and `multiPlayerColumnWeights`
  (length 3) are the canonical per-column weights, selected by the visible
  column shape. A non-rightmost column `i` takes `floor(W * w_i / sum(w))`
  cells of a `W`-cell window; the rightmost column absorbs the remainder.
  Weights are positive integers — scale a fractional ratio yourself (write
  `[1, 3]` for a `0.5 : 1.5` split). Defaults are `[1, 1]` and `[1, 1, 1]`.
- `columnWeights` is a backward-compatible alias: a two-element value feeds
  `singlePlayerColumnWeights`, a three-element value feeds
  `multiPlayerColumnWeights`. Setting `columnWeights` together with the
  matching canonical field is rejected; a home config that still uses
  `columnWeights` is migrated to the canonical field in place.
- `initialVisible` is an optional, duplicate-free subset of the configured
  player IDs naming the players whose panes appear at startup, in that order.
  It may be `[]` only when `players` itself is empty; that Boss/Captain-only
  session has no player pane or log-tail process. Omitting it shows every
  configured player in `players` order, including the empty set.
  Hidden players stay live and keep accumulating output to their per-player
  logs; a Captain can change the visible set during the session via
  `setVisiblePlayers`, and a re-shown player's pane is rebuilt from the recent
  tail of its log.

tmux-play enables tmux mouse mode for the session, so dragging selects within
one pane. Releasing the mouse keeps the selection highlighted in copy mode;
right-click copies the selection through tmux's normal copy path and also
pipes it to the host system clipboard when `pbcopy`, `wl-copy`, `xclip`,
`xsel`, `clip.exe`, or OSC 52 clipboard delivery through tmux is available.

## Snapshot and work directory

The launcher validates the config and writes
`tmux-play.config.snapshot.json` into a `tmux-play-*` work directory under
`os.tmpdir()`, then re-execs itself in session mode with `--work-dir` set.
Local `captain.from` paths are rewritten to absolute `file://` URLs
relative to the original config file; package specifiers pass through
unchanged. The session reads the snapshot, so YAML is not re-parsed inside
tmux.

## Custom Captains

A Captain module default-exports a factory. The full typed contract —
`Captain`, `CaptainSession`, `CaptainContext`, `BossTurn`,
`PlayerRunResult`, `CaptainRunResult`, and the record/observer types — is exported from
`@sublang/cligent/tmux-play`. Captains call players via
`context`, and may retain the `CaptainSession` from `init()` to
`emitStatus`/`emitTelemetry` from `init`, during turns, or between turns.
The optional `prepareDispose()` hook is the final point at which those session
emissions remain live; it runs after the active turn settles and before the
session signal aborts. Use `dispose()` only for post-close resource release —
session emissions reject there.
Both `session` and per-turn `context` expose `setVisiblePlayers(playerIds)`;
pass a duplicate-free subset of configured player IDs to choose which player
panes are visible. An empty list is accepted only when the configured roster
is empty; a nonempty roster cannot be hidden completely. The roster stays
unchanged, hidden players keep their logs, and awaiting the call lets the pane
rebuild finish before later player output is presented.

Every turn-scoped `CaptainContext` surface — `callPlayer`, `callCaptain`,
`setVisiblePlayers`, and `emitReply` — accepts new work only until the runtime
resumes from `handleBossTurn`. Promises obtained before that boundary continue
to settle, and the turn remains abortable while the runtime joins and drains
them before its terminal record.

Use `context.emitReply(text)` for natural Captain prose in the Boss pane. It
renders through the normal Markdown pipeline under the `captain> ` prefix;
use retained `CaptainSession.emitStatus` / `emitTelemetry` for operational or
structured session-lifetime output instead.

`context.callPlayer(playerId, prompt, options?)` also accepts
`{ resume: <token> }` to select an opaque backend session explicitly, or
`{ resume: false }` to force a fresh session even when that persistent player
has an automatic resume token. Omitting `options.resume` preserves the default
auto-resume behavior. Persist and reuse only result-level resume tokens —
`PlayerRunResult.resumeToken` or `CaptainRunResult.resumeToken`; event-level
`sessionId` values are transport correlation and may be synthetic.

`context.callCaptain(prompt, options?)` accepts the same `resume` selection,
plus `visibility: 'visible' | 'hidden'` and `allowedTools`. Its returned
`CaptainRunResult.resumeToken` is the opaque handle to persist when a later
Captain call must explicitly continue that backend session.
Tool-list support is adapter-specific: adapters with no independent exact
tool-registry surface, including Codex, Kimi, and OpenCode 1.18.25, reject an
explicit list before backend invocation.

Both call surfaces also accept a complete `settings` replacement:

```js
await context.callPlayer('dev.coder', prompt, {
  settings: {
    model: { kind: 'provider-default' },
    effort: { kind: 'value', value: 'high' },
    instruction: 'Implement the smallest coherent change.',
    permissions: { mode: 'auto', writablePaths: ['.git'] },
  },
});
```

Player IDs may use dot-delimited namespaces such as `dev.coder` and
`dev.reviewer`. When `settings` is omitted, tmux-play supplies the YAML model,
effort, instruction, and permissions as runtime-held call defaults. A supplied
`settings` object is the entire effective call
configuration: omitted `instruction` and `permissions` mean none, and neither
is merged with YAML defaults. Each `model` and `effort` selector is either a
concrete value or `provider-default`; the latter omits that option so Codex or
Gemini chooses its current default even on a resumed call. Claude and OpenCode
support provider defaults on fresh calls and can use default effort beside a
concrete resumed model, but a resumed provider-default model fails closed:
Claude Code restores the transcript model, while OpenCode persists its session
model without exposing a reset. Omitted permissions on
a resumed OpenCode complete-settings call clear the prior Cligent-owned session
ruleset. Kimi supports default reset only for a fresh call because ACP cannot
restore a resumed session's provider default. Invalid or unenforceable settings
fail before an agent call begins and do not discard the stored resume token.
tmux-play resolves the effective explicit, forced-fresh, or automatic resume
selection once at admission and uses that same selection for reset preflight
and the provider run.
Those failures reject with the public `AgentCallSettingsError`, preserving the
original diagnostic and `cause`. Use `isAgentCallSettingsError(error)` from
`@sublang/cligent/tmux-play` when deciding whether to retain the selected
session and ask for corrected settings. The predicate remains valid across
duplicate package instances and does not match turn-scope, unknown-player,
provider-execution, or observer-dispatch failures.

## Embedding a managed interactive session

`launchManagedTmuxPlay` and `runManagedTmuxPlaySession` are the public boundary
for a front end that owns durable session state. The launcher requires the
front end's public session ID to match
`^[A-Za-z0-9][A-Za-z0-9_-]*$`; the corresponding tmux session is named exactly
`tmux-play-<sessionId>`. Invalid IDs reject before work-directory or tmux
mutation. The launcher returns a prepared handle only after the pane child has
initialized or restored its runtime. Input is still gated then, so
the front end can report that ID before it calls `await prepared.attach()`.
Use `await prepared.cancel()` if reporting or handoff fails.
`runManagedTmuxPlaySession` independently validates the same grammar before it
starts lifecycle or presentation work.

An embedding front end can retain signal ownership until native attach with
`await prepared.attach({ signal, beforeNativeAttach })`. An abort before native
handoff gracefully retires the managed child and rejects only after bounded
shutdown and cleanup, with the abort reason first if cleanup also fails.
Immediately before the native tmux client starts, Cligent disarms managed
abort handling and synchronously invokes `beforeNativeAttach`; use that hook to
transfer or remove the embedding's temporary signal handlers. Signals after
the hook belong to the embedding and native client. With `attach: false`, the
hook never runs and abort remains managed through coordination cleanup.

The session-command context also supplies shutdown-request and shutdown-complete
paths plus `workDirOwnedByLauncher`. Pass that ownership boolean unchanged to
`runManagedTmuxPlaySession`; the child requires both a true value and a
launcher-ownership marker matching its own session ID before it can remove the
work directory. Marker presence by itself never grants cleanup ownership.
Cancellation and post-start launch failures request graceful child
shutdown, await cleanup acknowledgement and pane exit under the independent
`shutdownTimeoutMs`, and only then use a forced tmux kill as a bounded fallback.
After that kill, Cligent allows a fixed 500 ms for tmux to stop reporting the
pane; if it cannot prove retirement, it preserves the work and coordination
state and reports the cleanup defect.
Input-gate and shutdown-request markers are atomically published, so a polling
child cannot mistake an in-progress write for an invalid control message.
Launcher-created work directories carry the matching ownership marker and are
removed when no child can own cleanup. Caller-supplied directories carry no
such marker and are never recursively removed by the launcher or child, so the
directory and unrelated pre-existing entries survive shutdown; tmux-play still
writes its named logs, snapshot, and session artifacts there during a
successful launch. With `attach: false`, activation completes without an outer client,
closes the launcher coordination boundary, and leaves signals or EOF as the
child-owned cleanup path.

The child supplies lifecycle hooks to `runManagedTmuxPlaySession`. The runner
first removes the hosting session's `TMUX` and `TMUX_PANE` handles from the
environment inherited by agent subprocesses, just like stock session mode;
the orchestrator retains a private snapshot for its own tmux operations. A nonempty
turn awaits `beforeNonEmptyTurn`, crosses the runtime's complete turn fence,
then invokes `afterTurn` with detached Captain replies and the exact
`turn_finished` or `turn_aborted` record. Replies remain invisible until a
finished turn's `afterTurn` succeeds, and that successful settlement still
releases its replies if shutdown has started and is awaiting the transaction;
aborted and failed turns release none.
Pre-activation input remains queued as semantic prompts, including one
newline-preserving prompt for a bracketed multiline paste. If the fenced
runtime rejects after emitting its terminal record, `afterTurn` still receives
that record before the original failure enters managed shutdown.
Shutdown from EOF, SIGHUP, SIGINT, SIGTERM, or the embedding request first
aborts active work, then awaits the full hook/turn transaction
and runtime disposal before the lifecycle shutdown hook, so an embedding host
can release its lease without racing write-ahead, settlement, or semantic
runtime disposal. The lifecycle hook and an active turn see the exact reason
`embedding shutdown request` for that marker, distinct from `SIGHUP` for the
signal. The child publishes shutdown completion only after cleanup.
If the initiating failure and later shutdown steps both fail, the returned
`AggregateError` keeps the initiating failure first and includes every cleanup
defect; a lone failure retains its original object identity.

```js
export default function createCaptain(options = {}) {
  let captainSession;
  return {
    async init(session) {
      captainSession = session;
      await session.emitStatus('Captain ready', {
        players: session.players.length,
      });
      await session.emitTelemetry({
        topic: 'captain.ready',
        payload: { options },
      });
    },

    // Minimal example: real Captains usually frame prompts per player.
    async handleBossTurn(turn, context) {
      const results = await Promise.all(
        context.players.map((r) => context.callPlayer(r.id, turn.prompt)),
      );
      const summary = results
        .map(
          (r) =>
            `${r.playerId}: ${r.finalText ?? r.error ?? '(no final text)'}`,
        )
        .join('\n\n');
      await context.callCaptain(
        `Boss:\n${turn.prompt}\n\nPlayers:\n${summary}`,
      );
    },

    async prepareDispose() {
      await captainSession.emitTelemetry({
        topic: 'captain.disposed',
        payload: { complete: true },
      });
    },

    async dispose() {},
  };
}
```

Built-in `fanout` (`@sublang/cligent/captains/fanout`) uses this same
contract — third-party Captains aren't second-class.
