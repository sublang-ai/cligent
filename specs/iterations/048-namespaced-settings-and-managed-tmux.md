<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-048: Namespaced Settings and Managed tmux Lifecycle

## Goal

Let an embedding playbook bind namespaced players to independent sessions, replace an agent's effective settings per call, and own durable interactive-session transactions without exposing replies before settlement.

## Deliverables

- [x] tmux-play accepts dot-delimited player IDs and complete per-call model, effort, instruction, and permission settings.
- [x] Provider-default selections reset supported fresh or resumed calls by omission, while unenforceable settings fail with a typed public rejection before provider work without losing continuity.
- [x] A public prepared launcher and managed pane-session lifecycle expose initialized readiness, caller-controlled activation, fenced turn hooks, reply gating, and serialized shutdown.
- [x] An empty roster runs as a Boss/Captain-only session with no player panes while preserving runtime records, presentation, and managed settlement.
- [x] Specs, documentation, package declarations, and regression coverage describe and verify the complete surface.

## Tasks

1. [x] **Add namespaced calls and transactional managed sessions.**
       Amend [[tmux-play-7](../packages/tmux-play.md#tmux-play-7)] and [[tmux-play-41](../packages/tmux-play.md#tmux-play-41)], add [[tmux-play-93](../packages/tmux-play.md#tmux-play-93)], [[tmux-play-94](../packages/tmux-play.md#tmux-play-94)], [[tmux-play-196](../packages/tmux-play.md#tmux-play-196)], and [[tmux-play-197](../packages/tmux-play.md#tmux-play-197)]; implement detached complete call settings, adapter-owned mapping preflight, segmented player IDs, prepared activation/attach, terminal-aware reply settlement, serialized managed shutdown, and the strict empty-roster Boss/Captain-only shape; export and document the APIs per [[tmux-play-29](../packages/tmux-play.md#tmux-play-29)] and record the change in the changelog.
2. [x] **Make managed attachment abort-safe.**
       Amend [[tmux-play-94](../packages/tmux-play.md#tmux-play-94)] and [[tmux-play-197](../packages/tmux-play.md#tmux-play-197)]; add an abort signal and synchronous native-handoff callback to prepared attachment, keep abort ownership through activation or detached coordination cleanup, retire the child before rejection with primary-first cleanup aggregation, and preserve every managed shutdown failure.

## Acceptance criteria

- Dotted player IDs resolve without changing ordinary single-segment IDs or log/pane behavior.
- A supplied settings object is a closed detached replacement, and every rejection is distinguishable through the public settings-error predicate, precedes call records and provider work, preserves its diagnostic and cause, and retains the selected token.
- Codex and Gemini can select provider defaults on fresh and resumed calls; Claude and OpenCode can do so when fresh and can reset resumed effort beside a concrete model, but fail closed for an unrestorable resumed default model; fresh Kimi can select defaults, while resumed Kimi fails closed when ACP cannot restore a model, effort, or permission default.
- A managed launcher returns only after child initialization while input remains gated behind atomic control markers until the caller reports the public id and explicitly attaches; queued multiline paste retains one semantic prompt.
- The managed session runner isolates agent subprocesses from the hosting tmux server before embedding-owned runtime initialization, even when invoked without the tmux-play CLI dispatcher.
- A managed turn presents replies only after a finished terminal has crossed the runtime fence and settlement hook; aborted and failed transactions present none, and a fenced terminal still reaches settlement when the runtime then rejects.
- Shutdown aborts active work and awaits the full transaction and runtime disposal before lifecycle release and returned-promise settlement.
- Empty `players` plus omitted or empty `layout.initialVisible` launches one full-width Boss/Captain pane, exposes empty runtime manifests, accepts empty visibility records, and preserves managed reply settlement; a nonempty roster still rejects an empty visible set.
- Existing nonempty-roster tmux-play launch/session/runtime behavior and generic `Cligent` option merging remain unchanged, except that stock session mode now routes SIGHUP through the ordinary [[tmux-play-26](../packages/tmux-play.md#tmux-play-26)] shutdown lifecycle.
- Attachment abort before native handoff retires the managed child and preserves all failures, while a signal after the synchronous handoff belongs to the native client and detached activation never invokes the handoff callback.
