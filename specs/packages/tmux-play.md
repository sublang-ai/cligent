<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# tmux-play: tmux Play Application

## Intent

This package lets an operator run a multi-agent conversation in a tmux session, with a Boss at the keyboard, a scripted Captain orchestrating, and any number of coding agents as players, per [DR-004](../decisions/004-tmux-play-captain-architecture.md).
It owns the application's configuration, its tmux topology and presentation, the Captain contract and its records, the session lifecycle, and the per-call settings a Captain may vary, not the behavior of any agent adapter it drives.
Its requirements are stated in this project's `Cligent`, `AgentOptions`, `PermissionPolicy`, and adapter vocabulary, which the engine and the adapter packages define, and in the `tmux-play` executable, configuration file, and `@sublang/cligent/tmux-play` sub-export the distributable ships.

## External Behavior

### CLI Invocation

### tmux-play-1

The `@sublang/cligent` package shall expose a `tmux-play` bin entry.

### tmux-play-204

After recognized CLI flags are parsed, `tmux-play` shall select the first applicable dispatch outcome:

| Priority and invocation state | Outcome |
| --- | --- |
| `--help` present, alone or with any other recognized flags | print usage and exit zero before mode-specific validation or work |
| no help; `--theme-diagnostics` combined with a non-empty `--session` | apply [[tmux-play-61](#tmux-play-61)]'s diagnostics/session rejection |
| no help; diagnostics without a non-empty `--session`; non-empty `--work-dir` | apply [[tmux-play-61](#tmux-play-61)]'s diagnostic work-directory rejection |
| no help; diagnostics without a non-empty `--session` or `--work-dir`; `--owned-work-dir` | apply [[tmux-play-61](#tmux-play-61)]'s diagnostic ownership rejection |
| no help; diagnostics without a non-empty `--session` or `--work-dir` and without `--owned-work-dir` | apply [[tmux-play-61](#tmux-play-61)]'s launcher-only outcome |
| no help or diagnostics; non-empty `--session` combined with a non-empty `--config` | reject because `--config` is launcher-only |
| no help or diagnostics; non-empty `--session` without a non-empty `--work-dir` | reject because session mode requires `--work-dir` |
| no help or diagnostics; non-empty `--session`; work directory missing or not a directory | reject with `work dir does not exist or is not a directory: <path>` |
| no help or diagnostics; non-empty `--session`; work directory fails write or traversal access | reject with `work dir is not writable: <path>` |
| no help or diagnostics; non-empty `--session`; valid work directory | dispatch [[tmux-play-3](#tmux-play-3)] |
| no help, diagnostics, or non-empty `--session`; non-empty `--work-dir` | reject because `--work-dir` is session-only |
| no help, diagnostics, non-empty `--session`, or `--work-dir`; `--owned-work-dir` | reject because `--owned-work-dir` is session-only |
| no help, diagnostics, non-empty `--session`, non-empty `--work-dir`, or `--owned-work-dir` | dispatch [[tmux-play-2](#tmux-play-2)] |

### tmux-play-2

When [[tmux-play-204](#tmux-play-204)] admits ordinary launcher mode, the CLI shall resolve the config, verify the configured adapters' runtimes per [[tmux-play-89](#tmux-play-89)], construct the tmux session, attach, and exit.

### tmux-play-3

When [[tmux-play-204](#tmux-play-204)] admits session mode with `--session <id> --work-dir <path>`, the CLI shall instantiate the Captain and players, run a Boss readline against stdin/stdout, dispatch records to observers, and clean up on exit.

### tmux-play-4

When `--config <path>` is supplied, the launcher shall load that file and skip discovery and first-run auto-create.

### tmux-play-61

When `--theme-diagnostics` is supplied after [[tmux-play-204](#tmux-play-204)]'s help check, the CLI shall select the first applicable diagnostic outcome through this matrix and, for every accepted flow, exit without checking adapter-runtime readiness, checking for `tmux` or Glow, creating a config or tmux session, or attaching:

| Invocation and config state | Outcome |
| --- | --- |
| combined with a non-empty `--session` | reject with `--theme-diagnostics is only valid in launcher mode` before dispatching session mode |
| no non-empty `--session`; non-empty `--work-dir` | reject with `--work-dir is only valid with --session` before diagnostic handling |
| no non-empty `--session` or `--work-dir`; `--owned-work-dir` | reject with `--owned-work-dir is only valid with --session` before diagnostic handling |
| diagnostic flow with a discoverable or explicit config | load that config, resolve the Catppuccin flavor per [[tmux-play-194](#tmux-play-194)], and print `selected: <flavor>` plus `reason: <explicit\|yaml\|osc11\|fallback>` to stdout, including the raw OSC 11 reply when received |
| diagnostic flow where discovery per [[tmux-play-9](#tmux-play-9)] finds no config and `--config` is absent | resolve the flavor as for `theme: auto` and print `selected: <flavor>` plus `reason: <explicit\|yaml\|osc11\|fallback>` to stdout, including the raw OSC 11 reply when received |

### Configuration

### tmux-play-5

When the loader resolves the top-level configuration, it shall admit this surface:

| Member or form | Contract |
| --- | --- |
| document | YAML |
| `captain` | required object |
| `players` | required array, which may be empty for a Boss/Captain-only session |
| `theme` | optional field per [[tmux-play-60](#tmux-play-60)] |
| `layout` | optional field per [[tmux-play-64](#tmux-play-64)] |
| `notifications` | optional field per [[tmux-play-76](#tmux-play-76)] |

### tmux-play-6

The `captain` object shall require `from` (local path or package specifier), `adapter` (one of `claude`, `codex`, `gemini`, `opencode`, `kimi`), and may include `model`, `instruction`, a `permissions` object per [[tmux-play-52](#tmux-play-52)], `effort` per [[tmux-play-56](#tmux-play-56)], and an opaque `options` value forwarded verbatim to the Captain factory.

### tmux-play-60

When the configuration system resolves the top-level `theme` field, it shall apply this matrix:

| Input or output context | Outcome |
| --- | --- |
| `'mocha'`, `'latte'`, or `'auto'` | accept the value and select the Catppuccin flavor per [[tmux-play-194](#tmux-play-194)] |
| field missing | treat it as `'auto'` |
| another value | reject with an error naming `theme` per [[tmux-play-8](#tmux-play-8)] |
| default home config | include `theme: auto` so first-run users can see the option |

### tmux-play-64

When the configuration system resolves the optional top-level `layout` object, it shall apply this matrix, with `initialVisible` governed by [[tmux-play-80](#tmux-play-80)]:

| Input or derived value | Outcome |
| --- | --- |
| object surface | admit only the optional `window`, `singlePlayerColumnWeights`, `multiPlayerColumnWeights`, `columnWeights`, and `initialVisible` fields |
| `window` | admit optional positive-integer `columns` and `rows`; they supply the initial cell grid to [[tmux-play-35](#tmux-play-35)]'s `new-session -x/-y` and the pre-attach CSI 8 sequence to [[tmux-play-43](#tmux-play-43)] |
| `window` missing | resolve `{ columns: 174, rows: 49 }` |
| partial `window` | preserve each supplied member and independently default missing `columns` to `174` or `rows` to `49`, never replacing the whole object |
| zero visible players | select the full-width Boss/Captain column with active weights `[1]`; expose no authored one-element weight field |
| one visible player | select `singlePlayerColumnWeights`, whose explicit value is a two-positive-integer array and whose deferred default is `[1, 1]`, independent of the configured-player count |
| two or more visible players | select `multiPlayerColumnWeights`, whose explicit value is a three-positive-integer array and whose deferred default is `[1, 1, 1]`, independent of the configured-player count |
| omitted canonical field | leave the field absent until explicit values and the alias have been considered |
| two-element `columnWeights` | alias `singlePlayerColumnWeights` |
| three-element `columnWeights` | alias `multiPlayerColumnWeights` |
| alias and matching canonical field both present | reject per [[tmux-play-8](#tmux-play-8)]; an alias of one shape may coexist with the other shape's canonical field |
| weight source for a visible-column shape | choose its explicit canonical field, otherwise its matching alias, otherwise its shape default |
| resolved weights `[w_0, ..., w_{N-1}]` at width `W` | give each non-rightmost column `i` `floor(W * w_i / sum(w))` cells and the rightmost column the remainder per [[tmux-play-44](#tmux-play-44)]; the defaults yield 50/50 or even thirds |
| authored fractional ratio | require equivalent positive integers such as `[1, 3]` for `[0.5, 1.5]`; do not rescale it |
| invalid value | reject with an error naming the path per [[tmux-play-8](#tmux-play-8)]: non-integer or non-positive window dimensions; a weight field that is not an array; a NaN, infinite, fractional, zero, negative, or non-number weight; a canonical array of the wrong fixed length; an alias length other than two or three; or an alias colliding with its canonical field |
| snapshot per [[tmux-play-34](#tmux-play-34)] | preserve the resolved window dimensions and both canonical weight arrays verbatim so session mode can render either visible-column shape without re-resolving defaults |

### tmux-play-80

When the configuration system resolves optional `layout.initialVisible` against [[tmux-play-7](#tmux-play-7)]'s configured roster, it shall apply this matrix:

| Input or derived value | Outcome |
| --- | --- |
| non-empty duplicate-free array of configured player IDs | preserve the array as the startup-visible set and pane order |
| field omitted | use every configured player in roster order, preserving prior all-visible behavior |
| empty array with empty roster | accept it as the empty startup-visible set |
| field omitted with empty roster | resolve the same empty startup-visible set |
| empty array with non-empty roster, duplicate, or unknown ID | reject with an error naming the offending path per [[tmux-play-8](#tmux-play-8)] |
| any resolved non-empty roster | never produce an empty visible set |
| visible-column shape and [[tmux-play-64](#tmux-play-64)] weight preset | derive both from startup-visible-set size rather than configured-roster size |
| snapshot per [[tmux-play-34](#tmux-play-34)] | preserve the resolved startup-visible IDs so session mode and [[tmux-play-83](#tmux-play-83)] share the launcher's set |

### tmux-play-76

When the configuration system resolves the optional top-level `notifications` map, it shall apply this matrix:

| Input or output | Outcome |
| --- | --- |
| event key | accept only `player_finished`, `turn_finished`, and `turn_aborted`; reject `runtime_error` |
| sink | accept only `off`, `bell`, and `desktop`, with `bell` meaning a best-effort native sound rather than terminal BEL |
| block missing | resolve every event to `off` |
| event missing from a present block | resolve that event to `off` |
| accepted config | give [[tmux-play-34](#tmux-play-34)]'s snapshot all three resolved event keys |
| unknown key or invalid sink | reject with an error naming the offending path per [[tmux-play-8](#tmux-play-8)] |

### tmux-play-7

When the loader resolves an entry in `players`, it shall apply this matrix:

| Field or roster condition | Outcome |
| --- | --- |
| `id` and `adapter` | require both; accept only adapters `claude`, `codex`, `gemini`, `opencode`, and `kimi` |
| optional fields | accept `model`, `instruction`, `permissions` per [[tmux-play-52](#tmux-play-52)], and `effort` per [[tmux-play-56](#tmux-play-56)] |
| `id` | require a unique non-`captain` value matching `^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$` |
| adapter and model reused by several players | accept the entries |

### tmux-play-52

When the loader resolves optional `permissions` on the `captain` or a player, it shall apply this matrix per [DR-005](../decisions/005-per-adapter-permission-configuration.md):

| Input | Outcome |
| --- | --- |
| field absent | retain the adapter's SDK default with no policy override |
| accepted object | admit optional [[engine-21](engine.md#engine-21)] `mode` values `'auto'` and `'bypass'`; optional `fileWrite`, `shellExecute`, and `networkAccess` values from the closed set `'allow' \| 'ask' \| 'deny'`; and [[engine-22](engine.md#engine-22)]'s optional workspace-relative `writablePaths`; validate and canonicalize paths per [[engine-53](engine.md#engine-53)]; retain the policy as the role's call default |
| non-object field, unknown member, value outside a closed set, or invalid path | reject with an error naming the offending path per [[tmux-play-8](#tmux-play-8)] |

### tmux-play-56

When the loader resolves optional `effort` on the `captain` or a player, it shall apply this matrix per [DR-009](../decisions/009-adapter-scoped-effort-vocabularies.md):

| Input | Outcome |
| --- | --- |
| adapter-scoped value | accept `claude`'s portable values plus `ultracode`, `codex`'s portable values plus `ultra`, `gemini` and `opencode`'s [[engine-39](engine.md#engine-39)] portable values, and `kimi`'s provider-native `off` and `on`, per [[engine-40](engine.md#engine-40)] |
| accepted value | retain it as the role's call default |
| unsupported value | reject before runtime start with an error naming the path, adapter, and allowed values |
| field absent | retain the adapter's defaults with no override |

### tmux-play-95

Where tmux-play exports captain, player, and runtime configuration types, those types shall preserve [[tmux-play-56](#tmux-play-56)]'s correlation between each adapter and its effort vocabulary.

### tmux-play-86

Where the first release carrying canonical `effort` loads direct `captain.reasoningEffort` or `players[N].reasoningEffort` keys without same-object `effort`, the loader shall perform this compatibility flow:

| Stage or condition | Outcome |
| --- | --- |
| value validation | validate and use each legacy value as that object's in-memory `effort` |
| complete config valid and source bytes unchanged | locate only the parsed legacy key tokens, replace them with `effort`, re-read the source, and make a best-effort same-directory atomic update |
| reporting | invoke the optional deprecation callback with the config path, accepted field paths, and update outcome |
| source changed or update failed | continue with the validated in-memory values, preserve the source, and report an actionable manual rename |
| comments, instructions, or opaque `captain.options.reasoningEffort` | leave outside this compatibility path |

### tmux-play-87

When effort-key compatibility examines a loaded captain or player object, it shall apply this matrix:

| State | Outcome |
| --- | --- |
| both `effort` and deprecated `reasoningEffort` present | reject with an error naming the path, without a callback or write |
| legacy value invalid for the object's adapter | reject with an error naming the path, without a callback or write |
| compatible update | promise preservation only of changing the identified key tokens; keep independent home safe-default and layout migrations under [[tmux-play-90](#tmux-play-90)] |

### tmux-play-8

When loading a config, the loader shall reject malformed YAML and unknown fields with an error that names the offending file or path.

### Discovery and First-Run

### tmux-play-9

When `--config` is absent, the launcher shall select the configuration source through this matrix:

| Environment and files | Outcome |
| --- | --- |
| cwd contains `tmux-play.config.yaml` | use that file |
| cwd lacks it and `${XDG_CONFIG_HOME:-~/.config}/tmux-play/config.yaml` exists | use the home file |
| `XDG_CONFIG_HOME` is empty or unset | treat it as unset and use `~/.config` for the home candidate |
| neither file exists | report no discovered config to the first-run flow |

### tmux-play-10

Where [[tmux-play-204](#tmux-play-204)] has admitted ordinary launcher mode, neither discovery location holds a config, and `--config` is absent, the launcher shall select the first-run outcome through this matrix:

| Runtime availability | Outcome |
| --- | --- |
| at least one supported adapter runtime installed | create the home file from [[tmux-play-11](#tmux-play-11)]'s default, print one stdout line naming the path and the installed adapters used for its roster, and continue |
| no supported adapter runtime installed | create no file, print nothing to stdout, and fail with every supported adapter plus the commands that install what it requires, leaving no config whose roles cannot run |

### tmux-play-90

When fallback discovery loads an existing home YAML, the launcher shall apply this migration matrix:

| Existing state or source | Outcome |
| --- | --- |
| safe default missing | add only `theme: auto`, a `layout` block carrying the default `window` and shipped `multiPlayerColumnWeights` per [[tmux-play-11](#tmux-play-11)], `captain.options: {}`, and [[tmux-play-11](#tmux-play-11)]'s notification defaults |
| existing user values | preserve them; add no `model`, `instruction`, `permissions`, or `effort` defaults |
| two-element legacy `layout.columnWeights` | rewrite it as `layout.singlePlayerColumnWeights` and write one final YAML form without the alias |
| three-element legacy `layout.columnWeights` | rewrite it as `layout.multiPlayerColumnWeights` and write one final YAML form without the alias |
| alias and matching canonical field both present | do not resolve the conflict; reject per [[tmux-play-64](#tmux-play-64)] |
| explicit `--config` file or cwd project config | perform none of these safe-default or alias rewrites; retain [[tmux-play-64](#tmux-play-64)]'s alias support |
| legacy effort key | defer to [[tmux-play-86](#tmux-play-86)] for every loaded YAML source |

### tmux-play-11

When the launcher authors the default home config from the installed-runtime set, it shall select its contents through this matrix:

| Member or runtime state | Selection |
| --- | --- |
| Captain and roster | built-in `fanout` Captain plus one player per installed adapter, in canonical order `claude`, `codex`, `gemini`, `kimi`, `opencode`, limited to the first two players |
| Captain adapter and player IDs | Captain uses the first roster adapter; each player ID equals its adapter |
| pinned roles | `claude` gets `model: claude-opus-4-8` and `effort: xhigh`; `codex` gets `model: gpt-5.5` and `effort: xhigh` |
| every other adapter | omit `model` and `effort` so provider defaults apply, including Kimi's non-portable `off` / `on` vocabulary per [[tmux-play-56](#tmux-play-56)] |
| both Claude and Codex installed | roster is Claude then Codex |
| each player | include an `instruction` identifying it for the runtime-created `Cligent` |
| Captain and each player | include `permissions: { mode: 'auto' }` per [[tmux-play-52](#tmux-play-52)], selecting each adapter's native protected-auto posture under [DR-005](../decisions/005-per-adapter-permission-configuration.md): Claude still blocks high-risk actions and falls back to prompts after deny thresholds; Codex maps unset capabilities to `on-request + auto_review` with `:workspace` per [[codex-4](adapters/codex.md#codex-4)] without broadening its filesystem or network profile; OpenCode retains configured rules but may answer a surviving permission ask `once` without a human, which it labels dangerous |
| configs omitting `permissions` | impose no project-wide posture; this authored default changes only the example YAML |
| `layout` | include `window: { columns: 174, rows: 49 }` and `multiPlayerColumnWeights: [1, 1, 1]` per [[tmux-play-64](#tmux-play-64)] |
| `notifications` | include `{ player_finished: bell, turn_finished: desktop }` per [[tmux-play-76](#tmux-play-76)], leaving omitted `turn_aborted` to resolve to `off` |

### tmux-play-12

When the cwd contains a legacy `tmux-play.config.mjs`, `tmux-play.config.js`, or `tmux-play.config.json` and no cwd YAML, the launcher shall print a one-line stderr warning naming the legacy file before continuing.

### tmux-play-13

When session mode resolves `captain.from`, it shall select the module through this matrix:

| Specifier | Resolution |
| --- | --- |
| local path | anchor it at the originating config file's directory |
| package specifier | pass it unchanged to Node's module resolver |

### Captain Extension Contract

### tmux-play-14

When session mode loads a Captain module, the module shall expose this contract:

| Surface | Shape |
| --- | --- |
| default export | factory `(options: unknown) => Captain \| Promise<Captain>` |
| required Captain method | `handleBossTurn(turn, context): Promise<void>` |
| optional lifecycle methods | `init(session): Promise<void>`, `prepareDispose(): Promise<void>`, and `dispose(): Promise<void>` |

### tmux-play-15

While a tmux-play runtime is active, the runtime and Captain shall observe this ownership boundary:

| Subject | Boundary |
| --- | --- |
| runtime | owns every player and Captain `Cligent` instance |
| Captain | reaches players only through the `CaptainContext` passed to `handleBossTurn`; constructs neither adapters nor `Cligent` directly |

### tmux-play-16

When the runtime creates a `CaptainContext`, it shall expose this turn-scoped surface:

| Member | Contract |
| --- | --- |
| `readonly signal: AbortSignal` | the turn's abort signal |
| `readonly players: readonly PlayerHandle[]` | configured-player manifest |
| `callPlayer(playerId: string, prompt: string, options?: CallPlayerOptions): Promise<PlayerRunResult>` | return [[tmux-play-33](#tmux-play-33)]'s `PlayerRunResult` |
| `CallPlayerOptions.resume`, string | explicitly resume that opaque backend token instead of the player's stored automatic token |
| `CallPlayerOptions.resume`, `false` | force a fresh backend session |
| `CallPlayerOptions.resume`, omitted | preserve automatic continuity per [[tmux-play-41](#tmux-play-41)] |
| `CallPlayerOptions.settings` | optional complete per-call replacement per [[tmux-play-93](#tmux-play-93)] |
| `CallPlayerOptions` visibility boundary | expose no `visibility` member; player presentation is unchanged |
| `callCaptain(prompt: string, options?: CallCaptainOptions): Promise<CaptainRunResult>` | return [[tmux-play-33](#tmux-play-33)]'s `CaptainRunResult` |
| `CallCaptainOptions.visibility` | `'visible' \| 'hidden'`, defaulting to `'visible'`, per [[tmux-play-72](#tmux-play-72)] |
| `CallCaptainOptions.resume` | select the Captain backend session with the same string / `false` / omitted meanings |
| `CallCaptainOptions.allowedTools?: readonly string[]` | optional tool-name restriction per [[tmux-play-88](#tmux-play-88)] |
| `CallCaptainOptions.settings` | optional complete per-call replacement per [[tmux-play-93](#tmux-play-93)] |
| `setVisiblePlayers(playerIds: readonly string[]): Promise<void>` | [[tmux-play-81](#tmux-play-81)]'s turn-scoped visibility control |
| `emitReply(text: string): Promise<void>` | [[tmux-play-97](#tmux-play-97)]'s turn-scoped conversational reply, presented per [[tmux-play-92](#tmux-play-92)] |

### tmux-play-91

When a Captain invokes a turn-scoped `CaptainContext` surface from [[tmux-play-16](#tmux-play-16)], the runtime shall apply this admission matrix:

| Invocation state | Outcome |
| --- | --- |
| covered surface | `callPlayer`, `callCaptain`, `setVisiblePlayers`, and `emitReply` |
| before the runtime resumes from `handleBossTurn` | admit the call |
| continuation scheduled on the `handleBossTurn` promise that runs before the runtime regains control | admit the call; promise settlement alone is not an enforceable boundary |
| after the runtime resumes, including an admitted call's continuation or an observer handling a draining record | reject before any record or player/Captain `Cligent` run |
| during or after dispatch of `turn_finished` / `turn_aborted`, or after [[tmux-play-19](#tmux-play-19)] shutdown | reject before any record or player/Captain `Cligent` run |
| admitted call outlives `handleBossTurn` | keep the turn open through [[tmux-play-22](#tmux-play-22)]'s join and drain; retain turn abortability until the pre-terminal fence and keep session-scoped emissions on that turn ID per [[tmux-play-21](#tmux-play-21)] |

### tmux-play-17

When the runtime creates a `CaptainSession`, it shall expose this session-scoped surface:

| Member or use | Contract |
| --- | --- |
| `readonly signal: AbortSignal` | session-scoped abort signal |
| `readonly players: readonly PlayerHandle[]` | configured-player manifest |
| `emitStatus(message: string, data?: Record<string, unknown>): Promise<void>` | emit Captain status, with optional object data |
| `emitTelemetry(event: CaptainTelemetry): Promise<void>` | emit Captain telemetry whose event carries a string `topic` and an unknown `payload` |
| retained session reference | usable from `init`, during turns, and between turns |
| `setVisiblePlayers(playerIds: readonly string[]): Promise<void>` | [[tmux-play-81](#tmux-play-81)]'s visibility control for `init()` or between Boss turns |

### tmux-play-81

When a Captain calls `setVisiblePlayers(playerIds)` through [[tmux-play-16](#tmux-play-16)]'s `CaptainContext` or [[tmux-play-17](#tmux-play-17)]'s `CaptainSession`, the runtime shall apply this matrix:

| Input or call state | Outcome |
| --- | --- |
| duplicate-free non-empty subset of configured player IDs | emit exactly one [[tmux-play-82](#tmux-play-82)] `player_view_changed` carrying that order |
| empty set with empty configured roster | accept and emit the corresponding record |
| empty set with non-empty roster, duplicate, or unknown ID | reject before a record; preserve the visible set; permit the Captain to catch the rejection, otherwise follow [[tmux-play-25](#tmux-play-25)] |
| `CaptainContext` during its admitted turn scope | carry the active turn ID |
| `CaptainContext` after [[tmux-play-91](#tmux-play-91)] closes admission | reject before a record and preserve the visible set |
| `CaptainSession` while a turn is active | carry that active turn ID |
| `CaptainSession` between turns | carry `turnId: null`, including after a prior turn ended |
| every accepted call | change only main-window pane visibility; preserve the configured roster, runtime player map, per-player log streams, exposed manifests, and every player's `Cligent` continuity |

### tmux-play-92

When the tmux presenter receives a `captain_reply`, it shall render the text through [[tmux-play-50](#tmux-play-50)] as its own complete ordinary-prose block under [[tmux-play-38](#tmux-play-38)]'s `captain> ` prefix, not [[tmux-play-39](#tmux-play-39)]'s operational-line grammar.

### tmux-play-97

When a Captain invokes `CaptainContext.emitReply(text)`, the runtime shall apply this matrix:

| Call state | Outcome |
| --- | --- |
| call admitted by [[tmux-play-91](#tmux-play-91)] | emit exactly one `captain_reply` carrying `type: 'captain_reply'`, that turn's numeric ID, a timestamp, and the text on [[tmux-play-23](#tmux-play-23)]'s ordered awaited dispatch path |
| call after turn admission closes or after [[tmux-play-19](#tmux-play-19)] shutdown | reject and emit no `captain_reply`, including calls during or after terminal-record dispatch |
| reply Promise admitted while active | preserve its dispatch place before the terminal record |

### tmux-play-18

The runtime shall serialize Boss turns: at most one `handleBossTurn` invocation may be in flight per session.

### tmux-play-19

When session shutdown begins, the runtime shall perform this lifecycle:

| Stage | Outcome |
| --- | --- |
| 1 | unwind the active turn |
| 2 | call `Captain.prepareDispose()` exactly once when implemented |
| 3 | abort `CaptainSession.signal` |
| 4 | drain accepted session emissions |
| 5 | call `Captain.dispose()` exactly once |
| 6 | detach observers |
| after closure | reject `emitStatus` and `emitTelemetry` |

### tmux-play-85

When the Captain cleanup lifecycle runs, the runtime shall apply this matrix:

| State | Outcome |
| --- | --- |
| ordinary shutdown | after the active turn unwinds and before session-signal abort or emission close, invoke optional `prepareDispose()` exactly once; drain its accepted emissions in order before `dispose()`; preserve [[tmux-play-19](#tmux-play-19)]'s post-close rejection |
| `prepareDispose()` rejects | still abort the session signal, drain accepted emissions in order, invoke `dispose()` exactly once, and detach observers, then reject disposal with that failure |
| independent cleanup steps fail | preserve every failure in an `AggregateError` |
| `Captain.init()` rejects after partial initialization | run the same pre-close and post-close hooks and cleanup order before surfacing initialization failure |
| disposal repeated or concurrent | share one cleanup operation and repeat neither hook |

### Record Types and Observer Dispatch

### tmux-play-20

When the runtime emits a record, it shall select its public type and stable identity through this matrix:

| Record family | Types and identity |
| --- | --- |
| turn | `turn_started`, `turn_finished`, `turn_aborted` |
| player call | `player_prompt`, `player_event`, `player_finished`, each with the stable player ID |
| Captain call or reply | `captain_prompt`, `captain_event`, `captain_finished`, `captain_reply` |
| Captain session | `captain_status`, `captain_telemetry` |
| visibility | `player_view_changed` |
| control plane | `runtime_error` |

### tmux-play-21

When the runtime assigns a record's `turnId`, it shall apply this matrix:

| Record state | Value |
| --- | --- |
| turn-bound record | numeric active-turn ID |
| `captain_status`, `captain_telemetry`, or `player_view_changed` during a turn | numeric active-turn ID |
| one of those three session emissions outside a turn | `null` |

### tmux-play-22

While a Boss turn is open, the runtime shall enforce this record-ordering flow:

| Stage or call state | Outcome |
| --- | --- |
| turn start | `turn_started` first |
| each player call | `player_prompt` → `player_event*` → `player_finished` |
| each Captain call | `captain_prompt` → `captain_event*` → `captain_finished` |
| turn end | `turn_finished`, or `turn_aborted` on abort, last |
| admitted `callPlayer` / `callCaptain` not awaited by the Captain | join and emit its whole sequence before the terminal record on completed and failed paths |
| admitted call outlives `handleBossTurn` | keep the turn open until it settles, bounded by [[tmux-play-91](#tmux-play-91)]'s turn abortability |
| terminal dispatch | admit no turn-ID record afterward |

### tmux-play-23

When the dispatcher publishes a record requested by its caller (the source record), it shall apply this observer-delivery contract:

| Delivery property | Outcome |
| --- | --- |
| observer order | invoke in registration order |
| asynchronous observer | await its returned Promise before dispatching the record to the next observer |
| record sequencing | await the current record's observer-dispatch operation before beginning dispatch of the next record |
| record cardinality | drop and coalesce no record |
| one or more observers reject | detach each, complete the source record's delivery to every healthy later observer, and reject the originating publish with the first observer failure |
| queued or later source after a rejection | deliver it to the healthy observers that remain registered |
| fire-and-forget publish rejects | retain the first pending observer failure for the next `drain()` to surface once without gating source delivery |

### tmux-play-24

When the dispatcher publishes runtime emissions, it shall apply this matrix:

| Emission or observer state | Outcome |
| --- | --- |
| turn-bound emission | drain before `turn_finished` / `turn_aborted` |
| `turnId: null` emission | dispatch in emission order without a turn boundary |
| multiple observers registered | deliver every record to each observer |

### tmux-play-25

When a control-plane failure occurs, the runtime shall apply this matrix:

| Failure or state | Outcome |
| --- | --- |
| startup, `Captain.init`, `handleBossTurn`, or observer dispatch | emit `runtime_error` |
| active turn exists at failure | carry its numeric `turnId` |
| no active turn at failure | carry `turnId: null` |
| after error emission | abort any active turn and run [[tmux-play-19](#tmux-play-19)] shutdown |
| observer caused failure on a nonterminal source other than `runtime_error` | after source delivery completes, deliver `runtime_error` with the source's turn ID additionally to healthy observers after the first rejection in registration order, then emit `turn_aborted` when a turn is active and run shutdown |
| observer caused failure on `turn_finished` or `turn_aborted` | after that terminal reaches every healthy later observer exactly once, deliver `runtime_error` with `turnId: null` additionally to those observers; emit no later turn-ID record or second terminal |
| observer caused failure while delivering `runtime_error` | complete that diagnostic's source delivery and isolate each rejecting observer under [[tmux-play-23](#tmux-play-23)], synthesize no recursive diagnostic, and continue shutdown |
| individual player or Captain run fails | use its `player_finished` / `captain_finished` with `status: 'error'`, not `runtime_error` |

### tmux-play-77

Where session mode is running, the session shall establish and operate its notification observer through this matrix:

| Registration, record, sink, or platform | Outcome |
| --- | --- |
| observer registration | register with existing observers before caller-supplied observers |
| `player_finished` with `bell` | play one best-effort native sound regardless of result status; write no terminal BEL and launch no desktop notification |
| `turn_finished` with `desktop` | send one best-effort desktop notification after the full Boss turn |
| that row on macOS | additionally write exactly one terminal BEL to orchestrator stdout for tmux to forward |
| `player_finished` or `turn_aborted` with `desktop`, or `turn_finished` with `desktop` off macOS | write no terminal BEL or terminal-notification escape bytes |
| `turn_aborted` with `off`, or reason `ESC`, `SIGHUP`, `SIGINT`, `SIGTERM`, `EOF`, or `runtime disposed` | send no notification |
| `turn_aborted` with another reason and non-`off` sink | notify through that sink |
| sound on macOS | detached best-effort `afplay /System/Library/Sounds/Hero.aiff` |
| sound on Linux | detached best-effort freedesktop `complete` cue |
| sound on Windows | detached best-effort generic notification sound |
| sound on another platform | no operation |
| desktop on macOS | detached best-effort `osascript` notification |
| desktop on Linux | detached best-effort `notify-send` notification |
| desktop on another platform | no operation |
| every desktop notification | lowercase title `spex`, not [[tmux-play-55](#tmux-play-55)]'s status-left `Spex` |
| backend failure | swallow it without failing record dispatch, turn execution, or shutdown |
| `runtime_error` | send no notification |

### tmux-play-82

When the runtime processes a `setVisiblePlayers` result, it shall integrate `player_view_changed` through this matrix:

| Runtime state or surface | Outcome |
| --- | --- |
| record payload | `type: 'player_view_changed'`, [[tmux-play-21](#tmux-play-21)]'s numeric-or-null `turnId`, a timestamp, and ordered readonly `visiblePlayerIds` |
| accepted call per [[tmux-play-81](#tmux-play-81)] | emit exactly one record |
| rejected call | emit none |
| runtime core | validate and emit without inspecting or mutating tmux panes; leave reconciliation to [[tmux-play-83](#tmux-play-83)] |

### tmux-play-98

When a non-layout observer receives `player_view_changed`, it shall apply this matrix:

| Observer | Outcome |
| --- | --- |
| tmux presenter | write no Boss/Captain-pane content per [[tmux-play-40](#tmux-play-40)] |
| follow observer | return no pane to its live tail per [[tmux-play-69](#tmux-play-69)] |
| timing observer | alter no timer per [[tmux-play-71](#tmux-play-71)] |
| notification observer | send no notification per [[tmux-play-77](#tmux-play-77)] |

### tmux-play-83

Where session mode is running, the session shall establish and operate its layout observer through this matrix:

| State or stage | Outcome |
| --- | --- |
| registration and responsibility | register the layout observer with [[tmux-play-23](#tmux-play-23)]'s other observers, consume [[tmux-play-82](#tmux-play-82)]'s `player_view_changed` records, and own every tmux operation for visible-player reconciliation |
| tmux failure | swallow or surface as best-effort status without aborting the Boss turn |
| changed requested list | enumerate the main-window panes; kill every pane except Boss/Captain; recreate requested player panes in order using [[tmux-play-28](#tmux-play-28)]'s startup split; run each as `tail -n 200 -f <player>.log`; reapply titles, timer options, read-only input, mouse bindings, layout hooks, and Boss focus |
| tracked list initialization | use [[tmux-play-80](#tmux-play-80)]'s startup-visible set |
| complete successful reconciliation | advance the tracked list |
| incomplete best-effort reconciliation | leave the tracked list unchanged even when the handler returns |
| requested list equals tracked list | issue no tmux commands |
| empty roster and accepted empty list | leave the initially empty tracked list and sole Boss/Captain pane unchanged |
| Captain awaits visibility change then calls a newly visible player | ordered awaited dispatch completes a successful rebuild before later player records; after a failed rebuild, keep logging hidden output and permit a later visibility change to recover |
| replay count | fix it at `200` lines with no YAML or Captain-API option |

### tmux-play-84

While a configured player is hidden by [[tmux-play-80](#tmux-play-80)]'s startup set or [[tmux-play-82](#tmux-play-82)]'s later visibility, when its visibility or output changes, tmux-play shall apply this matrix:

| State or transition | Outcome |
| --- | --- |
| hidden player called | keep the runtime entity and accumulate output in its per-player log, without a live tmux pane |
| hidden player becomes visible | let [[tmux-play-83](#tmux-play-83)] create a new read-only `tail -n 200` pane while retaining the full backlog in the log file |
| hide/show cycle | preserve no pane scrollback, copy-mode state, active selection, or exact viewport |

### tmux-play-26

When SIGHUP, SIGINT, SIGTERM, or stdin EOF reaches the session, the runtime shall abort the active turn, run shutdown per [[tmux-play-19](#tmux-play-19)], kill the tmux session, and remove launcher-owned work directories.

### tmux Topology

### tmux-play-27

When the launcher arranges the main tmux window, it shall apply this topology matrix:

| Roster or pane | Placement |
| --- | --- |
| Boss/Captain | left column |
| configured player | right side in config order, read-only |
| empty roster | Boss/Captain only, occupying the full window |

### tmux-play-28

When tmux-play arranges the currently visible player set, it shall select its topology through this matrix:

| Visible state or geometry | Outcome |
| --- | --- |
| empty configured roster | no player columns; full-width Boss/Captain pane |
| one visible player | one player column |
| two or more visible players | two player columns |
| column order and population | Boss/Captain first, then player columns; first player column holds `ceil(visiblePlayerCount / 2)` players top-to-bottom |
| source of visible set | [[tmux-play-80](#tmux-play-80)]'s startup subset, defaulting to the roster, as changed by [[tmux-play-82](#tmux-play-82)] rather than fixed by roster size |
| column weights | use [[tmux-play-64](#tmux-play-64)]'s active shape: implicit `[1]` for zero players, `singlePlayerColumnWeights` for one, and `multiPlayerColumnWeights` for two or more |
| weighted width `W` | each non-rightmost column `i` gets `floor(W * w_i / sum(w))`; the rightmost gets the remainder |
| defaults | `[1, 1]` gives prior 50/50 single-player geometry; `[1, 1, 1]` gives even thirds for two or more players, with the rightmost absorbing the remainder |

### Programmatic Runtime API

### tmux-play-29

When a consumer imports `@sublang/cligent/tmux-play`, the sub-export shall expose this programmatic contract:

| Surface | Contract |
| --- | --- |
| runtime factory input | instantiated `captain`; adapter-discriminated `captainConfig` with optional `model`, `instruction`, `permissions`, and [[tmux-play-56](#tmux-play-56)] `effort`; an adapter-discriminated possibly-empty `players` array per [[tmux-play-7](#tmux-play-7)]; zero or more `observers`; optional `cwd`; optional session-scoped `signal` |
| runtime factory output | runtime that drives Boss turns without tmux |
| record exports | the public record union and constituent record types for every type named by [[tmux-play-20](#tmux-play-20)], including `captain_reply` and `player_view_changed` |
| observer export | observer-registration contract |
| complete-call-settings exports | `TuningSelection`, `AgentCallSettings`, `AgentCallSettingsError`, and `isAgentCallSettingsError()` from [[tmux-play-93](#tmux-play-93)] |
| managed-lifecycle runtime exports | `launchManagedTmuxPlay` and `runManagedTmuxPlaySession` from [[tmux-play-94](#tmux-play-94)] |
| managed-lifecycle type exports | `LaunchManagedTmuxPlayOptions`, `LaunchTmuxPlayResult`, `ManagedTmuxPlayAttachOptions`, `ManagedTmuxPlayLaunchContext`, `PreparedManagedTmuxPlayLaunch`, `ManagedTmuxPlayInitializeContext`, `ManagedTmuxPlayTurnContext`, `ManagedTmuxPlayAfterTurnContext`, `ManagedTmuxPlayTerminalRecord`, `ManagedTmuxPlayShutdownContext`, `ManagedTmuxPlayLifecycle`, `ManagedTmuxPlaySessionOptions`, and `TmuxPlayRuntimeHandle` |

### Built-in Fanout Captain

### tmux-play-30

The `@sublang/cligent/captains/fanout` Captain shall, per Boss turn, invoke `callPlayer` for every configured player concurrently, then issue a single `callCaptain` summary referencing each player's status and final text.

### tmux-play-31

When the fanout Captain presents a Boss turn, it shall select Boss-facing content through this matrix:

| Content | Outcome |
| --- | --- |
| raw player events | do not copy them into the Boss/Captain pane |
| synthesized summary | deliver the synthesized summary to the Boss through `callCaptain` |

### Public Contract Shapes

### tmux-play-32

The public Captain argument contract shall expose members through this matrix:

| Argument | Members |
| --- | --- |
| `BossTurn` | numeric turn `id`, Boss `prompt`, and `timestamp` |
| `PlayerHandle` | player `id`, `adapter`, and optional `model` |

### tmux-play-33

The public run-result contract shall expose members through this matrix:

| Result surface | Members |
| --- | --- |
| `PlayerRunResult` | required `playerId`, `turnId`, and `status`; optional `resumeToken`, `finalText`, and `error` |
| `CaptainRunResult` | required `turnId` and `status`; optional `resumeToken`, `finalText`, and `error` |
| `status` | `'ok'`, `'aborted'`, or `'error'` |
| aborted result | `finalText` and `error` may both be absent |

### tmux-play-99

When a player or Captain call settles from its terminal `done`, the programmatic runtime shall select the result's continuity member through this matrix:

| Call | Terminal `done` | Result |
| --- | --- | --- |
| player | carries `resumeToken` | expose it as `PlayerRunResult.resumeToken` |
| player | omits `resumeToken` | omit `PlayerRunResult.resumeToken`, identifying an interrupted, not-resumable call |
| Captain | carries `resumeToken` | expose it as `CaptainRunResult.resumeToken`, available for a later `CallCaptainOptions.resume` per [[tmux-play-88](#tmux-play-88)] |
| Captain | omits `resumeToken` | omit `CaptainRunResult.resumeToken` |

### tmux-play-59

Where a player or Captain call emits one or more complete `text` events after earlier captured `text` or `text_delta` content and before a terminal `done` whose `result` is absent, the programmatic runtime shall preserve each later complete message on its own line in `finalText`, inserting one newline before it only where the preceding captured content does not already end with one.

### Launcher → Session Protocol

### tmux-play-34

When the launcher prepares a session, it shall write the resolved YAML configuration to the session work directory as a JSON snapshot through this matrix:

| Input | Snapshot value |
| --- | --- |
| local `captain.from` path | absolute `file://` URL |
| package `captain.from` specifier | unchanged specifier |
| all other resolved configuration | resolved value |

### tmux-play-100

When session mode starts from a prepared work directory, it shall read the JSON snapshot rather than reload the source YAML, so YAML changes made after launch do not affect the running session.

### tmux-play-74

Before the stock or managed public session runner constructs the session, it shall isolate agent tmux access through this matrix:

| Surface or state | Outcome |
| --- | --- |
| session-mode orchestrator | run inside the Boss/Captain pane (pane 0) per [[tmux-play-27](#tmux-play-27)], initially carrying the live `TMUX` and `TMUX_PANE` handles from which player adapters would otherwise spawn agent CLIs |
| spawned player agent | inherit neither `TMUX` nor `TMUX_PANE`, and inherit a private `TMUX_TMPDIR`, so its `tmux` — including `kill-server` — resolves to an isolated server that cannot reach or terminate the run's session |
| orchestrator pane-width and pane-target queries, timer updates, and teardown | use the real tmux environment captured before the scrub and continue targeting the run's session |
| pane-width attached-state gate | consult the captured environment rather than the scrubbed `TMUX` |
| no inherited `TMUX` | perform no isolation change |
| isolation boundary | prevent an agent asked to debug tmux from taking down its own run and surfacing `[server exited]` / `tmux attach-session failed` to the Boss |

### External Dependencies

### tmux-play-51

When `tmux-play` is invoked in launcher mode per [[tmux-play-2](#tmux-play-2)], the launcher shall gate configuration loading through this dependency matrix:

| Dependency state | Outcome |
| --- | --- |
| `tmux` and the `glow` binary [[2]] are available on `PATH` | proceed to configuration loading |
| `glow` is unavailable | fail before configuration loading with an error naming `glow` and its installation page |
| both are unavailable | report `tmux` first |
| reason for the `glow` gate | prevent a session from silently losing the presenter's word-boundary wrapping, styled bodies, and fenced-code passthrough |

### tmux-play-89

When launcher mode per [[tmux-play-2](#tmux-play-2)] evaluates a loaded configuration's adapter runtimes, the launcher shall select readiness and repair output through this matrix:

| Runtime or repair state | Outcome |
| --- | --- |
| every configured runtime is installed at or above the version [[package-16](package.md#package-16)] declares supported | proceed; a version above the tested version does not block launch |
| one or more runtimes are absent or below the supported version | fail after configuration resolution but before creating a work directory, log directory, snapshot, tmux session, attachment, or model request; report every unmet adapter in one error, its roles, its repair commands, and the configuration path to edit |
| runtime is installed below the supported version | name the installed and required versions rather than report it absent |
| adapter imports an optional peer SDK | require it in the tree the running `@sublang/cligent` resolves from |
| adapter spawns an external CLI | require it globally regardless of the tree containing cligent |
| peer-SDK repair command | target that tree with `--prefix`, quote any path a shell would split, and pin install scope on the command line so running the printed command lands there |
| project peer-SDK repair | set both npm `global` and `location` to their non-global values |
| global peer-SDK repair | assert npm global mode, which wins the `global` / `location` disjunction |
| install-scope classification | derive global versus project-local from the running package's own tree and its defining manifest, never from the working directory |
| no `npm install` invocation reaches the resolved tree | print no peer-SDK install command; name the package and target tree and report that no command reaches it |
| vendor credential is absent | leave it outside this install gate to surface as the provider's run-time error |
| gate ordering | run after [[tmux-play-51](#tmux-play-51)]'s config-independent `tmux` and `glow` checks |
| bare `npm install` destination | do not infer it from the launching process, which cannot witness the paste-time shell's global prefix or nearest project; rely on command-line `--prefix` and scope settings that outrank environment and project discovery |

### Initial Window Geometry

### tmux-play-35

The tmux session's window geometry shall follow this lifecycle matrix:

| Stage or input | Outcome |
| --- | --- |
| session creation | request the resolved `layout.window.columns` and `layout.window.rows` from [[tmux-play-64](#tmux-play-64)] |
| YAML omits `layout.window` | request `174` columns by `49` rows, a cell grid sized for a 1920×1080 display at 18pt monospace (≈ 11×22 px cells) |
| client attaches with a different window size | let tmux's normal size negotiation govern the displayed layout |

### tmux-play-43

Before invoking `tmux attach-session`, the launcher shall request terminal geometry through this matrix:

| State | Outcome |
| --- | --- |
| resolved window | write `CSI 8 ; <rows> ; <columns> t` (`\x1b[8;<rows>;<columns>t`) to stdout from [[tmux-play-64](#tmux-play-64)]'s resolved `layout.window.rows` and `layout.window.columns`, matching [[tmux-play-35](#tmux-play-35)]'s `new-session -x/-y` dimensions |
| default window | write `\x1b[8;49;174t` |
| terminal honors the sequence | adjust before attachment completes |
| terminal ignores the sequence, including macOS Terminal.app by default | remain unchanged and let [[tmux-play-35](#tmux-play-35)]'s normal size negotiation govern |
| source-of-truth invariant | read both `new-session -x/-y` and CSI 8 from `layout.window`, preventing attachment negotiation from silently overriding a non-default requested geometry |

### tmux-play-44

While a tmux-play session is live, when its window width or visible-column shape is initialized or changes, the launcher shall reconcile weighted regions through this matrix:

| Surface or state | Outcome |
| --- | --- |
| trigger installation | configure session-scoped `client-resized`, `window-resized`, and `after-resize-window` hooks that re-apply widths with `resize-pane -x` |
| window width `W`, N visible columns, and current-shape weights `[w_0, ..., w_{N-1}]` from [[tmux-play-64](#tmux-play-64)] | give every non-rightmost column `i` exactly `floor(W * w_i / sum(w))` cells and the rightmost column the remainder, preserving [[tmux-play-28](#tmux-play-28)] at every size |
| background reconciliation | serialize workers per session, reject a worker from a superseded visible-column shape, and recheck negotiated width before completion so an earlier resize or shape cannot become the final writer |
| shipped one-player weights `[1, 1]` | Boss/Captain receives `floor(W / 2)` and the player receives the remainder |
| shipped multi-player weights `[1, 1, 1]` | Boss/Captain and the first player column each receive `floor(W / 3)` and the second player column receives the remainder |
| pane with a right-side border separator | content width is one less than region width |
| rightmost pane | content width equals region width |

### tmux-play-172

When ordinary launcher mode per [[tmux-play-2](#tmux-play-2)] starts, it shall reject a tmux version older than 3.3 before configuration resolution or session construction with a diagnostic naming the 3.3 minimum, because the required post-negotiation `window-resized` signal first exists in tmux 3.3 [[3]].

### tmux-play-45

After the launcher constructs the tmux session and before it attaches a client, the active pane shall be the Boss/Captain pane so startup cursor focus lands at the `boss> ` readline prompt.

### Mouse Interaction

### tmux-play-62

When the launcher creates a tmux-play session, it shall configure mouse interaction through this matrix:

| Interaction or scope | Outcome |
| --- | --- |
| session mouse input | set the session `mouse` option to `on`, letting tmux scope drag selection to a pane |
| primary-button drag release in `copy-mode` or `copy-mode-vi` | bind `MouseDragEnd1Pane` to `send-keys -X stop-selection`, leaving the selected text highlighted |
| right-button press in either copy-mode table | bind `MouseDown3Pane` to the focus-neutral `refresh-client` no-op, consuming the press so tmux delivers the release without changing focus or selection; do not use `select-pane` |
| right-button release with a selection | use one `MouseUp3Pane` `if-shell -F '#{selection_present}'` binding whose selected branch displays `Copied!` and runs `send-keys -X copy-pipe <system-clipboard-command>` |
| right-button release without a selection | run the same copy path silently and display no `Copied!` toast |
| copy and toast timing | fire on `MouseUp3Pane`, not `MouseDown3Pane`, so the release does not clear a toast painted on the press |
| selected-text copy | use `copy-pipe`, not `copy-pipe-and-cancel`: copy to the host route, clear the active selection as confirmation, and retain copy-mode and its scroll position; `q` remains the user's explicit exit |
| toast | use status-line `display-message`, inherit [[tmux-play-47](#tmux-play-47)]'s base-on-peach `message-style`, change no copy-mode state or scroll position, and auto-dismiss after `display-time` |
| system clipboard route | try `pbcopy`, Wayland `wl-copy`, X11 `xclip`, X11 `xsel`, and WSL `clip.exe`, then fall back to `tmux load-buffer -w -` for OSC 52 |
| stock primary click and wheel | let clicking select its pane and let the wheel enter or operate copy mode while clamping at the oldest history line; user `Mouse*` or `Wheel*` rebindings may alter those consequences |
| configuration boundary | do not configure `set-clipboard`, `WheelUpPane`, or `WheelDownPane`; terminal policy may still block OSC 52 |
| binding scope | accept that copy-mode bindings are server-global and outlive the session because tmux offers no session-local copy-mode table; safe future cleanup must preserve pre-existing bindings and concurrent tmux-play sessions |
| Boss/Captain scrollback top | rely on [[tmux-play-79](#tmux-play-79)] to prevent readline-redraw pollution rather than install a wheel override |

### tmux-play-66

_Superseded by [[tmux-play-67](#tmux-play-67)]._
_Status: retired and entirely non-normative. The paragraphs below record the original requirement in past tense for spec history; no clause in this item is in effect, and no `shall` text appears here. The active normative behavior for left-click on a tmux-play pane is owned by [[tmux-play-68](#tmux-play-68)]._
_Summary of supersession: cancelling copy-mode on every pane in the session before focusing the clicked pane returned each scrolled pane to its live tail, which surfaced as the user-reported "previously focused pane jumps to the last line" defect; [[tmux-play-67](#tmux-play-67)] preserved scroll by keeping stock left-click behavior, and [[tmux-play-68](#tmux-play-68)] is the current active requirement that also clears active selections._

Historical (non-normative) — what tmux-play-66 originally required:
- While a tmux-play session was running, when the Boss pressed the primary mouse button on any pane in the launched session, the session cancelled copy-mode in every pane in the session before focusing the clicked pane, so any active selection was cleared on the next click and at most one pane in the session could hold a copy-mode selection at any time.
- The deselect behavior held whether the clicked pane was currently in copy-mode or not, so a click on the pane that held the selection cleared it just as a click on a sibling pane did.
- The launcher bound `MouseDown1Pane` in the `root`, `copy-mode`, and `copy-mode-vi` key tables, because tmux dispatches a mouse event through the clicked pane's mode-specific table when the pane is in a mode (`copy-mode` / `copy-mode-vi` both ship a default `MouseDown1Pane select-pane` that would otherwise have shadowed a `root`-only binding) and through the `root` table otherwise.
- Each binding was gated on the current `#{session_name}` matching the launched session name via `if-shell -F`. The false branch reproduced tmux's stock per-table binding verbatim — `select-pane -t= ; send-keys -M` in the `root` table and `select-pane` in `copy-mode` and `copy-mode-vi` — so that in every other tmux session on the same server left-clicking retained tmux's default behavior. The `send-keys -M` forwarding in the `root` false branch was not omitted, since mouse-aware terminal applications (e.g. vim, less, htop) depend on it to receive forwarded clicks.
- The true branch cancelled copy-mode on every pane in the session that was currently in a mode and then ran the same per-table tail as the false branch (`select-pane -t= ; send-keys -M` in `root`; `select-pane -t=` in `copy-mode` / `copy-mode-vi`), so the deselect logic did not regress mouse-event forwarding or click-to-focus in the launched session either.
- The per-pane cancel was gated by `#{pane_in_mode}` so non-mode panes were not sent `-X cancel`, which would emit tmux's "no key table" error.
- Drag-select per [[tmux-play-62](#tmux-play-62)] was unaffected: `MouseDown1Pane` fired at the start of a drag and cleared any prior selection, then `MouseDrag1Pane` (tmux's stock root binding) entered `copy-mode -M` on the dragged pane and began a fresh selection.
- As with the copy-mode bindings of [[tmux-play-62](#tmux-play-62)] and the keyboard bindings of [[tmux-play-63](#tmux-play-63)] / [[tmux-play-65](#tmux-play-65)], tmux's `root`, `copy-mode`, and `copy-mode-vi` tables are server-global because tmux does not offer per-session bindings in those tables, so these entries outlived the tmux-play session; the `if-shell` guard kept each binding inert in every other session and was the launcher's narrowest available scoping mechanism.
- A future cleanup hook to reduce the binding lifetime was contemplated, with the caveat that safe cleanup would have to preserve any pre-existing user bindings and account for multiple concurrent tmux-play sessions; under [[tmux-play-67](#tmux-play-67)] this concern is moot because the launcher writes stock per-table bindings rather than session-scoped overrides.

### tmux-play-67

_Superseded by [[tmux-play-68](#tmux-play-68)]._
_Status: retired and entirely non-normative. The paragraphs below record the original requirement in past tense for spec history; no clause in this item is in effect, and no `shall` text appears here. The active normative behavior for left-click on a tmux-play pane is owned by [[tmux-play-68](#tmux-play-68)]._
_Summary of supersession: installing only tmux's stock per-table `MouseDown1Pane` bindings preserved scroll position across focus changes but reintroduced the original "left-click does not release an active copy-mode selection" defect that [[tmux-play-66](#tmux-play-66)] was written to fix. Under [[tmux-play-68](#tmux-play-68)], the launcher installs a session-scoped `MouseDown1Pane` override that runs `send-keys -X clear-selection` (not the retired `-X cancel`) per pane currently in a mode, then chains the per-table stock tail; `clear-selection` drops the selection without exiting copy-mode, so both goals hold at once — a click anywhere in the session releases any active selection while every scrolled-back pane keeps its scroll position._

Historical (non-normative) — what tmux-play-67 originally required:
- While a tmux-play session was running, when the Boss pressed the primary mouse button on any pane in the launched session, every pane in the session retained its current copy-mode state, scroll position, and any active selection; only pane focus changed.
- The launcher installed only tmux's stock per-table `MouseDown1Pane` bindings verbatim — `select-pane -t= ; send-keys -M` in the `root` table and `select-pane` in `copy-mode` and `copy-mode-vi` — explicitly written so a stale [[tmux-play-66](#tmux-play-66)] entry on a server reused across launches would be overwritten with stock semantics.
- The launcher therefore emitted no `if-shell` gate on `#{session_name}`, no `#{pane_in_mode}` clause, and no `send-keys -X cancel` as part of the left-click handler in any of the three key tables, and a server reused across launches would have any prior session-scoped chain replaced by the stock tail.
- The retired [[tmux-play-66](#tmux-play-66)] cancel-on-every-pane chain had used `send-keys -X cancel`, which exits copy-mode entirely and snaps a scrolled-back pane to its live tail; preserving scroll position across focus changes was the user-visible motivation for retiring it. tmux-play-67 chose a different tradeoff than [[tmux-play-68](#tmux-play-68)]: rather than splitting the two effects via a different `-X` primitive, it removed the override entirely and accepted that an active selection survived clicks elsewhere in the session.
- Drag-select per [[tmux-play-62](#tmux-play-62)] was unaffected: tmux's stock `MouseDrag1Pane` enters `copy-mode -M` on the dragged pane and begins a fresh selection there without touching other panes.
- The right-click copy path of [[tmux-play-62](#tmux-play-62)] was unaffected: right-clicking an active selection still ran `copy-pipe-and-cancel`, which cancels copy-mode on the clicked pane and returns it to its live tail because that is the explicit user action of copying and leaving copy-mode.
- The keyboard pane-switch bindings of [[tmux-play-63](#tmux-play-63)] only call `select-pane -L` / `select-pane -R`, which do not enter or cancel copy-mode, so they too preserved every pane's scroll position and selection.

### tmux-play-68

While a tmux-play session is running, its pane selection, copy-mode, scroll, and focus state shall respond to pointer and navigation input through this matrix:

| Input and prior state | Outcome |
| --- | --- |
| primary-button press on any launched-session pane while any pane holds an active selection | clear every active selection with a scroll-preserving primitive, retain each pane's copy-mode state and scroll position, and focus the click target |
| pane in copy-mode without an active selection | remain in copy-mode at the same scroll position |
| pane in copy-mode with an active selection | remain in copy-mode at the same scroll position with the selection cleared |
| pane not in a mode | remain outside every mode |
| selection sits on the clicked pane or a sibling | apply the same clearing outcome, so no stopped selection survives the next primary-button press in the session |
| selection clearing implementation | do not exit copy-mode, whose live-tail snap would lose scroll position |
| primary-button press in another tmux session | retain stock primary-click behavior |
| new primary-button drag | clear any prior selection before the dragged pane begins its fresh selection per [[tmux-play-62](#tmux-play-62)] |
| right-click copy | clear the copied selection while preserving copy-mode and scroll through [[tmux-play-62](#tmux-play-62)]'s `copy-pipe` path |
| keyboard pane switch | preserve every pane's scroll position and selection per [[tmux-play-63](#tmux-play-63)] |

### tmux-play-69

While a tmux-play session is running, when record processing may write pane content, the live-follow observer shall select its outcome through this matrix:

| Destination and rendered output | Outcome |
| --- | --- |
| visible bytes written to a destination pane currently in copy-mode | resolve the pane that [[tmux-play-40](#tmux-play-40)] routes the write to and exit copy-mode with `send-keys -X cancel`, returning that pane to its live tail with the new content visible |
| live-tail transition | exit copy-mode rather than kill the pane or its feeding process, preserving the player `tail -f` of [[tmux-play-27](#tmux-play-27)] and the Boss/Captain process; clearing an active selection is an accepted side effect |
| destination pane not in a mode | leave it untouched and issue no copy-mode exit |
| no bytes written, including idle time, a no-output control record, or content that [[tmux-play-50](#tmux-play-50)] renders entirely blank | retain copy-mode and scroll position |
| hidden Captain call | retain Boss/Captain-pane copy-mode and scroll because [[tmux-play-40](#tmux-play-40)] produces no visible bytes |
| write reaches one pane | leave every sibling pane that receives no concurrent write in its prior copy-mode state and scroll position |
| pane in another tmux session | leave it unaffected |
| interaction precedence | override [[tmux-play-62](#tmux-play-62)] and [[tmux-play-68](#tmux-play-68)] scroll preservation only for the pane receiving visible output |
| retired `tmux-play-78` wheel clamp | install no replacement: stock tmux clamps at the oldest history line, and [[tmux-play-79](#tmux-play-79)] fixes the actual readline-scrollback cause |

### tmux-play-63

When the launcher creates a tmux-play session, it shall configure direct pane navigation and its advertised surface through this matrix:

| Surface or scope | Outcome |
| --- | --- |
| launched session, `C-Left` or `S-Left` in `root` | run `select-pane -L` |
| launched session, `C-Right` or `S-Right` in `root` | run `select-pane -R` |
| any of those keys in another session on the same server | gate on `#{session_name}` with `if-shell -F` and forward the original key through the false branch |
| `status-left` hints | render `switch pane: ctrl+←/→ or shift+←/→ \| stop: esc \| exit: ctrl+c \| drag=select \| right-click=copy`, binding stop to [[tmux-play-57](#tmux-play-57)] and exit to [[tmux-play-26](#tmux-play-26)] |
| retired hint text | omit `Ctrl+b, then: d=detach \| o=switch pane \| [=scroll (q exits)` and the title-case `Switch pane: Ctrl+←/→ or Shift+←/→`, `Stop: ESC`, and `Exit: Ctrl+C` forms |
| binding lifetime | accept that the server-global root-table entries outlive the session while their session-name guards keep them inert elsewhere; safe future cleanup must preserve pre-existing bindings and concurrent tmux-play sessions |

### tmux-play-70

When the launcher creates a tmux-play session, it shall configure single-press `Escape` forwarding through this matrix:

| Key table and scope | Outcome |
| --- | --- |
| `root`, `copy-mode`, or `copy-mode-vi` in the launched session | gate on `#{session_name}`, exit pane 0's copy-mode when active, then forward one bare `Escape` to the Boss/Captain pane so [[tmux-play-57](#tmux-play-57)] handles it |
| `root` in another session | reproduce stock behavior with `send-keys Escape` |
| `copy-mode` in another session | reproduce stock behavior with `send-keys -X cancel` |
| `copy-mode-vi` in another session | reproduce stock behavior with `send-keys -X clear-selection`, preserving vi-mode scroll rather than collapsing it to `cancel` |
| arrow-key sequence or pasted ESC bytes | leave interpretation to [[tmux-play-57](#tmux-play-57)] and [[tmux-play-58](#tmux-play-58)]; do not broaden the bare-ESC meaning |
| binding lifetime | accept that the server-global entries outlive the session while their session-name guards keep them inert elsewhere; safe future cleanup must preserve pre-existing bindings and concurrent tmux-play sessions |

### tmux-play-65

When the launcher creates a tmux-play session, it shall configure single-press `C-c` forwarding through this matrix:

| Key table and scope | Outcome |
| --- | --- |
| `root`, `copy-mode`, or `copy-mode-vi` in the launched session | gate on `#{session_name}`, exit pane 0's copy-mode when active, then forward one `C-c` to the Boss/Captain pane so [[tmux-play-26](#tmux-play-26)] runs the exit lifecycle, including [[tmux-play-19](#tmux-play-19)] shutdown, tmux-session termination, and launcher-owned work-directory cleanup |
| `root` in another session | reproduce stock behavior with `send-keys C-c` |
| `copy-mode` or `copy-mode-vi` in another session | reproduce stock behavior with `send-keys -X cancel` |
| player pane or any pane in copy-mode | intercept before read-only pane input or the mode table can swallow the first press, honoring [[tmux-play-63](#tmux-play-63)]'s `exit: ctrl+c` hint from every pane |
| binding lifetime | accept that the server-global entries outlive the session while their session-name guards keep them inert elsewhere; safe future cleanup must preserve pre-existing bindings and concurrent tmux-play sessions |

### tmux-play-36

The launcher shall select each pane's display-name stem through this matrix, with [[tmux-play-48](#tmux-play-48)] composing the stem with its adapter into the full tmux title:

| Pane | Display-name stem |
| --- | --- |
| Boss/Captain | `Captain` |
| player | player `id` with its first character upper-cased and all remaining characters preserved, such as `coder` → `Coder` and `reviewer` → `Reviewer` |
| every pane | omit the literal `Player:` prefix |

### tmux-play-37

While session mode presents Boss input, the readline and presenter shall select the prompt source and rendering through this matrix:

| State or source | Outcome |
| --- | --- |
| ready, between-turn readline | echo the Boss input as typed with the visible prompt `boss> ` |
| Mocha snapshot flavor | render that readline prompt as `\x1b[1;38;2;137;180;250mboss> \x1b[0m` |
| Latte snapshot flavor | render that readline prompt as `\x1b[1;38;2;30;102;245mboss> \x1b[0m` |
| readline cursor measurement | treat the ANSI-colored prompt as six visible cells |
| `turn_started` presenter record | write no duplicate Boss prompt, leaving the submitted input exactly once in the Boss/Captain pane |
| active Boss turn | let [[tmux-play-75](#tmux-play-75)] suspend the live prompt, so type-ahead produces no `boss> ` line until prompt restoration |

### tmux-play-57

Where session mode is running, when it interprets a potential Boss ESC input, it shall select the outcome through this matrix:

| Input and state | Outcome |
| --- | --- |
| TTY stdin, active Boss turn, bare ESC | abort the active turn without shutting down, preserve the readline edit buffer, render [[tmux-play-40](#tmux-play-40)]'s `[turn aborted] ESC` line, and expose the preserved buffer when [[tmux-play-75](#tmux-play-75)] restores a ready `boss> ` prompt |
| TTY stdin, no active Boss turn, bare ESC | produce no observable effect |
| terminal escape sequence other than bare ESC, including an arrow-key sequence | do not abort the turn |
| non-TTY stdin | install no ESC keybinding and leave the [[tmux-play-26](#tmux-play-26)] SIGINT, SIGTERM, and EOF lifecycle unchanged |
| ESC originates in a player pane or any pane in copy-mode | use [[tmux-play-70](#tmux-play-70)] to forward it to pane 0, where this one readline handler applies the same interpretation |

### tmux-play-58

When session mode handles bracketed paste, it shall select input and terminal-mode behavior through this matrix:

| Terminal state or paste stage | Outcome |
| --- | --- |
| TTY stdin and TTY stdout, multiline paste followed by Enter | submit exactly one Boss turn whose `BossTurn.prompt` preserves embedded newlines as `\n` characters |
| bytes typed after paste end and before that Enter | include them in the same submission |
| stdin or stdout is not a TTY | omit tmux-play's multiline-paste handling and leave embedded newline behavior to the underlying readline |
| start with TTY stdin and stdout | enable bracketed-paste mode for this session's duration |
| every shutdown path after enabling | emit the bracketed-paste-disable sequence so tmux-play does not leave the terminal mode enabled |
| non-TTY output | emit neither bracketed-paste control sequence |

### tmux-play-75

While session mode presents Boss input, the session shall select live `boss> ` prompt behavior through this matrix:

| Input and turn state | Outcome |
| --- | --- |
| `turn_started` | suspend or clear the live readline prompt before the turn's first presenter output reaches the pane |
| active turn, from `turn_started` through the matching `turn_finished` or `turn_aborted` | paint no fresh `boss> ` line beyond the submitted-input line already echoed per [[tmux-play-37](#tmux-play-37)], so streaming output carries no implicit turn-over prompt |
| normal completion, [[tmux-play-57](#tmux-play-57)] ESC abort, or runtime error, with no submitted Boss line queued | restore exactly one ready prompt |
| one or more submitted Boss lines queued | keep the prompt suspended between [[tmux-play-18](#tmux-play-18)]'s consecutive turns and restore it exactly once after the final queued turn |
| empty or whitespace-only submission while no turn is active or queued | paint one fresh ready prompt |
| empty or whitespace-only submission while a turn is active or queued | paint no prompt amid streaming output |
| bytes typed or [[tmux-play-58](#tmux-play-58)] pasted during an active turn | preserve the edit buffer per [[tmux-play-57](#tmux-play-57)], expose it when the prompt is restored, and render no `boss> `-prefixed line before restoration |
| non-TTY stdin | install no keypress handling, perform no active-turn prompt suspension, and leave any static between-turn readline `boss> ` output unchanged |

### tmux-play-79

While session mode presents Boss input, the session shall preserve pane history through this readline-output matrix:

| Output state | Scrollback outcome |
| --- | --- |
| TTY stdout, live prompt redraw after any edit | add no prompt row, including when the prompt sits at the top of a mostly empty pane; later scrollback exposes none of the intermediate `boss> abc`, `boss> ab`, or `boss> a` rows |
| presenter turn output | continue adding legitimate content to Boss/Captain-pane scrollback |
| non-TTY stdout | perform no in-place-refresh intervention |
| wheel-up at the oldest history line | rely on stock tmux clamping and install no `WheelUpPane` override beyond [[tmux-play-62](#tmux-play-62)] |

### tmux-play-38

When the presenter emits a pane output block, it shall apply this speaker-prefix grammar:

| Line, speaker, or output kind | Rendering |
| --- | --- |
| first nonblank Captain reply in the Boss/Captain pane, or Captain prompt in a player pane | bold 24-bit `mauve` `captain> ` prefix: `#cba6f7` under Mocha or `#8839ef` under Latte |
| first nonblank player reply with a presenter adapter mapping | bold 24-bit `<playerId>> ` prefix using [[tmux-play-195](#tmux-play-195)]'s flavor-aware adapter accent |
| first nonblank player reply without a presenter adapter mapping | uncolored `<playerId>> ` prefix |
| every prefix | wrap the bytes through the trailing space as `\x1b[1;38;2;<r>;<g>;<b>m<who>> \x1b[0m` |
| body after a prefix | leave it unstyled by the presenter |
| nonblank continuation | use an uncolored two-space hanging indent and do not repeat the speaker prefix |
| blank line, including before the first nonblank line | keep it blank and do not consume the first-line prefix |
| legacy `[from captain]` or `[captain llm prompt]` framing | do not emit it |
| text body | pass it through [[tmux-play-50](#tmux-play-50)] and budget the visible prefix width so first and continuation lines fit the pane |
| [[tmux-play-39](#tmux-play-39)] status or [[tmux-play-49](#tmux-play-49)] tool lifecycle | bypass `glow` and apply this speaker prefix plus the operational tag directly; never restore the retired `tool>` / `tool<` replacement |

### tmux-play-39

When the presenter emits an operational record or event, it shall render one `<who>> [<tag> <optional glyph>] <optional body>` line through this matrix, using [[tmux-play-38](#tmux-play-38)]'s speaker prefix, a separate bold 24-bit span for each colored tag, an unstyled body outside the brackets, no placeholder for an absent source field, and no glyph on a single-state kind:

| Tag | Glyph slot | Body | Tag color | Source record / event |
| --- | --- | --- | --- | --- |
| `[status]` | — | message + optional structured-data tail | uncolored | `captain_status` |
| `[error]` | — | result `error` field | resolved `red`: Mocha `#f38ba8`, Latte `#d20f39` | `player_finished` / `captain_finished` with `status: 'error'` |
| `[aborted]` | — | — | resolved `yellow`: Mocha `#f9e2af`, Latte `#df8e1d` | `player_finished` / `captain_finished` with `status: 'aborted'` |
| `[turn aborted]` | — | turn-abort reason when present | resolved `yellow`: Mocha `#f9e2af`, Latte `#df8e1d` | `turn_aborted` |
| `[runtime error]` | — | runtime-error message | resolved `red`: Mocha `#f38ba8`, Latte `#d20f39` | `runtime_error` |
| `[tool ↪]` | `↪` (call) | tool name + input summary | uncolored | `tool_use` |
| `[tool ✓]` | `✓` (ok) | tool name + duration | resolved `green`: Mocha `#a6e3a1`, Latte `#40a02b` | `tool_result` `status: 'success'` |
| `[tool ✗]` | `✗` (err) | tool name + duration | resolved `red`: Mocha `#f38ba8`, Latte `#d20f39` | `tool_result` `status: 'error'` |
| `[tool ·]` | `·` (denied) | tool name + duration | resolved `yellow`: Mocha `#f9e2af`, Latte `#df8e1d` | `tool_result` `status: 'denied'` |
| no tag | — | emit no trailing line | — | `player_finished` / `captain_finished` with `status: 'ok'` |

An absent body yields only `<who>> [tag]`, including `[aborted]` per [[tmux-play-33](#tmux-play-33)] and a reason-less `[turn aborted]`; a non-empty body yields `<who>> [tag] <body>`, for example `<captain-mauve>captain> </reset><red>[runtime error]</reset> boom`.

### tmux-play-40

When the presenter routes a record or event, it shall select pane output through this matrix:

| Source or visibility | Output |
| --- | --- |
| Boss input | Boss/Captain pane |
| Captain synthesized reply or terminal failure | Boss/Captain pane through [[tmux-play-39](#tmux-play-39)] |
| `captain_reply` | Boss/Captain pane as [[tmux-play-92](#tmux-play-92)] Captain prose |
| `captain_status`, `runtime_error`, or `turn_aborted` | Boss/Captain pane through [[tmux-play-39](#tmux-play-39)], including `captain> [turn aborted] ESC` for [[tmux-play-57](#tmux-play-57)] |
| Captain-emitted `tool_use` / `tool_result` | Boss/Captain pane through [[tmux-play-49](#tmux-play-49)] |
| per-player output or Captain prompt body containing player results | no Boss/Captain-pane output |
| player-emitted tool event | that player's pane only |
| any record from [[tmux-play-72](#tmux-play-72)] `visibility: 'hidden'` call | no Boss/Captain-pane bytes, including no buffered text, terminal reply, status, error, or tool line |
| `visibility: 'visible'` or omitted | byte-for-byte ordinary presentation |

### tmux-play-49

When the presenter handles a `tool_use` or `tool_result`, it shall render the event in [[tmux-play-40](#tmux-play-40)]'s calling-entity pane through this pipeline, using [[tmux-play-38](#tmux-play-38)]'s speaker prefix and [[tmux-play-39](#tmux-play-39)]'s bracketed-tag grammar rather than the retired `tool>` / `tool<` replacement:

| Event or value | Selection |
| --- | --- |
| `tool_use` | one uncolored-tag line `<who>> [tool ↪] <toolName>[ <inputSummary>]` with an unstyled body |
| input summary | first non-empty string at `command`, `file_path`, `path`, `pattern`, `query`, `prompt`, or `description`, then compact `JSON.stringify(input)`; collapse whitespace, truncate after 60 display cells with `…`, and omit the segment and its leading space when unusable |
| `tool_result` | header `<who>> [tool <symbol>] <toolName>[ <duration>]` plus any continuation body; keep the body unstyled |
| result `success` / `error` / `denied` | respectively select [[tmux-play-39](#tmux-play-39)]'s green `✓`, red `✗`, or yellow `·` tag |
| `durationMs < 1000` / `>= 1000` / absent | respectively render `<n>ms`, `<n.n>s`, or no duration segment |
| output extraction | use a string directly, then `output.stdout` when present, then pretty-printed JSON; an empty or absent extraction leaves the header alone |

For a non-empty extracted output, the pipeline performs these ordered transformations:

1. Remove exactly the one trailing `\n` that terminates the last payload line while preserving every further trailing blank row.
2. Wrap the payload in a backtick fence one longer than its longest embedded backtick run, with a minimum of three.
3. Render through [[tmux-play-50](#tmux-play-50)] at `max(1, paneWidth - 2)`; this fenced continuation budget deliberately permits `glow`'s unwrapped or overflowing long code lines.
4. On success, remove `glow`'s trailing horizontal padding, preserve leading whitespace, trim at most one outer leading and trailing blank margin, retain all further structural and payload blanks, prefix every nonblank body line with two spaces, and leave blank lines unindented.
5. Let `glow` own body styling and do not restore the retired `overlay0` `#6c7086` wrapper.
6. If `renderMarkdown` fails despite [[tmux-play-51](#tmux-play-51)]'s gate, emit the raw body with the same two-space nonblank-line indent, without successful-render padding removal or outer-margin trimming, so payload edge blanks survive.

### tmux-play-50

While session mode processes pane records and events, the presenter shall maintain and flush each `(writer, block)` Markdown buffer through this pipeline:

| Input or state | Buffer action |
| --- | --- |
| `text_delta` | append and wait for a boundary; token-by-token rendering is excluded because open Markdown fences, tables, and lists are not streamable |
| `text` | append it as a complete block and flush |
| same-writer `player_finished`, `captain_finished`, [[tmux-play-92](#tmux-play-92)] `captain_reply`, `tool_use`, `tool_result`, `player_prompt`, `captain_status`, `runtime_error`, or `turn_aborted` | flush the preceding block before handling the boundary |
| [[tmux-play-39](#tmux-play-39)] status or [[tmux-play-49](#tmux-play-49)] tool line | bypass the Markdown buffer and write the operational line directly |
| writer pane width available / unavailable | render at `max(1, paneWidth)` / `80` using the launcher-resolved Mocha `dark` or Latte `light` built-in `glow` style |

Each flushed block follows these ordered transformations:

1. Let `glow` own word-boundary wrapping, fences, tables, inline styles, and inherent overflow for unbreakable or preformatted shapes; do not reflow its output except for the first-row prefix fit below.
2. Preserve `glow`'s leading two-cell document margin, remove all trailing horizontal padding even before SGR resets, trim at most one outer leading and trailing blank margin, and preserve every further structural blank without right padding.
3. Apply [[tmux-play-38](#tmux-play-38)] so the first nonblank row gets the speaker prefix, leading blanks pass unchanged, and every later nonblank row gets the presenter's uncolored two-space indent in addition to `glow`'s retained margin.
4. If the first visible row plus its speaker prefix exceeds the pane width, split only that row at a cell-aware word boundary, treating ANSI as zero width, keep the first segment after the colored prefix, and place the remainder after an uncolored two-space continuation indent.
5. Keep breakable prose within the pane without terminal rewrap; emit no bytes for an all-blank post-trim block.
6. If `renderMarkdown` fails despite [[tmux-play-51](#tmux-play-51)]'s gate, emit the buffered raw text through the same prefix grammar without the successful-render padding strip.

### tmux-play-46

_Superseded for text-body wrapping by [[tmux-play-50](#tmux-play-50)]: `glow` owns word-boundary wrapping inside rendered blocks. The cell-measurement rules below remain authoritative for tool-input truncation per [[tmux-play-49](#tmux-play-49)]. The character-level soft-wrap algorithm, the escape-parser carry, and the SGR close/reopen invariant described in the remainder of this item no longer apply to text bodies and are not implemented by the presenter; they are retained here for spec history and to keep the cell-measurement table addressable from one item._

The two-space hanging indent required by [[tmux-play-38](#tmux-play-38)] shall apply to every visible continuation line in a pane, whether the line break is an explicit `\n` in the source text or a soft wrap inserted by the presenter when content would otherwise exceed the pane's current display width.
The presenter shall soft-wrap each prefixed block at the per-pane display width by emitting `\n` followed by the two-space indent in place of the character that would have overflowed, so terminal-level rewrap is unnecessary and every wrapped row visibly carries the indent.

Display width shall be measured in terminal cells, not code points.
The following codepoints shall count as 2 cells:

- Codepoints in the curated subset of East Asian Wide and Fullwidth blocks that the implementation tracks: Hangul Jamo and Hangul Jamo Extended-A and Hangul Syllables; CJK Radicals / Kangxi / Ideographic Description Characters and CJK Symbols and Punctuation; Hiragana, Katakana, Bopomofo, CJK Strokes, Enclosed CJK Letters and Months, and CJK Compatibility blocks through U+33FF; CJK Unified Ideographs and CJK Compatibility Ideographs and CJK Unified Ideographs Extensions A–G+; Yi Syllables and Radicals; Yijing Hexagram Symbols; Vertical Forms and CJK Compatibility Forms and Small Form Variants; Fullwidth ASCII (U+FF00–U+FF60) and Fullwidth signs (U+FFE0–U+FFE6); Ideographic Symbols and Punctuation (U+16FE0–U+16FE4) and Ideographic vertical forms (U+16FF0–U+16FF1); Tangut Ideographs and Tangut Components and Khitan Small Script and Tangut Supplement; Kana Extended-B and Kana Supplement and Kana Extended-A and Small Kana Extension; Nüshu; Tai Xuan Jing Symbols and Counting Rod Numerals.
- Codepoints at `cp >= 0x2300` whose Unicode `Emoji_Presentation` property is `Yes`, including BMP emoji such as U+231A ⌚ and U+2615 ☕ and every supplementary emoji block — including blocks added in future Unicode releases — so this rule does not need a source update when Unicode adds new emoji.

The list above is a curated subset of Unicode East Asian Width = Wide/Fullwidth, not the full set.
JavaScript regex does not expose the `East_Asian_Width` property, so any codepoint that is EAW=W or =F per Unicode but is neither in the enumerated blocks nor `Emoji_Presentation` — for example, archaic scripts or rare symbol blocks not yet enumerated here — shall be measured as 1 cell.
Soft-wrap based on this measurement may therefore over-fill the pane for such codepoints; this is the documented limitation of the implementation's table.

Unicode combining marks (`\p{M}`) and zero-width formatting codepoints (ZWSP, ZWNJ, ZWJ, Word Joiner, BOM) count as 0 cells, and C0/C1 control bytes other than `\n` count as 0 cells.
ANSI escape sequences (CSI `ESC [` … final byte `0x40`–`0x7E`; OSC `ESC ]` … terminated by BEL or ST; and the simple `ESC` + next-byte form) shall pass through with 0 cells and shall never be split across a soft-wrap boundary.
The presenter shall keep its escape-parser state per writer across streaming writes (e.g., per `text_delta` event), so a CSI/OSC/`ESC` sequence whose bytes arrive in two or more chunks is reassembled into a single zero-width escape token before any subsequent visible byte is placed.
At every block boundary on a writer — including the start of any non-streaming prefixed block, the start of a status line, and the close of a run regardless of `status` — the presenter shall drain its pending escape parser state, emitting any still-unterminated escape bytes verbatim to that block's writer before writing the boundary newline, so the next block parses from a clean state and cannot have its leading byte consumed as the missing terminator of an earlier escape.

The presenter shall track the last body-emitted SGR opener (a CSI sequence ending in `m` that is not a reset) per writer.
At every continuation boundary — soft-wrap, explicit newline, or any path that emits a continuation indent — the presenter shall close that SGR (emit `\x1b[0m`) before the `\n`, emit the uncolored continuation indent, and re-emit the same opener after the indent so the body's color resumes on the new row.
This historically held the [[tmux-play-38](#tmux-play-38)] "continuation indents shall stay uncolored" invariant for status bodies that opened an SGR span and crossed a line break — the rule was motivated by the retired `[error: msg]` / `[runtime error: msg]` / `[turn aborted: reason]` shape in which the entire bracketed body, including the wrapping message, sat inside one SGR span.
Under the current [[tmux-play-39](#tmux-play-39)], status bodies sit outside the brackets and are unstyled by the presenter, so the bracketed tag's SGR span closes inside the line and no presenter-opened body SGR survives across a wrap; the rule has no live caller and is retained only as spec history alongside the rest of this item, expressly so the retired inside-brackets coloring model is not reintroduced.
Non-SGR CSI sequences (cursor movement, erase, etc., terminated by bytes other than `m`) do not change color/style and are not subject to this close/reopen rule.

Width sources: the Boss/Captain pane width shall track the captain's stdout `columns` property, which Node refreshes via SIGWINCH on terminal resize.
Each player pane width shall be queried from tmux at session start; the session shall refresh player widths when its stdout emits `'resize'` (the in-pane SIGWINCH that follows the tmux resize hooks set per [[tmux-play-44](#tmux-play-44)]) and again before each Boss turn as a safety net.
When a width source is unavailable or the value would not leave room for the two-space indent, the writer shall fall back to no soft wrap.

### Theme

### tmux-play-194

When the launcher resolves a Catppuccin flavor, it shall select and persist it through this matrix:

| Input or probe state | Outcome |
| --- | --- |
| concrete `themeFlavor` programmatic option | select that `'mocha'` or `'latte'` value |
| no concrete programmatic option and concrete YAML `theme` per [[tmux-play-6](#tmux-play-6)] | select that value |
| no concrete override, auto detection active, and a launch will attach — including a [[tmux-play-94](#tmux-play-94)] managed launch prepared for later native attachment — or [[tmux-play-61](#tmux-play-61)] diagnostics requested | write `OSC 11 ; ? BEL` (`\x1b]11;?\x07`) to the controlling terminal and read for a bounded short timeout |
| OSC 11 response | accept BEL or ST termination and `rgb:RR/GG/BB` or `rgb:RRRR/GGGG/BBBB`; normalize channels, compute `0.2126 * R + 0.7152 * G + 0.0722 * B`, and select Latte at luminance `>= 0.5` or Mocha below it, with reason `osc11` |
| controlling terminal unavailable, response absent or unparseable, timeout, non-TTY stdin/stdout, or public `attach: false` launch | select Mocha with reason `fallback` |
| resolved concrete flavor | write it into [[tmux-play-34](#tmux-play-34)]'s work-directory snapshot so session mode uses the same flavor for [[tmux-play-38](#tmux-play-38)] pane content without probing again |

### tmux-play-47

After [[tmux-play-194](#tmux-play-194)] resolves a flavor, the launcher shall apply [[1]] Catppuccin appearance before the content-bearing options of [[tmux-play-36](#tmux-play-36)], [[tmux-play-38](#tmux-play-38)]–[[tmux-play-40](#tmux-play-40)], [[tmux-play-44](#tmux-play-44)], [[tmux-play-55](#tmux-play-55)], and [[tmux-play-199](#tmux-play-199)] through exactly this option matrix:

| Option | Value | Note |
| --- | --- | --- |
| `default-terminal` | `tmux-256color` | Truecolor enablement so the hex values below render rather than quantizing to the nearest 256-color index. Set on the session. |
| `terminal-overrides` | append `,*:RGB` | Server option; the leading-comma list-separator idiom prepends `*:RGB` without clobbering existing entries. tmux normalizes the stored value, so `show-options -gv terminal-overrides` reports the entry as `*:RGB`. |
| `status-style` | `fg=<text>,bg=<mantle>` | Catppuccin text on the mantle band. Mocha: `fg=#cdd6f4,bg=#181825`. Latte: `fg=#4c4f69,bg=#e6e9ef`. |
| `pane-border-style` | `fg=<overlay0>` | Inactive border; dimmer than the active border for at-a-glance contrast per [[tmux-play-199](#tmux-play-199)]. Mocha: `fg=#6c7086`. Latte: `fg=#9ca0b0`. |
| `pane-active-border-style` | `fg=<blue>` | Mocha: `fg=#89b4fa`. Latte: `fg=#1e66f5`. |
| `message-style` | `fg=<base>,bg=<peach>` | Mocha: `fg=#1e1e2e,bg=#fab387`. Latte: `fg=#eff1f5,bg=#fe640b`. |
| `message-command-style` | `fg=<base>,bg=<green>` | Mocha: `fg=#1e1e2e,bg=#a6e3a1`. Latte: `fg=#eff1f5,bg=#40a02b`. |
| `display-panes-colour` | `<overlay0>` | |
| `display-panes-active-colour` | `<mauve>` | Mocha: `#cba6f7`. Latte: `#8839ef`. |
| `clock-mode-colour` | `<mauve>` | |

The matrix claims no `window-style` or `window-active-style`, leaving pane content on the terminal-native canvas; no `window-status-style` or `window-status-current-style`, because [[tmux-play-55](#tmux-play-55)] empties the window formats; and none of `pane-border-format`, `pane-border-status`, `status-left`, their lengths, `status-right`, or the three window-format options, which their cited owners set afterward so a future theme swap remains local.

### tmux-play-48

When the launcher names a pane, it shall set the tmux title to `<Display> · <adapter>`, using [[tmux-play-36](#tmux-play-36)]'s `Captain` or title-cased player display stem, the role's configured adapter, and the exact separator space + U+00B7 middle dot + space.

### tmux-play-195

When tmux-play selects an adapter or Captain timer accent, it shall use one stable lookup keyed by adapter name and [[tmux-play-194](#tmux-play-194)]'s resolved flavor through this matrix:

| Adapter | Role | Mocha hex | Latte hex |
| --- | --- | --- | --- |
| `claude` | `green` | `#a6e3a1` | `#40a02b` |
| `codex` | `teal` | `#94e2d5` | `#179299` |
| `gemini` | `lavender` | `#b4befe` | `#7287fd` |
| `kimi` | `sapphire` | `#74c7ec` | `#209fb5` |
| `opencode` | `pink` | `#f5c2e7` | `#ea76cb` |
| other adapter | deterministic stable fallback | `sky #89dceb`, `rosewater #f5e0dc`, `maroon #eba0ac`, or `flamingo #f2cdcd` | same roles at `#04a5e5`, `#dc8a78`, `#e64553`, or `#dd7878` |
| fallback-pool boundary | exclude known-adapter accents and the reserved `blue`, `mauve`, `peach`, `red`, `yellow`, and `green` speaker / tool / status roles | same exclusion | same exclusion |
| Boss/Captain timer | `mauve` | `#cba6f7` | `#8839ef` |

The presenter consumes the adapter rows through [[tmux-play-38](#tmux-play-38)], and player timers consume them through [[tmux-play-54](#tmux-play-54)].

### tmux-play-199

When the launcher configures a pane border, it shall render the title-and-timer band through this matrix:

| Pane or surface | Outcome |
| --- | --- |
| active Boss/Captain pane at index 0 | bold title block with resolved `base` foreground on `blue` background: Mocha `fg=#1e1e2e,bg=#89b4fa`; Latte `fg=#eff1f5,bg=#1e66f5` |
| inactive Boss/Captain pane or any player pane, including an active player | no highlight; render the title on the resolved `fg=text,bg=mantle` surface — Mocha `fg=#cdd6f4,bg=#181825`; Latte `fg=#4c4f69,bg=#e6e9ef` — consistent with read-only players per [[tmux-play-27](#tmux-play-27)] |
| row after the title | retain the mantle background through separator, timer glyph, and duration, standing out tonally from the terminal-native pane canvas that [[tmux-play-47](#tmux-play-47)] leaves unclaimed |
| vertical placement | set `pane-border-status` to `top`; use the mantle status bar below the terminal-native content as the lower boundary without a second border row |
| whitespace | put exactly one space before `#{pane_title}` and one after the timer text before `#[default]` |

### Run-Time Timers

### tmux-play-53

While a tmux-play session is running, its timing observer shall derive cumulative active time from record timestamps through this matrix:

| Timer | Closed interval added | Open value | Excluded time |
| --- | --- | --- | --- |
| player | `player_finished.timestamp - player_prompt.timestamp` for each run of that player | accumulated closed duration plus `now - player_prompt.timestamp` | gaps between that player's runs |
| Boss/Captain pane | `captain_finished.timestamp - captain_prompt.timestamp` for each Captain run | accumulated closed duration plus `now - captain_prompt.timestamp` | gaps between Captain runs |
| session total | `(turn_finished.timestamp \| turn_aborted.timestamp) - turn_started.timestamp` for each Boss turn | accumulated closed duration plus `now - turn_started.timestamp` | gaps between Boss turns |

### tmux-play-54

When the launcher renders a pane-border timer, it shall select its value and appearance through this matrix without replacing [[tmux-play-48](#tmux-play-48)]'s title and adapter:

| Pane and run state | Timer rendering |
| --- | --- |
| Boss/Captain pane | [[tmux-play-53](#tmux-play-53)] Captain timer |
| player pane | that player's [[tmux-play-53](#tmux-play-53)] timer |
| current run open | refresh roughly once per second; show `⏳` and [[tmux-play-195](#tmux-play-195)]'s bright Captain or player accent |
| no current run | freeze at the accumulated value; show `⌛` with resolved text-level `subtext1` (Mocha `#bac2de`, Latte `#5c5f77`), not the less-legible `overlay1` (Mocha `#7f849c`, Latte `#8c8fa1`) against [[tmux-play-199](#tmux-play-199)]'s mantle band |
| either glyph | budget two display cells, leave glyph color to the terminal emoji font, and put the running/frozen color cue on the duration text |

### tmux-play-55

When the launcher constructs the status bar, it shall configure its segments through this matrix:

| Segment or state | Rendering |
| --- | --- |
| `status-left` | bold `Spex` — never `spex`, `Cligent`, or `tmux-play` — in [[tmux-play-194](#tmux-play-194)]'s resolved flavor's `blue` (Mocha `#89b4fa`, Latte `#1e66f5`), one space, then [[tmux-play-63](#tmux-play-63)]'s navigation hints |
| tmux window list | set `window-status-format`, `window-status-current-format`, and `window-status-separator` to empty strings so no `0:node*` text appears |
| `status-right`, Boss turn open | [[tmux-play-53](#tmux-play-53)] session-total timer, refreshed roughly once per second, with [[tmux-play-54](#tmux-play-54)]'s `⏳` and resolved `mauve` duration text (Mocha `#cba6f7`, Latte `#8839ef`) |
| `status-right`, between Boss turns | frozen session-total timer with `⌛` and resolved `overlay1` duration text (Mocha `#7f849c`, Latte `#8c8fa1`) |
| segment lengths | preserve both hints and timer under [[tmux-play-35](#tmux-play-35)]'s 174-column initial window |

### tmux-play-71

When tmux-play formats [[tmux-play-53](#tmux-play-53)] elapsed milliseconds for a [[tmux-play-54](#tmux-play-54)] pane timer or [[tmux-play-55](#tmux-play-55)] status timer, it shall emit `<HH>:<MM>:<SS>` by clamping negative input to zero, setting `s = floor(elapsedMs / 1000)`, `h = floor(s / 3600)`, `m = floor(s / 60) mod 60`, and `n = s mod 60`, zero-padding minutes and seconds to exactly two digits and hours to at least two digits, retaining all three components and expanding hours beyond two digits so `00:00:00`, `01:00:00`, `99:59:59`, and `100:00:00` remain stable and monotonic.

### Player Session Continuity

### tmux-play-41

Within one tmux-play session, the runtime shall preserve each player's single persistent `Cligent` and select continuity through this matrix:

| Call or terminal state | Outcome |
| --- | --- |
| later call with `resume: <string>` | pass that explicit token to `Cligent.run()`, overriding the stored automatic token |
| later call with `resume: false` | pass `false` and force a fresh backend session despite any stored token |
| later call with `resume` omitted | let [[engine-33](engine.md#engine-33)] inject the stored token emitted by the adapter |
| accepted [[tmux-play-93](#tmux-play-93)] complete settings | apply them without changing the selected session token |
| settings rejected before provider work | preserve the stored token for a later call |
| ESC-aborted call whose interrupted `done` carries a token through [[engine-35](engine.md#engine-35)] | expose it through [[tmux-play-99](#tmux-play-99)] and let the next call auto-resume through [[engine-33](engine.md#engine-33)] |
| interrupted `done` without a token | expose [[tmux-play-33](#tmux-play-33)]'s aborted shape and [[tmux-play-99](#tmux-play-99)]'s not-resumable omission, keep the player callable, and perform no runtime- or engine-layer prompt rewrite |

### tmux-play-42

When the built-in fanout Captain constructs a player prompt, it shall select identity and recovery content through this matrix:

| Player state | Prompt or retained state |
| --- | --- |
| ordinary call | pass the Boss prompt verbatim; add no `The Boss asked:` label, `You are the "<player>" player` identity preamble, or inter-player instruction such as `Respond independently` / `Do not wait for other players` |
| player identity | convey it once through the runtime-held `instruction` composed at [[tmux-play-93](#tmux-play-93)]'s `Cligent.run()` boundary |
| Captain summarization prompt | permit static framing and inter-player context because it guides the synthesizer rather than a player |
| player returns `aborted` without `resumeToken` | retain that call's base Boss prompt as unresolved recovery context |
| next call with retained context | send every retained base Boss prompt plus the latest Boss prompt |
| consecutive no-token aborts | append only base Boss prompts, never a composed recovery prompt, preventing nesting or ballooning |
| non-aborted result or aborted result carrying `resumeToken` | clear retained recovery because the path is complete or backend-resumable |

### Captain Call Visibility

### tmux-play-72

When `callCaptain` admits its optional `CallCaptainOptions`, the runtime shall select visibility, result, and trace through this matrix:

| Input or surface | Outcome |
| --- | --- |
| `visibility: 'visible'` | resolve `'visible'` |
| `visibility: 'hidden'` | resolve `'hidden'` |
| options or `visibility` omitted | default to `'visible'` |
| hidden or visible execution | run the Captain identically and return the same [[tmux-play-33](#tmux-play-33)] `CaptainRunResult` shape and values, including `status`, `turnId`, optional `resumeToken`, optional `finalText`, and optional `error` |
| emitted trace | emit `captain_prompt`, zero or more `captain_event` records, and `captain_finished` in [[tmux-play-22](#tmux-play-22)] order, each carrying the resolved visibility, so every non-presenter observer receives the full trace |

### tmux-play-88

When `callCaptain` resolves session and tool controls, tmux-play shall map them to the Captain `Cligent.run()` call through this matrix without changing [[tmux-play-72](#tmux-play-72)]'s record visibility and result semantics or [[tmux-play-40](#tmux-play-40)] and [[tmux-play-69](#tmux-play-69)] presentation semantics:

| Option | Input | `Cligent.run()` value |
| --- | --- | --- |
| `resume` | string | that string, overriding the stored automatic token |
| `resume` | `false` | `false`, starting a fresh backend session |
| `resume` | omitted | preserve automatic Captain continuity per [[engine-33](engine.md#engine-33)] |
| `allowedTools` | non-empty readonly list | an equal mutable copy |
| `allowedTools` | empty readonly list | an explicit empty copy retaining [[engine-17](engine.md#engine-17)]'s no-tools meaning |
| `allowedTools` | omitted | no per-call override, preserving the configured or adapter-native tool surface |

### tmux-play-93

When tmux-play admits a player or Captain call, it shall resolve complete call settings through this matrix before emitting `player_prompt` or `captain_prompt` and before invoking the adapter:

| Input or state | Admission outcome |
| --- | --- |
| `settings` omitted | use the configured model, effort, instruction, and permissions as complete runtime-held defaults; map each supplied policy through [[engine-52](engine.md#engine-52)], omit every unconfigured field so the provider default remains in control, and leave generic `Cligent` merging outside this runtime unchanged per [[engine-3](engine.md#engine-3)] |
| `settings` supplied | require one closed `AgentCallSettings` object whose `model` and `effort` are `{ kind: 'value', value: <nonempty string> }` or `{ kind: 'provider-default' }`, and whose optional `instruction` and [[engine-21](engine.md#engine-21)] `permissions` are the complete effective values; omission means none and no member merges with configured defaults |
| supplied settings admitted | capture the object, selections, and permission data as a detached frozen snapshot before asynchronous work |
| accessor, unknown field, incomplete selection, invalid effort vocabulary, or unenforceable setting | reject before the prompt record and provider run |
| session selection | resolve the explicit token, forced-fresh selection, or stored automatic token exactly once at admission per [[tmux-play-41](#tmux-play-41)] and [[tmux-play-88](#tmux-play-88)], then give the same detached selection to reset preflight and `Cligent.run()` |
| runtime-owned `Cligent` | carry none of the configured model, effort, instruction, or permissions defaults |
| provider-default selector | omit that option from `Cligent.run()`, allowing Codex and Gemini defaults on fresh or resumed calls and Claude and OpenCode defaults on fresh calls |
| concrete Gemini effort without a [[gemini-11](adapters/gemini.md#gemini-11)] model alias, or concrete OpenCode effort without an [[opencode-12](adapters/opencode.md#opencode-12)] variant | reject instead of silently ignoring the effort |
| resumed Claude, provider-default model | reject because [[claude-code-6](adapters/claude-code.md#claude-code-6)] omission restores the transcript model |
| resumed Claude, concrete model and provider-default effort | omit effort per [[claude-code-8](adapters/claude-code.md#claude-code-8)] so Claude uses that model's default |
| resumed OpenCode, provider-default model | reject because its session persists model and variant and [[opencode-12](adapters/opencode.md#opencode-12)] exposes no model reset |
| resumed OpenCode, concrete model and provider-default effort | omit the variant per [[opencode-14](adapters/opencode.md#opencode-14)] so OpenCode resets that model to its default effort |
| resumed OpenCode, complete settings omit permissions | clear the prior Cligent-owned session ruleset through [[opencode-32](adapters/opencode.md#opencode-32)] before prompting |
| fresh Kimi, provider-default model or effort or no permissions | admit |
| resumed Kimi, provider-default model or effort or omitted permissions | reject because [[kimi-4](adapters/kimi.md#kimi-4)], [[kimi-23](adapters/kimi.md#kimi-23)], [[kimi-7](adapters/kimi.md#kimi-7)], and [[kimi-9](adapters/kimi.md#kimi-9)] expose no corresponding reset; require concrete model and effort plus an enforceable complete policy |
| any preflight rejection | emit no call record, perform no provider run, and preserve the stored resume token |
| supplied-settings rejection | expose an `AgentCallSettingsError` whose `message` preserves the prior diagnostic, whose `cause` preserves the original rejection, and which `isAgentCallSettingsError()` recognizes across package copies |
| turn or session scope rejection, unknown-player rejection, provider execution failure, or observer dispatch failure | do not classify it as `AgentCallSettingsError` |

### tmux-play-94

Where an embedding front end owns an interactive process lifecycle, `launchManagedTmuxPlay` and `runManagedTmuxPlaySession` shall apply this managed state machine while leaving `launchTmuxPlay`, `runTmuxPlaySession`, direct `createTmuxPlayRuntime`, and generic `Cligent` behavior unchanged outside the boundary:

| State or transition | Required outcome |
| --- | --- |
| public launch admission | require `sessionId` to match `^[A-Za-z0-9][A-Za-z0-9_-]*$` before work-directory or tmux mutation; derive exactly `tmux-play-<sessionId>` |
| accepted launch context | pass the public id, derived tmux name, work directory, `workDirOwnedByLauncher`, config snapshot, readiness, input-gate, input-active, shutdown-request, shutdown-complete, and working-directory paths to the session-command factory; run its command in the Boss/Captain pane |
| direct child-runner admission | independently enforce the same public-id grammar before isolation, presentation, lifecycle, or work-state mutation |
| initialized child | return a prepared launch only after successful readiness; keep Boss input gated so the caller can report the public id first |
| `attach()` | open the gate, await input-active, apply the resolved outer-terminal layout, and attach unless disabled |
| `cancel()` | do not activate input; request graceful child shutdown, await post-cleanup shutdown-complete and pane exit, and force-terminate only when graceful shutdown is unavailable or exceeds its bound |
| attachment signal already aborted or aborting before native handoff | preserve its exact reason as primary; await bounded failure-complete child shutdown, pane exit, owned-work cleanup, and coordination cleanup; aggregate secondary failures afterward; invoke neither `beforeNativeAttach` nor the native client |
| enabled attachment reaches native handoff | synchronously stop managed abort handling, invoke `beforeNativeAttach` at most once as the final operation before the native client, and then leave signals to the embedding and client |
| `attach: false` | never invoke `beforeNativeAttach`; retain managed abort ownership through coordination cleanup, activate input, close the launcher boundary, return without an outer client, and leave the child owning cleanup through SIGHUP, another session signal, or EOF |
| launcher monitoring | capture the original Boss pane's stable id, not a positional index; bound readiness and activation by `readinessTimeoutMs`, graceful shutdown plus pane exit independently by `shutdownTimeoutMs`, and clean coordination only after activation or shutdown acknowledgement |
| initialization or attachment failure after pane creation | request and await graceful child shutdown |
| forced teardown | verify pane disappearance for a fixed 500 ms; if still visible, retain child-owned work and coordination state and report the retirement defect after any initiating failure |
| launcher-created work directory | create a launcher-ownership marker whose complete contents equal the public id; remove the directory when no child can own cleanup |
| child cleanup of launcher-created work | accept the factory-forwarded `workDirOwnedByLauncher` unchanged and remove the directory only when it is `true` and the marker matches the child's session id; marker presence alone establishes no ownership |
| caller-supplied work directory | create no launcher marker, never recursively remove it, and preserve it plus unrelated entries on every path |
| teardown target | target only the session identity captured at creation; reject an existing derived name without terminating it |
| ownership before mutation | acquire the session name before truncating, overwriting, or creating shared per-player logs, the snapshot, or ownership marker, so collision rejection preserves existing bytes |
| input-gate or shutdown-request publication | use atomic, create-once markers so the child observes absent or complete valid content, never a partial write |
| child initialization | apply [[tmux-play-74](#tmux-play-74)] isolation before presentation or `initializeRuntime({ sessionId, config, observers, cwd })`; let the initialized-or-restored runtime own the gated observers and publish readiness only after runtime initialization and input handlers exist |
| input before activation | queue the semantic prompt without runtime work, preserving one bracketed multiline paste as one newline-bearing prompt; after gate open, publish input-active before dispatching queued prompts |
| shutdown begun | publish neither readiness nor activation and admit no queued input |
| empty or whitespace-only Boss input | invoke neither managed lifecycle hooks nor runtime |
| non-empty Boss input | await `beforeNonEmptyTurn`, invoke `runBossTurn`, buffer every `captain_reply` away from all presentation observers, await the complete turn fence, then call `afterTurn` with detached replies and the exact `turn_finished` or `turn_aborted` terminal |
| successful `afterTurn` for a finished turn | release buffered replies to presentation observers in original order, including while shutdown awaits the transaction |
| aborted turn or initialization, before-hook, runtime-turn, or after-hook failure | release no buffered reply and reject only after managed shutdown |
| `runBossTurn` rejects after a fenced terminal | still call `afterTurn` with that terminal and buffered replies, release none, then propagate through ordered shutdown |
| EOF, SIGHUP, SIGINT, SIGTERM, embedding request, or failure shutdown | stop input, request active-turn abort, await the complete hook/runtime/settlement transaction, dispose the runtime, await lifecycle `shutdown`, clean presentation and launcher-owned work, publish shutdown-complete, and settle one shared promise so release never overlaps write-ahead, settlement, disposal, or acknowledgement |
| embedding shutdown marker / SIGHUP | use exact reason `embedding shutdown request` / exact reason `SIGHUP` for active-turn abort and lifecycle shutdown |
| multiple shutdown failures | preserve the initiating failure first and aggregate every distinct later disposal, lifecycle, presentation, work-state, acknowledgement, or pane-cleanup defect; preserve a lone failure's identity |

### Pane Identity

### tmux-play-96

When launcher or layout code creates a Boss/Captain or player pane, it shall maintain pane identity through this matrix:

| Pane or operation | Identity behavior |
| --- | --- |
| Boss/Captain pane | store logical key `captain` in pane-scoped tmux state |
| player pane | store its player `id` as the logical key |
| player-area rebuild per [[tmux-play-83](#tmux-play-83)] | restore the same keys on recreated panes for the session's whole life |
| pane-width lookup, [[tmux-play-54](#tmux-play-54)] border timer, or [[tmux-play-69](#tmux-play-69)] live-follow | resolve the logical key to tmux's stable pane id instead of parsing [[tmux-play-48](#tmux-play-48)]'s displayed title |
| machine-readable pane query | separate fields with a character no logical key can contain |
| server normalizes non-ASCII display text | leave every pane-addressed operation unchanged |

### tmux-play-189

When the launcher verifies a composed pane title against the tmux server, it shall select diagnostics through this matrix:

| Server-observed result | Outcome |
| --- | --- |
| read-back differs from the title set, including normalization of ` · ` under a non-UTF-8 server locale | print one line naming the display limitation and continue launching |
| read-back round-trips exactly | print no warning |
| launcher process locale differs from server behavior | decide from the server read-back, not the launcher's locale variables |

## Verification

### tmux-play-73

Where scripted adapters emit a complete `text` message after captured `text` or `text_delta` content and before a terminal `done` with no `result`, when the programmatic runtime executes player and Captain calls across both preceding-content endings, the verification shall assert this `finalText` matrix [[tmux-play-59](#tmux-play-59)]:

| Call | First event | First content | Second `text` content | Exact `finalText` | Lines beginning `Commit: ` |
| --- | --- | --- | --- | --- | --- |
| player | `text` | `Reworked the small packages.` | `Commit: abc123` | `Reworked the small packages.\nCommit: abc123` | one |
| player | `text` | `Reworked the small packages.\n` | `Commit: abc123` | `Reworked the small packages.\nCommit: abc123` | one |
| Captain | `text` | `Reworked the small packages.` | `Commit: abc123` | `Reworked the small packages.\nCommit: abc123` | one |
| Captain | `text` | `Reworked the small packages.\n` | `Commit: abc123` | `Reworked the small packages.\nCommit: abc123` | one |
| player | `text_delta` | `Reworked the small packages.` | `Commit: abc123` | `Reworked the small packages.\nCommit: abc123` | one |
| player | `text_delta` | `Reworked the small packages.\n` | `Commit: abc123` | `Reworked the small packages.\nCommit: abc123` | one |
| Captain | `text_delta` | `Reworked the small packages.` | `Commit: abc123` | `Reworked the small packages.\nCommit: abc123` | one |
| Captain | `text_delta` | `Reworked the small packages.\n` | `Commit: abc123` | `Reworked the small packages.\nCommit: abc123` | one |

### tmux-play-101

Where the home and cwd are empty and the `claude` and `codex` adapter runtimes are installed, when `tmux-play` launches without `--config`, the check shall assert this first-run flow:

| Observation | Assertion |
| --- | --- |
| created home YAML | built-in `fanout` Captain; `claude` and `codex` players with identity instructions; Captain and `claude` use `model: claude-opus-4-8`, `effort: xhigh`; `codex` uses `model: gpt-5.5`, `effort: xhigh`; every role has `permissions: { mode: 'auto' }` [[tmux-play-11](#tmux-play-11)] |
| authored layout and notifications | `layout.window: { columns: 174, rows: 49 }`, `layout.multiPlayerColumnWeights: [1, 1, 1]`, no authored `columnWeights`, and `notifications: { player_finished: bell, turn_finished: desktop }` [[tmux-play-11](#tmux-play-11)], [[tmux-play-76](#tmux-play-76)] |
| stdout | one line naming the created path and the installed adapters used for the roster [[tmux-play-10](#tmux-play-10)] |
| second invocation | the freshly created home YAML remains byte-for-byte unchanged [[tmux-play-90](#tmux-play-90)] |

### tmux-play-102

Given a `tmux-play.config.yaml` in cwd and a different YAML at the home location, when launching, the check shall assert this discovery flow:

| Surface | Assertion |
| --- | --- |
| selected config | load the cwd YAML [[tmux-play-9](#tmux-play-9)] |
| home YAML | leave its bytes unchanged [[tmux-play-9](#tmux-play-9)] |

### tmux-play-103

When resolving the home configuration location, the check shall assert this environment matrix:

| `XDG_CONFIG_HOME` | Expected location |
| --- | --- |
| non-empty path | `${XDG_CONFIG_HOME}/tmux-play/config.yaml` [[tmux-play-9](#tmux-play-9)] |
| empty or unset | `~/.config/tmux-play/config.yaml` [[tmux-play-9](#tmux-play-9)] |

### tmux-play-104

Given a `tmux-play.config.{mjs,js,json}` in cwd and no cwd YAML, when launching, a one-line stderr warning shall name the legacy file before normal execution proceeds [[tmux-play-12](#tmux-play-12)].

### tmux-play-105

When loading candidate YAML configurations, the check shall assert this validation matrix:

| Input | Assertion |
| --- | --- |
| malformed YAML or unknown field | rejection naming the offending file or config path [[tmux-play-8](#tmux-play-8)] |
| unknown Captain adapter | rejection naming the offending file or `captain.adapter` path [[tmux-play-6](#tmux-play-6)] |
| unknown player adapter | rejection naming the offending file or player-adapter path [[tmux-play-7](#tmux-play-7)] |
| invalid, duplicate, or reserved `captain` player ID | rejection naming the offending file or player-ID path [[tmux-play-7](#tmux-play-7)] |
| missing or non-array `players` | rejection naming the offending file or `players` path [[tmux-play-5](#tmux-play-5)] |
| empty `players` array | acceptance [[tmux-play-5](#tmux-play-5)] |

### tmux-play-106

Given a cwd config whose `captain.from` selects either supported specifier kind, when session mode imports the Captain, the check shall assert this resolution matrix:

| Specifier | Assertion |
| --- | --- |
| relative local path | resolve from the original config file's directory [[tmux-play-13](#tmux-play-13)] |
| package specifier | pass it unchanged to Node's resolver [[tmux-play-13](#tmux-play-13)] |

### tmux-play-107

Given a Captain that calls one player and then `callCaptain`, when handling one Boss turn, the check shall assert this causal record flow:

| Surface | Assertion |
| --- | --- |
| record order | `turn_started`, `player_prompt`, `player_event`*, `player_finished`, `captain_prompt`, `captain_event`*, `captain_finished`, `turn_finished` [[tmux-play-22](#tmux-play-22)] |
| correlation | every record carries the same numeric `turnId` [[tmux-play-21](#tmux-play-21)] |

### tmux-play-108

Given two registered observers, when a record is emitted, both shall receive the record in registration order before the dispatcher releases the next record [[tmux-play-23](#tmux-play-23)], [[tmux-play-24](#tmux-play-24)].

### tmux-play-109

When a Captain emits `emitStatus` from `init`, the resulting `captain_status` record shall arrive at every observer with `turnId: null` before any `turn_started` [[tmux-play-17](#tmux-play-17)], [[tmux-play-21](#tmux-play-21)], [[tmux-play-24](#tmux-play-24)].

### tmux-play-110

When runtime or session cancellation occurs, the check shall assert this shutdown matrix:

| Trigger | Assertion |
| --- | --- |
| active-turn abort signal | emit `turn_aborted`, not `turn_finished`, after every previously enqueued turn-bound emission drains [[tmux-play-22](#tmux-play-22)], [[tmux-play-24](#tmux-play-24)] |
| session SIGHUP, SIGINT, SIGTERM, or stdin EOF | abort active work and complete the shutdown lifecycle [[tmux-play-26](#tmux-play-26)] |

### tmux-play-111

When a registered observer rejects while receiving a runtime source record, the integration check shall assert this failure flow:

| Source or surface | Assertion |
| --- | --- |
| every source | healthy later observers receive it once before any diagnostic; the rejecting observer receives no later source; queued and future sources continue to the survivors; the originating awaited publish rejects, and `drain()` surfaces a fire-and-forget failure once [[tmux-play-23](#tmux-play-23)], [[tmux-play-24](#tmux-play-24)] |
| nonterminal turn source | healthy later observers receive the source, its same-turn `runtime_error`, and then `turn_aborted`; the active turn aborts, cleanup completes, and the runtime call rejects [[tmux-play-25](#tmux-play-25)] |
| `turn_finished` or `turn_aborted` source | healthy later observers receive the terminal once, followed by one `runtime_error` with `turnId: null`, and receive no later turn-ID record or second terminal [[tmux-play-22](#tmux-play-22)], [[tmux-play-25](#tmux-play-25)] |
| `runtime_error` source | healthy later observers receive it once, no recursive diagnostic follows, the rejecting observer receives no later source, the active turn ends with `turn_aborted`, and the runtime call rejects [[tmux-play-23](#tmux-play-23)], [[tmux-play-25](#tmux-play-25)] |

### tmux-play-112

On session shutdown, the check shall assert this lifecycle flow:

| Stage | Assertion |
| --- | --- |
| active turn and accepted emissions | unwind the turn and drain accepted session emissions before disposal [[tmux-play-19](#tmux-play-19)] |
| disposal | invoke `Captain.dispose()` exactly once [[tmux-play-19](#tmux-play-19)] |
| after shutdown | reject `emitStatus` and `emitTelemetry` [[tmux-play-19](#tmux-play-19)] |

### tmux-play-113

Given the built bin on PATH (or invoked directly with execute permission), when launched on a POSIX runner with `--help` alone or combined with recognized mode flags, `tmux-play` shall exit 0 and print a usage banner before mode validation or work [[tmux-play-1](#tmux-play-1)], [[tmux-play-204](#tmux-play-204)].

### tmux-play-114

When the launcher constructs or resizes the main tmux window, the check shall assert this topology matrix:

| Configuration or transition | Assertion |
| --- | --- |
| N configured players; `layout.initialVisible` omitted | Boss/Captain on the left and N player panes on the right in config order; with N ≥ 2 the first player column holds `ceil(N / 2)` players top-to-bottom [[tmux-play-27](#tmux-play-27)], [[tmux-play-28](#tmux-play-28)], [[tmux-play-80](#tmux-play-80)] |
| N = 0 construction | exactly one full-width Boss/Captain pane; no split or player log-tail process [[tmux-play-27](#tmux-play-27)] |
| N = 0 title and timer | exact Captain title from [[tmux-play-36](#tmux-play-36)] and [[tmux-play-48](#tmux-play-48)]; initialized frozen-zero Captain timer from [[tmux-play-53](#tmux-play-53)], [[tmux-play-54](#tmux-play-54)], and [[tmux-play-195](#tmux-play-195)] |
| N = 0 input setup | session mouse enabled and every pointer, navigation, `C-c`, and ESC binding installed without a missing-player target [[tmux-play-62](#tmux-play-62)], [[tmux-play-63](#tmux-play-63)], [[tmux-play-65](#tmux-play-65)], [[tmux-play-68](#tmux-play-68)], [[tmux-play-70](#tmux-play-70)] |
| N = 0 resize setup | install every resize hook without a missing-player target [[tmux-play-44](#tmux-play-44)] |
| N = 0; real window resized under [[tmux-play-130](#tmux-play-130)]'s real-tmux acceptance harness | sole pane remains full-width [[tmux-play-44](#tmux-play-44)] |
| `layout.singlePlayerColumnWeights` and its `layout.columnWeights` alias omitted; N = 1 | visible columns use `[1, 1]`, one half each [[tmux-play-64](#tmux-play-64)], [[tmux-play-44](#tmux-play-44)] |
| `layout.multiPlayerColumnWeights` and its `layout.columnWeights` alias omitted; N ≥ 2 | visible columns use `[1, 1, 1]`, one third each with the rightmost absorbing the remainder [[tmux-play-64](#tmux-play-64)], [[tmux-play-44](#tmux-play-44)] |
| explicit `layout.columnWeights` | resolved regions follow that ratio at the resolved `layout.window.columns` [[tmux-play-28](#tmux-play-28)], [[tmux-play-44](#tmux-play-44)] |

Visible-subset startup topology remains covered by [[tmux-play-182](#tmux-play-182)].

### tmux-play-115

Given a snapshot file in the work directory, when session mode handles Boss input, the check shall assert this prepared-session flow:

| Stage | Assertion |
| --- | --- |
| configuration source | read the snapshot rather than source YAML [[tmux-play-100](#tmux-play-100)] |
| Captain setup | import `captain.from` exactly once while instantiating the Captain [[tmux-play-3](#tmux-play-3)], resolving its `file://` URL or package specifier through [[tmux-play-13](#tmux-play-13)] |
| Boss input | route each turn through the runtime [[tmux-play-107](#tmux-play-107)], [[tmux-play-3](#tmux-play-3)] |

### tmux-play-116

Given the built-in fanout Captain and all five supported adapters as players, when the composite acceptance probe runs, the check shall assert this flow and harness matrix:

| Case or surface | Assertion |
| --- | --- |
| successful Boss turn requiring a sentinel | every `player_finished` has `status: 'ok'` and the sentinel in `finalText`; one `captain_prompt` contains one delimited section per player naming status and including final text plus the sentinel; `captain_finished` has `status: 'ok'` and the sentinel in `finalText` [[tmux-play-30](#tmux-play-30)] |
| successful record stream | neither `runtime_error` nor `turn_aborted` appears [[tmux-play-30](#tmux-play-30)] |
| Kimi environment | use the acceptance suite's one temporary Kimi-home clone without mutating its source; resolve the CLI from `PATH` or the source home's managed `bin` directory |
| shared Kimi credential present but spent | self-skip with a precise reason even under `CI`, no runner configuration being able to supply a fresh token |
| explicit upstream overload, rate limit, or service unavailability | retry the complete fresh probe only for those failures, at most twice; every other failure and the third consecutive named transient is fatal |
| required player or Captain dependency absent | self-skip locally and hard-fail under `CI` |

### tmux-play-117

Given the fanout Captain handling a Boss turn, the check shall assert this roster matrix:

| Configured players | Assertion |
| --- | --- |
| N > 0 | emit all N `player_prompt` records before any `player_finished`, and emit `captain_prompt` only after every `player_finished` [[tmux-play-30](#tmux-play-30)] |
| N = 0 | make no player call and exactly one Captain call [[tmux-play-30](#tmux-play-30)] |

### tmux-play-118

When `Captain.init(session)` rejects before any turn starts, the check shall assert this failure flow:

| Surface | Assertion |
| --- | --- |
| observers | every registered observer receives `runtime_error` with `turnId: null` [[tmux-play-25](#tmux-play-25)] |
| turn records | no `turn_started` is delivered [[tmux-play-25](#tmux-play-25)] |
| lifecycle | shutdown completes [[tmux-play-25](#tmux-play-25)] |

### tmux-play-119

When `handleBossTurn` rejects mid-turn, the check shall assert this failure flow:

| Stage | Assertion |
| --- | --- |
| error | emit `runtime_error` carrying the active `turnId` [[tmux-play-25](#tmux-play-25)] |
| terminal | emit `turn_aborted` after the error [[tmux-play-25](#tmux-play-25)] |
| lifecycle | complete shutdown [[tmux-play-25](#tmux-play-25)] |

### tmux-play-120

Given local and package Captain configurations, when the launcher prepares and session mode consumes a snapshot, the check shall assert this snapshot matrix:

| Case | Assertion |
| --- | --- |
| relative local `captain.from` | work-directory JSON snapshot contains an absolute `file://` URL [[tmux-play-34](#tmux-play-34)] |
| package `captain.from` | work-directory JSON snapshot preserves the specifier verbatim [[tmux-play-34](#tmux-play-34)] |
| source YAML mutated after launch | running session remains governed by the prepared snapshot [[tmux-play-100](#tmux-play-100)] |

### tmux-play-121

When the launcher creates a tmux session, the check shall assert this window matrix:

| YAML `layout.window` | `new-session` assertion |
| --- | --- |
| omitted | request `-x 174 -y 49`, the shipped 1920×1080-at-18pt grid [[tmux-play-35](#tmux-play-35)], [[tmux-play-64](#tmux-play-64)] |
| explicit `{ columns: 200, rows: 50 }` | request `-x 200 -y 50` and do not request the 174×49 default [[tmux-play-35](#tmux-play-35)], [[tmux-play-64](#tmux-play-64)] |

### tmux-play-122

Given two or more players, omitted `layout.multiPlayerColumnWeights` and its `layout.columnWeights` alias, omitted `layout.initialVisible` so all configured players are visible per [[tmux-play-80](#tmux-play-80)], and a 174-column grid, when the launcher constructs the session, the check shall assert this region matrix:

| Region | Assertion |
| --- | --- |
| Boss/Captain | 58 columns [[tmux-play-28](#tmux-play-28)], [[tmux-play-64](#tmux-play-64)] |
| first player column | 58 columns [[tmux-play-28](#tmux-play-28)], [[tmux-play-64](#tmux-play-64)] |
| second player column | 58 columns within tmux nearest-cell rounding [[tmux-play-28](#tmux-play-28)], [[tmux-play-64](#tmux-play-64)] |

### tmux-play-123

Given player IDs `coder` and `reviewer`, when the launcher sets pane titles, the check shall assert this title matrix:

| Pane | Assertion |
| --- | --- |
| Boss/Captain | display name `Captain` inside [[tmux-play-48](#tmux-play-48)]'s full title [[tmux-play-36](#tmux-play-36)] |
| player `coder` | display name `Coder` inside the full title [[tmux-play-48](#tmux-play-48)], [[tmux-play-36](#tmux-play-36)] |
| player `reviewer` | display name `Reviewer` inside the full title [[tmux-play-48](#tmux-play-48)], [[tmux-play-36](#tmux-play-36)] |
| every pane | no title contains `Player:` [[tmux-play-36](#tmux-play-36)] |

### tmux-play-124

Given session mode is running, when the user enters a Boss prompt, the captured Boss/Captain pane content shall contain the prompt text exactly once [[tmux-play-37](#tmux-play-37)].

### tmux-play-125

Given session mode handles a Boss turn, the check shall assert this presenter flow:

| Surface | Assertion |
| --- | --- |
| Boss input | Boss/Captain pane contains a line beginning `boss> ` [[tmux-play-37](#tmux-play-37)] |
| Captain reply | Boss/Captain pane contains a nonblank line beginning `captain> ` [[tmux-play-38](#tmux-play-38)] |
| Captain prompt | player pane contains a nonblank line beginning `captain> ` [[tmux-play-38](#tmux-play-38)] |
| player reply | player pane contains a nonblank line beginning `<playerId>> ` [[tmux-play-38](#tmux-play-38)] |
| nonblank continuation | two-space hanging indent and no repeated speaker prefix [[tmux-play-38](#tmux-play-38)] |
| leading blank line | remains blank and does not consume the first speaker prefix [[tmux-play-38](#tmux-play-38)] |
| legacy framing | neither `[from captain]` nor `[captain llm prompt]` appears in any pane [[tmux-play-38](#tmux-play-38)] |

### tmux-play-126

When terminal and control records reach the presenter, the check shall assert this operational-line matrix:

| Input | Assertion |
| --- | --- |
| player or Captain `status: 'ok'` | no `[player <id> ok]` or `[captain ok]` line [[tmux-play-39](#tmux-play-39)] |
| player `status: 'error'` | one `<playerId>> [error] <message>` line whose body equals `result.error` and sits outside the brackets [[tmux-play-39](#tmux-play-39)] |
| Captain `status: 'error'` | one `captain> [error] <message>` line whose body equals `result.error` and sits outside the brackets [[tmux-play-39](#tmux-play-39)] |
| player `status: 'aborted'` | one `<playerId>> [aborted]` line [[tmux-play-39](#tmux-play-39)] |
| Captain `status: 'aborted'` | one `captain> [aborted]` line [[tmux-play-39](#tmux-play-39)] |
| `runtime_error` with `message: 'boom'` | `captain> [runtime error] boom`, with the body outside the brackets rather than `[runtime error: boom]` [[tmux-play-39](#tmux-play-39)] |
| `turn_aborted` with reason `ESC` | `captain> [turn aborted] ESC` [[tmux-play-39](#tmux-play-39)] |

### tmux-play-127

Given the fanout Captain handling a Boss turn, the check shall assert this Boss-pane filtering matrix:

| Content | Assertion |
| --- | --- |
| Captain-prompt open and close sentinels | no line beginning `=== player:<id>` and no `=== /player:<id> ===` line reaches the pane [[tmux-play-40](#tmux-play-40)] |
| Captain reply synthesized from player content | ordinary synthesized references remain permitted [[tmux-play-40](#tmux-play-40)] |

### tmux-play-128

Given a persistent player `Cligent`, when the Captain selects continuity across Boss turns, the check shall assert this matrix:

| Selection or prior terminal | Assertion |
| --- | --- |
| omitted selector after a prior `done` supplied `resumeToken: <resumeToken>` | reuse the same `Cligent` and pass `resume: <resumeToken>` on the next run [[tmux-play-16](#tmux-play-16)], [[tmux-play-41](#tmux-play-41)] |
| explicit `resume: <explicitToken>` with a stored automatic token | pass the explicit token instead [[tmux-play-16](#tmux-play-16)], [[tmux-play-41](#tmux-play-41)] |
| `resume: false` with a stored automatic token | pass no resume token and start a fresh backend session [[tmux-play-16](#tmux-play-16)], [[tmux-play-41](#tmux-play-41)] |
| ESC-aborted call whose interrupted `done` carries a token | expose it on the aborted `PlayerRunResult`, reuse the same `Cligent`, pass the token on the next call, and finish that later turn normally [[tmux-play-16](#tmux-play-16)], [[tmux-play-99](#tmux-play-99)], [[tmux-play-41](#tmux-play-41)] |
| ESC-aborted call whose interrupted `done` carries no token | omit `resumeToken` from the result, reuse the same `Cligent`, pass no `resume` option next, and pass through the Captain's prompt without a runtime or engine replay rewrite [[tmux-play-16](#tmux-play-16)], [[tmux-play-99](#tmux-play-99)], [[tmux-play-41](#tmux-play-41)] |

### tmux-play-129

When the fanout Captain builds a player's call prompt, the check shall assert this identity-and-recovery matrix:

| State | Assertion |
| --- | --- |
| no unresolved tokenless abort | prompt equals the Boss prompt verbatim, with no `The Boss asked`, `You are the`, player-ID repetition, `Respond independently`, or `other players` framing [[tmux-play-42](#tmux-play-42)] |
| ordinary call boundary | runtime-held `instruction` is the sole source of player identity [[tmux-play-42](#tmux-play-42)] |
| prior call aborted without `resumeToken` | next prompt contains the retained aborted Boss prompt and the latest Boss prompt [[tmux-play-42](#tmux-play-42)] |
| consecutive tokenless aborts | later recovery contains each retained base Boss prompt once and does not nest a prior recovery prompt [[tmux-play-42](#tmux-play-42)] |
| prior aborted call carried `resumeToken` | next prompt remains the Boss prompt verbatim because backend resume supplies continuity [[tmux-play-42](#tmux-play-42)] |

### tmux-play-130

When the real-tmux acceptance suite runs, it shall execute and assert through this matrix:

| Environment or result | Assertion |
| --- | --- |
| `tmux -V` or `glow -v` fails | self-skip because the launcher gates on both binaries [[tmux-play-51](#tmux-play-51)] |
| the runner cannot create a disposable tmux server | self-skip before the acceptance behavior runs |
| both binaries are available and a disposable tmux server can be created | run under `*.acceptance.test.ts` via `npm run test:acceptance` against a real tmux server rather than a mock or argv log, without gating on adapter API keys |
| `launchTmuxPlay({ attach: false })` returns | real-server `tmux display-message -t <session> -p '#{window_width}x#{window_height}'` reports `174x49` [[tmux-play-35](#tmux-play-35)] |

### tmux-play-131

Under [[tmux-play-130](#tmux-play-130)]'s real-tmux acceptance harness, given two configured players and omitted `layout.multiPlayerColumnWeights`, its `layout.columnWeights` alias, and `layout.initialVisible`, when `launchTmuxPlay({ attach: false })` returns, the check shall assert this pane matrix:

| Pane or ordering | Assertion |
| --- | --- |
| Boss/Captain | `pane_left=0`, effective 58-column region less tmux's one-cell border [[tmux-play-28](#tmux-play-28)], [[tmux-play-64](#tmux-play-64)] |
| first player column | `pane_left=58`, effective 58-column region less tmux's one-cell border [[tmux-play-28](#tmux-play-28)], [[tmux-play-64](#tmux-play-64)] |
| second player column | `pane_left=116`, effective 58-column region [[tmux-play-28](#tmux-play-28)], [[tmux-play-64](#tmux-play-64)] |
| `list-panes` index order | Boss/Captain followed by players in config order [[tmux-play-27](#tmux-play-27)] |

Both configured players are visible because `layout.initialVisible` is omitted per [[tmux-play-80](#tmux-play-80)].

### tmux-play-132

Under [[tmux-play-130](#tmux-play-130)]'s real-tmux acceptance harness, given player IDs `coder` and `reviewer`, when `launchTmuxPlay({ attach: false })` returns, the check shall assert this `tmux display-message -p '#{pane_title}'` matrix:

| Pane | Title |
| --- | --- |
| Boss/Captain | `Captain · <captain adapter>` [[tmux-play-36](#tmux-play-36)], [[tmux-play-48](#tmux-play-48)] |
| first player | `Coder · <coder adapter>` [[tmux-play-36](#tmux-play-36)], [[tmux-play-48](#tmux-play-48)] |
| second player | `Reviewer · <reviewer adapter>` [[tmux-play-36](#tmux-play-36)], [[tmux-play-48](#tmux-play-48)] |

### tmux-play-133

Under [[tmux-play-130](#tmux-play-130)]'s real-tmux acceptance harness, when `launchTmuxPlay({ attach: false })` returns, the check shall assert this input-isolation flow:

| Stage or pane | Assertion |
| --- | --- |
| every player pane | `#{pane_input_off}=1` [[tmux-play-27](#tmux-play-27)] |
| Boss/Captain pane | `#{pane_input_off}=0` [[tmux-play-27](#tmux-play-27)] |
| after `tmux send-keys -t <player-pane> '<probe>'` | `tmux capture-pane -p` for that player omits the unique probe [[tmux-play-27](#tmux-play-27)] |

### tmux-play-134

Under [[tmux-play-130](#tmux-play-130)]'s real-tmux acceptance harness, given `attach: true` and stdout routed to an in-memory writer, when `launchTmuxPlay` reaches attachment, the check shall assert this terminal-resize matrix:

| YAML `layout.window` | Assertion |
| --- | --- |
| omitted | writer contains `\x1b[8;49;174t` before the test's `attachTmuxSession` mock is invoked [[tmux-play-43](#tmux-play-43)], [[tmux-play-64](#tmux-play-64)] |
| `{ columns: 200, rows: 50 }` | writer contains `\x1b[8;50;200t`, omits `\x1b[8;49;174t`, and derives CSI 8 from the same source as `new-session -x/-y` [[tmux-play-35](#tmux-play-35)], [[tmux-play-43](#tmux-play-43)] |

### tmux-play-135

Under [[tmux-play-130](#tmux-play-130)]'s real-tmux acceptance harness, given two configured and initially visible players, when the window size or weights change, the check shall assert this resize matrix:

| Configuration or transition | Assertion |
| --- | --- |
| omitted `layout.multiPlayerColumnWeights` and its `layout.columnWeights` alias; manual size `W × H` | Boss/Captain and first player regions each equal `floor(W / 3)`; second player region absorbs the remainder; each pane with a right-side separator has `region width = pane_width + 1` [[tmux-play-44](#tmux-play-44)], [[tmux-play-64](#tmux-play-64)], [[tmux-play-80](#tmux-play-80)] |
| default weights at `80×24`, `160×40`, and `200×50` | the equal-thirds invariant holds at every sample [[tmux-play-44](#tmux-play-44)], [[tmux-play-64](#tmux-play-64)] |
| explicit non-equal weights such as `[3, 5, 5]` | each non-rightmost region equals `floor(W * w_i / sum(w))`; the rightmost absorbs the remainder [[tmux-play-44](#tmux-play-44)], [[tmux-play-64](#tmux-play-64)] |
| attached PTY changes `108 → 61 → 83 → 142` | tmux observes each width; after bounded settlement at 142, regions remain `[47, 47, 48]` for the stability interval so no earlier worker overwrites the final width [[tmux-play-35](#tmux-play-35)], [[tmux-play-44](#tmux-play-44)] |

### tmux-play-200

When launcher preparation observes a tmux version older than 3.3, the launcher integration check shall assert rejection before config resolution or any tmux session command with a diagnostic naming the 3.3 minimum [[tmux-play-172](#tmux-play-172)].

### tmux-play-136

Under [[tmux-play-130](#tmux-play-130)]'s real-tmux acceptance harness, given configured players, when `launchTmuxPlay({ attach: false })` returns, the check shall assert this focus matrix:

| Pane | `#{pane_active}` |
| --- | --- |
| Boss/Captain | `1` [[tmux-play-45](#tmux-play-45)] |
| every player | `0` [[tmux-play-45](#tmux-play-45)] |

### tmux-play-137

_Superseded for text-body wrapping by [[tmux-play-146](#tmux-play-146)], [[tmux-play-147](#tmux-play-147)], and [[tmux-play-148](#tmux-play-148)], matching the same supersession of [[tmux-play-46](#tmux-play-46)] by [[tmux-play-50](#tmux-play-50)]. The character-level soft-wrap and SGR close/reopen invariants asserted below are no longer implemented by the presenter; this item is retained for spec history alongside the cell-measurement table it verifies in the [[tmux-play-49](#tmux-play-49)] tool-input truncation path._

Given a `TmuxPresenter` whose Boss writer has display width `W_b` and whose player writer has display width `W_r`, when the presenter writes a single-logical-line player event of length greater than `W_r`, the player writer's captured text shall contain `\n  ` (newline + two spaces) at the boundary that keeps every emitted row no wider than `W_r` cells, with the first row prefixed by `<playerId>> ` and every subsequent row prefixed by exactly two spaces.
The same invariant shall hold for the Boss writer at width `W_b` for a Captain reply, including across `text_delta` events split before, at, and after the wrap boundary.
When a writer's width source returns `Infinity`, the writer's output shall be identical to the pre-tmux-play-46 behavior (no soft-wrap), and explicit `\n` continuations shall continue to be indented per [[tmux-play-38](#tmux-play-38)] [[tmux-play-46](#tmux-play-46)].

Cell-width and escape handling: when the source text contains East Asian Wide / Fullwidth codepoints, the presenter shall treat each such codepoint as 2 cells when computing the wrap boundary (e.g., at `W_r = 12` the captured text for `<playerId>> ` plus seven Wide characters shall wrap after the second Wide character so the first row is 11 cells and the continuation row is 12 cells).
Supplementary-plane emoji whose Unicode `Emoji_Presentation` property is `Yes` shall likewise count as 2 cells, including codepoints outside the hand-curated emoji ranges in the implementation (e.g., U+1F7E7 🟧 in Geometric Shapes Extended and U+1FAE0 🫠 in Symbols and Pictographs Extended-A); the same rule shall apply to BMP emoji such as U+231A ⌚, U+2615 ☕, and U+23F0 ⏰.
Each block enumerated in [[tmux-play-46](#tmux-play-46)]'s curated EAW=Wide/Fullwidth list shall also resolve to 2 cells, including at least: U+A960 (Hangul Jamo Extended-A), U+4DC0 (Yijing Hexagram Symbols), U+17000 (Tangut), U+18800 (Tangut Components), U+18B00 and U+18CFF (Khitan Small Script, including reserved tail), U+1AFF0 (Kana Extended-B), U+1B000 (Kana Supplement), U+1B100 (Kana Extended-A), U+1B150 (Small Kana Extension), U+1B170 (Nüshu), U+1D300 (Tai Xuan Jing Symbols), and U+1D360 (Counting Rod Numerals).
Codepoints that Unicode reports as Neutral, and EAW=Wide/Fullwidth codepoints in blocks not enumerated by tmux-play-46 (e.g., archaic scripts not in the curated subset), shall count as 1 cell — including U+1FB70 in Symbols for Legacy Computing and U+1F800 in Supplemental Arrows-C, both Neutral per Unicode.
Unicode combining marks and zero-width formatting codepoints shall not advance the wrap column.
ANSI escape sequences (CSI, OSC, and `ESC` + next-byte) shall be passed through verbatim without contributing to the cell count and shall never have a `\n  ` inserted in their interior, including when the sequence's bytes arrive in two or more streaming chunks: given three player `text_delta` events whose payloads are `hello`, `\x1b[31`, and `m world` with `W_r = 12`, the player writer's captured text shall be `<playerId>> hello\x1b[31m\n   world` — i.e., the CSI is reassembled into a single `\x1b[31m` token before the soft-wrap fires, and the wrap lands between the escape and the following space rather than inside the escape's parameter bytes.
Pending escape state shall not leak across block boundaries: given a player `text_delta` `hello\x1b[31` followed by a `player_finished` with `status: 'ok'` and then a fresh player `text` event `next`, the player writer's captured text shall be `<playerId>> hello\x1b[31\n<playerId>> next\n` — i.e., the partial CSI is flushed verbatim into the previous block before its closing newline, and the next block's leading `n` is not consumed as the missing CSI terminator.
Additionally, given a `TmuxPlaySession` whose stdout emits `'resize'`, the session's player pane width query (`queryPaneWidths`) shall be invoked again so subsequent writes use the post-resize width; after the session has shut down, further `'resize'` emissions on stdout shall not invoke the query.
The superseded probe's acceptance precondition is [[tmux-play-130](#tmux-play-130)]'s real-tmux harness.

### tmux-play-138

When the launcher applies a resolved theme, the check shall assert this option matrix:

| Flavor or option group | Assertion |
| --- | --- |
| Mocha from no concrete override or parseable OSC 11 answer | exact [[tmux-play-47](#tmux-play-47)] Mocha entries, including `default-terminal=tmux-256color`, `terminal-overrides` appended with `,*:RGB`, `status-style=fg=#cdd6f4,bg=#181825`, `pane-active-border-style=fg=#89b4fa`, and `pane-border-style=fg=#6c7086` [[tmux-play-194](#tmux-play-194)] |
| options excluded under Mocha | no `window-style`, `window-active-style`, `window-status-style`, or `window-status-current-style` [[tmux-play-47](#tmux-play-47)] |
| option order | every theme `set` precedes the launcher's `pane-border-format`, `status-left`, and `status-right` calls [[tmux-play-47](#tmux-play-47)] |
| explicit Latte or parseable light-background OSC 11 answer | same keys with exact Latte values, including `status-style=fg=#4c4f69,bg=#e6e9ef`, `pane-active-border-style=fg=#1e66f5`, and `pane-border-style=fg=#9ca0b0` [[tmux-play-194](#tmux-play-194)], [[tmux-play-47](#tmux-play-47)] |

### tmux-play-139

Under [[tmux-play-130](#tmux-play-130)]'s real-tmux acceptance harness, given a launched session, when the real-server color probe runs, the check shall assert this boundary matrix:

| Surface | Assertion |
| --- | --- |
| `show-options -gv default-terminal` | reports `tmux-256color` [[tmux-play-47](#tmux-play-47)] |
| `show-options -gv terminal-overrides` | contains `*:RGB`, a stricter application check than [[tmux-play-138](#tmux-play-138)]'s argv inspection [[tmux-play-47](#tmux-play-47)] |
| real terminal client negotiation | outside the launcher's control surface and not asserted |

### tmux-play-140

Given Captain adapter `claude` and players `coder` on `codex` and `reviewer` on `gemini`, when the launcher sets pane titles, the check shall assert this title matrix:

| Pane | Exact title |
| --- | --- |
| Captain | `Captain · claude` [[tmux-play-48](#tmux-play-48)] |
| player `coder` | `Coder · codex` [[tmux-play-48](#tmux-play-48)] |
| player `reviewer` | `Reviewer · gemini` [[tmux-play-48](#tmux-play-48)] |
| every title | separator is exactly ` · `: space, U+00B7 middle dot, space [[tmux-play-48](#tmux-play-48)] |

### tmux-play-202

When the adapter-accent lookup is exercised, the integration check shall select assertions through this matrix:

| Input | Assertion |
| --- | --- |
| each known adapter under Mocha or Latte | exact paired hex from [[tmux-play-195](#tmux-play-195)] |
| unknown adapter under either flavor | value belongs to that flavor's documented fallback pool [[tmux-play-195](#tmux-play-195)] |
| same unknown adapter and flavor repeated | identical value [[tmux-play-195](#tmux-play-195)] |
| fallback-pool boundary | excludes every known-adapter accent and reserved speaker, tool, and status role [[tmux-play-195](#tmux-play-195)] |

### tmux-play-141

When the presenter emits a speaker-prefixed block under Mocha, the check shall assert this byte matrix:

| Speaker or line | Assertion |
| --- | --- |
| Captain | `\x1b[1;38;2;203;166;247mcaptain> \x1b[0m` immediately precedes the first nonblank body line [[tmux-play-38](#tmux-play-38)] |
| `coder` player mapped to `claude` | `\x1b[1;38;2;166;227;161mcoder> \x1b[0m` immediately precedes the body [[tmux-play-38](#tmux-play-38)], [[tmux-play-195](#tmux-play-195)] |
| player absent from `playerAdapters` | uncolored `<playerId>> ` prefix [[tmux-play-38](#tmux-play-38)] |
| wrapped or explicit continuation | two-space indent carries no SGR escape [[tmux-play-38](#tmux-play-38)] |

### tmux-play-142

When the presenter emits an operational line under Mocha, the check shall assert this byte matrix:

| Record | Assertion |
| --- | --- |
| `coder` on `claude`, player error `<message>` | exact bytes `\x1b[1;38;2;166;227;161mcoder> \x1b[0m\x1b[1;38;2;243;139;168m[error]\x1b[0m <message>\n` [[tmux-play-38](#tmux-play-38)], [[tmux-play-39](#tmux-play-39)] |
| same player, aborted | player prefix followed by `\x1b[1;38;2;249;226;175m[aborted]\x1b[0m\n`, with no body [[tmux-play-38](#tmux-play-38)], [[tmux-play-39](#tmux-play-39)] |
| `turn_aborted` with `<reason>` | Captain mauve prefix followed by `\x1b[1;38;2;249;226;175m[turn aborted]\x1b[0m <reason>\n` [[tmux-play-38](#tmux-play-38)], [[tmux-play-39](#tmux-play-39)] |
| `turn_aborted` without reason | Captain mauve prefix followed by `\x1b[1;38;2;249;226;175m[turn aborted]\x1b[0m\n`, with no trailing space or synthesized body [[tmux-play-38](#tmux-play-38)], [[tmux-play-39](#tmux-play-39)] |
| `runtime_error` with `<message>` | Captain mauve prefix followed by `\x1b[1;38;2;243;139;168m[runtime error]\x1b[0m <message>\n` [[tmux-play-38](#tmux-play-38)], [[tmux-play-39](#tmux-play-39)] |

### tmux-play-143

When the presenter handles a tool event, the check shall assert this rendering matrix:

| Event or payload | Assertion |
| --- | --- |
| player `tool_use`, `coder` on `claude`, `Bash`, command `npm test` | exact bytes `\x1b[1;38;2;166;227;161mcoder> \x1b[0m[tool ↪] Bash npm test\n`; adapter-colored speaker prefix and uncolored tag [[tmux-play-38](#tmux-play-38)], [[tmux-play-39](#tmux-play-39)], [[tmux-play-49](#tmux-play-49)] |
| Captain `tool_use`, `Read`, `file_path: 'a.ts'` | exact bytes `\x1b[1;38;2;203;166;247mcaptain> \x1b[0m[tool ↪] Read a.ts\n`; mauve speaker prefix and uncolored tag [[tmux-play-38](#tmux-play-38)], [[tmux-play-39](#tmux-play-39)], [[tmux-play-49](#tmux-play-49)] |
| every `tool_use` | no retired `tool> ` replacement or caller-accent coloring on the tag [[tmux-play-49](#tmux-play-49)] |
| player successful `tool_result`, `Bash`, `durationMs: 1234` | header begins `\x1b[1;38;2;166;227;161mcoder> \x1b[0m\x1b[1;38;2;166;227;161m[tool ✓]\x1b[0m Bash 1.2s\n` [[tmux-play-38](#tmux-play-38)], [[tmux-play-39](#tmux-play-39)], [[tmux-play-49](#tmux-play-49)] |
| Captain successful `tool_result`, `Read`, `durationMs: 200` | exact header `\x1b[1;38;2;203;166;247mcaptain> \x1b[0m\x1b[1;38;2;166;227;161m[tool ✓]\x1b[0m Read 200ms\n`, with a green tag and unstyled body [[tmux-play-38](#tmux-play-38)], [[tmux-play-39](#tmux-play-39)], [[tmux-play-49](#tmux-play-49)] |
| result status `success` / `error` / `denied` | symbol `✓` / `✗` / `·` and green / red / yellow tag respectively [[tmux-play-39](#tmux-play-39)], [[tmux-play-49](#tmux-play-49)] |
| duration below 1000 ms / at least 1000 ms / absent | `<n>ms` / `<n.n>s` / no duration segment [[tmux-play-49](#tmux-play-49)] |
| every `tool_result` | no retired `tool< ` replacement [[tmux-play-49](#tmux-play-49)] |
| non-empty extracted output | remove exactly one trailing line terminator before wrapping; preserve any additional trailing blank lines [[tmux-play-49](#tmux-play-49)] |
| rendered non-empty body | fence with one more backtick than the longest payload run and at least three; render at [[tmux-play-49](#tmux-play-49)]'s width through [[tmux-play-50](#tmux-play-50)]; strip trailing horizontal padding while preserving leading whitespace; prefix nonblank lines with two spaces; keep blank lines unindented and without right padding; apply no retired `overlay0` wrapper |
| payload containing a ```` ``` ```` line | wrapper fence has at least four backticks so the embedded fence remains literal [[tmux-play-49](#tmux-play-49)] |
| empty or undefined extracted output | header stands alone with no body [[tmux-play-49](#tmux-play-49)] |

### tmux-play-144

When the presenter summarizes `tool_use.input`, the check shall assert this matrix:

| Input | Assertion |
| --- | --- |
| no priority key; `{ count: 3, flag: true }` | compact JSON `{"count":3,"flag":true}` [[tmux-play-49](#tmux-play-49)] |
| first priority-key string exceeds 60 cells | first 59 cells followed by `…` [[tmux-play-49](#tmux-play-49)] |
| empty object | header `<who>> [tool ↪] <toolName>` with no trailing space [[tmux-play-49](#tmux-play-49)] |
| only matching priority key is `query`, such as `{ query: 'select:WebFetch', max_results: 1 }` | `select:WebFetch`, proving `query` precedes `prompt` and compact JSON fallback [[tmux-play-49](#tmux-play-49)] |

### tmux-play-145

When the presenter routes a `tool_use`, the check shall assert this pane matrix:

| Source | Assertion |
| --- | --- |
| `captain_event` | only the Boss/Captain writer receives `captain> [tool ↪] …` [[tmux-play-40](#tmux-play-40)], [[tmux-play-49](#tmux-play-49)] |
| player `coder` event | only the `coder` writer receives `coder> [tool ↪] …`; Boss/Captain receives nothing [[tmux-play-40](#tmux-play-40)], [[tmux-play-49](#tmux-play-49)] |

### tmux-play-146

Under [[tmux-play-130](#tmux-play-130)]'s real-tmux acceptance harness, when a `TmuxPresenter` receives streaming text, the check shall assert this buffer flow:

| Input or boundary | Assertion |
| --- | --- |
| one or more `text_delta` events for one `(writer, who)` | capture zero bytes until a block boundary [[tmux-play-50](#tmux-play-50)] |
| same-writer `player_finished` or `captain_finished` | flush the open block [[tmux-play-50](#tmux-play-50)] |
| same-writer non-streaming `text` | flush the open block, then handle the complete block [[tmux-play-50](#tmux-play-50)] |
| same-writer `captain_reply` or `player_prompt` | flush the open block before the complete prose or prompt block [[tmux-play-50](#tmux-play-50)] |
| same-writer `tool_use` or `tool_result` | flush the open block before the tool line [[tmux-play-50](#tmux-play-50)] |
| same-writer `captain_status`, `runtime_error`, or `turn_aborted` | flush the open block before the status line [[tmux-play-50](#tmux-play-50)] |
| every flush | pass the accumulated text once to `renderMarkdown`, then emit through [[tmux-play-38](#tmux-play-38)]'s prefix grammar [[tmux-play-50](#tmux-play-50)] |
| `text_delta` after a flush | open a fresh block with an independent render call [[tmux-play-50](#tmux-play-50)] |
| `text_delta('partial\n')` followed by `tool_use(...)` | text appears before the `<who>> [tool ↪] …` header [[tmux-play-50](#tmux-play-50)] |

### tmux-play-147

Under [[tmux-play-130](#tmux-play-130)]'s real-tmux acceptance harness, when the presenter captures rendered text, the check shall assert this normalization matrix:

| Rendered state | Assertion |
| --- | --- |
| ordinary lines | first nonblank line carries the colored `<who>> ` prefix; later nonblank lines carry the two-space hanging indent; blank lines remain blank [[tmux-play-38](#tmux-play-38)], [[tmux-play-50](#tmux-play-50)] |
| horizontal spacing | no successful line retains trailing horizontal padding, including padding before only SGR resets; leading whitespace remains unchanged [[tmux-play-50](#tmux-play-50)] |
| continuation indent | no SGR sequence spans its two spaces [[tmux-play-38](#tmux-play-38)], [[tmux-play-50](#tmux-play-50)] |
| real-`glow` text and tool-result bodies | under [[tmux-play-150](#tmux-play-150)]'s real-glow acceptance harness, no trailing horizontal whitespace remains after ANSI is stripped [[tmux-play-49](#tmux-play-49)], [[tmux-play-50](#tmux-play-50)] |
| leading or trailing paragraph-margin blanks | drop at most one blank at each edge and preserve every further structural blank, including fenced-code, table, and inter-paragraph rows, without right padding [[tmux-play-50](#tmux-play-50)] |
| payload starts with a blank inside a fenced block | retain it rather than applying a blanket multi-line trim [[tmux-play-50](#tmux-play-50)] |
| content wholly blank after outer-margin trim | emit zero bytes, with no bare prefix or stranded blanks [[tmux-play-50](#tmux-play-50)] |
| unterminated `text_delta` followed by `player_prompt` or another same-writer boundary | flush before opening the new block and do not interleave speakers on one line [[tmux-play-50](#tmux-play-50)] |

### tmux-play-148

Under [[tmux-play-130](#tmux-play-130)]'s real-tmux acceptance harness, when the presenter selects a render width, the check shall assert this matrix:

| Width source or block | Assertion |
| --- | --- |
| configured pane width `W` | text calls `renderMarkdown` with `max(1, W)`, compensating for and preserving `glow`'s two-cell document margin [[tmux-play-50](#tmux-play-50)] |
| no pane-width source | text render width is `80` [[tmux-play-50](#tmux-play-50)] |
| first visible row plus its speaker prefix exceeds `W` (`6` cells for Boss, `9` for Captain, `playerId.length + 2` for a player) | split only that row at a cell-aware word boundary; no line exceeds `W`; later continuation rows may reach the pane edge [[tmux-play-50](#tmux-play-50)] |
| `tool_result` body | render width is `max(1, W - 2)`, matching the body indent rather than the tool-header prefix [[tmux-play-49](#tmux-play-49)], [[tmux-play-50](#tmux-play-50)] |

### tmux-play-149

Under [[tmux-play-130](#tmux-play-130)]'s real-tmux acceptance harness, when injected `isGlowAvailable()` returns `false`, the launcher check shall assert this failure flow:

| Stage or condition | Assertion |
| --- | --- |
| rejection | error names `glow` and `https://github.com/charmbracelet/glow#installation` [[tmux-play-51](#tmux-play-51)] |
| after rejection | no config discovery, work-directory creation, or tmux session construction [[tmux-play-51](#tmux-play-51)] |
| both injected availability results are false | tmux availability check reports first [[tmux-play-51](#tmux-play-51)] |

### tmux-play-150

When real-`glow` acceptance runs, it shall execute and assert through this matrix:

| Environment or input | Assertion |
| --- | --- |
| `glow -v` fails | self-skip only for that missing binary |
| `glow` is available | run under `*.acceptance.test.ts` via `npm run test:acceptance` against the real binary rather than a mock, without gating on tmux or adapter API keys |
| `renderMarkdown('hello **world** today\n', 80)` | non-empty output contains ANSI, omits literal `**`, and retains visible `world` after ANSI stripping, proving bold rendering [[tmux-play-50](#tmux-play-50)], [[tmux-play-51](#tmux-play-51)] |
| fenced block with one 200-character line at width 40 | all 200 characters remain intact after ANSI stripping, with no mid-token break [[tmux-play-49](#tmux-play-49)] |
| plain paragraph at width 80 | non-empty output retains every source word after ANSI stripping [[tmux-play-50](#tmux-play-50)] |

### tmux-play-151

Under [[tmux-play-150](#tmux-play-150)]'s real-`glow` acceptance harness, given a `TmuxPresenter` wired to in-memory writers, when representative blocks pass through the presenter and real `glow`, the check shall assert this integration matrix:

| Input | Assertion |
| --- | --- |
| text body containing a heading and bold span | exactly one `<who>> ` prefix line; every nonblank line begins with that prefix or the two-space hanging indent; ANSI styling is present; the literal `**` marker is absent [[tmux-play-38](#tmux-play-38)], [[tmux-play-50](#tmux-play-50)] |
| `tool_result` whose payload ends with an intentional blank row, such as `output: 'foo\n\n'` | ANSI-stripped output matches `/foo\s*\n\s*\n/`, preserving the blank through one-terminator removal, fence wrapping, fenced-code rendering, outer-margin trimming, and two-space indentation in that order [[tmux-play-49](#tmux-play-49)] |
| two consecutive short text blocks on one writer | no run of three or more consecutive newlines, so per-block paragraph margins do not stack [[tmux-play-50](#tmux-play-50)] |
| prose rendered in a 40-cell pane | after stripping ANSI, at least one non-first continuation row is at least 39 cells wide, no visible row exceeds 40 cells, and the near-edge row begins with the presenter's two-space indent followed by `glow`'s preserved two-space document margin [[tmux-play-38](#tmux-play-38)], [[tmux-play-50](#tmux-play-50)] |

These cases cover the presenter/real-`glow` seam that neither isolated `glow` acceptance nor identity-mock checks reach, including the reported excessive-blank-line and unused-right-edge regressions.

### tmux-play-152

When `loadTmuxPlayConfig` resolves optional `permissions` on the Captain or a player, the check shall assert this validation matrix:

| YAML input | Assertion |
| --- | --- |
| accepted policy on the Captain or a player | loaded `captain.permissions` or `players[i].permissions` is the typed `PermissionPolicy`, with every `writablePaths` entry validated and canonicalized [[tmux-play-52](#tmux-play-52)] |
| unknown `permissions` member | rejection naming the offending path [[tmux-play-8](#tmux-play-8)], [[tmux-play-52](#tmux-play-52)] |
| `mode` outside `'auto' \| 'bypass'` | rejection naming the offending path [[tmux-play-8](#tmux-play-8)], [[tmux-play-52](#tmux-play-52)] |
| `fileWrite`, `shellExecute`, or `networkAccess` outside `'allow' \| 'ask' \| 'deny'` | rejection naming the offending path [[tmux-play-8](#tmux-play-8)], [[tmux-play-52](#tmux-play-52)] |
| invalid `writablePaths` | rejection naming the offending path [[tmux-play-8](#tmux-play-8)], [[tmux-play-52](#tmux-play-52)] |
| non-object `permissions` | rejection naming the offending path [[tmux-play-8](#tmux-play-8)], [[tmux-play-52](#tmux-play-52)] |

### tmux-play-153

Given a Captain or player `PermissionPolicy` accepted by the loader, when the runtime constructs and invokes the corresponding `Cligent`, the check shall assert this delivery and adapter-mapping matrix per [DR-005](../decisions/005-per-adapter-permission-configuration.md) and [DR-006](../decisions/006-workspace-writable-paths.md):

| Role or adapter | Assertion |
| --- | --- |
| Captain or player | the canonicalized policy reaches the next `run()` call as `AgentOptions.permissions` [[tmux-play-52](#tmux-play-52)] |
| Claude | `mode: 'auto'` / `'bypass'` maps to `permissionMode: 'auto'` / `'bypassPermissions'`; supplied `writablePaths` is reported with ambient enforcement [[tmux-play-52](#tmux-play-52)] |
| Codex | auto maps to `ThreadOptions: { approvalPolicy: 'on-request' }`, `CodexOptions.config: { approvals_reviewer: 'auto_review', default_permissions: ':workspace' }`, and `exec --ignore-user-config`; writable paths generate the extra-writes profile; bypass maps to `ThreadOptions: { approvalPolicy: 'never' }`, `CodexOptions.config: { default_permissions: ':danger-full-access' }`, and `exec --ignore-user-config` [[tmux-play-52](#tmux-play-52)] |
| Gemini | auto and bypass each map to `approvalMode: 'yolo'`; supplied `writablePaths` is reported with ambient enforcement [[tmux-play-52](#tmux-play-52)] |
| OpenCode | auto adds no wildcard permission rule and maps only explicitly supplied portable capability levels as independent rules; supplied `writablePaths` is reported with ambient enforcement; bypass throws an error naming the SDK/server architecture [[tmux-play-52](#tmux-play-52)] |
| Kimi | auto maps to ACP mode config `auto` with ambient `writablePaths` reporting; bypass and a supplied policy with no mode fail before spawn [[tmux-play-52](#tmux-play-52)] |

### tmux-play-154

Given a YAML config whose `permissions.mode` is outside the closed set, when the launcher CLI is invoked, the check shall assert this startup-failure flow:

| Surface | Assertion |
| --- | --- |
| process | nonzero exit status [[tmux-play-8](#tmux-play-8)], [[tmux-play-52](#tmux-play-52)] |
| stderr | one `Error: ...` line naming the offending path, such as `captain.permissions.mode` or `players[0].permissions.mode` [[tmux-play-8](#tmux-play-8)], [[tmux-play-52](#tmux-play-52)] |
| runtime boundary | no runtime start and no observable `runtime_error`, because the launcher-startup abort falls outside [[tmux-play-25](#tmux-play-25)]'s runtime-existence scope per [DR-005](../decisions/005-per-adapter-permission-configuration.md) |

### tmux-play-155

Given the built-in fanout Captain and a `claude` player configured with `permissions: { mode: 'auto' }`, when the runtime constructed per [[tmux-play-29](#tmux-play-29)] handles a create-file Boss turn followed by a delete-file Boss turn, the real-run acceptance check shall assert this end-to-end flow:

| Stage or environment | Assertion |
| --- | --- |
| after the create turn | file exists in the working directory and the turn's Claude `player_finished` has `status: 'ok'` [[tmux-play-52](#tmux-play-52)] |
| after the delete turn | file is absent and the turn's Claude `player_finished` has `status: 'ok'` [[tmux-play-52](#tmux-play-52)] |
| complete record stream | neither `runtime_error` nor `turn_aborted` appears [[tmux-play-30](#tmux-play-30)] |
| `ANTHROPIC_API_KEY` absent locally / under `CI` | self-skip / hard-fail under `*.acceptance.test.ts` via `npm run test:acceptance` [[tmux-play-30](#tmux-play-30)] |

The flow crosses Boss turn → fanout Captain → player → Claude adapter → live SDK → filesystem and exercises the path a headless no-`permissions` player cannot complete under `permissionMode: 'default'`.

### tmux-play-156

Under [[tmux-play-130](#tmux-play-130)]'s real-tmux acceptance harness, given one Captain pane and at least two configured player panes, when a `TimingObserver` consumes controlled synthetic timing records, the check shall assert this timing-and-chrome flow:

| Stage or surface | Assertion |
| --- | --- |
| `turn_started`, `player_prompt`, `player_finished`, `captain_prompt`, `captain_finished`, and `turn_finished` timestamps | each pane option carries that pane's expected cumulative duration and the session-total option carries the expected Boss-turn duration [[tmux-play-53](#tmux-play-53)] |
| player or Captain run open at a supplied `now` | duration includes `now - <open-start>.timestamp`, uses `⏳`, and uses the bright flavor-aware player or Captain accent [[tmux-play-53](#tmux-play-53)], [[tmux-play-54](#tmux-play-54)], [[tmux-play-195](#tmux-play-195)] |
| matching player or Captain finish | duration freezes with `⌛` and `subtext1` (Mocha `#bac2de`), not the less-legible per-pane `overlay1`, against the mantle band [[tmux-play-54](#tmux-play-54)] |
| Boss turn open / finished | `status-right` includes `now - turn_started.timestamp` with `⏳` and `mauve` / freezes with `⌛` and `overlay1` [[tmux-play-53](#tmux-play-53)], [[tmux-play-55](#tmux-play-55)] |
| every pane and status duration | matches `^[0-9]{2,}:[0-9]{2}:[0-9]{2}$`; byte-exact sub-minute text such as `00:00:12`, minute text such as `00:01:00` or `00:03:07`, and hour text such as `01:00:00` or `01:02:03`, never the shortened `12s`, `1m0s`, `3m07s`, `187s`, `1h00m`, `1h2m3s`, or `3723s` forms [[tmux-play-71](#tmux-play-71)] |
| `status-left` | contains `Spex`, `switch pane: ctrl+←/→ or shift+←/→`, `stop: esc`, `exit: ctrl+c`, `drag=select`, and `right-click=copy`; omits the retired `spex`, `Cligent`, `tmux-play`, `d=detach`, `o=switch pane`, `[=scroll`, and `Stop: ESC` fragments [[tmux-play-55](#tmux-play-55)], [[tmux-play-63](#tmux-play-63)] |
| status and border options | `status-right` carries the total timer; `window-status-format`, `window-status-current-format`, and `window-status-separator` are empty [[tmux-play-55](#tmux-play-55)]; `pane-border-format` matches [[tmux-play-199](#tmux-play-199)] while retaining `#{pane_title}` |
| assertion surface | inspect tmux through `show-options`, `show-options -p`, and `display-message`, tolerating one cell of visual border-alignment variance for emoji glyph width [[tmux-play-53](#tmux-play-53)], [[tmux-play-54](#tmux-play-54)], [[tmux-play-55](#tmux-play-55)] |

### tmux-play-157

Where YAML selects representative values covering every distinct adapter transport class, when the launcher/session seam constructs and invokes the corresponding `Cligent`, the check shall assert this effort-routing matrix without cross-aliasing adapter vocabularies:

| Adapter and YAML case | Assertion |
| --- | --- |
| Claude ordinary effort and `ultracode` | each value reaches its Claude-native effort surface [[tmux-play-56](#tmux-play-56)] |
| Codex thread effort and constructor effort | each value reaches the corresponding Codex-native control [[tmux-play-56](#tmux-play-56)] |
| Gemini 3 and Gemini 2.5 concrete models | each value reaches the model-family-specific alias [[tmux-play-56](#tmux-play-56)] |
| known-provider OpenCode model | value reaches the provider's prompt variant [[tmux-play-56](#tmux-play-56)] |
| Kimi `on` with a model | model forwarding is preserved and the binary ACP `thinking` setting selects that model's default thinking effort [[tmux-play-56](#tmux-play-56)] |
| representative unmatched Gemini or OpenCode model | ordinary model forwarding is preserved and no effort override is created [[tmux-play-56](#tmux-play-56)] |

### tmux-play-158

Where one YAML config has an unsupported `captain.effort` and another has an unsupported `players[0].effort`, when the launcher CLI is invoked for each, the check shall assert this validation matrix:

| Surface or case | Assertion |
| --- | --- |
| unsupported Captain effort | nonzero exit and one error line naming `captain.effort`, its adapter, and the allowed values [[tmux-play-8](#tmux-play-8)], [[tmux-play-56](#tmux-play-56)] |
| unsupported player effort | nonzero exit and one error line naming `players[0].effort`, its adapter, and the allowed values [[tmux-play-8](#tmux-play-8)], [[tmux-play-56](#tmux-play-56)] |
| either launcher-startup failure | no runtime start and no observable `runtime_error`, because validation falls outside [[tmux-play-25](#tmux-play-25)]'s runtime-existence scope |

### tmux-play-159

Given a `TmuxPlaySession` with programmable input, when it interprets potential ESC input, the check shall assert this input-and-state matrix:

| Input and state | Assertion |
| --- | --- |
| TTY-like input, active Boss turn, bare ESC followed by readline timeout | observers capture exactly one `turn_aborted` with reason `ESC`; the Boss/Captain pane captures `captain> [turn aborted] ESC`; no `runtime_error` appears; the session remains open [[tmux-play-57](#tmux-play-57)], [[tmux-play-26](#tmux-play-26)], [[tmux-play-40](#tmux-play-40)] |
| same session, arrow-up sequence `\x1b[A` | no `turn_aborted` record [[tmux-play-57](#tmux-play-57)] |
| user-typed edit-buffer bytes present when bare ESC arrives, then Enter after abort | the next Boss turn receives the retained bytes as its prompt [[tmux-play-57](#tmux-play-57)] |
| non-TTY input | no ESC keybinding; SIGHUP, SIGINT, SIGTERM, and EOF remain governed by [[tmux-play-26](#tmux-play-26)] |

### tmux-play-160

Given a `TmuxPlaySession` with programmable input and output, when it handles bracketed paste and terminal lifecycle, the check shall assert this matrix [[tmux-play-58](#tmux-play-58)]:

| Input or terminal state | Assertion |
| --- | --- |
| TTY input/output; `\x1b[200~Alpha\nBravo\nCharlie\x1b[201~` then Enter | exactly one Boss turn with prompt `Alpha\nBravo\nCharlie` [[tmux-play-58](#tmux-play-58)] |
| TTY input/output; `\x1b[200~Alpha\nBravo\n\x1b[201~` then Enter | exactly one Boss turn with prompt `Alpha\nBravo` [[tmux-play-58](#tmux-play-58)] |
| TTY input/output; `\x1b[200~Alpha\nBravo\x1b[201~` then `-extra` and Enter | exactly one Boss turn with prompt `Alpha\nBravo-extra` [[tmux-play-58](#tmux-play-58)] |
| TTY session start and shutdown | output contains the bracketed-paste-enable sequence at start and the disable sequence on shutdown [[tmux-play-58](#tmux-play-58)] |
| non-TTY output | output contains neither bracketed-paste control sequence [[tmux-play-58](#tmux-play-58)] |

### tmux-play-161

When the CLI's theme-diagnostics paths are exercised, verification shall assert this matrix [[tmux-play-61](#tmux-play-61)], [[tmux-play-194](#tmux-play-194)]:

| Invocation or probe state | Assertion |
| --- | --- |
| YAML config supplied | load it, apply the launcher flavor rule, print `selected: <flavor>` and `reason: <reason>` plus the raw OSC 11 reply when received, and exit zero without tmux or Glow |
| parseable light OSC 11 reply such as `rgb:eeee/eeee/eeee` | report `selected: latte` and `reason: osc11` |
| no parseable reply and no concrete explicit or YAML flavor | report `selected: mocha` and `reason: fallback` |
| discovery finds no config and `--config` is absent | create no config and report the same auto-theme outcome without requiring an installed adapter runtime |
| combined with a non-empty `--session` | reject with `--theme-diagnostics is only valid in launcher mode` before session-mode dispatch [[tmux-play-204](#tmux-play-204)] |
| no non-empty `--session`; non-empty `--work-dir` | reject with `--work-dir is only valid with --session` before diagnostic handling [[tmux-play-204](#tmux-play-204)] |
| no non-empty `--session` or `--work-dir`; `--owned-work-dir` | reject with `--owned-work-dir is only valid with --session` before diagnostic handling [[tmux-play-204](#tmux-play-204)] |

### tmux-play-205

Given the built CLI and isolated dependencies, when CLI dispatch precedence is exercised, the check shall assert this matrix:

| Invocation | Assertion |
| --- | --- |
| POSIX runner; `--help` alone and combined with diagnostics, session, and invalid mode-local paths | print usage and exit zero before validation or external work [[tmux-play-204](#tmux-play-204)] |
| ordinary launcher with cwd YAML and available configured runtimes | load and snapshot the config, pass the runtime gate, construct and attach the tmux session, and exit zero [[tmux-play-204](#tmux-play-204)], [[tmux-play-2](#tmux-play-2)], [[tmux-play-9](#tmux-play-9)], [[tmux-play-34](#tmux-play-34)], [[tmux-play-89](#tmux-play-89)] |
| session invocation with a prepared snapshot and EOF | load the snapshot and package Captain, expose Boss readline, then remove launcher-owned work state and kill the tmux session [[tmux-play-204](#tmux-play-204)], [[tmux-play-3](#tmux-play-3)], [[tmux-play-13](#tmux-play-13)], [[tmux-play-26](#tmux-play-26)], [[tmux-play-100](#tmux-play-100)] |
| diagnostics with explicit YAML whose configured Kimi runtime, tmux, and Glow are unavailable | print that YAML flavor and its reason, create no config or session, and invoke no prerequisite command [[tmux-play-204](#tmux-play-204)], [[tmux-play-4](#tmux-play-4)], [[tmux-play-61](#tmux-play-61)], [[tmux-play-194](#tmux-play-194)] |
| diagnostics with no config, no parseable OSC 11 reply, and an executable search path whose prerequisite commands resolve only to failing sentinels | print the fallback flavor and reason, create no config or session, invoke no prerequisite command, and exit zero [[tmux-play-204](#tmux-play-204)], [[tmux-play-9](#tmux-play-9)], [[tmux-play-61](#tmux-play-61)], [[tmux-play-194](#tmux-play-194)] |
| diagnostics combined with session mode | print the exact conflict, dispatch neither mode, and issue no tmux command [[tmux-play-204](#tmux-play-204)], [[tmux-play-61](#tmux-play-61)] |

### tmux-play-162

When launcher and real-session checks exercise mouse selection and right-click copying, the check shall assert this verification matrix [[tmux-play-62](#tmux-play-62)]:

| Probe case | Assertion |
| --- | --- |
| launcher command stream | `set-option -t <session> mouse on`; both copy-mode tables bind `MouseDragEnd1Pane` to `send-keys -X stop-selection`, `MouseDown3Pane` to the focus-neutral `refresh-client` no-op, and `MouseUp3Pane` to one `if-shell -F '#{selection_present}'` whose true branch is `display-message Copied! ; send-keys -X copy-pipe '<system-clipboard-command>'` and false branch is `send-keys -X copy-pipe '<system-clipboard-command>'`; no `set-clipboard`, `WheelUpPane`, or `WheelDownPane` write [[tmux-play-62](#tmux-play-62)] |
| press-versus-release boundary | `MouseDown3Pane` contains none of `copy-pipe`, `Copied!`, or `select-pane`; copy and toast occur only on `MouseUp3Pane`, after whose delivery no later gesture event can wipe the toast [[tmux-play-62](#tmux-play-62)] |
| copy primitive and selection gate | each release body contains `if-shell`, `display-message`, and `selection_present`; uses `copy-pipe`, never `copy-pipe-and-cancel`; contains `Copied!` exactly once and only in the selection-present true branch [[tmux-play-62](#tmux-play-62)] |
| system clipboard route | `<system-clipboard-command>` contains `pbcopy`, `wl-copy`, `xclip`, `xsel`, `clip.exe`, and `tmux load-buffer -w -` [[tmux-play-62](#tmux-play-62)] |
| under [[tmux-play-130](#tmux-play-130)]'s real-tmux acceptance harness, after `launchTmuxPlay({ attach: false })` | `tmux show-options -v -t <session> mouse` reports `on`; `list-keys` for both copy-mode tables reports the stop-selection, press-no-op, and release bindings above; each press body omits `copy-pipe`, `Copied!`, and `select-pane`; each release body contains the selection gate and exactly one `Copied!` and omits `copy-pipe-and-cancel` [[tmux-play-62](#tmux-play-62)] |
| under [[tmux-play-130](#tmux-play-130)]'s harness, selected branch executed against a scrolled pane with stopped selection, using a test pipe | branch reparses and executes; the pipe receives the expected text; `#{selection_present}` becomes `0`; `#{pane_in_mode}` remains `1`; `#{scroll_position}` retains its pre-copy value [[tmux-play-62](#tmux-play-62)] |
| same pane after selection clears, no-selection branch executed | pipe receives no selected text, confirming a silent empty right-click [[tmux-play-62](#tmux-play-62)] |
| under [[tmux-play-130](#tmux-play-130)]'s harness, attached-client SGR right-button `M` then `m` over a scrolled pane with stopped selection | live release binding runs end-to-end: `#{selection_present}` becomes `0`, `#{pane_in_mode}` remains `1`, and `#{scroll_position}` retains its pre-click value; a dropped release instead leaves selection present [[tmux-play-62](#tmux-play-62)] |
| under [[tmux-play-130](#tmux-play-130)]'s harness, same real gesture through an inner client rendered in an outer tmux pane with generous `display-time` | captured inner status line contains `Copied!` after release, proving the toast survived release and therefore was not painted on press [[tmux-play-62](#tmux-play-62)] |
| attached-client mouse driver unavailable or unable to attach | attached-click and toast-persistence cases self-skip, including on a headless runner [[tmux-play-62](#tmux-play-62)] |

Selection clearing alone proves that real mouse routing delivered the copy but not whether it ran on press or release; the press-body assertion and post-release rendered-toast case jointly pin that timing, while the binding-body, branch-execution, real-click, and persistence cases together cover toast presence, persistence, and selection gating.

### tmux-play-163

When launcher and real-session checks exercise direct pane navigation, the check shall assert this binding-and-hint matrix:

| Probe surface | Assertion |
| --- | --- |
| launcher command stream, `C-Left` | `bind-key -T root C-Left if-shell -F #{==:#{session_name},<session>} 'select-pane -L' 'send-keys C-Left'` [[tmux-play-63](#tmux-play-63)] |
| launcher command stream, `C-Right` | symmetric binding with `select-pane -R` and `send-keys C-Right` [[tmux-play-63](#tmux-play-63)] |
| launcher command stream, `S-Left` | symmetric binding with `select-pane -L` and `send-keys S-Left` [[tmux-play-63](#tmux-play-63)] |
| launcher command stream, `S-Right` | symmetric binding with `select-pane -R` and `send-keys S-Right` [[tmux-play-63](#tmux-play-63)] |
| every launcher binding | true branch switches panes only inside `<session>`; false branch forwards the original key in every other session on the server [[tmux-play-63](#tmux-play-63)] |
| `status-left` | contains `switch pane: ctrl+←/→ or shift+←/→`, `stop: esc`, `exit: ctrl+c`, `drag=select`, and `right-click=copy`; omits `d=detach`, `o=switch pane`, `[=scroll`, and `Stop: ESC` [[tmux-play-63](#tmux-play-63)], [[tmux-play-62](#tmux-play-62)] |
| under [[tmux-play-130](#tmux-play-130)]'s real-tmux acceptance harness, `list-keys -T root` for each of the four keys | body contains `if-shell`, `session_name`, the launched session name, its matching `select-pane -L` or `-R`, and its matching forwarded key [[tmux-play-63](#tmux-play-63)] |

### tmux-play-164

When launcher checks resolve and snapshot valid layout YAML or reject malformed layout YAML, the check shall assert this matrix:

| YAML input or failure surface | Assertion |
| --- | --- |
| omitted `layout` | `<workDir>/tmux-play.config.snapshot.json` carries `layout.window: { columns: 174, rows: 49 }`, `singlePlayerColumnWeights: [1, 1]`, and `multiPlayerColumnWeights: [1, 1, 1]` regardless of configured-player count, preserving both visible-column shapes for session mode [[tmux-play-64](#tmux-play-64)], [[tmux-play-34](#tmux-play-34)] |
| fully concrete canonical `singlePlayerColumnWeights` / `multiPlayerColumnWeights` | snapshot carries resolved `window.columns`, `window.rows`, and both canonical weight arrays verbatim [[tmux-play-34](#tmux-play-34)], [[tmux-play-64](#tmux-play-64)] |
| fully concrete two-element / three-element `columnWeights` alias | snapshot surfaces the alias as resolved `singlePlayerColumnWeights` / `multiPlayerColumnWeights`, respectively, while carrying the other resolved canonical values [[tmux-play-34](#tmux-play-34)], [[tmux-play-64](#tmux-play-64)] |
| partial `layout.window`, such as `columns: 200` with no `rows` | snapshot window is `{ columns: 200, rows: 49 }`: each supplied member is verbatim, each missing member is independently defaulted, and the whole window is not replaced by `{ columns: 174, rows: 49 }` [[tmux-play-64](#tmux-play-64)] |
| `window.columns` or `window.rows` not a positive integer | CLI exits nonzero with one `Error: ...` stderr line naming the offending path [[tmux-play-8](#tmux-play-8)], [[tmux-play-64](#tmux-play-64)] |
| any canonical or alias weight field not an array | same path-specific CLI rejection [[tmux-play-8](#tmux-play-8)], [[tmux-play-64](#tmux-play-64)] |
| any weight is NaN, infinite, fractional such as `0.5`, zero, negative, or a non-number | same path-specific CLI rejection, such as `layout.multiPlayerColumnWeights[2]` [[tmux-play-8](#tmux-play-8)], [[tmux-play-64](#tmux-play-64)] |
| `singlePlayerColumnWeights` length other than two, `multiPlayerColumnWeights` length other than three, or alias length other than two or three | same path-specific CLI rejection [[tmux-play-8](#tmux-play-8)], [[tmux-play-64](#tmux-play-64)] |
| alias present beside the canonical field for the same shape | same path-specific CLI rejection [[tmux-play-8](#tmux-play-8)], [[tmux-play-64](#tmux-play-64)] |
| unknown member under `layout` or `layout.window` | same path-specific CLI rejection; recognized `layout.initialVisible` remains accepted [[tmux-play-8](#tmux-play-8)], [[tmux-play-64](#tmux-play-64)], [[tmux-play-80](#tmux-play-80)] |
| any malformed-layout rejection | no runtime start, tmux session, or observable `runtime_error`, because the launcher-startup abort falls outside [[tmux-play-25](#tmux-play-25)]'s runtime-existence scope |

### tmux-play-165

When launcher and real-session checks exercise single-press `C-c` forwarding, the check shall assert this three-table flow [[tmux-play-65](#tmux-play-65)], [[tmux-play-26](#tmux-play-26)]:

| Probe case | Assertion |
| --- | --- |
| launcher command stream | one `bind-key C-c` in each of `root`, `copy-mode`, and `copy-mode-vi`, gated by `if-shell -F #{==:#{session_name},<session>}` [[tmux-play-65](#tmux-play-65)] |
| launched-session true branch in every table | `if -F -t <session>:0.0 '#{pane_in_mode}' 'send-keys -t <session>:0.0 -X cancel'` followed by `send-keys -t <session>:0.0 C-c`, exiting pane 0's copy-mode when active before forwarding one byte to the Boss/Captain pane [[tmux-play-65](#tmux-play-65)], [[tmux-play-26](#tmux-play-26)] |
| other-session false branch | stock `send-keys C-c` for `root`; stock `send-keys -X cancel` for `copy-mode` and `copy-mode-vi` [[tmux-play-65](#tmux-play-65)] |
| under [[tmux-play-130](#tmux-play-130)]'s real-tmux acceptance harness, `list-keys` in every table | body contains `if-shell`, `session_name`, the launched session name, the pane-0 `pane_in_mode`-gated cancel, and the pane-0 `C-c` forward; each body also contains its table's stock false branch [[tmux-play-65](#tmux-play-65)] |
| under [[tmux-play-130](#tmux-play-130)]'s harness, pane 0 running a raw-byte logger and attached client presses `C-c` from a player pane scrolled into copy-mode with a stopped selection | pane 0 receives `0x03` after one press [[tmux-play-65](#tmux-play-65)], [[tmux-play-26](#tmux-play-26)] |
| under [[tmux-play-130](#tmux-play-130)]'s harness, pane 0 scrolled into copy-mode while another player is active in root mode and attached client presses `C-c` | pane 0 first leaves copy-mode and receives `0x03` after one press [[tmux-play-65](#tmux-play-65)], [[tmux-play-26](#tmux-play-26)] |
| attached-client key driver unavailable or unable to attach | driven-key cases self-skip, including on a headless runner [[tmux-play-65](#tmux-play-65)] |

### tmux-play-166

_Superseded by [[tmux-play-167](#tmux-play-167)]._
_Status: retired and entirely non-normative. The paragraphs below record the original verification criteria in past tense for spec history; no clause in this item is in effect, and no `shall` text appears here. The active verification of left-click behavior in a tmux-play session is owned by [[tmux-play-168](#tmux-play-168)]._

Historical (non-normative) — what tmux-play-166 originally verified:
- Given the launcher constructing a tmux-play session whose `sessionName` was `<session>` and which carried `paneCount` panes indexed `0..paneCount-1`, the tmux command stream included exactly one `bind-key -T <table> MouseDown1Pane if-shell -F #{==:#{session_name},<session>} '<trueBranch>' '<falseBranch>'` invocation for each `<table>` in `root`, `copy-mode`, `copy-mode-vi`. With one Boss/Captain pane plus N players, `paneCount` equalled `N + 1`.
- `<trueBranch>` chained, for every pane index `i` in `0..paneCount-1`, an `if -F -t <session>:0.<i> '#{pane_in_mode}' 'send-keys -t <session>:0.<i> -X cancel'` clause separated by ` ; `, followed by the per-table tail: ` ; select-pane -t= ; send-keys -M` for the `root` table and ` ; select-pane -t=` for `copy-mode` and `copy-mode-vi`.
- `<falseBranch>` was the per-table tmux stock binding verbatim: `select-pane -t= ; send-keys -M` for `root` and `select-pane` for `copy-mode` and `copy-mode-vi`; the `send-keys -M` byte in the `root` false branch was not omitted so mouse-aware applications in unrelated sessions continued to receive forwarded clicks.
- Given a real tmux server, when `launchTmuxPlay({ attach: false })` returned, `tmux list-keys -T root MouseDown1Pane` reported a binding whose body contained `if-shell`, `session_name`, the launched session name, `pane_in_mode`, `send-keys` with `-X cancel`, `select-pane -t=`, and `send-keys -M`; and `tmux list-keys -T copy-mode MouseDown1Pane` together with `tmux list-keys -T copy-mode-vi MouseDown1Pane` each reported a binding whose body contained `if-shell`, `session_name`, the launched session name, `pane_in_mode`, `send-keys` with `-X cancel`, and `select-pane`.
- The acceptance probe ran under `*.acceptance.test.ts`, did not require adapter API keys, and self-skipped when either `tmux -V` or `glow -v` failed.

### tmux-play-167

_Superseded by [[tmux-play-168](#tmux-play-168)]._
_Status: retired and entirely non-normative. The paragraphs below record the original verification criteria in past tense for spec history; no clause in this item is in effect, and no `shall` text appears here. The active verification of left-click behavior in a tmux-play session is owned by [[tmux-play-168](#tmux-play-168)], which pins the joint contract: a click clears any active selection in every pane while preserving each pane's copy-mode state and scroll position, via `send-keys -X clear-selection` (not the retired `-X cancel`) gated per pane by `#{pane_in_mode}`._

Historical (non-normative) — what tmux-play-167 originally verified:
- Given the launcher constructing a tmux-play session whose `sessionName` was `<session>`, the tmux command stream included exactly one `bind-key -T root MouseDown1Pane 'select-pane -t= ; send-keys -M'` invocation and exactly one `bind-key -T <table> MouseDown1Pane 'select-pane'` invocation for each `<table>` in `copy-mode`, `copy-mode-vi` — the stock per-table tmux defaults verbatim — and did not include any `MouseDown1Pane` argv that referenced `if-shell`, the launched session name, `#{pane_in_mode}`, or `send-keys -X cancel`.
- The `mouse` option was still set to `on`, and the `MouseDragEnd1Pane` stop-selection and `MouseDown3Pane` system-clipboard right-click-copy bindings of [[tmux-play-162](#tmux-play-162)] were installed unchanged.
- Given a real tmux server, `tmux list-keys -T root MouseDown1Pane`, `tmux list-keys -T copy-mode MouseDown1Pane`, and `tmux list-keys -T copy-mode-vi MouseDown1Pane` each reported a binding whose body matched the corresponding stock per-table tail.
- This verification was retired because it pinned an implementation (stock bindings) that turned out to lose the click-releases-selection behavior of the prior [[tmux-play-66](#tmux-play-66)] intent. Asserting only the binding strings — not the user-observable selection / scroll behavior — was the gap that let the regression land. [[tmux-play-168](#tmux-play-168)] corrects this by combining a static binding assertion with a real-tmux behavioral probe.
- The acceptance probe ran under `*.acceptance.test.ts`, did not require adapter API keys, and self-skipped when either `tmux -V` or `glow -v` failed.

### tmux-play-168

When verifying the launcher's session-scoped primary-click handling, the check shall assert this matrix:

| Surface or case | Assertion |
| --- | --- |
| binding cardinality | exactly one `bind-key -T <table> MouseDown1Pane if-shell -F #{==:#{session_name},<session>} '<trueBranch>' '<falseBranch>'` invocation for each of `root`, `copy-mode`, and `copy-mode-vi` [[tmux-play-68](#tmux-play-68)] |
| pane iteration | with one Boss/Captain pane plus N players, `paneCount` is `N + 1`, and `<trueBranch>` chains one `pane_in_mode`-gated `send-keys -t <session>:0.<i> -X clear-selection` for every index `0..paneCount-1`, separated by ` ; ` [[tmux-play-68](#tmux-play-68)] |
| `root` true branch | append ` ; select-pane -t= ; send-keys -M` after the per-pane chain [[tmux-play-68](#tmux-play-68)] |
| `copy-mode` and `copy-mode-vi` true branches | append ` ; select-pane` after the per-pane chain [[tmux-play-68](#tmux-play-68)] |
| `root` false branch | stock `select-pane -t= ; send-keys -M` verbatim, retaining mouse forwarding for unrelated sessions [[tmux-play-68](#tmux-play-68)] |
| `copy-mode` and `copy-mode-vi` false branches | stock `select-pane` verbatim [[tmux-play-68](#tmux-play-68)] |
| every `MouseDown1Pane` argv | no `-X cancel`, which would exit copy-mode and snap a scrolled pane to its live tail [[tmux-play-68](#tmux-play-68)] |
| [[tmux-play-130](#tmux-play-130)] real-tmux harness after `launchTmuxPlay({ attach: false })` | each table's `list-keys` body contains `if-shell`, the launched session name, `pane_in_mode`, `send-keys`, `-X clear-selection`, and its stock tail, with no `-X cancel` [[tmux-play-68](#tmux-play-68)] |
| attached-client setup | pane A holds a stopped selection at nonzero scroll, pane B has no selection at nonzero scroll, pane C is outside any mode, and deterministic history may be seeded into player panes without adapter API keys |
| primary-button mouse-down inside pane C | pane A reports selection `0`, mode `1`, and its pre-click scroll; pane B reports mode `1` and its pre-click scroll; pane C reports active `1` [[tmux-play-68](#tmux-play-68)] |
| attached-client availability | run under [[tmux-play-130](#tmux-play-130)]'s real-tmux harness with an attached mouse driver, self-skipping when that driver is unavailable or cannot attach |

### tmux-play-169

Under [[tmux-play-130](#tmux-play-130)]'s real-tmux harness, when a pane starts in copy-mode at a nonzero scroll position, the check shall assert this output-follow matrix:

| Activity | Assertion |
| --- | --- |
| flushed text block, `tool_use` / `tool_result` lifecycle line, player-prompt echo, or `[status]` / `[turn aborted]` / `[runtime error]` line written to the pane | destination reports `#{pane_in_mode}` as `0` and the new content is visible [[tmux-play-69](#tmux-play-69)] |
| concurrent output written only to a sibling pane | untouched pane retains mode `1` and its prior scroll position [[tmux-play-69](#tmux-play-69)] |
| between-turn idle activity | pane retains mode `1` and its prior scroll position [[tmux-play-69](#tmux-play-69)] |
| `turn_started`, `turn_finished`, `captain_prompt`, or `captain_telemetry` | no live-tail command [[tmux-play-69](#tmux-play-69)] |
| suppressed `done` or `error`, any other event rendering no visible text, or a buffered `text_delta` before flush | no live-tail command [[tmux-play-69](#tmux-play-69)] |
| probe setup | require a genuinely nonzero pre-output scroll, use deterministic synthetic records and seeded history when useful, and require no adapter API key |

_The retired tmux-play-177 wheel-up clamp probe is removed together with its requirement tmux-play-78; the Boss/Captain phantom-scrollback behavior it tried to assert through wheel events is now owned at the source by [[tmux-play-178](#tmux-play-178)] / [[tmux-play-79](#tmux-play-79)]._

### tmux-play-170

When verifying session-scoped Escape forwarding, the check shall assert this matrix:

| Surface or case | Assertion |
| --- | --- |
| each of `root`, `copy-mode`, and `copy-mode-vi` | one `bind-key -T <table> Escape` gated on the launched session name [[tmux-play-70](#tmux-play-70)] |
| every true branch | if pane 0 is in a mode, run `send-keys -t <session>:0.0 -X cancel`, then run `send-keys -t <session>:0.0 Escape` [[tmux-play-70](#tmux-play-70)], [[tmux-play-57](#tmux-play-57)] |
| `root` false branch | stock `send-keys Escape` verbatim [[tmux-play-70](#tmux-play-70)] |
| `copy-mode` false branch | stock `send-keys -X cancel` verbatim [[tmux-play-70](#tmux-play-70)] |
| `copy-mode-vi` false branch | stock `send-keys -X clear-selection` verbatim, with no bare `send-keys -X cancel` false branch, preserving unrelated vi-mode scrollback [[tmux-play-70](#tmux-play-70)] |
| [[tmux-play-130](#tmux-play-130)] real-tmux harness after `launchTmuxPlay({ attach: false })` | each table's `list-keys` body contains the session gate, cancel-pane-0 step, forward step, and exact stock false branch [[tmux-play-70](#tmux-play-70)] |
| under [[tmux-play-130](#tmux-play-130)]'s real-tmux harness, attached client presses Escape once from a player pane scrolled into copy-mode with a stopped selection | pane 0's raw logger receives byte `0x1b` [[tmux-play-70](#tmux-play-70)] |
| under [[tmux-play-130](#tmux-play-130)]'s real-tmux harness, attached client presses Escape once while pane 0 is scrolled and a different player pane is active in root mode | pane 0 first leaves copy-mode and its raw logger receives byte `0x1b` [[tmux-play-70](#tmux-play-70)] |
| attached-client availability | run under [[tmux-play-130](#tmux-play-130)]'s real-tmux harness without adapter API keys, self-skipping when the key driver is unavailable or cannot attach |

### tmux-play-171

When visible and hidden Captain calls run within a turn, the check shall assert this visibility matrix:

| Surface or call | Assertion |
| --- | --- |
| ordinary call | full `CaptainRunResult` with `status` and `finalText`; `captain_prompt`, `captain_event`, and `captain_finished` tagged `visibility: 'visible'` [[tmux-play-16](#tmux-play-16)], [[tmux-play-33](#tmux-play-33)], [[tmux-play-72](#tmux-play-72)] |
| hidden successful call | full `CaptainRunResult` with `status` and `finalText`; the same record sequence tagged `visibility: 'hidden'` [[tmux-play-16](#tmux-play-16)], [[tmux-play-33](#tmux-play-33)], [[tmux-play-72](#tmux-play-72)] |
| hidden error call | result carries `status: 'error'` and the propagated `error`; hidden `captain_finished` carries the error status [[tmux-play-16](#tmux-play-16)], [[tmux-play-33](#tmux-play-33)], [[tmux-play-72](#tmux-play-72)] |
| hidden streamed text, tool event, `error`, or any-status finish | Boss/Captain-pane writer captures zero bytes, including no reply, status, `[error]`, or `[aborted]` line [[tmux-play-40](#tmux-play-40)] |
| equivalent visible or untagged records | bytes equal ordinary presenter output [[tmux-play-40](#tmux-play-40)] |
| hidden records while Boss/Captain pane is scrolled | retain copy-mode and prior scroll position [[tmux-play-69](#tmux-play-69)] |
| later visible call writes to that pane | return it to the live tail despite the interleaved hidden records [[tmux-play-69](#tmux-play-69)] |

### tmux-play-173

When either public session runner applies [[tmux-play-74](#tmux-play-74)]'s isolation step, the check shall assert this environment matrix:

| Inherited state or consumer | Assertion |
| --- | --- |
| `TMUX` handle present; spawned-agent environment at runtime construction | `TMUX` and `TMUX_PANE` absent; `TMUX_TMPDIR` points to a private directory other than the run's socket directory [[tmux-play-74](#tmux-play-74)] |
| same isolated process; orchestrator membership query | still reports attached to tmux so pane-width queries run [[tmux-play-74](#tmux-play-74)] |
| orchestrator tmux command | executes with the pinned pre-scrub environment carrying the original `TMUX` handle [[tmux-play-74](#tmux-play-74)] |
| no inherited `TMUX` handle; `TMUX_PANE` and `TMUX_TMPDIR` absent | no-op, leaving both absent [[tmux-play-74](#tmux-play-74)] |
| no inherited `TMUX` handle; `TMUX_PANE` or `TMUX_TMPDIR` present | no-op, preserving each inherited value exactly [[tmux-play-74](#tmux-play-74)] |

### tmux-play-174

When session mode verifies active-turn Boss-prompt suspension, the check shall assert this flow matrix:

| Input, stage, or harness | Assertion |
| --- | --- |
| TTY-like session; blocked Boss turn; streamed Captain reply | after the already-submitted `boss> <prompt>` echo, no fresh `boss> ` line appears before the matching `turn_finished` or `turn_aborted`, and exactly one ready prompt appears after settlement [[tmux-play-75](#tmux-play-75)], [[tmux-play-37](#tmux-play-37)], [[tmux-play-40](#tmux-play-40)] |
| typed type-ahead during the active turn | no fresh prompt while active; next Enter starts exactly one turn with the preserved bytes [[tmux-play-57](#tmux-play-57)], [[tmux-play-75](#tmux-play-75)] |
| bracketed multi-line paste during the active turn | no fresh prompt while active; next Enter starts exactly one turn preserving embedded newlines [[tmux-play-58](#tmux-play-58)], [[tmux-play-75](#tmux-play-75)] |
| typed and pasted session-level probes | use a real `createInterface` over a TTY-like pair so prompt chrome is observable |
| second non-empty line queued behind a blocked turn | no ready prompt between [[tmux-play-18](#tmux-play-18)]'s consecutive turns; exactly one after the last queued turn [[tmux-play-75](#tmux-play-75)] |
| empty or whitespace-only line while a turn is active or queued | no fresh ready prompt [[tmux-play-75](#tmux-play-75)] |
| queue-drain probe | prompt-paint count may use a stubbed readline |
| [[tmux-play-130](#tmux-play-130)] real-tmux harness with an attached client and active Boss turn | pane 0 shows no fresh prompt after streamed Captain output before the terminal record, excluding the submitted-input line [[tmux-play-75](#tmux-play-75)] |
| attached-client availability | under [[tmux-play-130](#tmux-play-130)]'s real-tmux harness, self-skip when its driver is unavailable or cannot attach |

### tmux-play-175

When configuration loading selects notification or fallback-home behavior, the check shall assert this matrix:

| Input | Assertion |
| --- | --- |
| `notifications: { player_finished: bell, turn_finished: desktop }` | loaded value adds `turn_aborted: off` while preserving the two supplied sinks [[tmux-play-76](#tmux-play-76)], [[tmux-play-11](#tmux-play-11)], [[tmux-play-34](#tmux-play-34)] |
| notifications omitted | loaded config and snapshot carry `off` for `player_finished`, `turn_finished`, and `turn_aborted` [[tmux-play-76](#tmux-play-76)], [[tmux-play-34](#tmux-play-34)] |
| unknown key such as `runtime_error` | rejection names the offending `notifications.<key>` path [[tmux-play-76](#tmux-play-76)] |
| sink outside `off`, `bell`, and `desktop` | rejection names the offending notification path [[tmux-play-76](#tmux-play-76)] |
| fallback-discovered old home YAML missing safe defaults | update only missing `theme: auto`, resolved layout defaults, `captain.options: {}`, and notification defaults; preserve existing values; synthesize no `model`, `instruction`, `permissions`, or effort when neither effort key exists [[tmux-play-90](#tmux-play-90)] |

### tmux-play-176

When notification delivery and session registration are exercised, the check shall assert this platform-and-sink matrix:

| Configuration, platform, or input | Assertion |
| --- | --- |
| `player_finished: bell`; macOS; `ok`, `error`, and `aborted` | one detached best-effort `afplay /System/Library/Sounds/Hero.aiff` per record; no stdout bytes or desktop command [[tmux-play-77](#tmux-play-77)], [[tmux-play-23](#tmux-play-23)] |
| `player_finished: bell`; Linux | one detached best-effort `complete` sound through the freedesktop stack [[tmux-play-77](#tmux-play-77)] |
| `player_finished: bell`; Windows | one detached best-effort Windows generic-notification sound [[tmux-play-77](#tmux-play-77)] |
| `player_finished: bell`; other platform | no command [[tmux-play-77](#tmux-play-77)] |
| `turn_finished: desktop`; macOS | exactly one detached best-effort `osascript` notification titled lowercase `spex`, exactly one stdout BEL, and no `afplay` [[tmux-play-77](#tmux-play-77)] |
| `player_finished: desktop` or `turn_aborted: desktop`; macOS | exactly one detached best-effort `osascript` notification titled lowercase `spex`, with no stdout BEL or terminal notification escape [[tmux-play-77](#tmux-play-77)] |
| `turn_finished: desktop`; Linux | exactly one detached best-effort `notify-send` notification titled lowercase `spex`, with no stdout BEL or terminal notification escape [[tmux-play-77](#tmux-play-77)] |
| `turn_finished: desktop`; other platform | no command and no stdout BEL [[tmux-play-77](#tmux-play-77)] |
| [[tmux-play-130](#tmux-play-130)] real-tmux harness; pane 0 on macOS; attached client; `turn_finished: desktop` | finished Boss turn raises `alert-bell` from pane 0's raw BEL [[tmux-play-77](#tmux-play-77)] |
| `turn_aborted: bell`; reason `ESC`, `SIGHUP`, `SIGINT`, `SIGTERM`, `EOF`, or `runtime disposed` | no sound command [[tmux-play-77](#tmux-play-77)] |
| `turn_aborted: bell`; other reason | notify through the configured sink [[tmux-play-77](#tmux-play-77)] |
| sink throws, spawn fails, or `runtime_error` arrives | `NotificationObserver.onRecord` does not throw [[tmux-play-77](#tmux-play-77)] |
| session startup | register the notification observer with presenter, follow, and timing before opt-in observers [[tmux-play-23](#tmux-play-23)], [[tmux-play-77](#tmux-play-77)] |

### tmux-play-178

Under [[tmux-play-130](#tmux-play-130)]'s real-tmux harness, when the Boss edits a real session readline at the top of a mostly empty Boss/Captain pane, the check shall assert this history matrix:

| Action or setup | Assertion |
| --- | --- |
| type `abc`, then backspace it away without submission | `history_size` does not increase; scrollback contains none of `boss> abc`, `boss> ab`, or `boss> a` [[tmux-play-79](#tmux-play-79)] |
| wheel-up or `scroll-up` after those edits | no prompt row appears above the pane's first line [[tmux-play-79](#tmux-play-79)] |
| probe setup | local no-op Captain, no adapter API key, and no respawn of pane 0 because the real readline process is the subject |

### tmux-play-179

When configuration loading resolves column weights, the check shall assert this source-and-validation matrix:

| Input | Assertion |
| --- | --- |
| positive-integer `singlePlayerColumnWeights` length 2 | retain that array verbatim for the single-player shape [[tmux-play-64](#tmux-play-64)] |
| positive-integer `multiPlayerColumnWeights` length 3 | retain that array verbatim for the multi-player shape [[tmux-play-64](#tmux-play-64)] |
| only two-element `columnWeights` | use it for the single-player shape and `[1, 1, 1]` for the multi-player shape [[tmux-play-64](#tmux-play-64)] |
| only three-element `columnWeights` | use it for the multi-player shape and `[1, 1]` for the single-player shape [[tmux-play-64](#tmux-play-64)] |
| neither canonical field nor its matching alias | use `[1, 1]` for the single-player shape or `[1, 1, 1]` for the multi-player shape [[tmux-play-64](#tmux-play-64)] |
| alias and canonical field target the same shape | reject with an error naming both conflicting `layout` paths [[tmux-play-8](#tmux-play-8)], [[tmux-play-64](#tmux-play-64)] |
| alias and canonical field target different shapes | accept and resolve each shape from its own source [[tmux-play-64](#tmux-play-64)] |
| alias length other than 2 or 3, wrong canonical length, or any non-positive-integer weight | reject with an error naming the offending path [[tmux-play-8](#tmux-play-8)], [[tmux-play-64](#tmux-play-64)] |
| source precedence for either shape | canonical field, then matching alias, then default [[tmux-play-64](#tmux-play-64)] |

### tmux-play-180

When configuration loading resolves `layout.initialVisible`, the check shall assert this roster matrix:

| Input | Assertion |
| --- | --- |
| non-empty duplicate-free configured-player subset | preserve its order in the resolved set and [[tmux-play-34](#tmux-play-34)] snapshot [[tmux-play-80](#tmux-play-80)] |
| field omitted | resolve every configured player in `players` order [[tmux-play-80](#tmux-play-80)] |
| empty roster; field omitted or explicit `[]` | resolve and snapshot `[]` with active weights `[1]` [[tmux-play-80](#tmux-play-80)], [[tmux-play-64](#tmux-play-64)] |
| non-empty roster with explicit `[]` | reject with an error naming the path [[tmux-play-8](#tmux-play-8)], [[tmux-play-80](#tmux-play-80)] |
| duplicate or ID absent from `players` | reject with an error naming the offending path [[tmux-play-8](#tmux-play-8)], [[tmux-play-80](#tmux-play-80)] |
| one selected player from a multi-player roster | two-column single-player shape using `singlePlayerColumnWeights` [[tmux-play-28](#tmux-play-28)], [[tmux-play-64](#tmux-play-64)] |
| two or more selected players | three-column multi-player shape using `multiPlayerColumnWeights` [[tmux-play-28](#tmux-play-28)], [[tmux-play-64](#tmux-play-64)] |

### tmux-play-181

When the launcher authors or migrates layout weights, the check shall assert this file matrix:

| Source state | Assertion |
| --- | --- |
| neither discovery location has a config and no `--config` | default home YAML carries `layout.window: { columns: 174, rows: 49 }`, `multiPlayerColumnWeights: [1, 1, 1]`, and no `layout.columnWeights` [[tmux-play-10](#tmux-play-10)], [[tmux-play-11](#tmux-play-11)], [[tmux-play-64](#tmux-play-64)] |
| fallback home has a two-element legacy alias | rewritten home YAML carries that array as `singlePlayerColumnWeights` and no alias [[tmux-play-90](#tmux-play-90)] |
| fallback home has a three-element legacy alias | rewritten home YAML carries that array as `multiPlayerColumnWeights` and no alias [[tmux-play-90](#tmux-play-90)] |
| either successful alias migration | write one final form, with no intermediate on-disk state containing both the alias and matching canonical field [[tmux-play-90](#tmux-play-90)] |
| fallback home already has alias plus matching canonical field | do not rewrite; reject with an error naming the conflicting paths [[tmux-play-64](#tmux-play-64)], [[tmux-play-90](#tmux-play-90)] |
| explicit `--config` file with legacy alias | leave bytes unchanged and accept through the alias [[tmux-play-64](#tmux-play-64)], [[tmux-play-90](#tmux-play-90)] |
| cwd project config with legacy alias | leave bytes unchanged and accept through the alias [[tmux-play-64](#tmux-play-64)], [[tmux-play-90](#tmux-play-90)] |

### tmux-play-182

When the launcher builds startup panes from the resolved visible set, the check shall assert this topology matrix:

| Configuration or surface | Assertion |
| --- | --- |
| three configured players and ordered two-player subset `[b, a]` under [[tmux-play-130](#tmux-play-130)]'s real-tmux harness | Boss/Captain plus exactly two player panes in order `b`, `a`, each tailing its own log; third player has no pane [[tmux-play-80](#tmux-play-80)], [[tmux-play-28](#tmux-play-28)], [[tmux-play-64](#tmux-play-64)] |
| `layout.initialVisible` omitted | one player pane per configured player in `players` order [[tmux-play-27](#tmux-play-27)], [[tmux-play-80](#tmux-play-80)] |
| one visible player | two-column single-player shape using resolved weights [[tmux-play-28](#tmux-play-28)], [[tmux-play-64](#tmux-play-64)] |
| two or more visible players | three-column multi-player shape using resolved weights [[tmux-play-28](#tmux-play-28)], [[tmux-play-64](#tmux-play-64)] |
| empty roster; field omitted or explicit `[]` | only the full-width Boss/Captain pane; no split or player log-tail process [[tmux-play-27](#tmux-play-27)], [[tmux-play-80](#tmux-play-80)] |
| empty-roster title and timer | exact Captain title; initialized frozen-zero Captain timer [[tmux-play-36](#tmux-play-36)], [[tmux-play-48](#tmux-play-48)], [[tmux-play-53](#tmux-play-53)], [[tmux-play-54](#tmux-play-54)], [[tmux-play-195](#tmux-play-195)] |
| empty-roster input setup | session mouse enabled and every primary-button, drag, right-click, navigation, `C-c`, and Escape binding installed without a missing-player target [[tmux-play-62](#tmux-play-62)], [[tmux-play-63](#tmux-play-63)], [[tmux-play-65](#tmux-play-65)], [[tmux-play-68](#tmux-play-68)], [[tmux-play-70](#tmux-play-70)] |
| empty-roster resize setup | every resize hook installs with no missing-player target [[tmux-play-44](#tmux-play-44)] |
| empty-roster real window resized under [[tmux-play-130](#tmux-play-130)]'s real-tmux harness | sole pane remains full-width [[tmux-play-44](#tmux-play-44)] |

### tmux-play-183

Given a headless runtime constructed through [[tmux-play-29](#tmux-play-29)] and Captain visibility calls, the check shall assert this contract-and-record matrix:

| Call or state | Assertion |
| --- | --- |
| `CaptainContext.setVisiblePlayers` with a non-empty duplicate-free configured subset | resolve and emit exactly one ordered `player_view_changed` [[tmux-play-16](#tmux-play-16)], [[tmux-play-81](#tmux-play-81)], [[tmux-play-82](#tmux-play-82)] |
| `CaptainContext` call | record carries the active numeric `turnId` [[tmux-play-16](#tmux-play-16)], [[tmux-play-21](#tmux-play-21)] |
| `CaptainSession` call during a turn | record carries the active numeric `turnId` [[tmux-play-17](#tmux-play-17)], [[tmux-play-21](#tmux-play-21)] |
| `CaptainSession` call between turns | record carries `turnId: null` [[tmux-play-17](#tmux-play-17)], [[tmux-play-21](#tmux-play-21)] |
| empty roster; empty call through either scope | resolve, expose an empty `players` manifest, and emit the corresponding null-turn or active-turn record before ordinary Captain call and terminal records continue [[tmux-play-16](#tmux-play-16)], [[tmux-play-17](#tmux-play-17)], [[tmux-play-21](#tmux-play-21)], [[tmux-play-81](#tmux-play-81)], [[tmux-play-82](#tmux-play-82)] |
| non-empty roster with empty input, or any duplicate or unknown ID | reject; emit no view-change record; retain the tracked set; permit a Captain catching the rejection to continue [[tmux-play-81](#tmux-play-81)] |
| accepted call | preserve the configured roster, every field of the `players` manifest exposed to the Captain, and every player's `Cligent` continuity [[tmux-play-16](#tmux-play-16)], [[tmux-play-81](#tmux-play-81)] |

### tmux-play-184

Given the presenter, follow, timing, and notification observers registered in session mode, when a `player_view_changed` record is dispatched, verification shall assert this matrix for both `turnId: number` and `turnId: null` [[tmux-play-98](#tmux-play-98)]:

| Observer | Assertion |
| --- | --- |
| presenter | write no bytes to the Boss/Captain-pane writer |
| follow | issue no copy-mode-exit or live-tail command |
| timing | change no pane or status timer option |
| notification | emit no sound, desktop notification, or terminal BEL |

### tmux-play-185

When the layout observer reconciles a `player_view_changed` record, the check shall assert this matrix:

| State or transition | Assertion |
| --- | --- |
| Boss/Captain pane plus player panes for an initial visible set under [[tmux-play-130](#tmux-play-130)]'s real-tmux acceptance harness; `visiblePlayerIds` differs from the tracked set | kill every main-window pane except the Boss/Captain pane; recreate one read-only pane per requested player in order, each running `tail -n 200 -f <player>.log`; reapply pane titles, timer options, read-only input, mouse-selection bindings, layout hooks, and Boss-pane focus [[tmux-play-44](#tmux-play-44)], [[tmux-play-83](#tmux-play-83)], [[tmux-play-84](#tmux-play-84)] |
| `visiblePlayerIds` equals the tracked set in the same order | issue no tmux command [[tmux-play-83](#tmux-play-83)] |
| empty roster whose tracked set starts empty; accepted empty record | issue no tmux command and leave the sole Boss/Captain pane intact [[tmux-play-83](#tmux-play-83)] |
| previously hidden player appears in a later `visiblePlayerIds` | recreated pane displays the recent tail of its `<player>.log`, whose durable backlog lives in the log rather than tmux scrollback [[tmux-play-84](#tmux-play-84)] |
| tmux command fails mid-rebuild | do not throw into record dispatch or abort the Boss turn; do not advance the tracked set for the incomplete reconciliation [[tmux-play-83](#tmux-play-83)] |
| awaited `setVisiblePlayers(next)` followed by `callPlayer()` for a newly visible player | complete the successful pane rebuild before presenting that player's `player_prompt` or `player_event` [[tmux-play-83](#tmux-play-83)] |

### tmux-play-186

When runtime disposal is exercised, the check shall assert this cleanup matrix:

| Disposal path | Assertion |
| --- | --- |
| repeated or concurrent ordinary disposal | unwind the active turn; run an implemented `Captain.prepareDispose()` exactly once while `CaptainSession.signal` remains live; deliver its accepted status and telemetry emissions to observers in original order before aborting the signal; run `Captain.dispose()` exactly once afterward; reject later session emissions [[tmux-play-17](#tmux-play-17)], [[tmux-play-85](#tmux-play-85)] |
| pre-close, its emission observer dispatch, initialization, or final disposal rejects | still abort the session signal, drain every accepted emission in original order, invoke the remaining cleanup hook once, and detach observers; preserve the originating failure followed by every independent cleanup failure, without changing legacy handling of an earlier dispatcher failure already surfaced by its originating runtime call [[tmux-play-17](#tmux-play-17)], [[tmux-play-85](#tmux-play-85)] |

### tmux-play-187

Where a home, cwd, or explicit YAML config contains direct legacy `reasoningEffort` keys without same-object `effort` keys and the complete config validates, when migration runs, the check shall assert this update matrix:

| Source state or update outcome | Assertion |
| --- | --- |
| source remains unchanged | expose the legacy values as in-memory `effort`; replace only the parsed key tokens on disk; invoke the optional callback once with the config, accepted field paths, and successful outcome [[tmux-play-86](#tmux-play-86)] |
| deterministic seam changes the source | retain the same in-memory values; preserve the newer source; report a skipped outcome; emit one actionable stderr warning naming the file and fields and instructing the user to rename them manually [[tmux-play-86](#tmux-play-86)] |
| update fails | retain the same in-memory values; preserve the unwritable source; report a skipped outcome; emit the same actionable warning [[tmux-play-86](#tmux-play-86)] |

### tmux-play-188

When legacy-effort-like configuration input is loaded, the check shall assert this rejection-and-preservation matrix:

| Input | Assertion |
| --- | --- |
| one Captain or player contains both effort key names | reject without invoking the deprecation callback or modifying the source [[tmux-play-87](#tmux-play-87)] |
| legacy value is invalid for its adapter | reject without invoking the deprecation callback or modifying the source [[tmux-play-87](#tmux-play-87)] |
| text named `reasoningEffort` outside a direct Captain or player key | retain it as ordinary content without rewriting it or invoking the callback [[tmux-play-87](#tmux-play-87)] |

### tmux-play-190

Where a TypeScript consumer uses the public tmux-play declarations, the captain and player config types shall accept each adapter's own effort vocabulary and reject another adapter's provider-native value while retaining all non-effort runtime fields [[tmux-play-29](#tmux-play-29)], [[tmux-play-95](#tmux-play-95)].

### tmux-play-191

Where a Captain's runtime-owned `Cligent` stores an automatic resume token, when `callCaptain` receives session and tool controls, the check shall assert this matrix:

| Controls | Assertion |
| --- | --- |
| `{ resume: false, allowedTools: [] }` | adapter receives no resume token and an explicit empty allowlist; call retains its normal records, result, and resolved visibility [[tmux-play-16](#tmux-play-16)], [[tmux-play-72](#tmux-play-72)], [[tmux-play-88](#tmux-play-88)] |
| session and tool fields omitted | adapter receives the stored automatic resume token and no per-call allowlist override [[tmux-play-16](#tmux-play-16)], [[tmux-play-88](#tmux-play-88)] |
| readonly non-empty allowlist | `Cligent.run()` receives an equal mutable copy, preventing mutation of caller-owned option data at the adapter boundary [[tmux-play-16](#tmux-play-16)], [[tmux-play-88](#tmux-play-88)] |

### tmux-play-192

Under [[tmux-play-150](#tmux-play-150)]'s real-`glow` acceptance harness, when launcher-mode runtime readiness and its repair commands are exercised, the check shall assert this matrix:

| Runtime or installation state | Assertion |
| --- | --- |
| one unmet adapter used by one or more roles | issue no tmux command; fail the invocation; name the adapter once, every role using it, the commands that install its requirements, and the config path to edit [[tmux-play-89](#tmux-play-89)] |
| several unmet adapters | name every adapter rather than stopping at the first [[tmux-play-89](#tmux-play-89)] |
| every configured adapter runtime installed | proceed to session construction [[tmux-play-89](#tmux-play-89)], [[tmux-play-2](#tmux-play-2)] |
| every peer-SDK command | name the resolved tree with `--prefix` and pin install scope on the command line; accept no bare form because the launching process cannot witness the environment or working directory of the shell where the command is pasted [[tmux-play-89](#tmux-play-89)] |
| optional peer SDK in a global installation | command carries `-g`, names the resolved tree with `--prefix`, and asserts global scope on the command line [[tmux-play-89](#tmux-play-89)] |
| optional peer SDK in a project installation | command names the resolved tree with `--prefix` and carries explicit non-global `global` and `location` settings, preventing an environment-supplied global mode from diverting it to `<prefix>/lib/node_modules` [[tmux-play-89](#tmux-play-89)] |
| external CLI in either installation | command carries `-g` and is never pinned to cligent's tree [[tmux-play-89](#tmux-play-89)] |
| reported installation tree | use the `node_modules` root the adapters resolve from; leave a layout the canned command cannot repair diagnosable [[tmux-play-89](#tmux-play-89)] |
| `--prefix` path that a shell would split | print it quoted while retaining the reported tree as its target [[tmux-play-89](#tmux-play-89)] |
| project install invoked from another working directory | classify it by the manifest at its install root rather than the working directory [[tmux-play-89](#tmux-play-89)] |
| resolved tree unreachable by any `npm install` invocation | print no peer-SDK install command; name the package and the tree where it must be placed [[tmux-play-89](#tmux-play-89)] |

### tmux-play-193

Under [[tmux-play-150](#tmux-play-150)]'s real-`glow` acceptance harness, where the home and cwd are empty, when runtime-driven configuration generation is exercised, the check shall assert this matrix:

| Installed supported runtimes | Assertion |
| --- | --- |
| exactly one | created YAML wires the Captain and one player to that adapter, carries `model` and `effort` only where this project pins them for that adapter, and prints a stdout notice naming the adapter [[tmux-play-10](#tmux-play-10)], [[tmux-play-11](#tmux-play-11)] |
| more than two | generated roster uses the first two in canonical adapter order [[tmux-play-11](#tmux-play-11)] |
| none | create no file; fail with every supported adapter and the commands that install its requirements [[tmux-play-10](#tmux-play-10)], [[tmux-play-11](#tmux-play-11)] |

### tmux-play-196

Under [[tmux-play-150](#tmux-play-150)]'s real-`glow` acceptance harness, when complete detached call settings are exercised, the check shall assert this matrix:

| Input or state | Assertion |
| --- | --- |
| dot-delimited player IDs and concrete or provider-default selections | accept the IDs; apply detached settings without merging omitted instruction or permissions; use every enforceable provider default by omission; resolve explicit, forced-fresh, or automatic session selection once at admission for both reset preflight and the provider run [[tmux-play-7](#tmux-play-7)], [[tmux-play-41](#tmux-play-41)], [[tmux-play-93](#tmux-play-93)], [[tmux-play-94](#tmux-play-94)] |
| accessor, unknown or incomplete value, adapter-invalid effort, unmappable Gemini alias or OpenCode variant, adapter-rejected permission policy, resumed Claude or OpenCode provider-default model, or unenforceable resumed-Kimi provider-default reset | fail before the prompt record and provider run while preserving the stored resume token [[tmux-play-93](#tmux-play-93)] |
| supplied-settings rejection | expose an `AgentCallSettingsError` recognized by `isAgentCallSettingsError()`, preserving the prior message and original cause [[tmux-play-93](#tmux-play-93)] |
| turn- or session-scope error, unknown-player error, provider execution failure, or observer dispatch error | `isAgentCallSettingsError()` returns false [[tmux-play-93](#tmux-play-93)] |
| resumed OpenCode call with a concrete model and omitted permissions after an earlier call installed session rules | clear the prior Cligent-owned permission ruleset before dispatching the prompt [[tmux-play-93](#tmux-play-93)] |
| resumed OpenCode call with a concrete model and provider-default effort after an earlier variant | clear the prior variant without rejecting [[tmux-play-93](#tmux-play-93)] |

### tmux-play-203

Where TypeScript and runtime consumers import the public tmux-play subpath, when package output is verified, the check shall assert this export matrix:

| Surface | Exports |
| --- | --- |
| declarations | `TuningSelection`, `AgentCallSettings`, `AgentCallSettingsError`, `isAgentCallSettingsError`, `LaunchManagedTmuxPlayOptions`, `LaunchTmuxPlayResult`, `ManagedTmuxPlayAttachOptions`, `ManagedTmuxPlayLaunchContext`, `PreparedManagedTmuxPlayLaunch`, `ManagedTmuxPlayInitializeContext`, `ManagedTmuxPlayTurnContext`, `ManagedTmuxPlayAfterTurnContext`, `ManagedTmuxPlayTerminalRecord`, `ManagedTmuxPlayShutdownContext`, `ManagedTmuxPlayLifecycle`, `ManagedTmuxPlaySessionOptions`, and `TmuxPlayRuntimeHandle` [[tmux-play-29](#tmux-play-29)] |
| runtime | `AgentCallSettingsError`, `isAgentCallSettingsError`, `launchManagedTmuxPlay`, and `runManagedTmuxPlaySession` [[tmux-play-29](#tmux-play-29)] |

### tmux-play-197

Under [[tmux-play-150](#tmux-play-150)]'s real-`glow` acceptance harness, when an embedding front end exercises the managed tmux-play state machine, the test suite shall assert this matrix:

| State or transition | Assertion |
| --- | --- |
| prepared launch | initialized readiness precedes return; caller reporting can precede input activation and attach; launcher-to-child gate and shutdown markers are atomic complete create-once publications; stable original Boss pane id rather than a positional target guards bounded readiness; pre-child failure removes only launcher-owned work state; activation is acknowledged before coordination cleanup; configured layout reaches attach behavior; cancellation, initialization error, or attachment failure requests graceful shutdown, awaits post-cleanup acknowledgement and pane exit under a shutdown bound independent of readiness, and uses forced tmux teardown only as a bounded fallback [[tmux-play-94](#tmux-play-94)] |
| forced fallback | tolerate pane disappearance within its fixed 500 ms verification window; retain owned state when disappearance cannot be proved [[tmux-play-94](#tmux-play-94)] |
| empty session id or one containing a dot, colon, whitespace, or another character outside `^[A-Za-z0-9][A-Za-z0-9_-]*$` | managed launch rejects before work-directory creation, session-command factory invocation, or tmux command; direct runner rejects before lifecycle or presentation work [[tmux-play-94](#tmux-play-94)] |
| accepted public session id | factory receives it unchanged and tmux name is exactly `tmux-play-<sessionId>` [[tmux-play-94](#tmux-play-94)] |
| caller-supplied work directory with unrelated sentinel | retain directory and sentinel after ordinary, cancelled, and failed shutdown; factory receives `workDirOwnedByLauncher: false`; create no launcher-ownership marker [[tmux-play-94](#tmux-play-94)] |
| launcher-created work directory | factory receives `workDirOwnedByLauncher: true`; child removes it only when that unchanged input is true and the marker exactly matches the child's session id; false ownership, missing marker, or mismatched marker retains it [[tmux-play-94](#tmux-play-94)] |
| auto-theme prepared for native attachment receives a light OSC 11 reply | snapshot and tmux appearance use Latte before `attach()` [[tmux-play-194](#tmux-play-194)] |
| public launch has `attach: false` and no concrete theme override | perform no probe and use the fallback [[tmux-play-194](#tmux-play-194)] |
| managed input, including bracketed multiline paste, arrives before activation | queue the same semantic prompt without early runtime work [[tmux-play-94](#tmux-play-94)] |
| shutdown during either turn hook, SIGHUP, or embedding request | abort and await the whole hook/runtime/settlement transaction plus runtime disposal before one lifecycle release; publish shutdown acknowledgement only after ordered cleanup; publish no readiness or activation after shutdown starts; expose no buffered reply before a successful finished-turn settlement; release a successful finished settlement's replies even while shutdown awaits the transaction [[tmux-play-94](#tmux-play-94)] |
| SIGHUP and embedding shutdown request during active work | terminal and lifecycle shutdown hook receive exact reasons `SIGHUP` and `embedding shutdown request`, respectively [[tmux-play-94](#tmux-play-94)] |
| direct managed runner | apply [[tmux-play-74](#tmux-play-74)] isolation before its initialization hook even when no CLI dispatcher invoked it [[tmux-play-94](#tmux-play-94)] |
| runtime emits an aborted terminal after a buffered reply and then resolves or rejects | after hook receives that exact terminal before settlement or propagated failure; reply remains hidden [[tmux-play-94](#tmux-play-94)] |
| initialization or any hook fails | returned session promise rejects only after awaited cleanup and releases no reply [[tmux-play-94](#tmux-play-94)] |
| attachment signal already aborted, aborts during activation, or aborts during detached coordination cleanup | exact reason remains primary; neither `beforeNativeAttach` nor native client runs; graceful child shutdown acknowledgement and pane exit precede rejection; cleanup defects follow the reason in one aggregate [[tmux-play-94](#tmux-play-94)] |
| native attachment proceeds | resize completes first; callback runs exactly once immediately before native client; abort after callback triggers no managed cancellation [[tmux-play-94](#tmux-play-94)] |
| managed turn or runtime failure plus lifecycle-shutdown cleanup failure | run every ordered cleanup step; expose the primary failure followed by every distinct cleanup failure in one aggregate; preserve single-failure identity [[tmux-play-94](#tmux-play-94)] |

### tmux-play-198

Under [[tmux-play-130](#tmux-play-130)]'s real-tmux acceptance harness, with a Boss/Captain pane and deliberately unequal player-pane widths, when logical identity and server title round-trip are exercised, the check shall assert this ordered flow:

| Stage or server state | Assertion |
| --- | --- |
| session creation | every pane carries its logical key in pane-scoped tmux state alongside a unique stable pane id; capture the key-to-pane-id mapping [[tmux-play-96](#tmux-play-96)] |
| layout observer rebuilds the player area | every recreated pane carries its key the same way; capture the mapping again [[tmux-play-96](#tmux-play-96)] |
| displayed titles replaced with unrelated text and panes reordered through id-preserving swaps | per-pane timer update sets its option on the captured pane id for the intended logical key [[tmux-play-54](#tmux-play-54)], copy-mode live-follow returns the captured scrolled pane to its live tail [[tmux-play-69](#tmux-play-69)], and prose in the narrower pane produces no visible row wider than that pane even where the wider pane would allow it; routing by displayed title, pane position, or config order fails against captured ids regardless of host locale [[tmux-play-96](#tmux-play-96)] |
| server under a non-UTF-8 locale such as `LC_ALL=C`; composed title fails to round-trip | print the one-line warning exactly once and continue launching [[tmux-play-189](#tmux-play-189)] |
| UTF-8 server; composed title round-trips | operations behave identically and no warning is printed [[tmux-play-189](#tmux-play-189)] |

### tmux-play-201

Where the packed tarball alone is installed into an out-of-band global-style prefix holding no agent SDK peer and the search path reaches no agent CLI, when the installed executable's printed repair path is exercised against an isolated configuration home, the check shall assert this ordered flow:

| Stage | Assertion |
| --- | --- |
| documented launcher command before repair | fail; name the install command for every supported adapter; create no config file; issue no tmux command [[tmux-play-10](#tmux-play-10)], [[tmux-play-11](#tmux-play-11)], [[tmux-play-89](#tmux-play-89)] |
| prefix supplied out of band | fail any repair command npm would not resolve back to that prefix rather than passing through harness knowledge [[tmux-play-89](#tmux-play-89)] |
| Codex repair | execute the command printed by the failure verbatim as argv, adding no scope or target argument the user was not shown [[tmux-play-89](#tmux-play-89)] |
| repaired installation | Codex SDK lands in the same reported `node_modules` root; launcher command succeeds; created config names `codex` as its only adapter; stdout notice names the adapter used for the roster; tmux session is created [[tmux-play-10](#tmux-play-10)], [[tmux-play-11](#tmux-play-11)], [[tmux-play-89](#tmux-play-89)] |
| test composes an install command instead of running the printed one | verification fails because that substitution could let a command scoped to the wrong tree pass [[tmux-play-89](#tmux-play-89)] |

## References

[1]: https://catppuccin.com/palette/ "Catppuccin Palette"
[2]: https://github.com/charmbracelet/glow "glow — Render Markdown on the CLI"
[3]: https://github.com/tmux/tmux/blob/3.3/CHANGES "tmux 3.3 changes"
