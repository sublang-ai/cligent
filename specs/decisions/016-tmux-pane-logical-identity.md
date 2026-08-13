<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-016: Logical tmux Pane Identity

## Status

Accepted

## Context

- Operational lookups — pane width for soft-wrap, per-pane timers, copy-mode live-follow — key on the
  displayed pane title (`<Display> · <adapter>` per [TMUX-048](../user/tmux-play.md#tmux-048)) parsed from
  tab-separated `list-panes -F` output.
- Under a non-UTF-8 locale (observed byte-level with `LC_CTYPE=C` on tmux 3.6a), tmux normalizes both the
  title's ` · ` and the tab separator to `_`, so every lookup misses and the features silently degrade.
- Under a UTF-8 locale the tab separator survives on tmux 3.6a, also verified byte-level; the fragility is
  locale normalization of presentation text used as identity, not a tmux 3.6 format change, correcting the
  attribution an in-repo test comment carries.
- Pane titles are a presentation contract and were never designed as stable keys.

## Decision

- Machine identity: the launcher at pane creation, and the layout observer at every player-area rebuild,
  assign each pane a logical key (`captain`, or the player `id`) in pane-scoped tmux user state.
- Operational lookups resolve logical key → stable tmux pane id; the displayed title is never parsed for
  identity.
- Machine-readable `-F` queries separate fields with a character schema-validated keys cannot contain
  (`|`); pane titles are excluded from machine parsing entirely.
- A failed title round-trip — the server reads back a different string than was set — gets one launcher
  warning; display may degrade there, operational behavior shall not. The server's observed behavior is
  the trigger, not the launcher process's locale variables, since the server may run under a different
  environment.

## Consequences

- [TMUX-096](../user/tmux-play.md#tmux-096) specifies the observable contract and
  [TTMUX-098](../test/tmux-play.md#ttmux-098) pins title-replacement acceptance with the round-trip
  warning legs.
- The shared tmux query helpers and the width, timer, and follow consumers change in an implementing
  iteration; until then the code still parses titles.
- A normalized displayed title remains possible under exotic locales and is acceptable, being cosmetic
  only.
