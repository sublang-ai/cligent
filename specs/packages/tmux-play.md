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

### tmux-play-2

When `tmux-play` is invoked without `--session`, the CLI shall run launcher mode: resolve the config, verify the configured adapters' runtimes per [[tmux-play-89](#tmux-play-89)], construct the tmux session, attach, and exit.

### tmux-play-3

When `tmux-play` is invoked with `--session <id> --work-dir <path>`, the CLI shall run session mode: instantiate the Captain and players, run a Boss readline against stdin/stdout, dispatch records to observers, and clean up on exit.

### tmux-play-4

When `--config <path>` is supplied, the launcher shall load that file and skip discovery and first-run auto-create.

### tmux-play-61

When `--theme-diagnostics` is supplied, the CLI shall select the diagnostic flow through this matrix and, for every accepted flow, exit without checking for `tmux` or `glow`, creating a tmux session, or attaching:

| Invocation and config state | Outcome |
| --- | --- |
| launcher mode with a discoverable or explicit config | load that config, resolve the Catppuccin flavor per [[tmux-play-47](#tmux-play-47)], and print `selected: <flavor>` plus `reason: <explicit\|yaml\|osc11\|fallback>` to stdout, including the raw OSC 11 reply when received |
| launcher mode, discovery per [[tmux-play-9](#tmux-play-9)] finds no config, and `--config` is absent | create no config, skip [[tmux-play-10](#tmux-play-10)]'s first-run creation, resolve the flavor as for `theme: auto`, and print `selected: <flavor>` plus `reason: <explicit\|yaml\|osc11\|fallback>` to stdout, including the raw OSC 11 reply when received, without requiring an installed adapter runtime |
| combined with `--session` | reject before dispatching session mode |

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
| `'mocha'`, `'latte'`, or `'auto'` | accept the value and select the Catppuccin flavor per [[tmux-play-47](#tmux-play-47)] |
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

Where neither discovery location holds a config and `--config` is absent, the launcher shall select the first-run outcome through this matrix:

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

When the dispatcher publishes a record, it shall apply this observer-delivery contract:

| Delivery property | Outcome |
| --- | --- |
| observer order | invoke in registration order |
| asynchronous observer | await its returned Promise before dispatching the record to the next observer |
| record sequencing | await the current record's observer-dispatch operation before beginning dispatch of the next record |
| record cardinality | drop and coalesce no record |

### tmux-play-24

When the dispatcher publishes runtime emissions, it shall apply this matrix:

| Emission or observer state | Outcome |
| --- | --- |
| turn-bound emission | drain before `turn_finished` / `turn_aborted` |
| `turnId: null` emission | dispatch in emission order without a turn boundary |
| multiple observers registered | deliver every record to each observer |

### tmux-play-25

When a control-plane failure prevents normal record emission, the runtime shall apply this matrix:

| Failure or state | Outcome |
| --- | --- |
| startup, `Captain.init`, `handleBossTurn`, or observer dispatch | emit `runtime_error` |
| active turn exists at failure | carry its numeric `turnId` |
| no active turn at failure | carry `turnId: null` |
| after error emission | abort any active turn and run [[tmux-play-19](#tmux-play-19)] shutdown |
| observer caused failure | deliver `runtime_error` additionally to remaining observers in registration order before shutdown |
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
| `turn_aborted` with `off`, or reason `ESC`, `SIGINT`, `SIGTERM`, `EOF`, or `runtime disposed` | send no notification |
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

### Built-in Fanout Captain

### tmux-play-30

The `@sublang/cligent/captains/fanout` Captain shall, per Boss turn, invoke `callPlayer` for every configured player concurrently, then issue a single `callCaptain` summary referencing each player's status and final text.

### tmux-play-31

The fanout Captain shall not copy raw player events into the Boss/Captain pane; only the synthesized summary shall reach the Boss via `callCaptain`.

### Public Contract Shapes

### tmux-play-32

A `BossTurn` argument shall expose the turn's numeric `id`, the Boss `prompt`, and a `timestamp`.
A `PlayerHandle` shall expose the player `id`, the `adapter`, and an optional `model`.

### tmux-play-33

`PlayerRunResult` shall expose `playerId`, `turnId`, and `status`, and may include `resumeToken`, `finalText`, and `error`.
`CaptainRunResult` shall expose `turnId` and `status`, and may include `resumeToken`, `finalText`, and `error`.
`status` values are `'ok' | 'aborted' | 'error'`; aborted results may carry neither `finalText` nor `error`.
When an aborted player call's terminal `done` carries a `resumeToken`, `PlayerRunResult.resumeToken` shall expose it; when the terminal `done` omits `resumeToken`, `PlayerRunResult` shall omit it so captains can detect interrupted, not-resumable calls.
When a `callCaptain` call's terminal `done` carries a `resumeToken`, `CaptainRunResult.resumeToken` shall expose that token; when the terminal `done` omits it, `CaptainRunResult` shall omit it — the same pass-through as `PlayerRunResult`, so captains can capture a call's backend session (e.g., for a later `CallCaptainOptions.resume` per [[tmux-play-88](#tmux-play-88)]).

### tmux-play-59

Where a player or Captain call emits one or more complete `text` events after earlier captured `text` or `text_delta` content and before a terminal `done` whose `result` is absent, the programmatic runtime shall preserve each later complete message on its own line in `finalText`, inserting one newline before it only where the preceding captured content does not already end with one.

### Launcher → Session Protocol

### tmux-play-34

The launcher shall convert the resolved YAML config into a JSON snapshot written to the session's work directory, with local `captain.from` paths normalized to absolute `file://` URLs and package specifiers passed through unchanged.
Session mode shall read the snapshot rather than reloading the YAML, so config changes made between launch and session start shall not affect the running session.

### tmux-play-74

Session mode is the orchestrator: it runs inside the Boss/Captain pane (pane 0) of the launched tmux session per [[tmux-play-27](#tmux-play-27)], so its process environment carries that session's live tmux client handles (`TMUX`, `TMUX_PANE`), and player adapters spawn their agent CLIs from that same environment.
Before constructing the session, both the stock and managed public session runners shall isolate spawned player agents from the run's tmux server: they shall remove `TMUX` and `TMUX_PANE` from the environment player agents inherit and redirect their `TMUX_TMPDIR` to a private directory, so any `tmux` an agent runs — including `kill-server` — resolves to its own isolated server and can neither reach nor terminate the session hosting the run.
Without this isolation, a player tasked with debugging tmux can take down its own run, surfacing to the Boss as `[server exited]` / `tmux attach-session failed`.
The orchestrator's own tmux interactions — pane-width and pane-target queries, status-bar and per-pane timer updates, and session teardown — shall continue to target the run's session, by running with a snapshot of the real tmux environment captured before the scrub.
The pane-width query gate that skips work when not attached to tmux shall consult that snapshot rather than the scrubbed `TMUX`.
When session mode is not running inside tmux (no inherited `TMUX`, e.g. tests), the isolation step shall be a no-op.

### External Dependencies

### tmux-play-51

When `tmux-play` is invoked in launcher mode (per [[tmux-play-2](#tmux-play-2)]), the launcher shall verify that the `glow` binary [[2]] is available on `PATH` before loading any config, and when it is not, shall fail with an error message that names `glow` and points to its installation page.
The presenter's pane output pipeline delegates Markdown wrapping and styling to `glow`; running without it would silently degrade word-boundary wrapping, styled bodies, and fenced-code passthrough, so the launcher fails fast rather than letting that surface mid-session.
The gate mirrors the existing `tmux` availability check and shall run after the `tmux` check so a host missing both binaries reports `tmux` first.

### tmux-play-89

Where a loaded config assigns the Captain role or a player role to an adapter whose runtime is not installed, or is installed below the version [[package-16](package.md#package-16)] declares supported, when `tmux-play` runs in launcher mode per [[tmux-play-2](#tmux-play-2)], the launcher shall fail after resolving the config and before creating a work directory, a log directory, a config snapshot, or a tmux session, and before attaching or sending any model request.
The error shall name each such adapter, the roles that use it, the commands that install what it requires, and the path of the config to edit instead.
A runtime installed below its supported version shall be reported as such, naming the installed and required versions, and shall not be reported as absent; a runtime above the tested version shall not block the launch.
An adapter's runtime is the packages it needs before it can run: the optional peer SDK it imports, which shall be installed into the tree the running `@sublang/cligent` resolves from, plus any external CLI it spawns, which shall be installed globally whatever tree cligent itself occupies.
Each reported peer-SDK command shall install into that tree when run as printed, with any path argument quoted so a shell keeps it one argument.
Every peer-SDK command shall name the tree with `--prefix`: where a bare `npm install [-g]` lands is a property of the shell the command is pasted into — the global prefix npm resolves there, which npm rewrites in the environment of every lifecycle child, or the nearest enclosing project of the directory it is pasted in, which need not be the launching one — and no observation from the launching process can witness that shell, while npm's command line outranks both its environment and its project discovery, so the pinned form lands in the named tree in every context.
Every peer-SDK command shall also pin its install scope on the command line, because npm's global mode is the disjunction of its `global` and `location` configurations and either is settable by the paste-time environment, diverting a prefix-pinned project install into `<prefix>/lib/node_modules`: a project command shall set both to their non-global values, and a global command shall assert global mode, which alone wins the disjunction.
Whether the install is global or project-local shall be determined from the running package's own tree — a project install root carries the manifest that defines it — and never from the working directory, which says nothing about where cligent was installed.
Where no `npm install` invocation reaches the resolved tree, the launcher shall print no install command for that peer SDK; it shall name the package and the tree to place it in, and report that no command reaches it.
Vendor credentials are outside this gate: they are not installed by a command, they surface as the provider's own run-time error, and per [[tmux-play-51](#tmux-play-51)]'s precedent the launcher gates only on what an install command repairs.
The gate shall run after the `tmux` and `glow` checks of [[tmux-play-51](#tmux-play-51)], which need no config, and shall report every unmet adapter in one error rather than the first.

### Initial Window Geometry

### tmux-play-35

When the launcher creates the tmux session, the session shall be created with a cell grid whose column and row counts come from [[tmux-play-64](#tmux-play-64)]'s resolved `layout.window.columns` and `layout.window.rows`.
The default values are `174` columns by `49` rows — a cell grid sized for a 1920×1080 display at 18pt monospace (≈ 11×22 px cells) — when the YAML config omits `layout.window`.
When a client attaches with a different window size, tmux's normal size negotiation shall govern the displayed layout.

### tmux-play-43

Before invoking `tmux attach-session`, the launcher shall write the xterm window-manipulation request `CSI 8 ; <rows> ; <columns> t` (`\x1b[8;<rows>;<columns>t`) to stdout, where `<rows>` and `<columns>` are [[tmux-play-64](#tmux-play-64)]'s resolved `layout.window.rows` and `layout.window.columns`, asking the user's terminal to resize its cell grid to match the same dimensions [[tmux-play-35](#tmux-play-35)] uses for `new-session -x/-y`.
The default sequence with the default `layout.window` is `\x1b[8;49;174t`.
Reading both the `new-session -x/-y` arguments and the CSI 8 payload from the same `layout.window` is required because tmux's default `window-size` negotiation would otherwise renegotiate the session to whatever cell grid the terminal accepts on attach, silently overriding any non-default `layout.window` at the very moment it should take effect.
Terminals that honor the sequence (xterm, Konsole, GNOME Terminal, iTerm2 with the "Allow programs to change/resize window" option enabled, others) shall adjust before the attach completes; terminals that ignore it (including macOS Terminal.app by default) shall be left unchanged, in which case [[tmux-play-35](#tmux-play-35)]'s normal size negotiation governs.

### tmux-play-44

The weighted region split required by [[tmux-play-28](#tmux-play-28)] shall hold at every window size, not only at session creation.
The launcher shall reject tmux versions older than 3.3 before config resolution or session construction because `window-resized`, the post-negotiation signal this invariant requires, first exists in tmux 3.3 [[3]].
The launcher shall configure session-scoped tmux hooks (`client-resized`, `window-resized`, and `after-resize-window`) that re-apply pane widths via `resize-pane -x` so that, at any window width `W` with N visible columns and weights `[w_0, w_1, ..., w_{N-1}]` from [[tmux-play-64](#tmux-play-64)]'s resolved column weights for the current visible-column shape, each non-rightmost column `i < N-1` is `floor(W * w_i / sum(w))` cells and the rightmost column absorbs the remainder.
Resize reconciliation shall remain backgrounded, serialize workers per session, reject a worker from a superseded visible-column shape, and recheck the negotiated width before finishing so no earlier client-size event or pane shape may become the final writer after a later window resize or visibility rebuild.
With the shipped defaults: `[1, 1]` for one visible player yields `floor(W / 2)` for the Boss/Captain region and the remainder for the player pane; `[1, 1, 1]` for two or more visible players yields `floor(W / 3)` for the Boss/Captain region, `floor(W / 3)` for the first player column, and the remainder for the second player column.
Pane content widths are one less than their region for every pane that has a right-side tmux border separator; the rightmost pane's content width equals its region.

### tmux-play-45

After the launcher constructs the tmux session and before it attaches a client, the active pane shall be the Boss/Captain pane so startup cursor focus lands at the `boss> ` readline prompt.

### Mouse Interaction

### tmux-play-62

When the launcher creates a tmux-play session, it shall set that session's `mouse` option to `on` so tmux intercepts mouse events before the terminal and drag selection can be scoped by tmux pane instead of by the terminal's screen rectangle.
The launcher shall bind `MouseDragEnd1Pane` in both the `copy-mode` and `copy-mode-vi` key tables to `send-keys -X stop-selection`, so releasing the primary mouse button after a drag leaves the selected text highlighted in copy mode instead of copying and cancelling immediately.
The launcher shall bind the right-click copy gesture in both key tables across the press and release events so that right-clicking a pane that holds an active selection copies the selection through tmux's normal copy path via `send-keys -X copy-pipe <system-clipboard-command>`, pipes the selected text to the host system clipboard when a supported route is available, clears the active selection as visible copy-confirmation, preserves the clicked pane's current copy-mode scroll position, and surfaces a brief on-screen `Copied!` toast.
The copy and toast shall fire on the button release (`MouseUp3Pane`), not the press (`MouseDown3Pane`), because tmux clears a status-line message on the next key event and a right-click is a press immediately followed by a release, so a toast painted on the press is wiped by that release before it can be seen; binding the copy and toast to the release — the last event in the gesture, like the `MouseDragEnd1Pane` drag-copy toast — leaves no later event to clear it, so the toast stays up for the session's `display-time`.
The launcher shall bind `MouseDown3Pane` (right-click press) in both key tables to the focus-neutral no-op `refresh-client`; this press binding is required because tmux delivers a `MouseUp3Pane` event to a key table only when the matching `MouseDown3Pane` was consumed by a binding in that table, so an unbound press would make the paired release — and thus the copy and toast — vanish.
The press binding shall not change pane focus or selection: `refresh-client` consumes the press to deliver the release without any other effect, so right-click-to-copy does not double as a pane switch; `select-pane` shall not be used for this no-op even though it would also deliver the release, because focusing the clicked pane is a side effect this gesture does not need.
The launcher shall bind `MouseUp3Pane` (right-click release) in both key tables as a single `if-shell -F '#{selection_present}'` whose selection-present branch surfaces the `Copied!` toast and runs the copy and whose empty branch runs the copy silently; the gate is read at release time, before `copy-pipe` clears the selection.
When the right-clicked pane holds no active selection, the release's copy path shall still run (copying nothing) and no `Copied!` toast shall appear, so a right-click over unselected content never falsely claims a copy.
The toast shall be a status-line `display-message` (not a floating `display-popup`) so it inherits the session's `message-style` (`fg=<base>,bg=<peach>` per [[tmux-play-47](#tmux-play-47)]) and renders `Copied!` in the resolved flavor's base-on-peach styling — the same status-message band tmux uses for its own messages (dark text on Mocha's light peach, light text on Latte's vivid peach).
Showing the toast shall not change the clicked pane's copy-mode state or scroll position, and the toast shall auto-dismiss after the session's `display-time` like any other tmux status message.
The `copy-pipe` primitive is chosen over `copy-pipe-and-cancel` deliberately: `copy-pipe-and-cancel` exits copy-mode on the clicked pane and returns it to its live tail, which surfaces as the "right-click on a scrolled-back pane jumps to the last line" defect — the right-click analogue of the left-click defect [[tmux-play-68](#tmux-play-68)] addresses for the `MouseDown1Pane` override.
`copy-pipe` clears the selection (so a stale selection cannot survive the copy gesture and the user gets a visible cue that the copy happened) but does not exit copy-mode, so a Boss reviewing historical pane content can copy without losing their place.
A user who wants to leave copy-mode after the copy may press `q` as usual; right-click copy shall not be the action that returns the pane to its live tail.
The system clipboard command shall try `pbcopy`, Wayland `wl-copy`, X11 `xclip`, X11 `xsel`, and WSL `clip.exe`, then fall back to `tmux load-buffer -w -` for OSC 52 clipboard delivery through the attached terminal.
Customizing tmux copy-mode key tables is necessarily server-global because tmux does not offer per-session copy-mode bindings, so these copy-mode bindings outlive the tmux-play session; the launcher accepts that server-level footprint because preserving selection after mouse release is the requested UX and tmux has no narrower mechanism for it.
A future cleanup hook may reduce the binding lifetime, but safe cleanup must preserve any pre-existing user bindings and account for multiple concurrent tmux-play sessions.
Under tmux's default root mouse bindings, clicking selects the pane under the cursor and the scroll wheel enters or operates pane copy mode to scroll pane history.
User `Mouse*` / `Wheel*` rebindings may alter those default consequences.
The launcher shall not configure `set-clipboard` and shall not add `WheelUpPane` or `WheelDownPane` bindings; terminal policy may still block the OSC 52 fallback.
The launcher relies on tmux's stock wheel handling, which already enters copy-mode and clamps the viewport at the oldest history line so a wheel-up cannot scroll past the top of history; the Boss/Captain pane no longer surfaces phantom rows above its first line because [[tmux-play-79](#tmux-play-79)] stops the readline prompt from polluting that pane's scrollback in the first place.

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

While a tmux-play session is running, when the Boss presses the primary mouse button on any pane in the launched session — whether the clicked pane is the currently focused pane or a sibling, in copy-mode or not — every pane in the session whose copy-mode currently holds an active selection shall drop that selection; every pane in the session shall otherwise retain its current copy-mode state and scroll position, and pane focus shall change to the click target.
A pane that is in copy-mode without an active selection (a scrolled-back pane, for example) shall stay in copy-mode at its existing scroll position.
A pane that holds an active selection shall stay in copy-mode at the same scroll position with the selection cleared.
A pane that is not in any mode shall remain not in any mode.
The behavior shall hold for both the pane that currently holds the selection and any sibling pane in the launched session, so a stopped copy-mode selection cannot survive the next primary-button click inside that session.
The launcher shall not clear a selection by exiting copy-mode, because exiting copy-mode returns a scrolled-back pane to its live tail; selection clearing shall be scroll-preserving.
The click behavior shall be scoped to the launched tmux-play session so other tmux sessions on the same tmux server retain their stock primary-click behavior.
Drag-select per [[tmux-play-62](#tmux-play-62)] is unaffected: starting a new primary-button drag shall clear any prior selection before the dragged pane begins its fresh selection.
The right-click copy path of [[tmux-play-62](#tmux-play-62)] is also scroll-preserving: right-clicking an active selection runs `copy-pipe` (not `copy-pipe-and-cancel`), which clears the selection as visible copy-confirmation and leaves the clicked pane in copy-mode at its existing scroll position so a Boss reviewing historical pane content does not lose their place after copying; see [[tmux-play-62](#tmux-play-62)] for the rationale.
The keyboard pane-switch bindings of [[tmux-play-63](#tmux-play-63)] are unaffected and shall continue preserving every pane's scroll position and selection.

### tmux-play-69

While a tmux-play session is running, when the session writes new content to a pane in the launched session — the Boss/Captain pane or a player pane, with the destination pane resolved as the pane that write routes to per [[tmux-play-40](#tmux-play-40)] — that is currently in copy-mode, that pane shall return to its live tail so the newly written content is visible, overriding any prior scroll-back on that pane.
The pane shall be returned to its live tail by a copy-mode exit primitive (`send-keys -X cancel`), not by killing the pane or its feeding process, so a player pane's `tail -f` per [[tmux-play-27](#tmux-play-27)] and the Boss/Captain pane's process keep running; clearing any active selection on that pane is an accepted side effect of the exit.
A pane that is not in a mode shall be left untouched, and no copy-mode exit shall be issued against it.
The trigger shall be new output only: this override of the click and right-click scroll-preservation of [[tmux-play-62](#tmux-play-62)] and [[tmux-play-68](#tmux-play-68)] shall occur only when content is written, so between Boss turns — when no output is produced to a pane — a scrolled-back pane shall keep its scroll position and stay in copy-mode for historical review.
Content that renders to no visible bytes shall not count as new output: when a processed event emits nothing to the pane — for example an all-blank rendered block that per [[tmux-play-50](#tmux-play-50)] writes no bytes — a scrolled-back pane shall keep its scroll position and shall not be returned to its live tail, since the trigger is visible content reaching the pane, not the mere processing of an event.
A write to one pane shall not return any other pane to its tail; a pane that receives no concurrent write shall retain its copy-mode state and scroll position.
The behavior shall be scoped to the launched tmux-play session and shall not affect panes in any other tmux session on the same server.

_The retired wheel-up clamp once tracked here as tmux-play-78 is removed: it chased a symptom — phantom rows appearing above the Boss/Captain pane's first line when scrolling up — that was really the readline prompt polluting the pane's scrollback. Stock tmux already clamps wheel-up at the top of history, and the true cause is fixed at the source by [[tmux-play-79](#tmux-play-79)]._

### Keyboard Interaction

### tmux-play-63

When the launcher creates a tmux-play session, it shall bind `C-Left`, `C-Right`, `S-Left`, and `S-Right` in the `root` key table so that, while the active client is attached to the launched session, `C-Left` and `S-Left` each run `select-pane -L` and `C-Right` and `S-Right` each run `select-pane -R`.
Shipping both `Ctrl+←/→` and `Shift+←/→` as equivalent pane-switch bindings gives an out-of-the-box default that works across macOS, Windows, and Linux terminal emulators — at least one of the two pairs reaches tmux untouched on every common host (macOS Terminal.app and iTerm2 frequently rebind `Ctrl+←/→` for shell word-movement, while many Linux desktops swallow `Shift+←/→` for window-manager workspace switching), so providing both pairs avoids forcing per-platform documentation or user keybinding tweaks.
Each binding shall be gated on the current `#{session_name}` matching the launched session name via `if-shell -F`, with a false branch of `send-keys C-Left` (resp.
`C-Right`, `S-Left`, `S-Right`), so that for any other tmux session on the same server the binding is a no-op and the original `Ctrl+Left` / `Ctrl+Right` / `Shift+Left` / `Shift+Right` key is forwarded verbatim to the active pane.
This delivers the direct pane-switch UX that `status-left` advertises (`switch pane: ctrl+←/→ or shift+←/→`) without requiring the `Ctrl+b` prefix.
The launcher shall render `status-left` with hints in the form `switch pane: ctrl+←/→ or shift+←/→ | stop: esc | exit: ctrl+c | drag=select | right-click=copy`, naming the Boss-input ESC interrupt per [[tmux-play-57](#tmux-play-57)] and the Ctrl+C exit lifecycle per [[tmux-play-26](#tmux-play-26)]; the retired `Ctrl+b, then: d=detach | o=switch pane | [=scroll (q exits)` hint fragments and the prior title-case hint fragments `Switch pane: Ctrl+←/→ or Shift+←/→`, `Stop: ESC`, and `Exit: Ctrl+C` shall not appear.
As with the copy-mode bindings of [[tmux-play-62](#tmux-play-62)], tmux's root key table is server-global because tmux does not offer per-session root-table bindings, so the four entries outlive the tmux-play session; the `if-shell` guard keeps each binding inert in every other session and is the launcher's narrowest available scoping mechanism.
A future cleanup hook may reduce the binding lifetime, but safe cleanup must preserve any pre-existing user bindings and account for multiple concurrent tmux-play sessions.

### tmux-play-70

When the launcher creates a tmux-play session, it shall bind `Escape` in the `root`, `copy-mode`, and `copy-mode-vi` key tables so that, while the active client is attached to the launched session, a single `Escape` pressed in any pane and in any mode forwards a bare ESC byte to the Boss/Captain pane (pane index 0).
Each binding shall be gated on the current `#{session_name}` matching the launched session name via `if-shell -F`.
Each binding's true branch shall first exit pane 0's copy-mode when pane 0 is in a mode and then deliver the ESC byte to pane 0 — `if -F -t <session>:0.0 '#{pane_in_mode}' 'send-keys -t <session>:0.0 -X cancel'` followed by `send-keys -t <session>:0.0 Escape` — because an `Escape` delivered via `send-keys` to a pane that is itself in copy-mode is consumed by copy-mode's stock `cancel` and never reaches the Boss readline, so without the prior cancel the forwarded byte is swallowed when pane 0 is the scrolled pane.
The false branch shall reproduce the per-table tmux stock binding for `Escape` verbatim so other tmux sessions on the same server retain stock behavior: `send-keys Escape` for the `root` table (tmux ships no stock root binding for `Escape`; this passes the key to the focused pane), `send-keys -X cancel` for `copy-mode` (emacs-mode stock: Escape exits copy-mode), and `send-keys -X clear-selection` for `copy-mode-vi` (vi-mode stock: Escape leaves visual selection without leaving copy-mode, because the vi-mode key for exiting copy-mode is `q`).
The asymmetric stock between `copy-mode` and `copy-mode-vi` is intentional in tmux and shall be preserved on the false branch: tmux's `root`, `copy-mode`, and `copy-mode-vi` key tables are server-global (see [[tmux-play-62](#tmux-play-62)] / [[tmux-play-63](#tmux-play-63)] / [[tmux-play-65](#tmux-play-65)]), so collapsing the vi-mode false branch to `-X cancel` would change every unrelated vi-mode user's Escape on the same tmux server from "drop selection, keep scrollback" to "exit copy-mode, snap to live tail" — the same scroll-snapping regression class [[tmux-play-68](#tmux-play-68)] enumerates for mouse events.
This mirrors the [[tmux-play-65](#tmux-play-65)] `C-c` forwarding pattern so the `stop: esc` hint advertised by `status-left` per [[tmux-play-63](#tmux-play-63)] is honored from every pane in the launched session.
Without this binding, an ESC pressed in a player pane is swallowed by `pane-input-off=1` per [[tmux-play-27](#tmux-play-27)] and never reaches the readline keypress handler in pane 0 that [[tmux-play-57](#tmux-play-57)] wires to `abortActiveTurn('ESC')`; an ESC pressed in any pane scrolled back into copy-mode is consumed by the stock copy-mode handling (`cancel` or `clear-selection`) before it could reach the root table.
The bare-vs-sequence distinction continues to be enforced inside the readline keypress handler per [[tmux-play-57](#tmux-play-57)] — arrow-key sequences `\x1b[A` etc. are recognized by tmux as their own keys (not `Escape`) and never trigger this binding, and pasted ESC bytes arrive via bracketed-paste markers per [[tmux-play-58](#tmux-play-58)] which tmux strips before key dispatch — so this item does not change ESC semantics beyond the pane-of-origin / copy-mode-state expansion.
As with the copy-mode bindings of [[tmux-play-62](#tmux-play-62)] and the navigation bindings of [[tmux-play-63](#tmux-play-63)], tmux's `root`, `copy-mode`, and `copy-mode-vi` key tables are server-global, so these entries outlive the tmux-play session; the `if-shell` guard keeps each binding inert in every other session and is the launcher's narrowest available scoping mechanism.
A future cleanup hook may reduce the binding lifetime, but safe cleanup must preserve any pre-existing user bindings and account for multiple concurrent tmux-play sessions.

### tmux-play-65

When the launcher creates a tmux-play session, it shall bind `C-c` in the `root`, `copy-mode`, and `copy-mode-vi` key tables so that, while the active client is attached to the launched session, a single `C-c` pressed in any pane and in any mode triggers the [[tmux-play-26](#tmux-play-26)] exit lifecycle on the Boss/Captain pane (pane index 0).
Each of the three bindings shall be gated on the current `#{session_name}` matching the launched session name via `if-shell -F`, so that for any other tmux session on the same server the binding is a no-op and the original key is forwarded verbatim through that table's stock behavior.
Each binding's true branch shall first exit pane 0's copy-mode when pane 0 is in a mode and then deliver the Ctrl+C byte to pane 0 — `if -F -t <session>:0.0 '#{pane_in_mode}' 'send-keys -t <session>:0.0 -X cancel'` followed by `send-keys -t <session>:0.0 C-c` — because a `C-c` delivered via `send-keys` to a pane that is itself in copy-mode is consumed by copy-mode's stock `cancel` and never reaches the Boss readline, so without the prior cancel the forwarded byte raises no signal when pane 0 is the scrolled pane.
Each binding's false branch shall reproduce that table's stock binding verbatim — `send-keys C-c` for `root`, and `send-keys -X cancel` for `copy-mode` and `copy-mode-vi` — so other tmux sessions on the same server retain stock `Ctrl+C` and stock copy-mode `C-c` behavior.
Binding `C-c` in the `copy-mode` and `copy-mode-vi` tables in addition to `root` is required because, while the active pane is scrolled into copy-mode, tmux dispatches `C-c` through the mode table's stock `send-keys -X cancel` rather than the `root` binding, so a `root`-only binding would merely cancel copy-mode on the first press and need a second press to quit.
Player panes are read-only per [[tmux-play-27](#tmux-play-27)] — their `pane-input-off=1` would otherwise swallow `Ctrl+C` entirely; intercepting at the key table fires the binding before the pane sees the key, so the `exit: ctrl+c` hint advertised by `status-left` per [[tmux-play-63](#tmux-play-63)] is honored from every pane in the launched session, not only from the Boss/Captain pane whose readline already raises the signal.
Once delivered to the Boss/Captain pane, the Captain process handles the byte per [[tmux-play-26](#tmux-play-26)]: the runtime aborts the active turn, runs shutdown per [[tmux-play-19](#tmux-play-19)], kills the tmux session, and removes launcher-owned work directories.
As with the copy-mode bindings of [[tmux-play-62](#tmux-play-62)] and the navigation bindings of [[tmux-play-63](#tmux-play-63)], tmux's root, `copy-mode`, and `copy-mode-vi` key tables are server-global, so these entries outlive the tmux-play session; the `if-shell` guard keeps each binding inert in every other session and is the launcher's narrowest available scoping mechanism.
A future cleanup hook may reduce the binding lifetime, but safe cleanup must preserve any pre-existing user bindings and account for multiple concurrent tmux-play sessions.

### Pane Titles

### tmux-play-36

This item defines the display name a pane is known by, which is the stem of its title rather than the whole of it: [[tmux-play-48](#tmux-play-48)] composes that stem with the pane's adapter to form the title tmux carries.

The Boss/Captain pane's display name shall be `Captain`.
Each player pane's display name shall be the player `id` rendered with the first character upper-cased and the remaining characters preserved (e.g., `coder` → `Coder`, `reviewer` → `Reviewer`).
The literal `Player:` prefix shall not appear in pane titles.

### Presenter Output

### tmux-play-37

While in session mode, the Boss readline shall echo the user's input line as the user types it (standard readline behavior).
When the runtime emits `turn_started`, the presenter shall not write the Boss prompt to the Boss/Captain pane, so the user's input shall appear exactly once in the pane.
This as-typed echo is scoped to the ready (between-turns) `boss> ` prompt; while a Boss turn is active the live readline prompt is suspended per [[tmux-play-75](#tmux-play-75)], so type-ahead the Boss enters during the turn is not echoed as a `boss> ` line until [[tmux-play-75](#tmux-play-75)] restores the prompt.

### tmux-play-57

Where session mode is running with TTY stdin, while a Boss turn is active, when the Boss presses a bare ESC key in the Boss/Captain pane, the session shall abort the active turn without shutting down, preserve the Boss readline's current edit-buffer contents, and return to a ready `boss> ` prompt for the next Boss turn.
The Boss/Captain pane shall render the existing `[turn aborted] ESC` status line per [[tmux-play-40](#tmux-play-40)].
The preserved edit-buffer contents are surfaced on the `boss> ` prompt when it is restored at turn end per [[tmux-play-75](#tmux-play-75)], since while the turn is active that prompt is suspended.
While no Boss turn is active, a bare ESC keypress shall have no observable effect.
Terminal escape sequences that are not a bare ESC keypress (for example arrow-key sequences) shall not trigger a turn abort.
Where stdin is not a TTY, the ESC keybinding shall not be installed, and the SIGINT/SIGTERM/EOF lifecycle per [[tmux-play-26](#tmux-play-26)] shall remain unchanged.
The readline ESC handler is the single point of ESC interpretation regardless of which pane in the launched session the Boss pressed the key in: ESC pressed in a player pane (whose `pane-input-off=1` would otherwise swallow the byte) or in any pane scrolled back into copy-mode (where the stock copy-mode `Escape` handling — `cancel` in emacs-mode `copy-mode`, `clear-selection` in vi-mode `copy-mode-vi` per [[tmux-play-70](#tmux-play-70)] — would otherwise consume the keystroke before it could reach the root table) is forwarded to pane index 0 by [[tmux-play-70](#tmux-play-70)], where this item's readline handler runs unchanged.

### tmux-play-58

Where session mode is running with TTY stdin and TTY stdout, when the Boss pastes multi-line text into the Boss/Captain pane and then presses Enter, the session shall submit exactly one Boss turn whose `BossTurn.prompt` preserves the pasted text's embedded newlines as `\n` characters inside that single prompt string.
Bytes typed by the Boss after the paste and before that Enter shall be included in the same submission.
Where either stdin or stdout is not a TTY, the multi-line paste behavior shall be omitted and embedded newlines in pasted text shall behave as in the underlying readline.
The session shall enable bracketed paste only for its own duration and shall emit the bracketed-paste-disable sequence on every shutdown path so tmux-play does not leave bracketed-paste mode enabled in the terminal after exit.

### tmux-play-75

Where session mode is running with TTY stdin, while a Boss turn is active — between the runtime's `turn_started` and the matching `turn_finished` or `turn_aborted` — the Boss/Captain pane shall paint no fresh `boss> ` readline prompt line (the input line already echoed for the submitted prompt per [[tmux-play-37](#tmux-play-37)] is unaffected), so the turn's streaming presenter output is never interleaved with or followed by a fresh `boss> ` prompt that a turn-completion consumer reading the pane would misread as an implicit turn-over signal.
When the runtime starts a Boss turn, the session shall suspend or clear the live readline prompt before the turn's first presenter output reaches the pane.
When the turn ends — by normal completion, ESC abort per [[tmux-play-57](#tmux-play-57)], or a runtime error — the session shall restore the `boss> ` prompt, but shall paint a fresh ready prompt only once no submitted Boss line remains queued.
When the Boss has submitted further lines that queued behind the active turn (the runtime runs them one at a time per [[tmux-play-18](#tmux-play-18)]), the session shall paint no ready `boss> ` prompt between the consecutive turns — each queued turn begins under the same suspension — and shall paint exactly one ready prompt after the last queued turn ends.
An empty or whitespace-only Boss submission shall paint a fresh ready `boss> ` prompt only while no Boss turn is active or queued; submitted while a turn is active or queued, it shall paint no `boss> ` prompt amid the turn's streaming output.
While a Boss turn is active, edit-buffer bytes the Boss types — or pastes per [[tmux-play-58](#tmux-play-58)] — shall be preserved per [[tmux-play-57](#tmux-play-57)] and surfaced on the restored prompt, and shall not render as a `boss> `-prefixed line until the prompt is restored.
Where stdin is not a TTY, no keypress handling is installed (per [[tmux-play-57](#tmux-play-57)]) and there is no live (raw-mode, echoing) editing prompt whose `boss> ` chrome a keystroke could repaint mid-turn, so this item's active-turn suspension shall be a no-op; any static `boss> ` string the underlying readline writes between turns is unchanged by this item.

### tmux-play-79

Where session mode is running with TTY stdout, while the Boss/Captain pane shows the live readline prompt, when the Boss edits the prompt — typing characters and deleting them, or any edit that triggers a line refresh — the Boss/Captain pane's tmux scrollback history shall gain no prompt row, so scrolling that pane up afterward reveals no phantom intermediate prompt rows (for example `boss> abc`, `boss> ab`, `boss> a` left behind after typing `abc` and backspacing it away).
This shall hold wherever the prompt sits in the pane, including at the top of a mostly-empty pane — the condition under which Node's readline line refresh, which clears to the end of the display before repainting, would otherwise make tmux scroll the erased on-screen rows into scrollback instead of blanking them.
Turn output the presenter writes to the Boss/Captain pane shall continue to scroll into that pane's scrollback as before, so only the readline prompt's own redraws are kept out of history, not legitimate content.
Where stdout is not a TTY, the readline produces no in-place line refresh, so this item shall be a no-op.
Because stock tmux already clamps a wheel-up at the oldest history line, removing this scrollback pollution at the source is sufficient: the launcher needs no `WheelUpPane` override (see [[tmux-play-62](#tmux-play-62)]) to keep the Boss from scrolling past the pane's first line.

### tmux-play-38

The presenter shall tag the first nonblank textual line of each tmux-play pane output block with a `<who>> ` prefix where `<who>` is `boss`, `captain`, or the speaker's player `id`.
Continuation lines within the same block shall use a two-space hanging indent without repeating the speaker prefix.
Blank lines shall remain blank and shall not count as continuation lines before the first nonblank line.
The Boss readline prompt shall be `boss> `; the first nonblank line of the Captain's reply rendered in the Boss/Captain pane shall be prefixed with `captain> `; the first nonblank line of the Captain's prompt rendered in a player pane shall be prefixed with `captain> `; and the first nonblank line of the player's reply rendered in the player pane shall be prefixed with `<playerId>> `.
Bracket-tag notation such as `[from captain]` or `[captain llm prompt]` shall not be used.

The presenter shall color the speaker prefix by wrapping its bytes — including the trailing space — in a bold 24-bit-foreground SGR pair: `\x1b[1;38;2;<r>;<g>;<b>m<who>> \x1b[0m`.
Body text following the prefix shall remain unstyled by the presenter, so any ANSI bytes inside the body come from the body itself.
Continuation indents shall stay uncolored.
The speaker → color mapping is:

| Speaker | Mocha role | Hex |
| --- | --- | --- |
| `boss` | `blue` | `#89b4fa` |
| `captain` | `mauve` | `#cba6f7` |
| `<playerId>` | adapter-keyed via [[tmux-play-48](#tmux-play-48)] `playerAccent(player.adapter)` | varies (e.g., `claude` → `#a6e3a1`) |

The Boss readline prompt set by session mode shall carry the same colored form (`\x1b[1;38;2;137;180;250mboss> \x1b[0m`); Node's readline strips ANSI from prompts when computing the visible width, so cursor positioning still treats the prompt as 6 cells wide.

Per [[tmux-play-50](#tmux-play-50)], text bodies pass through `glow` before reaching the writer; the presenter applies the prefix and two-space hanging indent to `glow`'s rendered output, and budgets the visible prefix's cell width into the render width passed to `glow` so the prefixed first line and the indented continuation lines both fit the pane.
Status lines (per [[tmux-play-39](#tmux-play-39)]) and tool lifecycle lines (per [[tmux-play-49](#tmux-play-49)]) bypass `glow` — they are single-line operational text — and apply the speaker prefix plus the bracketed-tag grammar directly.
The speaker prefix grammar now governs tool lines as well; the `tool>` / `tool<` prefix replacement is retired.

### tmux-play-39

Every operational line in a tmux-play pane shall follow one unified shape: `<who>> [<tag> <optional glyph>] <optional body>`.
The `<who>> ` speaker prefix follows [[tmux-play-38](#tmux-play-38)]; the bracketed tag is one of the kinds in the table below; the body, when present, lives outside the brackets — not after a colon inside them.
Colored tags (kinds whose row in the table below assigns a tag color) carry their own bold 24-bit-foreground SGR span distinct from the surrounding speaker prefix span; uncolored tags (`[status]`, `[tool ↪]`) are emitted plain so the surrounding text style passes through.
The body remains unstyled by the presenter.
Lines whose body is non-empty emit `<who>> [tag] <body>`; lines with no body emit just `<who>> [tag]` — `[aborted]` always (per [[tmux-play-33](#tmux-play-33)]) and `[turn aborted]` when the `turn_aborted` record carries no reason.
No synthesized placeholder body shall be inserted when a source field is absent.

The glyph slot is optional and is only populated for kinds with multi-state semantics — tools today.
Single-state kinds (status, error, aborted, turn-aborted, runtime-error) carry no glyph; the word in the tag names the kind and color names the outcome.

When a player or Captain run finishes with `status: 'ok'`, the presenter shall not write a trailing status line such as `[player <id> ok]` or `[captain ok]`.
When a run finishes with `status: 'error'`, the presenter shall write a single `<who>> [error] <message>` line in the corresponding pane, where `<message>` is the result's `error` field.
When a run finishes with `status: 'aborted'`, the presenter shall write a single `<who>> [aborted]` line; per [[tmux-play-33](#tmux-play-33)] aborted results need not carry a reason, so no reason is rendered.

The kind table:

| Tag | Glyph slot | Body | Tag color | Source record / event |
| --- | --- | --- | --- | --- |
| `[status]` | — | message + optional structured-data tail | uncolored | `captain_status` |
| `[error]` | — | result `error` field | `red` (`#f38ba8`) | `player_finished` / `captain_finished` with `status: 'error'` |
| `[aborted]` | — | — | `yellow` (`#f9e2af`) | `player_finished` / `captain_finished` with `status: 'aborted'` |
| `[turn aborted]` | — | turn-abort reason when present | `yellow` (`#f9e2af`) | `turn_aborted` |
| `[runtime error]` | — | runtime-error message | `red` (`#f38ba8`) | `runtime_error` |
| `[tool ↪]` | `↪` (call) | tool name + input summary | uncolored | `tool_use` |
| `[tool ✓]` | `✓` (ok) | tool name + duration | `green` (`#a6e3a1`) | `tool_result` `status: 'success'` |
| `[tool ✗]` | `✗` (err) | tool name + duration | `red` (`#f38ba8`) | `tool_result` `status: 'error'` |
| `[tool ·]` | `·` (denied) | tool name + duration | `yellow` (`#f9e2af`) | `tool_result` `status: 'denied'` |

The result is an operational line whose speaker prefix carries the speaker color, whose bracketed tag (when colored) carries the outcome color, and whose body is unstyled — e.g., `<captain-mauve>captain> </reset><red>[runtime error]</reset> boom`.

### tmux-play-40

The Boss/Captain pane shall display the Boss's input lines, the Captain's synthesized reply or terminal Captain failure line per [[tmux-play-39](#tmux-play-39)], the Captain's conversational replies (`captain_reply` rendered as Captain prose per [[tmux-play-92](#tmux-play-92)]), operational records intended for that pane (`captain_status`, `runtime_error`, and `turn_aborted`), and Captain-emitted `tool_use` / `tool_result` events rendered per [[tmux-play-49](#tmux-play-49)].
Per-player outputs and the Captain's prompt body (which references player results) shall not be written to the Boss/Captain pane; player-emitted tool events remain in their respective player panes.
Records from a `callCaptain` invocation tagged `visibility: 'hidden'` are the exception per [[tmux-play-72](#tmux-play-72)]: the Boss/Captain pane shall display none of them.

### tmux-play-49

`tool_use` and `tool_result` events shall render under the unified bracketed-tag grammar of [[tmux-play-39](#tmux-play-39)] in the calling entity's pane (the player pane for player-emitted events; the Boss/Captain pane for Captain-emitted events per [[tmux-play-40](#tmux-play-40)]).
The speaker prefix follows [[tmux-play-38](#tmux-play-38)]'s `<who>> ` grammar — `captain> ` for Captain-emitted events and `<playerId>> ` for player-emitted events — and the bracketed tag follows [[tmux-play-39](#tmux-play-39)]'s kind table.
The `tool>` / `tool<` prefix replacement and its caller-accent rule are retired; speaker identity is carried in the `<who>> ` prefix, not in the bracketed tag's color.

A `tool_use` event shall render as a single line `<who>> [tool ↪] <toolName> <inputSummary>` where the bracketed tag is uncolored (the speaker prefix already carries identity) and the body — tool name + input summary — is unstyled.

`<inputSummary>` is the first non-empty string value found in `input` checked in priority order `command`, `file_path`, `path`, `pattern`, `query`, `prompt`, `description`, or a compact `JSON.stringify(input)` otherwise.
The `query` slot covers search/fetch tools (ToolSearch, WebFetch wrappers, etc.) so a real query surfaces in the header instead of the JSON fallback.
Whitespace runs in the chosen string shall be collapsed to single spaces and the result truncated at 60 cells with a trailing `…` when longer.
When no usable summary exists, the line shall be `<who>> [tool ↪] <toolName>` with no trailing space.

A `tool_result` event shall render as a header line `<who>> [tool <symbol>] <toolName>[ <duration>]` followed by the tool's output as a continuation block.
The `<symbol>` and the bracketed tag's SGR derive from `status` per [[tmux-play-39](#tmux-play-39)]'s kind table: `✓` green for `success`, `✗` red for `error`, `·` yellow for `denied`.
The body — tool name and optional duration — is unstyled.

`<duration>` is `<n>ms` when `durationMs < 1000`, `<n.n>s` otherwise; the duration segment is omitted when `durationMs` is undefined.
When the extracted output (the string itself, or `output.stdout` when present, or the pretty-printed JSON of `output` otherwise) is empty or undefined, the header line stands alone with no body.

When the extracted output is non-empty, the presenter shall strip exactly one trailing line terminator (the `\n` that closes the payload's last line) from the body before wrapping it; trailing blank lines beyond that terminator are preserved so payloads that intentionally end with a blank row (e.g., a file whose final line is empty) survive into the rendered output.
The body shall then be wrapped in a fenced code block and rendered through `renderMarkdown` per [[tmux-play-50](#tmux-play-50)], including [[tmux-play-50](#tmux-play-50)]'s successful-render rule that emitted lines do not retain `glow`'s trailing horizontal padding while leading whitespace remains intact; existing two-space continuation indentation remains unchanged.
Every nonblank line of the rendered output shall be prefixed with two spaces and emitted after the header, and blank lines shall remain blank (unindented) so the fenced-code frame and any payload edge blanks read as the user would see them in a `glow` pane outside this presenter.
The fence shall be a run of backticks one longer than the longest backtick run anywhere in the payload, with a minimum of three, so any embedded ```` ``` ```` in the payload stays inert as literal content instead of terminating the wrapper early and leaking the tail into Markdown rendering.
The render width shall be `max(1, paneWidth - 2)`, matching the two-space continuation indent.
Tool-result bodies keep this continuation-body budget rather than the text-block pane-width compensation because they are fenced verbatim output: edge fill is not a goal, and `glow`'s code-block rendering may intentionally leave long code lines unwrapped or overflowed.

`glow`'s code-block rendering owns the body's styling and leaves long code lines unwrapped by design; the prior `overlay0` `#6c7086` dim SGR around the body is no longer applied because `glow`'s styling supersedes it.
The presenter shall trim at most one leading and at most one trailing blank line from `glow`'s rendered body output — `glow`'s outer paragraph margin — before the two-space indent is applied, matching [[tmux-play-50](#tmux-play-50)]'s outer-margin trim.
Any further blank lines (the fenced-code frame `glow` emits around the payload, and any blank rows inside the payload itself) shall be preserved so the body's visible structure survives the indent pass.
When `renderMarkdown` raises a mid-session failure (rare given the [[tmux-play-51](#tmux-play-51)] launcher gate), the presenter shall emit the raw body text under the same two-space continuation indent rather than crash the session, and shall not apply the successful-render padding strip to that raw fallback body.
The outer-margin trim shall not apply on the fallback path: the raw body never passed through `glow` and so carries no outer paragraph margin to strip, and trimming would mistake a payload trailing blank row for a margin and silently lose it — directly violating this item's payload-trailing-blank-preservation rule.

### tmux-play-50

While in session mode, the presenter shall buffer text from `text_delta` and `text` events per `(writer, block)` and render the buffered text through `renderMarkdown` per [[tmux-play-51](#tmux-play-51)] at the next block boundary.
Block boundaries are: a `player_finished` or `captain_finished` record; a `text` event (always a complete block); a `captain_reply` record (itself a complete prose block per [[tmux-play-92](#tmux-play-92)]) on the same writer; a `tool_use` or `tool_result` event on the same writer; a `player_prompt` on the same writer; any status emission (`captain_status`, `runtime_error`, `turn_aborted`) on the same writer.

The render width for text blocks shall be `max(1, paneWidth)`.
When no pane-width source is configured for the writer, the render width shall default to `80`.
This budget compensates for `glow`'s built-in two-cell document margin in the built-in `dark` / `light` styles: after `glow` wraps ordinary prose and the presenter strips trailing right padding, a rendered continuation row that reaches `glow`'s wrap limit plus the presenter's two-space continuation indent shall reach the pane width rather than stopping short.
The presenter shall preserve `glow`'s leading document margin, so a nonblank continuation row rendered by `glow` carries the presenter's two-space continuation indent followed by `glow`'s two-space document margin.
The presenter shall then prefix-fit the first visible rendered row only: if adding the speaker's `<who>> ` first-line prefix would exceed the pane display width, the presenter shall split that first rendered row at a cell-aware word boundary, write the first segment after the colored `<who>> ` prefix, and write the remaining segment as the next two-space-indented continuation row.
The prefix-fit split shall preserve ANSI escape sequences as zero-width bytes and shall not color the continuation indent.
For breakable prose, emitted text-block rows shall remain within the pane's display width without relying on terminal-level rewrap.
Glow-inherent overflow remains allowed for unbreakable long tokens, tables, and other preformatted shapes that `glow` itself does not wrap at the requested width.

After successful rendering, no line emitted by the presenter shall retain `glow`'s trailing horizontal line padding.
Trailing padding includes right-side padding cells emitted by `glow`, including padding followed only by SGR resets; leading whitespace shall be preserved, so `glow`'s left margin and the presenter's existing indentation behavior remain unchanged.
The presenter shall trim at most one leading and at most one trailing blank line from `glow`'s output — `glow`'s default outer paragraph margin — before the prefix grammar is applied.
Any further blank lines (whether between paragraphs, around a fenced-code frame, between table rows, or anywhere else `glow` emits structural blanks) shall be preserved as blank lines but shall not retain `glow`'s right-padding cells.
The presenter shall then apply the [[tmux-play-38](#tmux-play-38)] prefix grammar over the preserved `glow` output: the first nonblank line after the outer-margin trim carries the colored `<who>> ` prefix; any blank lines preceding it (e.g., the inner edge of a fenced-code frame) pass through unmodified; every nonblank continuation line carries the presenter's two-space hanging indent, and rendered continuation lines also retain `glow`'s leading document margin.
An all-blank rendered block (after the outer trim) shall emit no bytes to the writer, so empty content never surfaces as a stranded `<who>> ` line or a parade of padding blanks between consecutive turns.

`glow` owns word-boundary wrapping, fenced-code preservation, table layout, and inline-style rendering inside the block; except for the first-row prefix-fit split described above, the presenter shall not reflow `glow`'s output.
`renderMarkdown` shall receive the launcher-resolved Catppuccin flavor and invoke `glow` with the matching built-in style: `dark` for Mocha, `light` for Latte.
When `renderMarkdown` raises (a rare mid-session failure given the [[tmux-play-51](#tmux-play-51)] launcher gate), the presenter shall emit the buffered raw text under the same prefix grammar rather than crash the session, and shall not apply the `glow`-padding strip to that raw fallback text.

`text_delta` events accumulate until a boundary fires.
Token-by-token streaming is the deliberate tradeoff: Markdown is not a streamable format — a renderer cannot tell whether subsequent bytes belong to an open fence until the closing fence arrives — so partial rendering would corrupt fenced code, tables, and lists.

Status lines (per [[tmux-play-39](#tmux-play-39)]) and tool lifecycle lines (per [[tmux-play-49](#tmux-play-49)]) bypass the buffer-then-render pipeline: each is a single line of operational text, not Markdown, and writes directly with the speaker prefix and the bracketed-tag grammar applied.

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

### tmux-play-47

The launcher shall apply a **Catppuccin flavor** (Mocha for dark terminals, Latte for light) per [[1]] to the session's appearance options before any content-bearing option in [[tmux-play-36](#tmux-play-36)], [[tmux-play-38](#tmux-play-38)]–[[tmux-play-40](#tmux-play-40)], or [[tmux-play-44](#tmux-play-44)] is set, so the launcher's own pane-border-format and status-left/status-right strings remain authoritative for any option a future theme might also claim.
Catppuccin ships both flavors with matching role keys; selecting the flavor whose `mantle` band reads as a subtle tonal step on the user's terminal canvas — rather than an inverted dark block on light or vice versa — is the canonical pattern.

The flavor shall resolve in this priority: (1) explicit `themeFlavor` on the programmatic `launchTmuxPlay` option, when present and one of `'mocha' | 'latte'`; (2) the YAML config's `theme` field per [[tmux-play-6](#tmux-play-6)], when present and one of `'mocha' | 'latte'`; (3) after those concrete overrides are exhausted, an OSC 11 terminal-background query when auto-detection is active and the launcher is going to attach, including a managed launch prepared for later native attachment per [[tmux-play-94](#tmux-play-94)], or when [[tmux-play-61](#tmux-play-61)] diagnostics mode is explicitly requested; (4) default Mocha.

The OSC 11 query shall write `OSC 11 ; ? BEL` (`\x1b]11;?\x07`) to the controlling terminal, read for a bounded short timeout, accept either BEL or ST termination, parse `rgb:RR/GG/BB` and `rgb:RRRR/GGGG/BBBB` replies, compute relative luminance as `0.2126 * R + 0.7152 * G + 0.0722 * B` over normalized channel values, and select Latte for luminance `>= 0.5`, otherwise Mocha.
Failure to open the controlling terminal, failure to receive a parseable reply, a public launch with no eventual native attachment (`attach: false`) or non-TTY stdin/stdout, or timeout shall select Mocha with reason `fallback`.
The launcher shall write the resolved (concrete) flavor into the session work-dir snapshot per [[tmux-play-34](#tmux-play-34)] so the session subprocess uses the same flavor for pane-content SGR colors per [[tmux-play-38](#tmux-play-38)] without re-running detection.

The `window-style` and `window-active-style` options are NOT claimed — the canonical Catppuccin tmux pattern leaves the pane content area on the user's terminal-native canvas, and switching flavor by host bg is what keeps the band tonally correct without forcing a dark UI onto a light terminal.

The theme shall set exactly these tmux options and no others (`<text>`, `<mantle>`, etc. resolve to the Mocha or Latte hex per the resolved flavor):

| Option | Value | Note |
| --- | --- | --- |
| `default-terminal` | `tmux-256color` | Truecolor enablement so the hex values below render rather than quantizing to the nearest 256-color index. Set on the session. |
| `terminal-overrides` | append `,*:RGB` | Server option; the leading-comma list-separator idiom prepends `*:RGB` without clobbering existing entries. tmux normalizes the stored value, so `show-options -gv terminal-overrides` reports the entry as `*:RGB`. |
| `status-style` | `fg=<text>,bg=<mantle>` | Catppuccin text on the mantle band. Mocha: `fg=#cdd6f4,bg=#181825`. Latte: `fg=#4c4f69,bg=#e6e9ef`. |
| `pane-border-style` | `fg=<overlay0>` | Inactive border; dimmer than the active border for at-a-glance contrast per [[tmux-play-48](#tmux-play-48)]. Mocha: `fg=#6c7086`. Latte: `fg=#9ca0b0`. |
| `pane-active-border-style` | `fg=<blue>` | Mocha: `fg=#89b4fa`. Latte: `fg=#1e66f5`. |
| `message-style` | `fg=<base>,bg=<peach>` | Mocha: `fg=#1e1e2e,bg=#fab387`. Latte: `fg=#eff1f5,bg=#fe640b`. |
| `message-command-style` | `fg=<base>,bg=<green>` | Mocha: `fg=#1e1e2e,bg=#a6e3a1`. Latte: `fg=#eff1f5,bg=#40a02b`. |
| `display-panes-colour` | `<overlay0>` | |
| `display-panes-active-colour` | `<mauve>` | Mocha: `#cba6f7`. Latte: `#8839ef`. |
| `clock-mode-colour` | `<mauve>` | |

`window-style` and `window-active-style` are not claimed: the canonical Catppuccin tmux pattern leaves the pane content area as the user's terminal-native canvas, and a per-host flavor choice gives the theme adaptive surface tone without overriding the terminal background.
`window-status-style` and `window-status-current-style` are not claimed either: the window-list formats below ([[tmux-play-55](#tmux-play-55)]) are set to empty strings, so those style options have nothing to color and any tmux default for them is inert.
`pane-border-format`, `pane-border-status`, `status-left`, `status-left-length`, `status-right`, `status-right-length`, `window-status-format`, `window-status-current-format`, and `window-status-separator` are NOT claimed by the theme; they remain owned by the clauses cited above (and [[tmux-play-48](#tmux-play-48)] for the format) and shall be set after the theme so a future swap is a one-place change.

### tmux-play-48

The launcher shall set each pane's title to `<Display> · <adapter>` where `<Display>` is `Captain` for the Boss/Captain pane and the title-cased player id (per [[tmux-play-36](#tmux-play-36)]) for each player pane, and `<adapter>` is the adapter name configured in the YAML config for the captain or the player respectively.
The middle separator shall be ` · ` (space + U+00B7 middle dot + space).

The launcher shall publish a stable per-adapter accent color, surfaced to consumers (the presenter, per [[tmux-play-38](#tmux-play-38)] Task 2 and the launcher's own per-pane timer accents) as a single lookup keyed by adapter name and the resolved Catppuccin flavor from [[tmux-play-47](#tmux-play-47)].
Each adapter maps to the same role across flavors (claude → green, codex → teal, etc.) so the session reads the matching variant.
Known adapter accents:

| Adapter | Role | Mocha hex | Latte hex |
| --- | --- | --- | --- |
| `claude` | `green` | `#a6e3a1` | `#40a02b` |
| `codex` | `teal` | `#94e2d5` | `#179299` |
| `gemini` | `lavender` | `#b4befe` | `#7287fd` |
| `kimi` | `sapphire` | `#74c7ec` | `#209fb5` |
| `opencode` | `pink` | `#f5c2e7` | `#ea76cb` |

For an adapter name outside the table, the lookup shall return a stable color from a fallback pool selected deterministically from the adapter name so repeated lookups for the same name yield the same color.
The Mocha pool is `sky #89dceb`, `rosewater #f5e0dc`, `maroon #eba0ac`, `flamingo #f2cdcd`; the Latte pool is the same roles at their Latte hex (`sky #04a5e5`, `rosewater #dc8a78`, `maroon #e64553`, `flamingo #dd7878`).
Neither pool shall contain an accent assigned to a known adapter or reserved for speaker / tool / status roles (`blue`, `mauve`, `peach`, `red`, `yellow`, `green`).
The Boss/Captain pane's timer accent shall use Catppuccin `mauve` at the flavor-resolved hex (`#cba6f7` on Mocha, `#8839ef` on Latte), so the Captain pane timer reads against the mantle band on either polarity rather than washing out under a Mocha-only lookup on a Latte session.

When the launcher sets `pane-border-format`, only the Boss/Captain pane (pane index 0) shall carry the highlighted blue title block, and only while it is the active pane.
Player pane titles — even when active — shall never carry the highlight block (they are read-only per [[tmux-play-27](#tmux-play-27)] and don't need a focus indicator there); the format's else branch shall render their titles on the resolved flavor's mantle surface (`fg=text,bg=mantle`).
The pane-border row shall carry an explicit Catppuccin mantle background end-to-end after the title segment, so the separator, timer glyph, and timer duration text all sit on the same theme-defined surface.
The pane content area above this row stays on the user's terminal-native canvas (no `window-style` claim per [[tmux-play-47](#tmux-play-47)]); the mantle band on the border row reads as a tonal step away from that canvas — darker on a dark terminal under Mocha, lighter-but-distinct on a light terminal under Latte — so the title-and-timer band always stands out from pane content without inverting the user's chosen polarity.
The launcher shall set `pane-border-status` to `top` so each pane's title-and-timer row renders above its content.
The bottom edge of each pane is the tonal step between the user's terminal-native pane content and the mantle status bar below, which serves as the pane's lower visual boundary without claiming a second border row.
The format's whitespace shall be symmetric: exactly one space precedes the `#{pane_title}` substitution and exactly one space follows the timer text substitution before the trailing `#[default]` reset, so the title-and-timer band sits with equal left and right padding rather than reading flush-right against the next pane's separator.

### Run-Time Timers

### tmux-play-53

While a tmux-play session is running, the session shall maintain cumulative active-time timers derived from existing record timestamps.
A player pane's timer shall add `player_finished.timestamp - player_prompt.timestamp` for each run of that player.
The Boss/Captain pane's timer shall add `captain_finished.timestamp - captain_prompt.timestamp` for each Captain run.
The session-total timer shall add `(turn_finished.timestamp | turn_aborted.timestamp) - turn_started.timestamp` for each Boss turn.
While a player, Captain, or turn occurrence is open, the corresponding displayed timer shall equal its accumulated closed duration plus `now - <open-start>.timestamp`.
The player and Captain timers shall not include gaps between that participant's runs, and the session-total timer shall not include gaps between Boss turns.

### tmux-play-54

When the launcher constructs a tmux-play session, each pane border shall include that pane's cumulative active-time timer.
The Boss/Captain pane border timer shall display the Captain timer from [[tmux-play-53](#tmux-play-53)], and each player pane border timer shall display that player's timer from [[tmux-play-53](#tmux-play-53)].
The pane-border timer shall not replace or remove the pane title and adapter information required by [[tmux-play-48](#tmux-play-48)].
While a pane's current run is open, its timer shall refresh roughly once per second and render with the running glyph `⏳` plus the bright Catppuccin accent for that pane: `mauve` (`#cba6f7`) for Captain and [[tmux-play-48](#tmux-play-48)]'s adapter accent for a player.
When a pane has no open run, its timer shall render frozen with the settled glyph `⌛` plus a Catppuccin text-level neutral color such as `subtext1` (`#bac2de`), not `overlay1` (`#7f849c`), so the timer remains legible against the Mocha mantle pane-border surface required by [[tmux-play-48](#tmux-play-48)].
The timer format shall budget two display cells for each emoji glyph because terminal emoji presentation is not uniformly reported by tmux.
The glyph's own color shall be left to the terminal's emoji font; the duration text shall carry the Catppuccin running/frozen cue.

### tmux-play-55

When the launcher constructs a tmux-play session, the navigation hints shall be rendered in `status-left`, and the session-total timer from [[tmux-play-53](#tmux-play-53)] shall be rendered in `status-right`.
The `status-left` segment shall open with the bold brand heading `Spex` rendered in the resolved Catppuccin flavor's `blue` accent per [[tmux-play-47](#tmux-play-47)], followed by a single space and then the navigation hints whose shape is owned by [[tmux-play-63](#tmux-play-63)]; the heading text shall be `Spex` and shall not be `spex`, `Cligent`, or `tmux-play`.
The launcher shall suppress tmux's default window-list segment by setting `window-status-format`, `window-status-current-format`, and `window-status-separator` to empty strings, so the status bar does not render window text such as `0:node*`.
The status-total timer shall refresh roughly once per second while a Boss turn is open and shall freeze between Boss turns.
The status-total timer shall use the hourglass pair from [[tmux-play-54](#tmux-play-54)] — the running glyph `⏳` while a Boss turn is open and the settled glyph `⌛` between turns — so the bottom-right status timer reads with the same flowing-vs-settled cue as the per-pane title timers.
While a Boss turn is open, the duration text shall use Catppuccin `mauve` (`#cba6f7`); between turns, it shall use `overlay1` (`#7f849c`).
The launcher shall set sufficient `status-left-length` and `status-right-length` values so the hints and total timer are not truncated under the 174-column initial window from [[tmux-play-35](#tmux-play-35)].

### tmux-play-71

The duration text for every per-pane timer of [[tmux-play-54](#tmux-play-54)] and for the status-bar total timer of [[tmux-play-55](#tmux-play-55)] shall be rendered in `hh:mm:ss` form, derived from the non-negative integer `s = floor(elapsedMs / 1000)` where `elapsedMs` is the timer's elapsed milliseconds from [[tmux-play-53](#tmux-play-53)] clamped to zero for any negative value, with `h = floor(s / 3600)`, `m = floor(s / 60) mod 60`, and `n = s mod 60`.
The duration text shall be the literal string `<HH>:<MM>:<SS>`, where `<MM>` is `m` and `<SS>` is `n` each rendered as a decimal integer zero-padded to exactly two digits, the components are joined by a single ASCII colon (`:`), and the three components are always present at every magnitude so a session that has accumulated zero active time surfaces as `00:00:00` and a session that has accumulated exactly one hour surfaces as `01:00:00`.
The `<HH>` field shall be the decimal integer `h` zero-padded to at least two digits, expanding to additional digits when `h >= 100` so the format remains monotonic past one hundred hours (`100:00:00` shall follow `99:59:59`) rather than truncating or wrapping.
The duration text shall always carry exactly two digits per component while `h < 100`, so the rendered width stays stable from one second to the next and the Boss never loses sub-minute resolution as a session ages.

### Player Session Continuity

### tmux-play-41

Within a single tmux-play session, each player's `Cligent` instance shall be created once and reused across every Boss turn.
Per [[engine-33](engine.md#engine-33)], the engine shall auto-inject `resume` on subsequent runs when the underlying adapter emits a `resumeToken`, so player responses on later turns may build on prior context for adapters that support session continuity.
When `callPlayer` receives `CallPlayerOptions.resume` as a string, tmux-play shall pass that string through to `Cligent.run()` for the call, overriding any resume token stored on the player's persistent `Cligent`.
When `CallPlayerOptions.resume` is `false`, tmux-play shall pass `false` through to `Cligent.run()` so the call starts fresh even when the player's persistent `Cligent` stores a prior token.
When `CallPlayerOptions.resume` is omitted, tmux-play shall preserve the existing automatic continuity behavior above.
Where complete settings per [[tmux-play-93](#tmux-play-93)] are accepted for a resumed call, tmux-play shall apply them without changing the selected token; where settings are rejected before provider work, the stored token shall remain available to a later call.
This continuity shall include an ESC-aborted Boss turn when a player's interrupted adapter `done` carries a `resumeToken` through [[engine-35](engine.md#engine-35)]'s drain: the next Boss turn that calls the same player shall pass that token as `resume` per [[engine-33](engine.md#engine-33)].
When the interrupted `done` carries no `resumeToken`, tmux-play shall expose the aborted, not-resumable result through [[tmux-play-33](#tmux-play-33)] and keep the player callable normally after the aborted round without rewriting prompts at the runtime or engine layer.

### tmux-play-42

The built-in fanout Captain shall convey each player's identity once, via the player's `instruction` retained as a runtime-held call default and composed at the `Cligent.run()` boundary per [[tmux-play-93](#tmux-play-93)].
Per Boss turn, the per-player prompt the fanout Captain passes to `callPlayer` shall be the Boss prompt verbatim, with no static framing label such as `The Boss asked:`, no player identity preamble such as `You are the "<player>" player`, and no trailing instructions that reference inter-player behavior (e.g., "Respond independently", "Do not wait for other players") — players cannot see other players, so such instructions are unactionable.
Static framing labels and inter-player instructions are permitted only in prompts directed at the Captain itself (e.g., the summarization prompt passed to `callCaptain`), where they describe context for the synthesizer rather than instruct a player.
The verbatim player-prompt rule has one exception: when a player result has `status: 'aborted'` and no `resumeToken`, fanout shall retain that player's base Boss prompt as unresolved recovery context.
On that player's next call, fanout shall pass a recovery prompt containing every retained base Boss prompt for that player plus the latest Boss prompt.
Consecutive no-token aborts shall append only base Boss prompts, not already-composed recovery prompts, so recovery prompts do not nest or balloon.
Fanout shall clear a player's retained recovery context after any non-aborted result, or after an aborted result that carries `resumeToken`, because those paths are either complete or backend-resumable.

### Captain Call Visibility

### tmux-play-72

`callCaptain` shall accept an optional second argument `options: CallCaptainOptions` whose `visibility` field is `'visible' | 'hidden'`, defaulting to `'visible'` when `options` or `visibility` is omitted.

A `'hidden'` call shall run identically to a `'visible'` call and shall return the same `CaptainRunResult` per [[tmux-play-33](#tmux-play-33)] — same `status`, `turnId`, `resumeToken`, `finalText`, and `error`.
The runtime shall still emit the call's `captain_prompt`, `captain_event*`, and `captain_finished` records in the order of [[tmux-play-22](#tmux-play-22)], each carrying the resolved `visibility`, so non-presenter observers receive the full trace regardless of the tag.

The tmux presenter shall produce zero Boss/Captain-pane output for a `'hidden'` call: it shall skip the call's `captain_event` records (so their text never accumulates into a rendered block) and its `captain_finished` record (so no terminal reply, status, or error line is written), in addition to the Captain-prompt body already withheld per [[tmux-play-40](#tmux-play-40)].
For `'visible'` or omitted visibility, Boss/Captain-pane output shall be byte-for-byte identical to the behavior before this option existed.

Because a `'hidden'` call writes no bytes to the Boss/Captain pane, it shall not trigger the live-tail follow of [[tmux-play-69](#tmux-play-69)]: a Boss who has scrolled the Captain pane into copy-mode shall keep that scroll position across a hidden call, since a hidden call's records are no-visible-bytes activity under [[tmux-play-69](#tmux-play-69)].

`callPlayer` shall not accept this option; player visibility is unchanged.

### tmux-play-88

When `CallCaptainOptions.resume` is a string, tmux-play shall pass that string to the Captain `Cligent.run()` call and override its stored automatic resume token; when it is `false`, tmux-play shall pass `false` so the call starts a fresh backend session; when it is omitted, tmux-play shall preserve automatic Captain continuity per [[engine-33](engine.md#engine-33)].
When `CallCaptainOptions.allowedTools` is provided, tmux-play shall copy and pass the exact list to the Captain `Cligent.run()` call; an empty list shall retain its explicit no-tools meaning per [[engine-17](engine.md#engine-17)], while omission shall preserve the Captain's configured or adapter-native tool surface.
The session and tool controls shall not change [[tmux-play-72](#tmux-play-72)]'s record visibility, result, or presentation semantics.

### tmux-play-93

Where `CallPlayerOptions.settings` or `CallCaptainOptions.settings` is omitted, when tmux-play invokes that agent, it shall supply the configured model, effort, instruction, and permissions as the complete runtime-held call defaults, with each supplied permission policy mapped by the adapter per [[engine-52](engine.md#engine-52)], omitting each unconfigured field so its provider default remains in control; this tmux-play layer shall not change generic `Cligent` option merging outside the runtime per [[engine-3](engine.md#engine-3)].
Where `settings` is supplied, when tmux-play admits the call, it shall require one closed `AgentCallSettings` object whose `model` and `effort` each select either `{ kind: 'value', value: <nonempty string> }` or `{ kind: 'provider-default' }`, and whose optional `instruction` and `permissions` per [[engine-21](engine.md#engine-21)] are the complete effective values for that call; omitted instruction or permissions shall mean none, and no member shall merge with configured call settings.
The runtime shall capture the complete object, its selections, and permission data as a detached frozen snapshot before asynchronous work, and shall reject accessors, unknown fields, incomplete selections, invalid effort vocabularies, or settings an adapter cannot enforce before emitting `player_prompt` or `captain_prompt` and before calling the adapter.
At call admission, tmux-play shall resolve the effective session selection exactly once from the explicit token, forced-fresh selection, or stored automatic token per [[tmux-play-41](#tmux-play-41)] and [[tmux-play-88](#tmux-play-88)]; reset preflight and the eventual `Cligent.run()` invocation shall use that same detached selection.
The runtime-owned `Cligent` shall carry none of the configured model, effort, instruction, or permissions call defaults; where a supplied selector chooses `provider-default`, tmux-play shall omit the selected option from `Cligent.run`, so Codex and Gemini use their current provider default on fresh or resumed calls and Claude and OpenCode do so on fresh calls.
Where a concrete Gemini effort has no model alias from [[gemini-11](adapters/gemini.md#gemini-11)], or a concrete OpenCode effort has no variant from [[opencode-12](adapters/opencode.md#opencode-12)], the call shall reject rather than silently ignore the effort.
Where a resumed Claude call selects a provider-default model, the call shall reject because [[claude-code-6](adapters/claude-code.md#claude-code-6)] exposes only omission, which restores the prior transcript model; where it supplies a concrete model with provider-default effort, tmux-play shall omit effort per [[claude-code-8](adapters/claude-code.md#claude-code-8)] so Claude uses that model's default effort.
Where a resumed OpenCode call selects a provider-default model, the call shall reject because OpenCode persists the prior session model and variant and [[opencode-12](adapters/opencode.md#opencode-12)] exposes no model reset; where it supplies a concrete model with provider-default effort, tmux-play shall omit the variant per [[opencode-14](adapters/opencode.md#opencode-14)] so OpenCode resets that model to its default effort.
Where a resumed OpenCode call's complete settings omit permissions, tmux-play shall clear its prior Cligent-owned session permission ruleset through [[opencode-32](adapters/opencode.md#opencode-32)]'s reset surface before prompting rather than preserve a policy from an earlier call.
Where a resumed Kimi call selects provider-default model or effort or omits complete permissions, the call shall reject because [[kimi-4](adapters/kimi.md#kimi-4)], [[kimi-23](adapters/kimi.md#kimi-23)], [[kimi-7](adapters/kimi.md#kimi-7)], and [[kimi-9](adapters/kimi.md#kimi-9)] expose no operation that restores a resumed session's provider default model, effort, or permission mode; a fresh Kimi call may use provider-default and no permissions, while a resumed Kimi call shall use concrete model and effort values plus an adapter-enforceable complete permission policy.
Any preflight rejection shall emit no call record, perform no provider run, and preserve the runtime's stored resume token.
The `@sublang/cligent/tmux-play` sub-export shall expose the public `TuningSelection` and `AgentCallSettings` types; every rejection caused by a supplied complete settings object at this boundary shall be an exported `AgentCallSettingsError` carrying the original diagnostic in `message` and the original rejection in `cause`, and the exported `isAgentCallSettingsError()` predicate shall recognize it across copies of the package.
Turn or session scope rejection, unknown-player rejection, provider execution failure, and observer dispatch failure shall not carry that classification.

### tmux-play-94

Where an embedding front end owns an interactive process lifecycle, when it launches tmux presentation through `launchManagedTmuxPlay`, the launcher shall require a caller-supplied public `sessionId` matching `^[A-Za-z0-9][A-Za-z0-9_-]*$`, reject any other value before work-directory or tmux-session mutation, pass the accepted id, the exact derived tmux session name `tmux-play-<sessionId>`, work directory, a `workDirOwnedByLauncher` boolean, config snapshot path, readiness path, input-gate path, input-active path, shutdown-request path, shutdown-complete path, and working directory to a caller-supplied session-command factory, run that returned command in the Boss/Captain pane, and return a prepared launch only after the child publishes successful initialized readiness.
When `runManagedTmuxPlaySession` is invoked directly, the child runner shall independently require the same `sessionId` grammar before agent isolation, presentation construction, lifecycle invocation, or work-state mutation.
The prepared launch shall leave Boss input gated so the caller can report the public id before awaiting `attach(options?)`; `attach()` shall open the gate, await the child's input-active acknowledgement, use the resolved layout for any outer terminal resize, and then attach unless attachment was disabled, while `cancel()` shall request graceful child shutdown without activating input, await the child's post-cleanup shutdown-complete acknowledgement and pane exit, and force-terminate the tmux session only when graceful shutdown is unavailable or exceeds the bounded wait.
Where `attach({ signal, beforeNativeAttach })` receives an already-aborted signal or that signal aborts before native client handoff, the prepared launch shall keep the signal's reason primary, request and await the same bounded failure-complete child shutdown, pane exit, owned-work cleanup, and coordination cleanup as an attachment failure, aggregate every secondary cleanup defect after that reason, reject only after cleanup, and never invoke `beforeNativeAttach` or the native client.
Where attachment is enabled and activation succeeds without abort, the prepared launch shall synchronously stop managed abort handling and invoke `beforeNativeAttach` at most once as the last operation before starting the native tmux client, after which signals belong to the embedding and native client rather than managed cancellation; where attachment is disabled, it shall never invoke that callback and shall retain abort ownership through coordination cleanup.
The launcher shall capture and monitor the original Boss pane's stable tmux pane id rather than a positional pane index, bound readiness and activation by `readinessTimeoutMs` and graceful shutdown completion plus pane exit by the independent `shutdownTimeoutMs`, request and await graceful child shutdown when initialization or attachment fails after pane creation, and clean up its coordination files only after activation or shutdown acknowledgement.
After a forced tmux teardown, the launcher shall allow only a fixed 500 ms pane-disappearance verification window; if the pane remains visible, it shall retain child-owned work and coordination state and report that retirement defect after any initiating failure.
A launcher-created work directory shall carry a launcher-ownership marker whose complete contents match the public `sessionId`; the launcher shall remove that directory when no child can own cleanup, and the child shall remove it during managed shutdown only when its public `ManagedTmuxPlaySessionOptions.workDirOwnedByLauncher` input is `true` and the marker still matches its own session id.
A caller-supplied session-command factory shall pass the launch context's `workDirOwnedByLauncher` value unchanged to `runManagedTmuxPlaySession`; marker presence alone shall never establish child cleanup ownership.
A caller-supplied work directory shall carry no launcher-ownership marker and shall never be removed recursively by the launcher or child; the directory itself and unrelated pre-existing entries shall survive every launch and shutdown path.
Teardown shall be scoped to what this invocation created: force-termination shall target only the session whose identity the launcher captured at creation, and where a session by the derived name already exists when the launch begins, the launch shall reject without terminating that session.
Ownership shall precede mutation: the launcher shall not truncate, overwrite, or create artifacts a same-name session could share — its per-player logs, its config snapshot, or its launcher-ownership marker — before acquiring the session name, so a launch rejected for a collision leaves the existing session's artifact bytes unchanged.
When `attach: false` succeeds, the prepared handle activates input, closes the launcher coordination boundary, and returns without an outer client; the child remains the owner, and SIGHUP, another session signal, or EOF remains its cleanup path.
The launcher shall publish its input-gate and shutdown-request markers atomically and with create-once conflict semantics, so the child observes either no marker or the complete valid marker and never a partial write.
When the child runs `runManagedTmuxPlaySession`, it shall apply the session-mode agent isolation of [[tmux-play-74](#tmux-play-74)] before constructing presentation resources or invoking the caller's `initializeRuntime({ sessionId, config, observers, cwd })`; the returned initialized-or-restored runtime shall own the supplied gated observers, and successful readiness shall be published only after runtime initialization and input handlers exist.
Input received before activation shall be queued semantically without starting a turn, including preserving one bracketed multiline paste as one newline-bearing prompt; input shall become admissible only after the gate opens, and the child shall then publish the input-active acknowledgement before dispatching queued prompts.
Once shutdown starts, it shall publish neither readiness nor activation and shall admit no queued input.
Where Boss input is empty or whitespace-only, the managed lifecycle hooks and runtime shall not run.
Where Boss input is nonempty, the session shall await `beforeNonEmptyTurn({ sessionId, prompt })` before `runBossTurn`, buffer every `captain_reply` away from all presentation observers, await the runtime's complete turn fence, and then call `afterTurn({ sessionId, prompt, replies, terminal })` with detached reply records and the exact `turn_finished` or `turn_aborted` terminal record.
When `afterTurn` succeeds for a finished turn, the session shall release buffered replies to presentation observers in original order, including when shutdown has already started and is awaiting that transaction; an aborted turn shall release none, and initialization, before-hook, runtime-turn, or after-hook failure shall also release none and shall reject after managed shutdown.
Where `runBossTurn` rejects after emitting a fenced terminal record, the session shall still invoke `afterTurn` with that exact terminal and the buffered replies before propagating the runtime failure through ordered managed shutdown; it shall release no buffered reply.
On ordinary EOF, SIGHUP, SIGINT, SIGTERM, embedding shutdown request, or failure shutdown, the session shall stop accepting input, request active-turn abort, await the complete managed turn transaction including any active hook, dispose the runtime, then invoke and await `shutdown({ sessionId, reason, error? })`, clean up presentation resources and launcher-owned work state, publish shutdown-complete only after those ordered steps, and settle one shared shutdown promise so lifecycle release never overlaps write-ahead, settlement, semantic runtime disposal, or acknowledgement.
The embedding shutdown-request marker shall use the exact reason `embedding shutdown request` for both active-turn abort and the lifecycle shutdown hook, distinct from the exact `SIGHUP` reason produced by that signal.
Where managed shutdown encounters more than one failure, the session shall preserve the initiating failure first and expose every distinct later disposal, lifecycle, presentation, work-state, acknowledgement, or pane-cleanup defect in one aggregate; a single failure shall retain its original identity.
The `@sublang/cligent/tmux-play` sub-export shall expose the runtime values `launchManagedTmuxPlay` and `runManagedTmuxPlaySession` plus the public types `LaunchManagedTmuxPlayOptions`, `LaunchTmuxPlayResult`, `ManagedTmuxPlayAttachOptions`, `ManagedTmuxPlayLaunchContext`, `PreparedManagedTmuxPlayLaunch`, `ManagedTmuxPlayInitializeContext`, `ManagedTmuxPlayTurnContext`, `ManagedTmuxPlayAfterTurnContext`, `ManagedTmuxPlayTerminalRecord`, `ManagedTmuxPlayShutdownContext`, `ManagedTmuxPlayLifecycle`, `ManagedTmuxPlaySessionOptions`, and `TmuxPlayRuntimeHandle`.
The existing `launchTmuxPlay`, `runTmuxPlaySession`, direct `createTmuxPlayRuntime`, and generic `Cligent` APIs shall retain their behavior outside the managed boundary.

### Pane Identity

### tmux-play-96

When the launcher creates the Boss/Captain and player panes, it shall assign each pane a logical key — `captain` for the Boss/Captain pane, the player `id` for a player pane — in pane-scoped tmux state observable through tmux's per-pane option query surface.
When the layout observer rebuilds the player area per [[tmux-play-83](#tmux-play-83)], it shall reassign the same keys to the recreated panes, so every pane carries its key for the session's whole life.
Pane-addressed operations — pane-width soft-wrap, the per-pane border timers per [[tmux-play-54](#tmux-play-54)], and copy-mode live-follow per [[tmux-play-69](#tmux-play-69)] — shall resolve their target pane through that logical key and tmux's stable pane id, and machine-readable pane queries shall separate fields with a character no logical key can contain, so no operational lookup parses the displayed pane title of [[tmux-play-48](#tmux-play-48)].
Where the tmux server normalizes non-ASCII display text — a non-UTF-8 server locale rewrites the title's ` · ` separator — pane-addressed operations shall be unaffected; when the composed title fails to round-trip through the server, reading back different from what was set, the launcher shall print a one-line warning naming the display limitation and shall not refuse the launch; where the round-trip succeeds, no warning shall be printed, the server's observed behavior rather than the launcher process's locale variables being the deciding signal.

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

Where the home and cwd are empty and the `claude` and `codex` adapter runtimes are installed, when launching `tmux-play` without `--config`, the home YAML shall be created with the default `fanout` Captain plus `claude` and `codex` players with identity instructions, the default Captain and `claude` player shall use `model: claude-opus-4-8` with `effort: xhigh`, the default `codex` player shall use `model: gpt-5.5` with `effort: xhigh`, and the default Captain and both default players shall carry `permissions: { mode: 'auto' }` per [[tmux-play-11](#tmux-play-11)].
The created YAML shall also carry an explicit `layout` block with `window: { columns: 174, rows: 49 }` and `multiPlayerColumnWeights: [1, 1, 1]` (and no `columnWeights` key) per [[tmux-play-11](#tmux-play-11)], plus `notifications: { player_finished: bell, turn_finished: desktop }` per [[tmux-play-76](#tmux-play-76)].
A one-line notice naming the path and the installed adapters the roster was built from shall be printed to stdout, and a second invocation against that freshly-created home YAML shall leave the file unchanged [[tmux-play-10](#tmux-play-10)], [[tmux-play-90](#tmux-play-90)], [[tmux-play-11](#tmux-play-11)], [[tmux-play-76](#tmux-play-76)].

### tmux-play-102

Given a `tmux-play.config.yaml` in cwd and a different YAML at the home location, when launching, the cwd config shall be loaded and the home file shall be left untouched [[tmux-play-9](#tmux-play-9)].

### tmux-play-103

Given `XDG_CONFIG_HOME` set to a non-empty path, when launching, the home location shall be `${XDG_CONFIG_HOME}/tmux-play/config.yaml`.
Given `XDG_CONFIG_HOME` empty or unset, the home location shall be `~/.config/tmux-play/config.yaml` [[tmux-play-9](#tmux-play-9)].

### tmux-play-104

Given a `tmux-play.config.{mjs,js,json}` in cwd and no cwd YAML, when launching, a one-line stderr warning shall name the legacy file before normal execution proceeds [[tmux-play-12](#tmux-play-12)].

### tmux-play-105

Given malformed YAML or a config that violates the schema (unknown adapter, unknown field, invalid player id, duplicate player id, player id `captain`, or missing/non-array `players`), when launching, the launcher shall fail with an error naming the offending file or path [[tmux-play-5](#tmux-play-5)], [[tmux-play-6](#tmux-play-6)], [[tmux-play-7](#tmux-play-7)], [[tmux-play-8](#tmux-play-8)].
Given an empty `players` array, when loading the config, the launcher shall accept it per [[tmux-play-5](#tmux-play-5)].

### tmux-play-106

Given a cwd config whose `captain.from` is a relative local path, when session mode imports the Captain, resolution shall be anchored at the original config file's directory; package specifiers shall reach Node's resolver unchanged [[tmux-play-13](#tmux-play-13)].

### tmux-play-107

Given a Captain that calls one player then `callCaptain`, when handling a Boss turn, observers shall receive records in this order: `turn_started`, `player_prompt`, `player_event`*, `player_finished`, `captain_prompt`, `captain_event`*, `captain_finished`, `turn_finished`.
All shall carry the same `turnId` [[tmux-play-22](#tmux-play-22)], [[tmux-play-21](#tmux-play-21)].

### tmux-play-108

Given two registered observers, when a record is emitted, both shall receive the record in registration order before the dispatcher releases the next record [[tmux-play-23](#tmux-play-23)], [[tmux-play-24](#tmux-play-24)].

### tmux-play-109

When a Captain emits `emitStatus` from `init`, the resulting `captain_status` record shall arrive at every observer with `turnId: null` before any `turn_started` [[tmux-play-17](#tmux-play-17)], [[tmux-play-21](#tmux-play-21)].

### tmux-play-110

When the abort signal fires during a turn, the runtime shall emit `turn_aborted` (not `turn_finished`); turn-bound emissions enqueued before the abort shall drain first [[tmux-play-24](#tmux-play-24)], [[tmux-play-26](#tmux-play-26)].
Where session mode receives SIGHUP, SIGINT, SIGTERM, or stdin EOF, it shall abort active work and complete the shutdown lifecycle per [[tmux-play-26](#tmux-play-26)].

### tmux-play-111

When a registered observer rejects, the runtime shall emit `runtime_error` to remaining observers, abort the active turn if any, and complete normal cleanup.
The runtime call may reject; whether it does is unconstrained by this item [[tmux-play-25](#tmux-play-25)].

### tmux-play-112

On session shutdown, `Captain.dispose()` shall run exactly once, after the active turn unwinds and after accepted session emissions drain.
Post-shutdown `emitStatus`/`emitTelemetry` calls shall reject [[tmux-play-19](#tmux-play-19)].

### tmux-play-113

Given the built bin on PATH (or invoked directly with execute permission), when launched on a POSIX runner, `tmux-play --help` shall exit 0 and print a usage banner [[tmux-play-1](#tmux-play-1)].

### tmux-play-114

Given N configured players and `layout.initialVisible` omitted — so all N configured players are visible per [[tmux-play-80](#tmux-play-80)] — when the launcher constructs the tmux session, the layout shall be Boss/Captain on the left and N player panes on the right in config order; with N ≥ 2 the first player column shall hold `ceil(N / 2)` players top-to-bottom. (Visible-subset startup topology is covered by [[tmux-play-182](#tmux-play-182)].)
Given N = 0, when the launcher constructs the tmux session, it shall create exactly one full-width Boss/Captain pane, no split or player log-tail process, and shall still apply the Captain title, timer options, input and mouse bindings, and resize hooks safely.
When that real tmux window is resized, the sole pane shall remain full-width.
Given a YAML config that omits `layout.columnWeights`, each visible column shall occupy its share of the window width per the shipped defaults of [[tmux-play-64](#tmux-play-64)]: with N = 1 the weights are `[1, 1]` (Boss/Captain and player each 1/2); with N ≥ 2 the weights are `[1, 1, 1]` (Boss/Captain and each player column each 1/3, rightmost absorbing the remainder).
Given a YAML config that supplies an explicit `layout.columnWeights`, the resolved region widths shall follow that ratio at the resolved `layout.window.columns` per [[tmux-play-28](#tmux-play-28)] and [[tmux-play-44](#tmux-play-44)].

### tmux-play-115

Given a snapshot file at the work directory, when session mode runs, the Captain shall be imported once from `captain.from` (a `file://` URL for local paths or a package specifier) and Boss turns shall flow through the runtime per [[tmux-play-107](#tmux-play-107)] [[tmux-play-3](#tmux-play-3)], [[tmux-play-34](#tmux-play-34)].

### tmux-play-116

Given the built-in fanout Captain and the five supported adapters (`claude`, `codex`, `gemini`, `kimi`, and `opencode`) as players with valid credentials, when handling a Boss turn that requires a sentinel token in every reply, every `player_finished` shall report `status: 'ok'` with the sentinel in `finalText`, the single `captain_prompt` shall contain one delimited result section per player that names its status and includes its final text with the sentinel, and `captain_finished` shall report `status: 'ok'` with the sentinel in `finalText`.
`runtime_error` and `turn_aborted` shall not appear.
The Kimi leg shall share the acceptance suite's single temporary Kimi home clone without mutating the source home it was copied from, shall resolve the `kimi` CLI from `PATH` or that home's managed `bin` directory, and shall self-skip with a precise reason — under `CI` as well — when the shared credential is present but spent, no runner configuration being able to supply a fresh token.
It shall retry the complete fresh probe after, and only after, an explicit upstream-overload, rate-limit, or service-unavailable failure, shall make at most two retries, and shall treat any other failure and the third consecutive named transient failure as fatal.
The composite fanout item shall self-skip locally when any required player or Captain dependency is absent and shall hard-fail under `CI` [[tmux-play-30](#tmux-play-30)].

### tmux-play-117

Given the fanout Captain and N configured players, when handling a Boss turn, all N `player_prompt` records shall be emitted before any `player_finished` record (concurrent dispatch), and the `captain_prompt` record shall be emitted only after every `player_finished` [[tmux-play-30](#tmux-play-30)].
Given the fanout Captain and N = 0 configured players, when handling a Boss turn, the Captain shall make no player call and exactly one Captain call.

### tmux-play-118

When `Captain.init(session)` rejects before any turn starts, the runtime shall emit `runtime_error` with `turnId: null` to every registered observer, run shutdown, and shall not deliver any `turn_started` record [[tmux-play-25](#tmux-play-25)].

### tmux-play-119

When `handleBossTurn` rejects mid-turn, the runtime shall emit `runtime_error` carrying the active `turnId`, then `turn_aborted`, and shall complete shutdown [[tmux-play-25](#tmux-play-25)].

### tmux-play-120

Given a cwd YAML config whose `captain.from` is a relative local path and a separate config whose `captain.from` is a package specifier, when the launcher prepares each session, the work directory shall contain a JSON snapshot in which the local path is rewritten to an absolute `file://` URL and the package specifier is preserved verbatim.
Mutations to the YAML after launch shall not affect the running session [[tmux-play-34](#tmux-play-34)].

### tmux-play-121

Given a YAML config that omits `layout.window`, when the launcher creates the tmux session, the `new-session` invocation shall request a 174-column by 49-row grid (sized for 1920×1080 at 18pt monospace) [[tmux-play-35](#tmux-play-35)], [[tmux-play-64](#tmux-play-64)].
Given a YAML config that supplies an explicit `layout.window` (for example `columns: 200, rows: 50`), the `new-session` invocation shall request `-x 200 -y 50` and shall not fall back to the default 174×49.

### tmux-play-122

Given two or more players, a YAML config that omits `layout.columnWeights`, and `layout.initialVisible` omitted (so all configured players are visible per [[tmux-play-80](#tmux-play-80)]), when the launcher constructs the tmux session against a 174-column-wide grid, the Boss/Captain pane shall occupy 58 columns, the first player column shall occupy 58 columns, and the second player column shall occupy 58 columns — matching the shipped `[1, 1, 1]` multi-player default, within tmux's nearest-cell rounding [[tmux-play-28](#tmux-play-28)], [[tmux-play-64](#tmux-play-64)].

### tmux-play-123

Given players with ids `coder` and `reviewer`, when the launcher sets pane titles, the display name carried by the Boss/Captain pane title shall be `Captain` and those carried by the player pane titles shall be `Coder` and `Reviewer` respectively, each within the full title composed per [[tmux-play-48](#tmux-play-48)].
No pane title shall contain the substring `Player:` [[tmux-play-36](#tmux-play-36)].

### tmux-play-124

Given session mode is running, when the user enters a Boss prompt, the captured Boss/Captain pane content shall contain the prompt text exactly once [[tmux-play-37](#tmux-play-37)].

### tmux-play-125

Given session mode handling a Boss turn, the captured Boss/Captain pane shall contain a line beginning with `boss> ` for the Boss input and a nonblank line beginning with `captain> ` for the Captain's reply; the captured player pane shall contain a nonblank line beginning with `captain> ` for the Captain's prompt and a nonblank line beginning with `<playerId>> ` for the player's reply.
Multi-line presenter output blocks shall render continuation lines with a two-space hanging indent and no repeated speaker prefix; leading blank lines shall remain blank and shall not consume the first speaker prefix.
The strings `[from captain]` and `[captain llm prompt]` shall not appear in any pane [[tmux-play-38](#tmux-play-38)].

### tmux-play-126

Given a player and Captain that finish with `status: 'ok'`, the captured pane content shall not contain `[player <id> ok]` or `[captain ok]`.
Given a player that finishes with `status: 'error'`, the player pane shall contain a single `<playerId>> [error] <message>` line where `<message>` matches `result.error` and sits outside the brackets; given a Captain run that finishes with `status: 'error'`, the Boss/Captain pane shall contain a single `captain> [error] <message>` line where `<message>` matches `result.error` and sits outside the brackets.
Given a player that finishes with `status: 'aborted'`, the player pane shall contain a single `<playerId>> [aborted]` line; given a Captain run that finishes with `status: 'aborted'`, the Boss/Captain pane shall contain a single `captain> [aborted]` line.
Given a `runtime_error` record with `message: 'boom'` on the Boss/Captain pane, the rendered line shall be `captain> [runtime error] boom` — body outside the brackets, not `[runtime error: boom]`.
Given a `turn_aborted` record with reason `ESC`, the rendered line shall be `captain> [turn aborted] ESC` [[tmux-play-39](#tmux-play-39)].

### tmux-play-127

Given the fanout Captain handling a Boss turn, the captured Boss/Captain pane shall not contain any line beginning with `=== player:<id>` and shall not contain a `=== /player:<id> ===` line — i.e., the open/close sentinel framing of the Captain's prompt body shall not leak through.
Synthesized references to player content within the Captain's reply shall be permitted [[tmux-play-40](#tmux-play-40)].

### tmux-play-128

Given a tmux-play session and a player whose adapter supports `resumeToken`, when the runtime handles two Boss turns in sequence, the player's `Cligent` instance on the second turn shall be the same instance as on the first turn, and the second `run()` call shall pass `resume: <resumeToken>` to the adapter where the token came from the prior `done` event [[tmux-play-16](#tmux-play-16)], [[tmux-play-41](#tmux-play-41)].
Given that persistent player `Cligent` stores an automatic resume token, when a Captain calls `callPlayer(playerId, prompt, { resume: <explicitToken> })`, the adapter shall receive `resume: <explicitToken>` rather than the stored automatic token [[tmux-play-16](#tmux-play-16)], [[tmux-play-41](#tmux-play-41)].
Given that persistent player `Cligent` stores an automatic resume token, when a Captain calls `callPlayer(playerId, prompt, { resume: false })`, the adapter shall receive no resume token and the call shall start a fresh backend session [[tmux-play-16](#tmux-play-16)], [[tmux-play-41](#tmux-play-41)].
Given the first Boss turn is aborted by ESC while a player call is active and that player's interrupted `done` carries `resumeToken: <resumeToken>`, when a later Boss turn calls the same player, the same `Cligent` instance shall pass `resume: <resumeToken>`, the `PlayerRunResult` for the aborted call shall expose `resumeToken: <resumeToken>`, and the runtime shall finish the later turn normally [[tmux-play-16](#tmux-play-16)], [[tmux-play-33](#tmux-play-33)], [[tmux-play-41](#tmux-play-41)].
Given the first Boss turn is aborted by ESC while a player call is active and that player's interrupted `done` carries no `resumeToken`, when a later Boss turn calls the same player with no explicit resume override, the aborted `PlayerRunResult` shall omit `resumeToken`, the same `Cligent` instance shall pass no `resume` option, and the runtime/engine shall pass through the prompt supplied by the Captain rather than doing its own replay rewrite [[tmux-play-16](#tmux-play-16)], [[tmux-play-33](#tmux-play-33)], [[tmux-play-41](#tmux-play-41)].

### tmux-play-129

Given the fanout Captain handling a Boss turn with no unresolved no-token abort for a player, the prompt string passed to that player's `callPlayer` shall equal the Boss prompt verbatim — no static framing label (`The Boss asked`), no player identity preamble (`You are the`), no player-id repetition, and no inter-player trailing instructions (`Respond independently`, `other players`).
The player's runtime-held `instruction`, composed at the call boundary, shall be the sole source of player identity [[tmux-play-42](#tmux-play-42)].
Given a fanout player call returns `status: 'aborted'` with no `resumeToken`, when fanout handles a later Boss turn, that player's `callPlayer` prompt shall contain the retained aborted Boss prompt and the latest Boss prompt.
Given consecutive no-token aborts, the later recovery prompt shall contain each retained base Boss prompt once and shall not nest a prior recovery prompt.
Given an aborted player call carries `resumeToken`, the next fanout prompt for that player shall remain the Boss prompt verbatim because backend resume handles continuity.

### tmux-play-130

Given a real tmux server, when `launchTmuxPlay({ attach: false })` returns, `tmux display-message -t <session> -p '#{window_width}x#{window_height}'` shall report `174x49` [[tmux-play-35](#tmux-play-35)].
The probe shall exercise a real `tmux` server rather than a mock or an argv log, shall run under `*.acceptance.test.ts` via `npm run test:acceptance`, shall self-skip when either `tmux -V` or `glow -v` fails since the launcher gates on both [[tmux-play-51](#tmux-play-51)], and shall not gate on adapter API keys.

### tmux-play-131

Given a real tmux server with two configured players and a YAML config that omits `layout.columnWeights` and `layout.initialVisible` (so both configured players are visible per [[tmux-play-80](#tmux-play-80)]), when `launchTmuxPlay({ attach: false })` returns, `tmux list-panes` shall report exactly three panes matching the shipped `[1, 1, 1]` multi-player default: a Boss/Captain pane at `pane_left=0` with effective width 58 columns (less tmux's 1-cell border), a first player column at `pane_left=58` with effective width 58 columns (less tmux's 1-cell border), and a second player column at `pane_left=116` with effective width 58 columns.
Pane order in `list-panes` index space shall match config order [[tmux-play-27](#tmux-play-27)], [[tmux-play-28](#tmux-play-28)], [[tmux-play-64](#tmux-play-64)].
The probe shall exercise a real `tmux` server rather than a mock or an argv log, shall run under `*.acceptance.test.ts` via `npm run test:acceptance`, shall self-skip when either `tmux -V` or `glow -v` fails since the launcher gates on both [[tmux-play-51](#tmux-play-51)], and shall not gate on adapter API keys.

### tmux-play-132

Given a real tmux server with player ids `coder` and `reviewer`, when `launchTmuxPlay({ attach: false })` returns, `tmux display-message -p '#{pane_title}'` against each pane shall return the title composed per [[tmux-play-48](#tmux-play-48)] from the pane's display name and its configured adapter: `Captain · <captain adapter>` for the Boss/Captain pane, `Coder · <coder adapter>` for the first player pane, and `Reviewer · <reviewer adapter>` for the second player pane [[tmux-play-36](#tmux-play-36)].
The probe shall exercise a real `tmux` server rather than a mock or an argv log, shall run under `*.acceptance.test.ts` via `npm run test:acceptance`, shall self-skip when either `tmux -V` or `glow -v` fails since the launcher gates on both [[tmux-play-51](#tmux-play-51)], and shall not gate on adapter API keys.

### tmux-play-133

Given a real tmux server, when `launchTmuxPlay({ attach: false })` returns, every player pane shall report `#{pane_input_off}=1` (input disabled) and the Boss/Captain pane shall report `#{pane_input_off}=0`.
After `tmux send-keys -t <player-pane> '<probe>'` is invoked with a unique probe string, `tmux capture-pane -p` against that player pane shall not contain the probe [[tmux-play-27](#tmux-play-27)].
The probe shall exercise a real `tmux` server rather than a mock or an argv log, shall run under `*.acceptance.test.ts` via `npm run test:acceptance`, shall self-skip when either `tmux -V` or `glow -v` fails since the launcher gates on both [[tmux-play-51](#tmux-play-51)], and shall not gate on adapter API keys.

### tmux-play-134

Given a launcher invocation with `attach: true` and stdout routed to an in-memory writer, when `launchTmuxPlay` completes against a YAML config that omits `layout.window`, the writer's content shall contain the byte sequence `\x1b[8;49;174t`, and that sequence shall have been written before the test's `attachTmuxSession` mock is invoked [[tmux-play-43](#tmux-play-43)], [[tmux-play-64](#tmux-play-64)].
Given the same invocation against a YAML config that supplies an explicit `layout.window` (for example `columns: 200, rows: 50`), the writer's content shall contain `\x1b[8;50;200t` and shall not contain `\x1b[8;49;174t`, so the pre-attach CSI 8 payload reads from the same `layout.window` source of truth as `new-session -x/-y` per [[tmux-play-35](#tmux-play-35)].
The probe shall exercise a real `tmux` server rather than a mock or an argv log, shall run under `*.acceptance.test.ts` via `npm run test:acceptance`, shall self-skip when either `tmux -V` or `glow -v` fails since the launcher gates on both [[tmux-play-51](#tmux-play-51)], and shall not gate on adapter API keys.

### tmux-play-135

Given a real tmux server with two configured players and a YAML config that omits `layout.columnWeights` and `layout.initialVisible` (so both configured players are visible per [[tmux-play-80](#tmux-play-80)]), when `launchTmuxPlay({ attach: false })` returns and the test forces the window to size `W × H` via `tmux resize-window` (with `window-size manual`), `tmux list-panes` shall report the Boss/Captain pane region width equal to `floor(W / 3)`, the first player column region width equal to `floor(W / 3)`, and the second player column region width equal to the remainder, where region width = `pane_width + 1` for each pane with a right-side border separator [[tmux-play-44](#tmux-play-44)], [[tmux-play-64](#tmux-play-64)].
The invariant shall hold at multiple sample sizes (e.g., `80×24`, `160×40`, `200×50`).
Given the same setup with an explicit non-equal `layout.columnWeights` (for example `[3, 5, 5]`), the per-column region widths shall follow the generalized formula `floor(W * w_i / sum(w))` for each non-rightmost column `i`, with the rightmost column absorbing the remainder, so an explicit override is honored distinctly from the equal-thirds default.
Given the default three-column setup with a real attached client whose PTY is 108 columns wide, when the PTY shrinks to 61 columns and then grows through 83 to 142 columns while the client remains attached, the tmux window shall observe those widths and, after bounded settlement at 142, the pane regions shall remain continuously `[47, 47, 48]` for the stability interval, proving an earlier background worker cannot overwrite the final negotiated width.
Given a tmux version older than 3.3, launcher preparation shall reject before config resolution or any tmux session command with a diagnostic naming the 3.3 minimum.
The probe shall exercise a real `tmux` server rather than a mock or an argv log, shall run under `*.acceptance.test.ts` via `npm run test:acceptance`, shall self-skip when either `tmux -V` or `glow -v` fails since the launcher gates on both [[tmux-play-51](#tmux-play-51)], and shall not gate on adapter API keys.

### tmux-play-136

Given a real tmux server with configured players, when `launchTmuxPlay({ attach: false })` returns, `tmux list-panes` shall report `#{pane_active}=1` for the Boss/Captain pane and `#{pane_active}=0` for every player pane [[tmux-play-45](#tmux-play-45)].
The probe shall exercise a real `tmux` server rather than a mock or an argv log, shall run under `*.acceptance.test.ts` via `npm run test:acceptance`, shall self-skip when either `tmux -V` or `glow -v` fails since the launcher gates on both [[tmux-play-51](#tmux-play-51)], and shall not gate on adapter API keys.

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
The probe shall exercise a real `tmux` server rather than a mock or an argv log, shall run under `*.acceptance.test.ts` via `npm run test:acceptance`, shall self-skip when either `tmux -V` or `glow -v` fails since the launcher gates on both [[tmux-play-51](#tmux-play-51)], and shall not gate on adapter API keys.

### tmux-play-138

Given the launcher building a tmux session with the Mocha flavor resolved per [[tmux-play-47](#tmux-play-47)] (no explicit flavor, no YAML concrete flavor, and no parseable OSC 11 answer), the `tmux set` calls issued shall include the Mocha theme entries enumerated by [[tmux-play-47](#tmux-play-47)] — anchored by `default-terminal=tmux-256color`, `terminal-overrides` appended with `,*:RGB`, `status-style=fg=#cdd6f4,bg=#181825`, `pane-active-border-style=fg=#89b4fa`, and `pane-border-style=fg=#6c7086` — and shall not include `window-style`, `window-active-style`, `window-status-style`, or `window-status-current-style` since the canonical Catppuccin tmux pattern leaves the pane content area on the user's terminal-native canvas and the window-list formats are empty strings.
Every theme `set` shall appear before the launcher's own `pane-border-format`, `status-left`, and `status-right` option calls so the launcher's content strings remain authoritative on options the theme does not claim.
Given the same launcher invocation with `themeFlavor: 'latte'` or a parseable light-background OSC 11 reply, the same option keys shall be set with their Latte hex values per [[tmux-play-47](#tmux-play-47)]'s palette table — e.g., `status-style=fg=#4c4f69,bg=#e6e9ef`, `pane-active-border-style=fg=#1e66f5`, `pane-border-style=fg=#9ca0b0` — proving the flavor selection reaches the tmux server [[tmux-play-47](#tmux-play-47)].

### tmux-play-139

Given a launched session, `show-options -gv` on the real tmux server shall report `default-terminal = tmux-256color` and `terminal-overrides` containing `*:RGB`, confirming the launcher's `tmux set` calls applied to a real server (a stricter check than [[tmux-play-138](#tmux-play-138)]'s argv inspection).
The probe shall run against an actual tmux server (no mocks) and shall self-skip when either `tmux -V` or `glow -v` fails, since the launcher gates on both per [[tmux-play-51](#tmux-play-51)].
Whether a real terminal client subsequently negotiates the `RGB` capability is tmux's own contract, beyond the launcher's control surface, and is not asserted here [[tmux-play-47](#tmux-play-47)].

### tmux-play-140

Given a config with captain adapter `claude` and players `coder` (adapter `codex`) and `reviewer` (adapter `gemini`), when the launcher sets pane titles, the captain pane title shall be `Captain · claude` and the player pane titles shall be `Coder · codex` and `Reviewer · gemini` respectively.
The separator shall be ` · ` (space, middle dot, space).
The per-adapter accent lookup shall be flavor-aware per [[tmux-play-48](#tmux-play-48)]: with flavor `'mocha'` it returns `#a6e3a1` for `claude`, `#94e2d5` for `codex`, `#b4befe` for `gemini`, `#74c7ec` for `kimi`, and `#f5c2e7` for `opencode`; with flavor `'latte'` it returns `#40a02b`, `#179299`, `#7287fd`, `#209fb5`, and `#ea76cb` for the same adapters.
For any other adapter name the lookup shall return a value drawn from the documented per-flavor fallback pool, identical on repeated calls with the same input and flavor [[tmux-play-48](#tmux-play-48)].

### tmux-play-141

Given the presenter receives a `captain` block, the writer shall capture bytes `\x1b[1;38;2;203;166;247mcaptain> \x1b[0m` immediately before the body's first nonblank line.
Given a `coder` player whose adapter is `claude`, the same writer shall capture `\x1b[1;38;2;166;227;161mcoder> \x1b[0m` before the body.
Given an unmapped player (no `playerAdapters` entry), the prefix shall fall back to the uncolored `<playerId>> ` form.
Continuation indents in wrapped or multi-line blocks shall NOT carry any SGR escape [[tmux-play-38](#tmux-play-38)].

### tmux-play-142

Given a player error finished record on `coder` (adapter `claude`) with message `<message>`, the player pane shall capture `\x1b[1;38;2;166;227;161mcoder> \x1b[0m\x1b[1;38;2;243;139;168m[error]\x1b[0m <message>\n` — the bracketed tag carries the red outcome SGR span, and the body sits outside the brackets unstyled.
Given a player aborted record on the same player, the pane shall capture the player prefix span followed by `\x1b[1;38;2;249;226;175m[aborted]\x1b[0m\n` with no body.
Given a `turn_aborted` record on the Boss/Captain pane with reason `<reason>`, the captured bytes shall include the captain mauve prefix span followed by `\x1b[1;38;2;249;226;175m[turn aborted]\x1b[0m <reason>\n`.
Given a `turn_aborted` record on the Boss/Captain pane without a reason, the captured bytes shall include the captain mauve prefix span followed by `\x1b[1;38;2;249;226;175m[turn aborted]\x1b[0m\n` — the bracketed tag stands alone with no trailing space and no synthesized placeholder body.
Given a `runtime_error` record on the Boss/Captain pane with message `<message>`, the captured bytes shall include the captain mauve prefix span followed by `\x1b[1;38;2;243;139;168m[runtime error]\x1b[0m <message>\n` [[tmux-play-39](#tmux-play-39)].

### tmux-play-143

Given a player `tool_use` event with `toolName: 'Bash'` and `input: { command: 'npm test' }` on a player pane writer for player `coder` (adapter `claude`), the captured bytes shall be `\x1b[1;38;2;166;227;161mcoder> \x1b[0m[tool ↪] Bash npm test\n` — the speaker prefix carries the player's adapter accent per [[tmux-play-38](#tmux-play-38)] and the bracketed tag `[tool ↪]` is emitted uncolored per [[tmux-play-39](#tmux-play-39)].
When the caller is the captain (a `captain_event` carrying a `tool_use`) with `toolName: 'Read'` and `input: { file_path: 'a.ts' }`, the captured bytes shall be `\x1b[1;38;2;203;166;247mcaptain> \x1b[0m[tool ↪] Read a.ts\n` (captain mauve `#cba6f7` on the prefix; uncolored tag).
The retired `tool> ` prefix replacement and its caller-accent coloring shall not appear [[tmux-play-49](#tmux-play-49)].

Given a `tool_result` event with `status: 'success'`, `toolName: 'Bash'`, and `durationMs: 1234` on the `coder` player pane (adapter `claude`), the captured bytes shall begin with the colored header line `\x1b[1;38;2;166;227;161mcoder> \x1b[0m\x1b[1;38;2;166;227;161m[tool ✓]\x1b[0m Bash 1.2s\n`.
Given a Captain-emitted `tool_result` with `status: 'success'`, `toolName: 'Read'`, and `durationMs: 200`, the header line shall be `\x1b[1;38;2;203;166;247mcaptain> \x1b[0m\x1b[1;38;2;166;227;161m[tool ✓]\x1b[0m Read 200ms\n` with the bracketed tag in green and the body unstyled — `200 < 1000` so the duration uses the `<n>ms` form per [[tmux-play-49](#tmux-play-49)].
Status symbol shall be `✓` for `success`, `✗` for `error`, `·` for `denied`; the corresponding bracketed-tag SGR shall use green / red / yellow per the [[tmux-play-39](#tmux-play-39)] kind table.
The duration segment shall be `<n>ms` for `durationMs < 1000`, `<n.n>s` otherwise, and absent when `durationMs` is undefined.
The retired `tool< ` prefix replacement shall not appear.

Given a `tool_result` event whose extracted output is non-empty, the presenter shall strip exactly one trailing line terminator from the payload before wrapping it (so a payload ending `foo\n` does not surface a phantom blank line inside the fence), while any trailing blank lines beyond that terminator shall survive into the rendered output.
The body following the header line shall be enclosed in a fenced code block whose fence is a run of backticks one longer than the longest backtick run in the payload, with a minimum of three; the fenced payload shall be passed to `renderMarkdown` per [[tmux-play-50](#tmux-play-50)] at the width specified in [[tmux-play-49](#tmux-play-49)], the captured body output shall not retain `glow`'s trailing horizontal line padding while preserving leading whitespace, and every nonblank line of the rendered output shall be prefixed with two spaces before reaching the writer.
Blank lines in the rendered output (the fenced-code frame, payload edge blanks) shall remain blank with no indent and no right-padding spaces so the body's structure reads as it would in a `glow` pane outside this presenter without reserving cells to the right of visible content.
The retired `overlay0` `#6c7086` SGR pair shall not wrap any byte of the body — `glow`'s code-block rendering supersedes it per the [[tmux-play-49](#tmux-play-49)] amendment.

Given a `tool_result` payload that itself contains a ```` ``` ```` line, the selected wrapper fence shall be at least four backticks long so the embedded fence remains inert as literal content of the outer fence and no part of the payload escapes into Markdown rendering at the writer.

Given a `tool_result` event whose extracted output is empty or undefined, the header line shall stand alone with no body.

### tmux-play-144

Given a `tool_use` event whose `input` lacks the priority keys but contains `{ count: 3, flag: true }`, the input summary shall be the compact JSON `{"count":3,"flag":true}`.
Given an `input` whose first priority-key string exceeds 60 cells, the summary shall be the value's first 59 cells followed by `…`.
Given an empty `input` object, the rendered header shall be `<who>> [tool ↪] <toolName>` with no trailing space.
Given an `input` whose only matching priority-key string is `query` (e.g., `{ query: 'select:WebFetch', max_results: 1 }`), the input summary shall be the `query` value — `query` sits in the priority list between `pattern` and `prompt` so search/fetch tools surface their query text rather than falling through to compact JSON [[tmux-play-49](#tmux-play-49)].

### tmux-play-145

Given a `captain_event` carrying a `tool_use` record, the Boss/Captain pane writer (not any player writer) shall receive the `captain> [tool ↪] …` header per [[tmux-play-49](#tmux-play-49)].
Given a player-id `coder` `player_event` carrying the same `tool_use`, only the `coder` player pane writer shall receive the `coder> [tool ↪] …` header; the Boss/Captain pane writer shall not [[tmux-play-40](#tmux-play-40)], [[tmux-play-49](#tmux-play-49)].

### tmux-play-146

Given a `TmuxPresenter` receiving one or more `text_delta` events for the same `(writer, who)` pair, the writer shall capture zero bytes until a block boundary fires.
The block boundaries that trigger a flush are: a `player_finished` or `captain_finished` record on the writer's pane; a non-streaming `text` event on the same writer; a `captain_reply` record (itself a complete prose block) on the writer's pane; a `player_prompt` on the same writer; a `tool_use` or `tool_result` event on the same writer; and any status emission (`captain_status`, `runtime_error`, `turn_aborted`) targeting the same writer.
On flush, the accumulated text shall be passed once to `renderMarkdown` per [[tmux-play-51](#tmux-play-51)], and the rendered output shall be emitted under the [[tmux-play-38](#tmux-play-38)] prefix grammar.
A subsequent `text_delta` arriving after the flush shall open a fresh block whose render call is independent of the prior one [[tmux-play-50](#tmux-play-50)].

Given a streaming sequence interleaved with a tool event — e.g., `text_delta('partial\n')` followed by `tool_use(...)` on the same writer — the text shall flush before the `<who>> [tool ↪] …` header so the events appear in order on the pane.
The probe shall exercise a real `tmux` server rather than a mock or an argv log, shall run under `*.acceptance.test.ts` via `npm run test:acceptance`, shall self-skip when either `tmux -V` or `glow -v` fails since the launcher gates on both [[tmux-play-51](#tmux-play-51)], and shall not gate on adapter API keys.

### tmux-play-147

Given the rendered output of a text block, the captured bytes shall apply the [[tmux-play-38](#tmux-play-38)] grammar to the rendered lines: the first nonblank line shall carry the colored `<who>> ` SGR prefix; every nonblank continuation line shall carry the two-space hanging indent; blank lines in the rendered output shall remain blank without the indent [[tmux-play-50](#tmux-play-50)], [[tmux-play-38](#tmux-play-38)].
The captured bytes shall contain no successfully rendered line that retains `glow`'s trailing horizontal line padding, including padding followed only by SGR resets, while preserving leading whitespace so existing indentation does not change.
The indent shall be uncolored — no SGR sequence shall span the two-space prefix bytes.
Real-glow acceptance shall assert that text-body and tool-result body lines retain no trailing horizontal whitespace after ANSI is stripped.

Given leading or trailing blank lines in the rendered output (introduced by `glow`'s default paragraph-margin styling), the captured bytes shall drop at most one blank line from each edge — `glow`'s outer margin — and shall preserve every other blank line as a blank line, including any blank rows inside a fenced-code frame, around table rows, or between paragraphs, without retaining `glow`'s right-padding cells on those blank lines.
A blanket multi-line trim is not applied because `glow`'s fenced-code rendering emits structural blank rows that match the same shape as its outer margin and would otherwise be collapsed away (e.g., a payload that itself starts with a blank line would lose that line).
Given a rendered block whose content is entirely whitespace after the outer-margin trim, the writer shall receive zero bytes — no synthesized `<who>> ` prefix and no stranded blanks — so empty content cannot surface as a bare prefix line or as padding between turns.

Given a `text_delta` sequence that ends without a trailing newline followed by a `player_prompt` or other boundary event on the same writer, the open block shall flush before the new block opens; the writer shall not interleave the two speakers' content on a single line.
The probe shall exercise a real `tmux` server rather than a mock or an argv log, shall run under `*.acceptance.test.ts` via `npm run test:acceptance`, shall self-skip when either `tmux -V` or `glow -v` fails since the launcher gates on both [[tmux-play-51](#tmux-play-51)], and shall not gate on adapter API keys.

### tmux-play-148

Given a writer with a configured pane width source returning `W`, `renderMarkdown` shall be invoked for a text block with `width = max(1, W)`, compensating for `glow`'s built-in two-cell document margin while preserving that margin.
Given a writer with no configured pane width source, the default render width shall be `80`.
Given the first visible rendered row would exceed `W` after adding the speaker's `<who>> ` prefix (`6` cells for `boss`, `9` for `captain`, `playerId.length + 2` for a player pane), the presenter shall split only that first row at a cell-aware word boundary, emit no line wider than `W`, and keep later continuation rows free to reach the pane edge when real rendered content reaches that width.
Given a `tool_result` body, the render width shall be `max(1, W - 2)`, matching the two-space continuation indent the body lines carry (not the wider tool header prefix) [[tmux-play-50](#tmux-play-50)].
The probe shall exercise a real `tmux` server rather than a mock or an argv log, shall run under `*.acceptance.test.ts` via `npm run test:acceptance`, shall self-skip when either `tmux -V` or `glow -v` fails since the launcher gates on both [[tmux-play-51](#tmux-play-51)], and shall not gate on adapter API keys.

### tmux-play-149

Given `tmux-play` invoked in launcher mode on a host where `isGlowAvailable()` returns `false`, `launchTmuxPlay` shall reject with an error whose message names `glow` and contains the install URL `https://github.com/charmbracelet/glow#installation`.
The launcher shall not invoke any subsequent launcher work — no config discovery, no work-directory creation, no `tmux` session construction — so the rejection surfaces before any side effects.
The `glow` check shall run after the existing `tmux` availability check so a host missing both binaries reports `tmux` first [[tmux-play-51](#tmux-play-51)].
The probe shall exercise a real `tmux` server rather than a mock or an argv log, shall run under `*.acceptance.test.ts` via `npm run test:acceptance`, shall self-skip when either `tmux -V` or `glow -v` fails since the launcher gates on both [[tmux-play-51](#tmux-play-51)], and shall not gate on adapter API keys.

### tmux-play-150

Given a real `glow` binary on `PATH`, `renderMarkdown('hello **world** today\n', 80)` shall return non-empty output that contains at least one ANSI escape sequence (`\x1B[…`), does not contain the literal `**` marker, and contains the visible word `world` after ANSI bytes are stripped.
This confirms `glow` rendered bold styling instead of emitting raw Markdown [[tmux-play-50](#tmux-play-50)], [[tmux-play-51](#tmux-play-51)].

Given a fenced code block whose content is a single 200-character line rendered at width 40, the captured output shall contain the 200-character content intact after ANSI bytes are stripped — `glow` shall not insert a mid-token break inside the fenced block, matching [[tmux-play-49](#tmux-play-49)]'s "glow leaves long code lines unwrapped by design".

Given a plain paragraph rendered at width 80, the captured output shall be non-empty and shall contain each source word after ANSI bytes are stripped, guarding against silent `glow` misconfiguration (for example, a `glow` build that writes nothing under `spawnSync` because it gated its output on a TTY check).
The probe shall exercise a real `glow` binary rather than a mock, shall run under `*.acceptance.test.ts` via `npm run test:acceptance`, shall self-skip only when `glow -v` fails, and shall not gate on `tmux` or adapter API keys.

### tmux-play-151

Given a real `glow` binary on `PATH` and a `TmuxPresenter` wired to in-memory writers, the integration of the presenter with `glow` shall hold the spec-promised structural invariants — not just `glow`'s isolated rendering — across these scenarios.
These probes cover bugs that live at the seam where the presenter consumes real `glow` output, which neither glow-in-isolation acceptance ([[tmux-play-150](#tmux-play-150)]) nor identity-mock unit tests can catch [[tmux-play-38](#tmux-play-38)], [[tmux-play-49](#tmux-play-49)], [[tmux-play-50](#tmux-play-50)].

Given a text-body block containing a heading and a bold span, the captured writer output shall carry exactly one `<who>> ` prefix line for the block; every nonblank line shall begin with either that prefix or the two-space hanging indent; ANSI styling shall be present and the literal `**` marker shall be absent.
This pins the [[tmux-play-38](#tmux-play-38)] prefix grammar and the [[tmux-play-50](#tmux-play-50)] post-indent rule against real `glow` output rather than against a trivially-shaped mock.

Given a `tool_result` event whose payload ends with an intentional blank row (e.g., `output: 'foo\n\n'`), the visible writer output (ANSI stripped) shall match `/foo\s*\n\s*\n/` — the blank survives the strip-one-terminator rule, the fence wrap, real `glow`'s fenced-code rendering, the outer-margin trim, and the two-space indent, in that order.
This pins the [[tmux-play-49](#tmux-play-49)] trailing-payload-blank-preservation rule end-to-end.

Given two consecutive short text blocks emitted back-to-back on the same writer, the captured writer output shall contain no run of three or more consecutive newlines: `glow`'s per-block paragraph margins shall not stack into a parade of blank lines between turns.
This directly pins the user-reported "excessive blank lines between player messages" defect that motivated the [[tmux-play-50](#tmux-play-50)] outer-margin trim.

Given a text-body prose block rendered in a 40-cell pane by a real `glow` binary, at least one non-first continuation row shall be at least 39 cells wide after ANSI is stripped, and no visible row shall exceed 40 cells.
The near-edge row shall begin with the presenter's two-space continuation indent followed by `glow`'s preserved two-space document margin.
This pins the user-reported "empty right side of every pane" defect that remained after the trailing-padding strip: the output must compensate for `glow`'s document margin while still avoiding terminal-level rewrap.
The probe shall exercise a real `glow` binary rather than a mock, shall run under `*.acceptance.test.ts` via `npm run test:acceptance`, shall self-skip only when `glow -v` fails, and shall not gate on `tmux` or adapter API keys.

### tmux-play-152

Given a YAML config that sets `permissions` on the captain and on a player, when `loadTmuxPlayConfig` returns, the loaded `captain.permissions` and `players[i].permissions` shall be the typed `PermissionPolicy` values from the YAML, with `writablePaths` entries validated and canonicalized [[tmux-play-52](#tmux-play-52)].
Given a YAML with an unknown sub-field under `permissions`, with a `mode` value outside `'auto' | 'bypass'`, with a `fileWrite` / `shellExecute` / `networkAccess` value outside `'allow' | 'ask' | 'deny'`, with invalid `writablePaths`, or with `permissions` set to a non-object, the loader shall reject with an error that names the offending path per [[tmux-play-8](#tmux-play-8)] [[tmux-play-52](#tmux-play-52)].

### tmux-play-153

Given a captain or player `PermissionPolicy` accepted by the loader, when the runtime constructs the corresponding `Cligent`, the value shall reach the adapter as `AgentOptions.permissions` at the next `run()` call, and the adapter's `mapPermissionsToXxxOptions` shall translate `mode: 'auto'`, `mode: 'bypass'`, and any canonicalized `writablePaths` to the SDK knobs enumerated in [DR-005](../decisions/005-per-adapter-permission-configuration.md) and [DR-006](../decisions/006-workspace-writable-paths.md): claude → `permissionMode: 'auto'` / `'bypassPermissions'` plus ambient `writablePaths` reporting; codex → `ThreadOptions: { approvalPolicy: 'on-request' }` plus `CodexOptions.config: { approvals_reviewer: 'auto_review', default_permissions: ':workspace' }` and `exec --ignore-user-config`, or a generated extra-writes profile for writable paths / `ThreadOptions: { approvalPolicy: 'never' }` plus `CodexOptions.config: { default_permissions: ':danger-full-access' }` and `exec --ignore-user-config`; gemini → `approvalMode: 'yolo'` for either mode plus ambient `writablePaths` reporting when provided; opencode → no wildcard permission rule for `'auto'`, with only explicitly supplied portable capability levels mapped as independent rules, ambient `writablePaths` reporting when provided, and a thrown error naming the SDK/server architecture for `'bypass'`; kimi → ACP mode config `auto` plus ambient `writablePaths` reporting, while bypass and no-mode policies fail before spawn [[tmux-play-52](#tmux-play-52)].

### tmux-play-154

Given a YAML config whose `permissions.mode` is outside the closed set, when the launcher CLI is invoked, the process shall exit with a nonzero status and write a single `Error: ...` line to stderr that names the offending path (e.g., `captain.permissions.mode` or `players[0].permissions.mode`).
The runtime shall not start, and no `runtime_error` record shall be observable — the failure is a launcher-startup abort that falls outside [[tmux-play-25](#tmux-play-25)]'s runtime-existence scope, per [DR-005](../decisions/005-per-adapter-permission-configuration.md)'s failure-surfacing rule [[tmux-play-52](#tmux-play-52)], [[tmux-play-8](#tmux-play-8)], [[tmux-play-25](#tmux-play-25)].

### tmux-play-155

Given the built-in fanout Captain and a `claude` player configured with `permissions: { mode: 'auto' }`, when the runtime (constructed per [[tmux-play-29](#tmux-play-29)]) handles a Boss turn instructing the player to create a file in the working directory and a second turn instructing it to delete that file, the file shall exist on disk after the create turn and be absent after the delete turn, each turn's `claude` `player_finished` shall report `status: 'ok'`, and neither `runtime_error` nor `turn_aborted` shall appear.
This is a real-run end-to-end probe — Boss turn → fanout Captain → player → Claude adapter → live SDK → filesystem — exercising the path a no-`permissions` player cannot complete (its headless `permissionMode: 'default'` blocks every file tool).
It lives under `*.acceptance.test.ts`, runs via `npm run test:acceptance`, and self-skips when `ANTHROPIC_API_KEY` is absent, hard-failing under `CI` [[tmux-play-30](#tmux-play-30)], [[tmux-play-52](#tmux-play-52)].

### tmux-play-156

Given a real tmux server with one Captain pane and at least two configured player panes, when a `TimingObserver` receives synthetic `turn_started`, `player_prompt`, `player_finished`, `captain_prompt`, `captain_finished`, and `turn_finished` records with controlled timestamps, each pane-scoped timer option shall carry the expected cumulative duration for that pane, and the session-scoped total option shall carry the expected turn duration.
Given a player or Captain run that is still open when the observer refreshes with a supplied `now`, the displayed duration shall include `now - <open-start>.timestamp`, use the running glyph `⏳`, and use the bright player/Captain accent; after the matching finished record, it shall freeze with glyph `⌛` and `subtext1` (`#bac2de`), per [[tmux-play-54](#tmux-play-54)]'s legibility-against-the-mantle-band constraint that explicitly forbids `overlay1` for the per-pane timers.
Given an open Boss turn, the status-total timer shall include `now - turn_started.timestamp`, render on `status-right` with the running glyph `⏳` and `mauve`; after `turn_finished`, it shall freeze with the settled glyph `⌛` and `overlay1`.
Per [[tmux-play-71](#tmux-play-71)], the duration text on every per-pane border timer option and on the `status-right` total timer shall render in `hh:mm:ss` form, every rendered value shall match the regular expression `^[0-9]{2,}:[0-9]{2}:[0-9]{2}$`, and the probe shall pin this on a real tmux server at three regression-relevant magnitudes whose component values shall match the byte-for-byte expected text: at the sub-minute magnitude the rendered text shall begin with `00:00:` and end with a two-digit seconds field (e.g., `00:00:12`, not `12s`); at the minute magnitude the rendered text shall begin with `00:` and carry a non-zero, two-digit minutes field (e.g., `00:01:00`, `00:03:07` — not `1m0s`, not `3m07s`, and not a seconds-only `187s`); at the hour magnitude the rendered text shall carry a non-zero, two-digit hours field followed by colon-separated, two-digit minutes and seconds fields (e.g., `01:00:00`, `01:02:03` — not `1h00m`, not `1h2m3s`, and not a seconds-only `3723s`).
The real tmux session shall report the `Spex` brand heading and navigation hints on `status-left` including `switch pane: ctrl+←/→ or shift+←/→`, `stop: esc`, `exit: ctrl+c`, `drag=select`, and `right-click=copy`, and shall not contain the retired `spex`, `Cligent`, or `tmux-play` headings or the retired `d=detach`, `o=switch pane`, `[=scroll`, or `Stop: ESC` fragments; `status-right` shall carry the total timer; `window-status-format`, `window-status-current-format`, and `window-status-separator` shall be empty strings so no default `0:node*` window-list text is rendered; and `pane-border-format` shall reference the pane timer slot without removing `#{pane_title}`.
The probe shall assert tmux state via `show-options`, `show-options -p`, and `display-message`, and shall tolerate one cell of visual border-alignment variance for emoji glyph width.
It shall run under `*.acceptance.test.ts`, shall not require adapter API keys, and shall self-skip when either `tmux -V` or `glow -v` fails [[tmux-play-53](#tmux-play-53)], [[tmux-play-54](#tmux-play-54)], [[tmux-play-55](#tmux-play-55)], [[tmux-play-63](#tmux-play-63)], [[tmux-play-71](#tmux-play-71)].

### tmux-play-157

Where YAML selects representative values covering each distinct adapter transport class, when the launcher/session seam constructs and invokes the corresponding `Cligent`, the value shall reach that adapter's own effort surface without cross-aliasing into another adapter's vocabulary: Claude ordinary effort and ultracode, Codex thread and constructor effort, Gemini 3 and Gemini 2.5 concrete-model aliases, known-provider OpenCode prompt variants, and Kimi's binary ACP thinking setting.
Representative unmatched Gemini and OpenCode models shall create no effort override while preserving ordinary model forwarding; Kimi `on` shall preserve model forwarding and select that model's default thinking effort [[tmux-play-56](#tmux-play-56)].

### tmux-play-158

Where one YAML config has an unsupported `captain.effort` and another has an unsupported `players[0].effort`, when the launcher CLI is invoked, each process shall exit nonzero and write one error line naming the offending path, adapter, and allowed values.
The runtime shall not start and no `runtime_error` record shall be observable because validation is a launcher-startup failure outside [[tmux-play-25](#tmux-play-25)] [[tmux-play-56](#tmux-play-56)], [[tmux-play-8](#tmux-play-8)], [[tmux-play-25](#tmux-play-25)].

### tmux-play-159

Given a `TmuxPlaySession` running against TTY-like input with an active Boss turn in flight, when the input delivers a bare ESC byte and the readline escape timeout elapses, observers shall capture one `turn_aborted` record with reason `ESC`, the Boss/Captain pane shall capture the `captain> [turn aborted] ESC` status line, no `runtime_error` record shall be emitted, and the session shall remain open [[tmux-play-57](#tmux-play-57)], [[tmux-play-26](#tmux-play-26)], [[tmux-play-40](#tmux-play-40)].
Given the same session, when the input delivers the arrow-up sequence `\x1b[A`, no `turn_aborted` record shall be emitted.
Given the Boss readline edit buffer contained user-typed bytes when the bare ESC arrived, when the Boss presses Enter after the abort, the next Boss turn shall receive those retained bytes as its prompt.
Given non-TTY input, the ESC keybinding shall not be installed and SIGHUP/SIGINT/SIGTERM/EOF shutdown behavior shall remain governed by [[tmux-play-26](#tmux-play-26)].

### tmux-play-160

Given a `TmuxPlaySession` running against TTY-like input and output, when the input delivers `\x1b[200~Alpha\nBravo\nCharlie\x1b[201~` followed by Enter, exactly one Boss turn shall start with prompt `Alpha\nBravo\nCharlie` [[tmux-play-58](#tmux-play-58)].
Given the input delivers `\x1b[200~Alpha\nBravo\n\x1b[201~` followed by Enter, exactly one Boss turn shall start with prompt `Alpha\nBravo`.
Given the input delivers `\x1b[200~Alpha\nBravo\x1b[201~` followed by `-extra` and Enter, exactly one Boss turn shall start with prompt `Alpha\nBravo-extra`.
The output shall capture the bracketed-paste-enable sequence when the session starts and the bracketed-paste-disable sequence on shutdown.
Given non-TTY output, neither bracketed-paste control sequence shall be written to output.

### tmux-play-161

When the CLI's theme-diagnostics paths are exercised, verification shall assert this matrix [[tmux-play-61](#tmux-play-61)], [[tmux-play-47](#tmux-play-47)]:

| Invocation or probe state | Assertion |
| --- | --- |
| YAML config supplied | load it, apply the launcher flavor rule, print `selected: <flavor>` and `reason: <reason>` plus the raw OSC 11 reply when received, and exit zero without tmux or Glow |
| parseable light OSC 11 reply such as `rgb:eeee/eeee/eeee` | report `selected: latte` and `reason: osc11` |
| no parseable reply and no concrete explicit or YAML flavor | report `selected: mocha` and `reason: fallback` |
| discovery finds no config and `--config` is absent | create no config and report the same auto-theme outcome without requiring an installed adapter runtime |
| combined with `--session` | reject before session-mode dispatch |

### tmux-play-162

Given the launcher constructing a tmux-play session, the tmux command stream shall include `set-option -t <session> mouse on`, shall include `bind-key -T copy-mode MouseDragEnd1Pane send-keys -X stop-selection`, `bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X stop-selection`, a `bind-key -T copy-mode MouseDown3Pane refresh-client` plus a `bind-key -T copy-mode-vi MouseDown3Pane refresh-client` consuming-no-op press binding, and a `bind-key -T copy-mode MouseUp3Pane` plus a `bind-key -T copy-mode-vi MouseUp3Pane` binding whose bound command is a single `if-shell -F '#{selection_present}'` with a true branch `display-message Copied! ; send-keys -X copy-pipe '<system-clipboard-command>'` and a false branch `send-keys -X copy-pipe '<system-clipboard-command>'`, shall not include a `set-clipboard` option write, and shall not include any `WheelDownPane` binding [[tmux-play-62](#tmux-play-62)].
The copy and toast shall be bound to the release event `MouseUp3Pane`, not the press event `MouseDown3Pane`: tmux clears a status-line message on the next key event, and a right-click is a press immediately followed by a release, so a `Copied!` toast painted on the press is wiped by the release before it can be seen ("the toast disappears as the right-click releases"); the `MouseDown3Pane` press binding shall carry the focus-neutral no-op `refresh-client` and neither `copy-pipe`, `Copied!`, nor `select-pane`, so a regression that moves the copy or toast back onto the press, or that switches the press to a focus-changing `select-pane`, fails.
The right-click binding argv shall be exactly `copy-pipe`, not `copy-pipe-and-cancel`: `copy-pipe-and-cancel` exits copy-mode and snaps a scrolled-back pane to its live tail, which is the "right-click on a scrolled-back pane jumps to the last line" defect [[tmux-play-62](#tmux-play-62)] requires not to occur.
The release binding's true branch shall pair a `display-message Copied!` copy-confirmation toast with the `copy-pipe`, gated on the `if-shell` condition `#{selection_present}`, so the bound command contains `if-shell`, `display-message`, the literal `Copied!`, and `selection_present`, with the toast inside the `if-shell` true branch so it fires only when a selection is present.
The literal `Copied!` shall appear exactly once in each `MouseUp3Pane` binding body — only in the selection-present true branch — so a toast leaking into the no-selection false branch (a false `Copied!` on an empty right-click) is caught.
The `<system-clipboard-command>` shall contain `pbcopy`, `wl-copy`, `xclip`, `xsel`, `clip.exe`, and `tmux load-buffer -w -`.
Given a real tmux server, when `launchTmuxPlay({ attach: false })` returns, `tmux show-options -v -t <session> mouse` shall report `on`, and `tmux list-keys -T copy-mode` plus `tmux list-keys -T copy-mode-vi` shall report the preserve-selection bindings above, each table's `MouseDown3Pane` binding being the `refresh-client` no-op carrying neither `copy-pipe`, `Copied!`, nor `select-pane`, and each table's `MouseUp3Pane` body containing `if-shell`, `display-message`, `selection_present`, and exactly one `Copied!`; neither table's `MouseUp3Pane` binding shall reference `copy-pipe-and-cancel`.
Given a real tmux server with a launched pane scrolled back into history holding a stopped active selection, when the release binding's selection-present `if-shell` branch — its `display-message Copied! ; send-keys -X copy-pipe <command>` shape with the system-clipboard command swapped for a test pipe — is run against the pane, the pipe shall receive the expected selected text (so the branch is proven to reparse and execute, not merely match a string), `#{selection_present}` shall become `0`, `#{pane_in_mode}` shall remain `1`, and `#{scroll_position}` shall equal its pre-copy value; and when the no-selection false branch is then run against the same pane (now `#{selection_present}` is `0`), the pipe shall receive no selected text, confirming a right-click over nothing selected copies silently.
Given a real tmux server with an attached client and a launched pane scrolled back into history holding a stopped active selection, when a real right-click press-then-release (SGR right-button `M` then `m`) is dispatched through the attached client inside that pane, the live release binding shall run end-to-end: `#{selection_present}` shall become `0` (the `copy-pipe` cleared the selection as visible copy-confirmation), `#{pane_in_mode}` shall remain `1`, and `#{scroll_position}` shall equal its pre-click value.
This proves the release is actually delivered and the copy runs over real tmux mouse routing: a binding that dropped the release — by removing the `MouseDown3Pane` press no-op that consumes the press, or by leaving `MouseUp3Pane` unbound — would never run the copy and would leave `#{selection_present}` at `1`.
This signal does not by itself prove the copy lives on the release rather than the press, because a copy moved onto the press would also clear the selection to `0`; that the copy and toast live on the release and not the press is fixed instead by the static binding checks above (the `MouseDown3Pane` press binding is `refresh-client`, carrying no `copy-pipe` or `Copied!`) and by the toast-persistence probe below (a toast painted on the press is wiped by the release).
This probe shall run under `*.acceptance.test.ts`, shall not require adapter API keys, and shall self-skip when `tmux -V`, `glow -v`, or an attached-client mouse driver is unavailable or cannot attach a client (e.g. a headless CI runner).
Given a real tmux server whose launched session has a generous `display-time` and a pane holding a stopped active selection, when a real right-click press-then-release is dispatched through an attached client rendered inside an outer tmux pane (so the inner client's status line is capturable), the captured status line shall show the `Copied!` toast after the release has been processed, proving the toast survives the release rather than being wiped by it; a binding that painted the toast on the press would leave the captured status line with no `Copied!`.
This probe shall run under `*.acceptance.test.ts`, shall not require adapter API keys, and shall self-skip when `tmux -V`, `glow -v`, or an attached-client mouse driver is unavailable or cannot attach a client (e.g. a headless CI runner).
The toast is asserted on the rendered status line by the persistence probe above; together with the binding-body, branch-execution, and real-right-click checks, these are the test's verification surface for the toast's presence, persistence, and selection gating.

### tmux-play-163

Given the launcher constructing a tmux-play session whose `sessionName` is `<session>`, the tmux command stream shall include `bind-key -T root C-Left if-shell -F #{==:#{session_name},<session>} 'select-pane -L' 'send-keys C-Left'`, `bind-key -T root C-Right if-shell -F #{==:#{session_name},<session>} 'select-pane -R' 'send-keys C-Right'`, `bind-key -T root S-Left if-shell -F #{==:#{session_name},<session>} 'select-pane -L' 'send-keys S-Left'`, and `bind-key -T root S-Right if-shell -F #{==:#{session_name},<session>} 'select-pane -R' 'send-keys S-Right'`, so the binding's true branch switches panes inside this session while the false branch forwards the original key for every other tmux session on the same server [[tmux-play-63](#tmux-play-63)].
The launcher shall render `status-left` with `switch pane: ctrl+←/→ or shift+←/→`, `stop: esc`, and `exit: ctrl+c` substrings and shall not include the retired `d=detach`, `o=switch pane`, `[=scroll`, or `Stop: ESC` fragments; `drag=select` and `right-click=copy` shall remain so the mouse interaction surface from [[tmux-play-62](#tmux-play-62)] stays discoverable.
Given a real tmux server, when `launchTmuxPlay({ attach: false })` returns, `tmux list-keys -T root C-Left` shall report a binding whose body contains `if-shell`, `session_name`, the launched session name, `select-pane -L`, and `send-keys C-Left`; `tmux list-keys -T root C-Right` shall report the symmetric binding with `select-pane -R` and `send-keys C-Right`; `tmux list-keys -T root S-Left` shall report a binding whose body contains `if-shell`, `session_name`, the launched session name, `select-pane -L`, and `send-keys S-Left`; and `tmux list-keys -T root S-Right` shall report the symmetric binding with `select-pane -R` and `send-keys S-Right`.
The acceptance probe shall run under `*.acceptance.test.ts`, shall not require adapter API keys, and shall self-skip when either `tmux -V` or `glow -v` fails.

### tmux-play-164

Given a YAML config that omits `layout`, when `launchTmuxPlay({ attach: false })` returns, the work-directory snapshot at `<workDir>/tmux-play.config.snapshot.json` shall carry `layout.window` of `{ columns: 174, rows: 49 }` and the resolved shape-specific weights `singlePlayerColumnWeights: [1, 1]` and `multiPlayerColumnWeights: [1, 1, 1]`, regardless of how many players are configured, so session mode can render either visible-column shape [[tmux-play-64](#tmux-play-64)], [[tmux-play-8](#tmux-play-8)], [[tmux-play-25](#tmux-play-25)], [[tmux-play-34](#tmux-play-34)].
Given a YAML config that supplies a fully concrete `layout` — whether through the canonical `singlePlayerColumnWeights` / `multiPlayerColumnWeights` fields or the `columnWeights` alias — the same snapshot file shall carry the resolved `window.columns`, `window.rows`, `singlePlayerColumnWeights`, and `multiPlayerColumnWeights` values verbatim per [[tmux-play-34](#tmux-play-34)]; a two-element `columnWeights` shall surface as the resolved `singlePlayerColumnWeights` and a three-element `columnWeights` as the resolved `multiPlayerColumnWeights`.
Given a YAML config that supplies a partial `layout.window` (for example `columns: 200` with no `rows`), the snapshot's `layout.window` shall be `{ columns: 200, rows: 49 }` — each missing sub-field independently defaulted, each supplied sub-field preserved verbatim — and the snapshot shall not contain `{ columns: 174, rows: 49 }` for that window.
Given a YAML config whose `layout` is malformed — `layout.window.columns` or `layout.window.rows` not a positive integer; `layout.singlePlayerColumnWeights`, `layout.multiPlayerColumnWeights`, or `layout.columnWeights` not an array; any weight not a positive integer (decimals such as `0.5`, NaN, Infinity, zero, negatives, and non-number types shall all reject); `layout.singlePlayerColumnWeights` length other than `2` or `layout.multiPlayerColumnWeights` length other than `3`; `layout.columnWeights` length other than `2` or `3`; `layout.columnWeights` present alongside the canonical field for the same shape; any unknown sub-field under `layout` (a recognized `layout.initialVisible` per [[tmux-play-80](#tmux-play-80)] is accepted, not rejected) or `layout.window` — when the launcher CLI is invoked, the process shall exit with a nonzero status and write a single `Error: ...` line to stderr that names the offending path (e.g., `layout.window.columns`, `layout.multiPlayerColumnWeights[2]`) per [[tmux-play-8](#tmux-play-8)].
The runtime shall not start, no tmux session shall be created, and no `runtime_error` record shall be observable because the failure is a launcher-startup abort outside [[tmux-play-25](#tmux-play-25)]'s runtime-existence scope.

### tmux-play-165

Given the launcher constructing a tmux-play session whose `sessionName` is `<session>`, the tmux command stream shall include a `bind-key -T root C-c`, a `bind-key -T copy-mode C-c`, and a `bind-key -T copy-mode-vi C-c`, each gated `if-shell -F #{==:#{session_name},<session>}` whose true branch is the same cancel-then-forward pair — `if -F -t <session>:0.0 '#{pane_in_mode}' 'send-keys -t <session>:0.0 -X cancel'` followed by `send-keys -t <session>:0.0 C-c` — so pane 0's copy-mode is exited (when pane 0 is in a mode) before the `Ctrl+C` byte reaches the Boss/Captain pane (pane index 0) [[tmux-play-65](#tmux-play-65)], [[tmux-play-26](#tmux-play-26)].
Each binding's false branch shall reproduce that table's stock binding verbatim: `send-keys C-c` for `root`, and `send-keys -X cancel` for `copy-mode` and `copy-mode-vi`, so other tmux sessions on the same server retain stock `Ctrl+C` and stock copy-mode `C-c` behavior.
Given a real tmux server, when `launchTmuxPlay({ attach: false })` returns, `tmux list-keys -T root C-c`, `tmux list-keys -T copy-mode C-c`, and `tmux list-keys -T copy-mode-vi C-c` shall each report a binding whose body contains `if-shell`, `session_name`, the launched session name, the `pane_in_mode`-gated `send-keys -t <session>:0.0 -X cancel`, and `send-keys -t <session>:0.0 C-c`; the `root` body shall additionally contain its `send-keys C-c` false branch, and the `copy-mode` and `copy-mode-vi` bodies shall additionally contain their `send-keys -X cancel` false branch.
The acceptance probe shall additionally drive real attached-client keypresses, not only `list-keys`: given pane 0 is running a raw byte logger, when an attached client presses `C-c` from a player pane scrolled into copy-mode with a stopped selection, pane 0 shall receive byte `0x03` after one press; and given pane 0 itself is scrolled into copy-mode while a different player pane is active in root mode, when the attached client presses `C-c`, pane 0 shall first leave copy-mode and shall receive byte `0x03` after one press.
The acceptance probe shall run under `*.acceptance.test.ts`, shall not require adapter API keys, and shall self-skip when either `tmux -V`, `glow -v`, or an attached-client key driver is unavailable or cannot attach a client (e.g. a headless CI runner).

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

Given the launcher constructing a tmux-play session whose `sessionName` is `<session>` and which carries `paneCount` panes indexed `0..paneCount-1`, the tmux command stream shall include exactly one `bind-key -T <table> MouseDown1Pane if-shell -F #{==:#{session_name},<session>} '<trueBranch>' '<falseBranch>'` invocation for each `<table>` in `root`, `copy-mode`, `copy-mode-vi`.
With one Boss/Captain pane plus N players, `paneCount` shall equal `N + 1` [[tmux-play-68](#tmux-play-68)].
`<trueBranch>` shall chain, for every pane index `i` in `0..paneCount-1`, an `if -F -t <session>:0.<i> '#{pane_in_mode}' 'send-keys -t <session>:0.<i> -X clear-selection'` clause separated by ` ; `, followed by the per-table tail: ` ; select-pane -t= ; send-keys -M` for the `root` table and ` ; select-pane` for `copy-mode` and `copy-mode-vi`.
`<falseBranch>` shall be the per-table tmux stock binding verbatim: `select-pane -t= ; send-keys -M` for `root` and `select-pane` for `copy-mode` and `copy-mode-vi`.
The `send-keys -M` byte in the `root` false branch shall not be omitted so mouse-aware applications in unrelated sessions continue to receive forwarded clicks.
No `MouseDown1Pane` argv shall reference `-X cancel`: that primitive exits copy-mode entirely and was the root of the retired [[tmux-play-166](#tmux-play-166)] "previously focused pane jumps to the last line" defect; [[tmux-play-68](#tmux-play-68)] requires `clear-selection` instead.
The `mouse` option shall still be set to `on`, and the `MouseDragEnd1Pane` stop-selection binding, the `MouseDown3Pane` `refresh-client` press no-op, and the `MouseUp3Pane` system-clipboard right-click-copy binding of [[tmux-play-162](#tmux-play-162)] shall still be installed unchanged.

Given a real tmux server, when `launchTmuxPlay({ attach: false })` returns, `tmux list-keys -T root MouseDown1Pane`, `tmux list-keys -T copy-mode MouseDown1Pane`, and `tmux list-keys -T copy-mode-vi MouseDown1Pane` shall each report a binding whose body contains `if-shell`, the launched session name, `pane_in_mode`, `send-keys`, `-X clear-selection`, and the table's stock tail (`select-pane -t=` and `send-keys -M` for `root`; `select-pane` for `copy-mode` / `copy-mode-vi`), and shall not contain `-X cancel`.
The acceptance probe shall additionally pin the observable consequence required by [[tmux-play-68](#tmux-play-68)] (not only the binding string or a direct invocation of the binding body): on a real tmux server, given pane A in the launched session holds a stopped active selection while scrolled back into its history, pane B in the launched session is scrolled back into its history without a selection, and pane C in the launched session is not in any mode, when an attached tmux client sends a primary-button mouse-down event inside pane C, then `#{selection_present}` on pane A shall be `0` (selection cleared); `#{pane_in_mode}` on pane A shall remain `1` and `#{scroll_position}` on pane A shall equal its pre-click value (still in copy-mode at the same scroll position); `#{pane_in_mode}` on pane B shall remain `1` and `#{scroll_position}` on pane B shall equal its pre-click value (a scrolled-back sibling that holds no selection keeps its scroll, the case [[tmux-play-68](#tmux-play-68)] also requires); and `#{pane_active}` on pane C shall be `1` (focus moved to the click target).
The probe shall assert that pane A's and pane B's pre-click `#{scroll_position}` is greater than `0`, so a setup that failed to scroll back fails loudly rather than letting the scroll-preservation assertions pass vacuously at `0 == 0`.
Asserting `#{pane_in_mode}` alone would not pin scroll preservation — it only distinguishes `clear-selection` from the retired `-X cancel`, which exits copy-mode — so the `#{scroll_position}` equality on genuinely scrolled panes is the assertion that pins the user-visible "previously focused pane jumps to the last line" contract.
Because the launched player panes carry no scrollback when the suite runs without adapter API keys, the probe may seed deterministic history into those panes (for example via `respawn-pane`) before scrolling; the binding under test is session- and `pane_in_mode`-gated and independent of pane contents, so substituting pane contents does not weaken the probe.
Pinning the attached-client click outcome — selection cleared, scroll preserved — directly catches regressions where the clear-selection primitive works when called manually but the real click path does not dispatch it.
The acceptance probe shall run under `*.acceptance.test.ts`, shall not require adapter API keys, and shall self-skip when either `tmux -V`, `glow -v`, or an attached-client mouse driver is unavailable or cannot attach a client (e.g. a headless CI runner).

### tmux-play-169

Given a real tmux server hosting a launched tmux-play session, where a pane is seeded with scrollback and scrolled back so that `#{scroll_position}` is greater than `0` and `#{pane_in_mode}` is `1`, when the session runtime writes new output to that pane — a flushed text block, a `tool_use` / `tool_result` lifecycle line, a player-prompt echo, or a `[status]` / `[turn aborted]` / `[runtime error]` bracketed line — the pane shall return to its live tail with `#{pane_in_mode}` reporting `0` and the newly written content visible [[tmux-play-69](#tmux-play-69)].
A pane in the same session that receives no concurrent output shall keep its `#{scroll_position}` and remain at `#{pane_in_mode}` `1`, so a scrolled pane is returned to its tail only by output written to that pane, not by output written to a sibling pane nor by between-turn idle activity.
Activity that renders no pane output shall not return a scrolled pane to its tail: the `turn_started` / `turn_finished` / `captain_prompt` / `captain_telemetry` control records, the `done` and `error` events the presenter suppresses, any event the presenter renders to no visible text, and a buffered `text_delta` that only accumulates into the open block before a flush.
The probe shall assert the pane's pre-output `#{scroll_position}` is greater than `0` so a setup that failed to scroll back fails loudly rather than passing vacuously at `0 == 0`, and shall not require adapter API keys — it may drive the session runtime with deterministic synthetic records and seed pane history via `respawn-pane`, since the follow is `#{pane_in_mode}`-gated and independent of pane contents.
The acceptance probe shall run under `*.acceptance.test.ts` and shall self-skip when either `tmux -V` or `glow -v` fails.

_The retired tmux-play-177 wheel-up clamp probe is removed together with its requirement tmux-play-78; the Boss/Captain phantom-scrollback behavior it tried to assert through wheel events is now owned at the source by [[tmux-play-178](#tmux-play-178)] / [[tmux-play-79](#tmux-play-79)]._

### tmux-play-170

Given the launcher constructing a tmux-play session whose `sessionName` is `<session>`, the tmux command stream shall include a `bind-key -T root Escape`, a `bind-key -T copy-mode Escape`, and a `bind-key -T copy-mode-vi Escape`, each gated `if-shell -F #{==:#{session_name},<session>}` whose true branch is the same cancel-then-forward pair — `if -F -t <session>:0.0 '#{pane_in_mode}' 'send-keys -t <session>:0.0 -X cancel'` followed by `send-keys -t <session>:0.0 Escape` — so pane 0's copy-mode is exited (when pane 0 is in a mode) before the bare ESC byte reaches the Boss/Captain pane (pane index 0), mirroring the [[tmux-play-165](#tmux-play-165)] `C-c` pattern [[tmux-play-70](#tmux-play-70)], [[tmux-play-57](#tmux-play-57)].
Each binding's false branch shall reproduce that table's stock binding verbatim — `send-keys Escape` for `root`, `send-keys -X cancel` for `copy-mode`, and `send-keys -X clear-selection` for `copy-mode-vi` — so other tmux sessions on the same server retain stock `Escape` behavior.
The asymmetry between `copy-mode` (`-X cancel`) and `copy-mode-vi` (`-X clear-selection`) shall be pinned by the test, not absorbed into a single `-X cancel` expectation: tmux's `copy-mode-vi` stock `Escape` is `clear-selection` (vi convention — Escape leaves visual selection without exiting copy-mode; `q` is the vi exit key), so writing `-X cancel` instead would degrade every unrelated vi-mode user's Escape on the same server from "drop selection, keep scrollback" to "exit copy-mode, snap to live tail" — the same scroll-snapping regression class [[tmux-play-168](#tmux-play-168)] enumerates for mouse events.
A regression that collapsed both mode tables' Escape false branches to one string shall fail this item statically.
The cross-table install is the ESC analogue of [[tmux-play-165](#tmux-play-165)]'s "Ctrl+C requires two presses to quit when a pane is scrolled" fix: a binding only at `root` would leave the "ESC pressed on a player pane is swallowed by `pane-input-off=1`" path fixed but reintroduce the "ESC on a scrolled-back pane cancels copy-mode instead of aborting the turn" defect.
Given a real tmux server, when `launchTmuxPlay({ attach: false })` returns, `tmux list-keys -T root Escape`, `tmux list-keys -T copy-mode Escape`, and `tmux list-keys -T copy-mode-vi Escape` shall each report a binding whose body contains `if-shell`, `session_name`, the launched session name, the `pane_in_mode`-gated `send-keys -t <session>:0.0 -X cancel`, and `send-keys -t <session>:0.0 Escape`; the `root` body shall additionally contain its `send-keys Escape` false branch, the `copy-mode` body shall additionally contain its `-X cancel` false branch, and the `copy-mode-vi` body shall additionally contain its `send-keys -X clear-selection` false branch and shall not contain a bare `send-keys -X cancel` false branch (its `pane_in_mode`-gated `send-keys -t <session>:0.0 -X cancel` true-branch step is the only `-X cancel` the body carries).
Once the byte reaches pane 0, the existing [[tmux-play-57](#tmux-play-57)] keypress handler shall raise the bare-ESC abort path covered by [[tmux-play-159](#tmux-play-159)]; this item does not duplicate that verification.
The acceptance probe shall additionally drive real attached-client keypresses, not only `list-keys`: given pane 0 is running a raw byte logger, when an attached client presses `Escape` from a player pane scrolled into copy-mode with a stopped selection, pane 0 shall receive byte `0x1b` after one press; and given pane 0 itself is scrolled into copy-mode while a different player pane is active in root mode, when the attached client presses `Escape`, pane 0 shall first leave copy-mode and shall receive byte `0x1b` after one press.
The acceptance probe shall run under `*.acceptance.test.ts`, shall not require adapter API keys, and shall self-skip when either `tmux -V`, `glow -v`, or an attached-client key driver is unavailable or cannot attach a client (e.g. a headless CI runner).

### tmux-play-171

Given a Captain that issues one `callCaptain(prompt)` and one `callCaptain(prompt, { visibility: 'hidden' })` within a turn, both calls shall return a `CaptainRunResult` with the run's `status` and `finalText`, and observers shall receive both calls' `captain_prompt` / `captain_event` / `captain_finished` records — the first call's tagged `visibility: 'visible'`, the second's tagged `visibility: 'hidden'` [[tmux-play-16](#tmux-play-16)], [[tmux-play-33](#tmux-play-33)], [[tmux-play-69](#tmux-play-69)], [[tmux-play-72](#tmux-play-72)].

Given a hidden call whose underlying run reports an error `status`, it shall still return the full `CaptainRunResult` — `status: 'error'` with the propagated `error` — and the observers' `captain_finished` record, tagged `visibility: 'hidden'`, shall carry that error `status` [[tmux-play-16](#tmux-play-16)], [[tmux-play-33](#tmux-play-33)], [[tmux-play-72](#tmux-play-72)].

Given the tmux presenter receives a hidden call's records (`captain_event` carrying streamed text or an `error` event, then a `captain_finished` of any `status`), the Boss/Captain pane writer shall capture zero bytes — no rendered reply block, and no `[error]`, `[aborted]`, or status line.
Given the same records tagged `visibility: 'visible'` (or with `visibility` omitted), the captured Boss/Captain-pane bytes shall be identical to the presenter's behavior before the option existed.

Given a Boss/Captain pane scrolled back into copy-mode, a hidden call's records — a `captain_event` carrying a tool, text, or `error` event, then a `captain_finished` of any `status` — shall not return that pane to its live tail per [[tmux-play-69](#tmux-play-69)]: the pane shall keep its `#{scroll_position}` and remain at `#{pane_in_mode}` `1`.
A later visible call whose flush writes bytes to that pane shall still return it to its live tail, so interleaved hidden records do not suppress the return owed once visible content reaches the pane.

### tmux-play-173

Given either public session runner whose inherited environment carries a `TMUX` handle, when it performs the [[tmux-play-74](#tmux-play-74)] isolation step, `TMUX` and `TMUX_PANE` shall be absent before runtime construction from the environment subsequently inherited by spawned player agents and `TMUX_TMPDIR` shall point to a private directory other than the run's tmux socket directory, so an agent's `tmux` resolves to an isolated server [[tmux-play-74](#tmux-play-74)].
The orchestrator shall still report itself attached to tmux so pane-width queries run, and its own tmux commands shall execute with the pinned pre-scrub environment carrying the original `TMUX` handle so they target the run's session rather than the agents' sandbox.
Given no inherited `TMUX` handle, the isolation step shall be a no-op that leaves `TMUX_TMPDIR` unset.

### tmux-play-174

Given a `TmuxPlaySession` running against TTY-like input and output with a Boss turn in flight whose player/Captain call is blocked (the `runBossTurn` promise is still pending), when the presenter streams the Captain's `captain> ` reply to the Boss/Captain pane (player `<playerId>> ` output stays in its player pane per [[tmux-play-40](#tmux-play-40)]), the captured Boss/Captain-pane content shall show no fresh `boss> ` readline prompt line following that streamed output between `turn_started` and the matching `turn_finished` or `turn_aborted` — the already-submitted input line that opened the turn (the `boss> <prompt>` echo per [[tmux-play-37](#tmux-play-37)]) is unaffected; after the turn resolves, exactly one fresh `boss> ` prompt shall be restored as the pane's ready prompt [[tmux-play-75](#tmux-play-75)], [[tmux-play-37](#tmux-play-37)], [[tmux-play-57](#tmux-play-57)], [[tmux-play-58](#tmux-play-58)].
Given the Boss types type-ahead bytes during the active turn, those bytes shall not render a fresh `boss> `-prefixed line while the turn is active, and the next Enter after the turn ends shall fire exactly one `runBossTurn` whose prompt is the preserved type-ahead bytes per [[tmux-play-57](#tmux-play-57)].
Given the Boss instead pastes multi-line text (bracketed paste per [[tmux-play-58](#tmux-play-58)]) during the active turn, the pasted bytes shall not render a fresh `boss> ` line while the turn is active, and the next Enter after the turn ends shall fire exactly one `runBossTurn` whose prompt preserves the pasted text's embedded newlines per [[tmux-play-58](#tmux-play-58)].
The session-level probe shall use a real `createInterface` over a TTY-like input/output pair (as the [[tmux-play-159](#tmux-play-159)] ESC probe does), because a stubbed readline does not echo prompt chrome and would pass vacuously.
Given a `TmuxPlaySession` whose `runBossTurn` blocks, when the Boss submits one line that starts a turn and then submits a second line that queues behind it (the runtime serializes turns per [[tmux-play-18](#tmux-play-18)]), releasing the first turn shall paint no fresh ready `boss> ` prompt while the second turn is still queued, and exactly one fresh ready prompt shall be painted after the second (last) queued turn ends.
An empty or whitespace-only line submitted while a turn is active or queued shall paint no fresh ready `boss> ` prompt.
This queue-drain clause is observable through the session's prompt-paint count, so it may use a stubbed readline rather than a real `createInterface`.
Given a real tmux server with an attached client and a Boss turn in flight, pane 0 shall show no fresh `boss> ` readline prompt line after the turn's streamed Captain output between `turn_started` and the turn's terminal record (the submitted-prompt input line is unaffected); this acceptance clause shall run under `*.acceptance.test.ts` and shall self-skip when `tmux -V`, `glow -v`, or an attached-client driver is unavailable or cannot attach a client (e.g. a headless CI runner).

### tmux-play-175

Given a YAML config with `notifications: { player_finished: bell, turn_finished: desktop }`, when `loadTmuxPlayConfig` returns, the loaded config shall carry `notifications: { player_finished: bell, turn_finished: desktop, turn_aborted: off }` [[tmux-play-76](#tmux-play-76)], [[tmux-play-11](#tmux-play-11)], [[tmux-play-34](#tmux-play-34)].
Given a YAML config that omits `notifications`, when `loadTmuxPlayConfig` returns and the launcher writes a snapshot, both the loaded config and snapshot shall carry `off` for all three notification events.
Given a YAML config with an unknown notification key such as `runtime_error` or a sink outside `off | bell | desktop`, the loader shall reject with an error that names the offending `notifications.<key>` path.
Where an old home YAML loaded through fallback discovery lacks safe defaults, the loader shall update that home YAML with only missing `theme: auto`, resolved layout defaults, `captain.options: {}`, and notification defaults; it shall preserve existing values and shall not synthesize `model`, `instruction`, `permissions`, or an effort default when neither effort key exists [[tmux-play-90](#tmux-play-90)].

### tmux-play-176

Given a `NotificationObserver` configured with `player_finished: bell`, when it receives `player_finished` records with `status: ok`, `status: error`, and `status: aborted` on macOS, it shall launch one detached best-effort `afplay /System/Library/Sounds/Hero.aiff` sound command for each record, shall write no terminal BEL (`\x07`) or other bytes to orchestrator stdout, and shall launch no desktop notification command [[tmux-play-77](#tmux-play-77)], [[tmux-play-23](#tmux-play-23)].
Given a `NotificationObserver` configured with `player_finished: bell`, when it receives a `player_finished` record on Linux or Windows, it shall launch one detached best-effort native completion sound command (`complete` through the freedesktop sound stack on Linux; the Windows generic notification sound on Windows); on other platforms it shall launch no command.
Given a `NotificationObserver` configured with `turn_finished: desktop`, when it receives one `turn_finished` record on macOS, it shall launch exactly one detached best-effort `osascript` notification command with lowercase title `spex`, shall write exactly one terminal BEL (`\x07`) to orchestrator stdout, and shall not launch an `afplay` sound command.
Given a `NotificationObserver` configured with `player_finished: desktop` or `turn_aborted: desktop`, when it receives the matching record on macOS, it shall launch exactly one detached best-effort `osascript` notification command with lowercase title `spex` and shall write no terminal BEL (`\x07`) or terminal notification escape bytes to orchestrator stdout.
Given a `NotificationObserver` configured with `turn_finished: desktop`, when it receives one `turn_finished` record on Linux, it shall launch exactly one detached best-effort `notify-send` OS notification command with lowercase title `spex` and shall write no terminal BEL (`\x07`) or terminal notification escape; on other platforms it shall launch no command and write no terminal BEL.
Given a built `TmuxPlaySession` running in pane 0 on macOS with `turn_finished: desktop` and an attached real tmux client, when a Boss turn finishes, tmux shall raise an `alert-bell` for the raw terminal BEL emitted from pane 0.
Given a `NotificationObserver` configured with `turn_aborted: bell`, when it receives `turn_aborted` records whose reason is `ESC`, `SIGHUP`, `SIGINT`, `SIGTERM`, `EOF`, or `runtime disposed`, it shall launch no sound command; when it receives a non-user-cancellation reason, it shall notify through the configured sink.
Given notification sinks throw, spawn fails, or a `runtime_error` record arrives, `NotificationObserver.onRecord` shall not throw.
Given a `TmuxPlaySession` starts, the runtime observer array shall contain the notification observer registered with the existing presenter, follow, and timing observers before any opt-in test/user observers.

### tmux-play-178

Given a real tmux server hosting a launched tmux-play session whose Boss/Captain pane is running the real session readline with a local no-op Captain and sits at the top of its mostly-empty pane, when the Boss types `abc` and then backspaces it away (no submission), the pane's `#{history_size}` shall not increase across the edits and the pane scrollback shall contain none of the phantom rows `boss> abc`, `boss> ab`, `boss> a`; a wheel-up or `scroll-up` after the edits shall not reveal any prompt row above the pane's first line [[tmux-play-79](#tmux-play-79)].
The acceptance probe shall run under `*.acceptance.test.ts`, shall not require adapter API keys, shall not respawn pane 0 (the defect depends on pane 0's real readline process), and shall self-skip when `tmux -V` or `glow -v` fails.

### tmux-play-179

Given a YAML config that sets explicit positive-integer `layout.singlePlayerColumnWeights` (length `2`) and/or `layout.multiPlayerColumnWeights` (length `3`), when the config is loaded the resolved layout shall carry those arrays verbatim for their shapes [[tmux-play-64](#tmux-play-64)].
Given a YAML config that sets only a two-element `layout.columnWeights`, the resolved `singlePlayerColumnWeights` shall equal that array and the resolved `multiPlayerColumnWeights` shall be the `[1, 1, 1]` default; given only a three-element `layout.columnWeights`, the resolved `multiPlayerColumnWeights` shall equal that array and the resolved `singlePlayerColumnWeights` shall be the `[1, 1]` default.
Given a shape with neither its canonical field nor a matching `layout.columnWeights` alias present, weight resolution shall fall back to that shape's default (`[1, 1]` for the single-player shape, `[1, 1, 1]` for the multi-player shape), so the resolution precedence is the canonical field, then the matching `columnWeights` alias, then the shape default.
Given a YAML config that sets both `layout.columnWeights` and the canonical field for the same shape (a two-element `columnWeights` with `singlePlayerColumnWeights`, or a three-element `columnWeights` with `multiPlayerColumnWeights`), the loader shall reject the config with an error naming the conflicting `layout` paths per [[tmux-play-8](#tmux-play-8)].
Given a two-element `layout.columnWeights` alongside an explicit `layout.multiPlayerColumnWeights` (or a three-element `columnWeights` alongside `singlePlayerColumnWeights`) — aliases targeting different shapes — the loader shall accept the config and resolve each shape from its own source.
Given a `layout.columnWeights` whose length is neither `2` nor `3`, a `layout.singlePlayerColumnWeights` not of length `2`, a `layout.multiPlayerColumnWeights` not of length `3`, or any non-positive-integer weight in any of these fields, the loader shall reject the config with an error naming the offending path per [[tmux-play-8](#tmux-play-8)].

### tmux-play-180

Given a YAML config whose `layout.initialVisible` names a non-empty, duplicate-free subset of configured player IDs, when the config is loaded the resolved startup-visible set shall equal that list in its given order, and the snapshot per [[tmux-play-34](#tmux-play-34)] shall carry that list [[tmux-play-80](#tmux-play-80)], [[tmux-play-64](#tmux-play-64)], [[tmux-play-28](#tmux-play-28)].
Given a config that omits `layout.initialVisible`, the resolved startup-visible set shall be every configured player in `players` order.
Given an empty configured roster, omitted or explicit `layout.initialVisible: []` shall resolve and snapshot an empty startup-visible set with active weights `[1]`.
Given a non-empty roster and `layout.initialVisible: []`, or any roster with a duplicate or an ID absent from `players`, the loader shall reject the config with an error naming the offending path per [[tmux-play-8](#tmux-play-8)].
Given a `layout.initialVisible` that selects a single player from a multi-player roster, the resolved visible-column shape shall be the two-column single-player shape and the resolved weights shall come from `singlePlayerColumnWeights` per [[tmux-play-64](#tmux-play-64)]; given one that selects two or more, the shape shall be the three-column multi-player shape and the weights shall come from `multiPlayerColumnWeights`.

### tmux-play-181

Given no config in either discovery location and no `--config`, when the launcher creates the default home config, the written YAML shall carry an explicit `layout` block with `window: { columns: 174, rows: 49 }` and `multiPlayerColumnWeights: [1, 1, 1]`, and shall not carry a `layout.columnWeights` key [[tmux-play-10](#tmux-play-10)], [[tmux-play-11](#tmux-play-11)], [[tmux-play-64](#tmux-play-64)].
Given an existing home config loaded through fallback discovery that carries a legacy two-element `layout.columnWeights`, when migration runs the rewritten home YAML on disk shall carry `layout.singlePlayerColumnWeights` with that array and shall not carry `layout.columnWeights`; given a three-element `layout.columnWeights`, the rewritten YAML shall carry `layout.multiPlayerColumnWeights` with that array and shall not carry `layout.columnWeights` [[tmux-play-90](#tmux-play-90)].
The migration shall write exactly one final YAML form; at no point shall the on-disk file contain both `layout.columnWeights` and the matching canonical field [[tmux-play-90](#tmux-play-90)].
Given an existing home config that already carries both `layout.columnWeights` and the matching canonical field, the launcher shall not rewrite it to resolve the conflict and the load shall be rejected per [[tmux-play-64](#tmux-play-64)] with an error naming the conflicting `layout` paths [[tmux-play-90](#tmux-play-90)].
Given an explicit `--config` file or a cwd project config that carries a legacy `layout.columnWeights`, the launcher shall not mutate that file; the config shall remain valid through the [[tmux-play-64](#tmux-play-64)] alias [[tmux-play-90](#tmux-play-90)].

### tmux-play-182

Given a YAML config with three configured players and `layout.initialVisible: [b, a]` (a two-player subset in that order), when `launchTmuxPlay({ attach: false })` builds the session on a real tmux server, the main window shall contain the Boss/Captain pane plus exactly two player panes created in the order `b` then `a`, each tailing its own `<player>.log`, and the third configured player shall have no pane [[tmux-play-80](#tmux-play-80)], [[tmux-play-28](#tmux-play-28)], [[tmux-play-64](#tmux-play-64)].
Given a config that omits `layout.initialVisible`, the launcher shall create one player pane per configured player in `players` order, reproducing the prior startup topology.
The startup column geometry shall follow the visible-column shape of the startup-visible set per [[tmux-play-28](#tmux-play-28)] — a two-player visible set yields the three-column multi-player shape, a one-player visible set yields the two-column single-player shape — using the resolved weights per [[tmux-play-64](#tmux-play-64)].
Given an empty configured roster with omitted or explicit `layout.initialVisible: []`, the launcher shall create only the full-width Boss/Captain pane and no player pane or player log-tail process, while retaining safe Captain title, timer, input, mouse, and resize behavior.

### tmux-play-183

Given a running runtime driven headlessly per [[tmux-play-29](#tmux-play-29)] and a Captain that calls `CaptainContext.setVisiblePlayers` with a non-empty, duplicate-free subset of configured player IDs, the call shall resolve and the runtime shall emit exactly one `player_view_changed` record whose `visiblePlayerIds` equals the requested list in order [[tmux-play-16](#tmux-play-16)], [[tmux-play-81](#tmux-play-81)], [[tmux-play-82](#tmux-play-82)].
A call from `CaptainContext` during a turn shall carry that turn's `turnId: number`; a call from `CaptainSession` shall carry the active turn's `turnId: number` when a turn is in flight and `turnId: null` when no turn is active [[tmux-play-16](#tmux-play-16)], [[tmux-play-17](#tmux-play-17)], [[tmux-play-21](#tmux-play-21)].
Given an empty configured roster, empty calls through `CaptainSession` and `CaptainContext` shall both resolve, expose empty `players` manifests, and emit the corresponding null-turn and active-turn `player_view_changed` records before ordinary Captain call and terminal records continue [[tmux-play-16](#tmux-play-16)], [[tmux-play-17](#tmux-play-17)], [[tmux-play-21](#tmux-play-21)].
Given a non-empty roster and an empty argument, or any roster with a duplicate or unknown player ID, the returned Promise shall reject, no `player_view_changed` record shall be emitted, and the tracked visible set shall be unchanged; a Captain that catches the rejection shall be able to continue the turn [[tmux-play-81](#tmux-play-81)].
Across an accepted call, the runtime shall not alter the configured `players` roster, the `players` manifest exposed to the Captain, or any player's `Cligent` continuity [[tmux-play-16](#tmux-play-16)].

### tmux-play-184

Given the presenter, follow, timing, and notification observers registered in session mode, when a `player_view_changed` record is dispatched, verification shall assert this matrix for both `turnId: number` and `turnId: null` [[tmux-play-98](#tmux-play-98)]:

| Observer | Assertion |
| --- | --- |
| presenter | write no bytes to the Boss/Captain-pane writer |
| follow | issue no copy-mode-exit or live-tail command |
| timing | change no pane or status timer option |
| notification | emit no sound, desktop notification, or terminal BEL |

### tmux-play-185

Given a real tmux server with a Boss/Captain pane plus player panes for an initial visible set, when the layout observer handles a `player_view_changed` whose `visiblePlayerIds` differs from the tracked set, the observer shall kill every main-window pane except the Boss/Captain pane and recreate one read-only pane per requested player in `visiblePlayerIds` order, each running `tail -n 200 -f <player>.log`, with pane titles, timer options, read-only input, mouse-selection bindings, layout hooks, and Boss-pane focus reapplied [[tmux-play-83](#tmux-play-83)], [[tmux-play-84](#tmux-play-84)].
Given a `player_view_changed` whose `visiblePlayerIds` equals the tracked set in the same order, the observer shall issue no tmux commands.
Given an empty roster whose tracked set starts empty, when the observer receives an accepted empty `player_view_changed`, it shall issue no tmux commands and leave the sole Boss/Captain pane intact.
Given a player that was hidden and is then named in a later `visiblePlayerIds`, its recreated pane shall display the recent tail of its `<player>.log` — the durable backlog living in the log file, not in tmux pane scrollback — per [[tmux-play-84](#tmux-play-84)].
Given a tmux command failure mid-rebuild, the observer shall not throw into record dispatch and shall not abort the Boss turn, and the tracked visible set shall not advance for an incomplete reconciliation.
Given an awaited `setVisiblePlayers(next)` followed by a `callPlayer()` for a newly visible player, the successful pane rebuild shall complete before that player's `player_prompt` / `player_event` records are presented, per [[tmux-play-83](#tmux-play-83)]'s ordered-dispatch guarantee.

### tmux-play-186

When a runtime is disposed repeatedly or concurrently, an implemented `Captain.prepareDispose()` shall run exactly once after the active turn unwinds while `CaptainSession.signal` remains live, its accepted status/telemetry emissions shall reach observers in their original order before the signal aborts, and `Captain.dispose()` shall run exactly once afterward with session emissions rejecting [[tmux-play-17](#tmux-play-17)], [[tmux-play-85](#tmux-play-85)].
When pre-close, its emission observer dispatch, initialization, or final-disposal steps reject, the runtime shall still abort the session signal, drain every accepted emission in its original order, invoke the remaining cleanup hook once, and detach observers; the returned rejection shall preserve the originating failure and every independent cleanup failure from those steps, without changing the legacy handling of an earlier dispatcher failure already surfaced by its originating runtime call [[tmux-play-17](#tmux-play-17)], [[tmux-play-85](#tmux-play-85)].

### tmux-play-187

Where a home, cwd, or explicit YAML config contains direct legacy `reasoningEffort` keys without same-object `effort` keys, when the complete config validates and the source remains unchanged, the loader shall expose the values as in-memory `effort`, replace only the parsed key tokens on disk, and invoke its optional callback once with the config, accepted field paths, and successful outcome.
Where a deterministic seam changes the source or makes the update fail, the loader shall retain the same in-memory values, preserve that newer or unwritable source, and report a skipped outcome; the launcher shall then emit one actionable stderr warning naming the file and fields and instructing the user to rename them manually [[tmux-play-86](#tmux-play-86)].

### tmux-play-188

Where one captain or player contains both effort key names, or a legacy value is invalid for its adapter, when the config is loaded, the loader shall reject without invoking the deprecation callback or modifying the source.
Text named `reasoningEffort` outside a direct captain/player key shall remain ordinary content and shall not be rewritten or trigger the callback [[tmux-play-87](#tmux-play-87)].

### tmux-play-190

Where a TypeScript consumer uses the public tmux-play declarations, the captain and player config types shall accept each adapter's own effort vocabulary and reject another adapter's provider-native value while retaining all non-effort runtime fields [[tmux-play-29](#tmux-play-29)], [[tmux-play-95](#tmux-play-95)].

### tmux-play-191

Where a Captain's runtime-owned `Cligent` stores an automatic resume token, when it calls `callCaptain(prompt, { resume: false, allowedTools: [] })`, the Captain adapter shall receive no resume token and an explicit empty allowlist while the call retains its normal records, result, and resolved visibility [[tmux-play-16](#tmux-play-16)], [[tmux-play-72](#tmux-play-72)], [[tmux-play-88](#tmux-play-88)].
Where `callCaptain` omits the session and tool fields, when the Captain calls it, the Captain adapter shall receive its stored automatic resume token and no per-call allowlist override [[tmux-play-16](#tmux-play-16)], [[tmux-play-88](#tmux-play-88)].
Where `callCaptain` receives a readonly non-empty allowlist, when the Captain calls it, tmux-play shall pass an equal mutable copy to `Cligent.run()` so caller-owned option data cannot be mutated at the adapter boundary [[tmux-play-16](#tmux-play-16)], [[tmux-play-88](#tmux-play-88)].

### tmux-play-192

Where a launcher-mode config assigns the Captain role or a player role to an adapter whose runtime is not installed, when `tmux-play` is invoked, no tmux command shall be issued, the invocation shall fail, and the error shall name that adapter, every role that uses it, the commands that install what it requires, and the config path to edit.
Where several roles share one unmet adapter, the error shall name that adapter once with all of its roles; where several adapters are unmet, the error shall name each of them rather than stopping at the first.
Where every configured adapter's runtime is installed, the launch shall proceed to session construction [[tmux-play-89](#tmux-play-89)], [[tmux-play-2](#tmux-play-2)].

The repair commands shall follow the tree the running package occupies: an optional peer SDK shall carry `-g` for a global installation and explicit non-global scope settings for a project installation, while an external CLI shall carry `-g` in both and shall never be pinned to cligent's tree, and the reported tree shall be the `node_modules` root the adapters resolve from, so a layout the canned command cannot repair stays diagnosable.

The test suite shall additionally fail unless every peer-SDK command — global and project alike — names the resolved tree with `--prefix` and pins its install scope on the command line: no observation from the launching process licenses a bare form, because that process cannot witness the environment or the working directory of the shell where the command is pasted, and an environment-supplied global mode would divert a prefix-only project command into `<prefix>/lib/node_modules`, so a project command shall carry explicit non-global `global` and `location` settings while a global command's asserted global mode alone suffices.
A `--prefix` path a shell would split shall be printed quoted and still target the reported tree.
A project install shall stay a project install wherever it is invoked from — classified by the manifest at its install root rather than by the working directory — and a resolved tree that no `npm install` invocation reaches shall carry no peer-SDK install command, naming instead the package and the tree to place it in.
The probe shall exercise a real `glow` binary rather than a mock, shall run under `*.acceptance.test.ts` via `npm run test:acceptance`, shall self-skip only when `glow -v` fails, and shall not gate on `tmux` or adapter API keys.

### tmux-play-193

Where the home and cwd are empty and exactly one supported adapter runtime is installed, when the config is resolved, the created YAML shall wire the Captain and a single player on that adapter, shall carry `model` and `effort` only where that adapter is one this project pins, and the stdout notice shall name that adapter.
Where more than two adapter runtimes are installed, the generated roster shall hold the first two in canonical adapter order.
Where no supported adapter runtime is installed, no file shall be created, and the failure shall name every supported adapter with the commands that install what it requires [[tmux-play-10](#tmux-play-10)], [[tmux-play-11](#tmux-play-11)].
The probe shall exercise a real `glow` binary rather than a mock, shall run under `*.acceptance.test.ts` via `npm run test:acceptance`, shall self-skip only when `glow -v` fails, and shall not gate on `tmux` or adapter API keys.

### tmux-play-196

Where player IDs contain one or more dot-delimited namespace segments and complete call settings select concrete or provider-default values, when tmux-play resolves and runs those calls, it shall accept the IDs, apply the complete detached settings without merging omitted instruction or permissions, use each enforceable provider default by omission, and resolve each explicit, forced-fresh, or automatic session selection once at admission for both reset preflight and the provider run [[tmux-play-7](#tmux-play-7)], [[tmux-play-41](#tmux-play-41)], [[tmux-play-93](#tmux-play-93)], [[tmux-play-94](#tmux-play-94)].
Where settings contain accessors, unknown or incomplete values, an adapter-invalid effort, an unmappable Gemini alias or OpenCode variant, a permission policy rejected by the adapter-owned mapping, a resumed Claude or OpenCode provider-default model, or a provider-default model, effort, or permission reset that resumed Kimi cannot enforce, the call shall fail before its prompt record and provider run while preserving its stored resume token.
Each such supplied-settings rejection shall be an `AgentCallSettingsError` recognized by `isAgentCallSettingsError()`, with its prior message and original cause preserved; the predicate shall reject turn or session scope errors, unknown-player errors, provider execution failures, and observer dispatch errors.
Where one OpenCode call installs a session permission ruleset and a later resumed complete-settings call supplies a concrete model but omits permissions, tmux-play shall clear the prior Cligent-owned session permission ruleset before dispatching the resumed prompt; the concrete model with provider-default effort shall also clear a prior variant without rejecting.
Package declaration verification shall expose `TuningSelection`, `AgentCallSettings`, `AgentCallSettingsError`, `isAgentCallSettingsError`, `LaunchManagedTmuxPlayOptions`, `LaunchTmuxPlayResult`, `ManagedTmuxPlayAttachOptions`, `ManagedTmuxPlayLaunchContext`, `PreparedManagedTmuxPlayLaunch`, `ManagedTmuxPlayInitializeContext`, `ManagedTmuxPlayTurnContext`, `ManagedTmuxPlayAfterTurnContext`, `ManagedTmuxPlayTerminalRecord`, `ManagedTmuxPlayShutdownContext`, `ManagedTmuxPlayLifecycle`, `ManagedTmuxPlaySessionOptions`, and `TmuxPlayRuntimeHandle`; package runtime verification shall expose `AgentCallSettingsError`, `isAgentCallSettingsError`, `launchManagedTmuxPlay`, and `runManagedTmuxPlaySession`.
The probe shall exercise a real `glow` binary rather than a mock, shall run under `*.acceptance.test.ts` via `npm run test:acceptance`, shall self-skip only when `glow -v` fails, and shall not gate on `tmux` or adapter API keys.

### tmux-play-197

Where an embedding front end prepares a managed tmux-play launch, the test suite shall prove that initialized readiness precedes return, caller reporting can occur before input activation and attach, launcher-to-child gate and shutdown markers are atomic complete create-once publications, the stable original Boss pane id—not a renumberable positional target—guards bounded readiness, pre-child failure removes only launcher-owned work state, activation is acknowledged before coordination cleanup, configured layout reaches attach behavior, and cancellation, initialization error, or attachment failure requests graceful shutdown, awaits the child's post-cleanup acknowledgement and pane exit under a shutdown bound independent of the readiness bound, then uses forced tmux teardown only as a bounded fallback.
The forced fallback shall tolerate pane disappearance within its fixed 500 ms verification window and shall retain owned state when disappearance cannot be proved [[tmux-play-94](#tmux-play-94)].
Where a managed launch receives an empty public session id or one containing a dot, colon, whitespace, or another character outside `^[A-Za-z0-9][A-Za-z0-9_-]*$`, it shall reject before creating a work directory, invoking the session-command factory, or issuing a tmux command; the direct managed runner shall reject the same values before lifecycle or presentation work, and an accepted id shall reach the factory unchanged and produce the exact `tmux-play-<sessionId>` name.
Where a managed launch uses a caller-supplied work directory containing an unrelated sentinel, ordinary, cancelled, and failed shutdown shall retain that directory and sentinel, shall expose `workDirOwnedByLauncher: false` to the session-command factory, and shall create no launcher-ownership marker; where the launcher created the directory, the factory shall receive `true`, and managed child cleanup shall remove it only while both that unchanged input is true and its launcher-ownership marker exactly matches the child's session id, while false ownership, a missing marker, or a mismatched marker shall retain it.
Where managed auto-theme resolution is prepared for eventual native attachment and receives a light OSC 11 reply, the snapshot and tmux appearance shall use Latte before `attach()`; where the public launch has `attach: false`, it shall not probe and shall use the fallback in the absence of a concrete override.
Where managed input, including a bracketed multiline paste, arrives before activation or shutdown occurs during either turn hook, SIGHUP, or an embedding shutdown request, the test suite shall prove that input is queued as the same semantic prompt without early runtime work, shutdown aborts and then awaits the whole hook/runtime/settlement transaction and runtime disposal before one lifecycle release, publishes its shutdown acknowledgement only after ordered cleanup, no readiness or activation is published after shutdown starts, no buffered reply becomes visible before a successful finished-turn settlement, and a successful finished settlement releases its replies even when shutdown is already awaiting that transaction.
Where SIGHUP and an embedding shutdown request are exercised separately during active work, the terminal and lifecycle shutdown hook shall receive `SIGHUP` and `embedding shutdown request`, respectively, without conflating the triggers.
The managed runner shall also prove that it applies [[tmux-play-74](#tmux-play-74)] isolation before its initialization hook, even when no CLI dispatcher invoked it.
Where a runtime emits an aborted terminal after a buffered reply and then resolves or rejects, the after hook shall receive that exact terminal record before settlement or propagated failure and the reply shall remain hidden; where initialization or any hook fails, the returned session promise shall reject only after awaited cleanup and shall release no reply.
Where an attachment signal is already aborted, aborts while activation is pending, or aborts during detached coordination cleanup, the test suite shall prove that its exact reason stays primary, `beforeNativeAttach` and the native client do not run, graceful child shutdown acknowledgement and pane exit precede rejection, and cleanup defects follow the reason in one aggregate; where native attachment proceeds, it shall prove that resize completes first, the callback runs exactly once immediately before the native client, and an abort after that callback does not trigger managed cancellation.
Where a managed turn or runtime failure and lifecycle shutdown cleanup both fail, the test suite shall prove that shutdown still runs every ordered cleanup step and exposes the primary failure followed by every distinct cleanup failure in one aggregate while preserving single-failure identity.
The probe shall exercise a real `glow` binary rather than a mock, shall run under `*.acceptance.test.ts` via `npm run test:acceptance`, shall self-skip only when `glow -v` fails, and shall not gate on `tmux` or adapter API keys.

### tmux-play-198

Given a real tmux server with a Boss/Captain pane and player panes of deliberately unequal widths, when the session is created, every pane shall carry its logical key in pane-scoped tmux state alongside a unique stable pane id, and the probe shall capture the key-to-pane-id mapping.
When the layout observer rebuilds the player area, every recreated pane shall carry its key the same way, and the probe shall capture the mapping again.
Given the displayed pane titles are then replaced with unrelated text and the panes are reordered by id-preserving swaps, a per-pane timer update per [[tmux-play-54](#tmux-play-54)] shall set its option on the captured pane id for the intended logical key, copy-mode live-follow per [[tmux-play-69](#tmux-play-69)] shall return the captured scrolled pane to its live tail, and prose rendered to the narrower player pane shall produce no visible row wider than that pane's own width even where the wider pane's width would have allowed one — so an implementation that routes by displayed title, pane position, or config order fails against the captured ids regardless of host locale behavior.
Given a tmux server started under a non-UTF-8 locale (e.g., `LC_ALL=C`), the launcher shall print the one-line warning exactly when the composed title fails to round-trip on that server, and the launch shall proceed; given a UTF-8 server whose composed-title round-trip succeeds, the same operations shall behave identically and no warning shall be printed.
The probe shall self-skip when either `tmux -V` or `glow -v` fails per [[tmux-play-51](#tmux-play-51)] [[tmux-play-96](#tmux-play-96)].

### tmux-play-201

Where the packed tarball alone is installed into a global-style prefix holding no agent SDK peer, and the search path reaches no agent CLI, when the installed `tmux-play` executable runs its documented launcher command against an isolated configuration home, the invocation shall fail, shall name the install command for every supported adapter, shall create no config file, and shall issue no tmux command [[tmux-play-10](#tmux-play-10)], [[tmux-play-11](#tmux-play-11)], [[tmux-play-89](#tmux-play-89)].
The prefix shall be supplied out of band, so that a repair command npm would not resolve back to it fails this test rather than passing on the harness's own knowledge of the prefix.
Where the Codex SDK is then installed by executing the repair command that failure printed — verbatim, as argv, with no scope or target argument the user was not shown — the SDK shall land in the `node_modules` root the same failure reported, the same launcher command shall succeed, the created config shall name `codex` as its only adapter, the stdout notice shall name the adapter the roster was built from, and a tmux session shall be created.
Composing an install command in the test instead of running the printed one shall not satisfy this item: it is the substitution that would let a command scoped to the wrong tree pass.

## References

[1]: https://catppuccin.com/palette/ "Catppuccin Palette"
[2]: https://github.com/charmbracelet/glow "glow — Render Markdown on the CLI"
[3]: https://github.com/tmux/tmux/blob/3.3/CHANGES "tmux 3.3 changes"
