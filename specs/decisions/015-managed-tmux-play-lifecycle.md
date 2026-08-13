<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-015: Managed tmux-play Launch Lifecycle

## Status

Accepted

## Context

- The managed embedding surface was developed twice in parallel.
  One line carried the complete two-phase implementation — readiness, a launcher-opened input gate with an
  input-active acknowledgement, and a shutdown request/acknowledgement pair — while the published line
  carried only a partial port of it: an `input-ready` file no child read, pre-activation input dropped, and
  no activation, abandonment, attach-failure, or teardown-ownership contract at all.
- Five review rounds designed a one-phase alternative (readiness as the only activation boundary) against
  that partial port, deferring a two-way protocol "until an embedding host needs a ready-but-inactive
  phase" and demanding that any such protocol bring its own cancellation, timeout, and abandonment
  semantics.
- The current launcher still prepares shared artifacts before session creation, so a colliding launch
  clobbers the existing session's live logs before the collision is detected.
- The finished implementation is that protocol: the prepared launch holds input gated so the host can
  report the public session id before activation, and it carries the demanded semantics — bounded
  readiness and shutdown timeouts, abort-safe attachment, acknowledged graceful shutdown with forced
  fallback, and aggregate cleanup-failure reporting.

## Decision

Adopt the two-phase managed lifecycle as specified by [TMUX-094](../user/tmux-play.md#tmux-094) and
verified by [TTMUX-097](../test/tmux-play.md#ttmux-097); the one-phase design is superseded.

- Readiness, input activation, and shutdown are each explicit, acknowledged transitions; coordination
  markers are atomic and create-once, so a child observes either no marker or a complete one.
- `attach()` opens the gate, awaits the child's input-active acknowledgement, and only then attaches;
  `cancel()` requests acknowledged graceful shutdown and force-terminates only past the bound.
- Input submitted before activation is queued semantically — one bracketed paste stays one prompt — and
  never executed early nor dropped, except on the failure path.
- Child liveness is monitored through the created Boss pane's stable pane id, never its position.

Constraints carried forward from the one-phase review, still unimplemented on this line:

- Teardown shall be ownership-scoped: the launcher captures the created session's identity and removes
  only that instance, so a launch that fails because a session by the derived name already exists rejects
  without killing or touching the pre-existing session.
- Ownership shall precede mutation: per-player logs, the session marker, and the config snapshot are
  truncated or overwritten only after the session name is acquired.
- The readiness and coordination markers' JSON shapes are a public wire contract with whatever child the
  caller's command runs, and shall be stated as such where a third-party child must interoperate.

## Consequences

- [TMUX-094](../user/tmux-play.md#tmux-094) carries the collision and mutation-order clauses; the
  implementing change and its acceptance legs follow in a dedicated iteration.
- The superseded one-phase items (a prepared handle with readiness-as-activation) were never merged; no
  code implements them and none shall.
- Logical pane identity is decided separately in
  [DR-016](016-tmux-pane-logical-identity.md).
