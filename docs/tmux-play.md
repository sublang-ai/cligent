<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# tmux-play

`tmux-play` is a reference application built on the `@sublang/cligent`
SDK. The Boss chats with a Captain in the left pane; the Captain
coordinates per-player `Cligent` instances whose output streams into
read-only panes on the right.

```bash
tmux-play                                 # discover or create config
tmux-play --config ./tmux-play.config.yaml
```

Requirements:

- [`tmux`](https://github.com/tmux/tmux/wiki/Installing).
- [`glow`](https://github.com/charmbracelet/glow#installation) — Markdown renderer used by the in-pane output pipeline; the launcher fails fast if it is missing.
- Credentials and any out-of-process CLIs for the adapters you use:
  [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview),
  [Codex CLI](https://github.com/openai/codex),
  [Gemini CLI](https://github.com/google-gemini/gemini-cli),
  [OpenCode](https://opencode.ai).

Each configured adapter behaves the same way it would for direct
`Cligent` use (see [guide.md](guide.md)).

## Config

Discovery order:

1. `tmux-play.config.yaml` in the cwd.
2. `${XDG_CONFIG_HOME:-~/.config}/tmux-play/config.yaml`.

If neither file exists and `--config` is not set, `tmux-play` creates the
home config with the default `fanout` Captain and two stub players, prints a
one-line notice, and continues. Existing home config values are preserved,
and a cwd config takes precedence over the home file. `--config <path>`
points at a specific YAML file and disables discovery and auto-create
behavior.

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
`auto` (default; the launcher detects via `COLORFGBG` and
`TERM_PROGRAM=Apple_Terminal`, then falls back to Mocha). The presenter
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
SIGINT, SIGTERM, EOF, and runtime disposal stay silent. Sound cues are
best-effort: Hero via `afplay` on macOS, the freedesktop `complete` cue on
Linux, the Windows generic notification sound on Windows, and no-op elsewhere.
Desktop notifications are best-effort: `osascript` on macOS, `notify-send` on
Linux, and no-op elsewhere.

The shipped default applies `permissions: { mode: 'auto' }` to the
Captain and both players. That runs each adapter's classifier-, sandbox-,
or reviewer-protected auto-mode, reducing routine permission prompts
during a session. Prompts are not eliminated: Claude's `auto`
still blocks high-risk actions and falls back to prompts after repeated
denies, and Codex's `on-request + :workspace + auto_review` keeps the
same network limits while routing eligible approval requests to a
reviewer agent. Remove the blocks to fall back to each adapter's SDK
default; cligent itself ships no project-wide permission posture.

- Adapters: `claude`, `codex`, `gemini`, `opencode`.
- Player IDs match `^[a-z][a-z0-9_-]*$`, are unique, and may not be `captain`. Multiple players may share an adapter or model.
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
OpenCode reject both.

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

Captain and each player accept an optional `permissions` block that maps to
`CligentOptions.permissions` and reaches the adapter's SDK knobs at run
time. The field is typed; arbitrary adapter-specific knobs are not
settable from YAML.

```yaml
captain:
  from: '@sublang/cligent/captains/fanout'
  adapter: claude
  options: {}
  permissions:
    mode: auto                  # session-wide automation posture
players:
  - id: coder
    adapter: codex
    permissions:
      mode: auto
      writablePaths:
        - .git                 # allow git metadata writes under mode: auto
  - id: reviewer
    adapter: claude
    permissions:
      fileWrite: ask            # per-capability levels
      shellExecute: deny
      networkAccess: deny
```

- `mode: 'auto'` selects each adapter's classifier-, sandbox-, or reviewer-protected
  auto-mode (claude `permissionMode: auto`, codex `approval_policy:
  on-request + default_permissions: :workspace + approvals_reviewer:
  auto_review` with user config ignored for that managed run, gemini
  `--approval-mode yolo`, opencode `permission: allow` SDK body).
  `mode: 'bypass'` selects each adapter's
  unchecked-bypass mode where the SDK supports one; the
  opencode adapter rejects `bypass` because the cligent opencode path
  drives `opencode serve` via the SDK rather than `opencode run`.
- When `mode` is unset, the adapter derives an effective posture from
  `fileWrite` / `shellExecute` / `networkAccess`.
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

## Layout

Boss/Captain occupies the left pane; the visible players fill the right in
order. Sessions start on a 174×49 grid. The visible columns derive from the
*visible* player set (see `layout.initialVisible` below), not the full
roster: two columns with one visible player, three with two or more, and the
first player column holds `ceil(visibleCount / 2)` players from top to bottom.

The optional top-level `layout` block tunes the window grid, the per-column
weights, and which players are visible at startup:

```yaml
layout:
  window:
    columns: 174                       # initial cell grid (default 174 × 49)
    rows: 49
  multiPlayerColumnWeights: [1, 1, 1]  # Boss + 2 player columns (3-column shape)
  singlePlayerColumnWeights: [1, 1]    # Boss + 1 player column (2-column shape)
  initialVisible:                      # panes shown at startup (default: all, in order)
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
- `initialVisible` is an optional, non-empty, duplicate-free subset of the
  configured player IDs naming the players whose panes appear at startup, in
  that order. Omitting it shows every configured player in `players` order.
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

A Captain module default-exports a factory. Captains call players via
`context`, and may retain the `CaptainSession` from `init()` to
`emitStatus`/`emitTelemetry` from `init`, during turns, or between turns.
The optional `prepareDispose()` hook is the final point at which those session
emissions remain live; it runs after the active turn settles and before the
session signal aborts. Use `dispose()` only for post-close resource release —
session emissions reject there.
Both `session` and per-turn `context` expose `setVisiblePlayers(playerIds)`;
pass a non-empty, duplicate-free subset of configured player IDs to choose
which player panes are visible. The roster stays unchanged, hidden players
keep their logs, and awaiting the call lets the pane rebuild finish before
later player output is presented.

`context.callPlayer(playerId, prompt, options?)` also accepts
`{ resume: <token> }` to select an opaque backend session explicitly, or
`{ resume: false }` to force a fresh session even when that persistent player
has an automatic resume token. Omitting `options.resume` preserves the default
auto-resume behavior. Persist and reuse only `PlayerRunResult.resumeToken`;
event-level `sessionId` values are transport correlation and may be synthetic.

```js
export default function createCaptain(options = {}) {
  let captainSession;
  return {
    async init(session) {
      captainSession = session;
      await session.emitStatus('Captain ready', { players: session.players.length });
      await session.emitTelemetry({ topic: 'captain.ready', payload: { options } });
    },

    // Minimal example: real Captains usually frame prompts per player.
    async handleBossTurn(turn, context) {
      const results = await Promise.all(
        context.players.map((r) => context.callPlayer(r.id, turn.prompt)),
      );
      const summary = results
        .map((r) => `${r.playerId}: ${r.finalText ?? r.error ?? '(no final text)'}`)
        .join('\n\n');
      await context.callCaptain(`Boss:\n${turn.prompt}\n\nPlayers:\n${summary}`);
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
