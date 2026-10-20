<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# DR-038: Native Skills in tmux-play Call Settings

## Status

Accepted (2026-10-20).
Amends [DR-037](037-per-run-native-skill-switch.md) in its scope: Captain call settings carry `nativeSkills`, while tmux-play configuration stays out of scope.
Amends the supplied-settings admission of [[tmux-play-93](../packages/tmux-play.md#tmux-play-93)]: complete call settings may hold `nativeSkills`, admitted, snapshotted and forwarded as the other members are.

## Context

[DR-037](037-per-run-native-skill-switch.md) gives every `Cligent.run()` a per-call `nativeSkills` switch and left tmux-play configuration and Captain call settings out of scope.
Hosts that drive a Captain through tmux-play, such as Playbook's interactive and headless hosts and Spex's programmatic runtime, make every routing, adjudication and Judge call through `callCaptain` with complete `AgentCallSettings` ([DR-010](010-isolated-captain-control-calls.md)), and every player call through `callPlayer` the same way.
Admission takes a closed settings object, so a host cannot pass `nativeSkills`: an unknown member is rejected before the prompt record, and the runtime forwards only the members it names to `Cligent.run()`.
The switch therefore cannot reach the calls [DR-037](037-per-run-native-skill-switch.md) was made for: a Captain's control calls on adapters that cannot restrict tools, whose decisions persistent skills could otherwise steer.

## Decision

- `AgentCallSettings` gains an optional boolean `nativeSkills`, with [DR-037](037-per-run-native-skill-switch.md)'s meaning for that one call; omitting it leaves the runtime's own skill discovery as `Cligent.run()` leaves it.
- Admission rejects, before the prompt record and as an `AgentCallSettingsError`, a value other than a boolean and `false` for an adapter whose `NATIVE_SKILL_SUPPORT` descriptor does not accept the switch, so a Kimi Code call fails before it records anything.
- Admitted settings carry the value in their frozen snapshot, and the call passes it to `Cligent.run()` unchanged; the runtime-owned `Cligent` carries no `nativeSkills` default.
- The member applies to Captain and player calls alike, since both admit the same settings.
- A run that turns out unable to honor `false` only once it starts, such as OpenCode's external server mode, is rejected by its adapter before backend invocation, as for any other call.
- Rejected: a configured `nativeSkills` default at the top level, on the Captain or on a player, because hosts already supply complete settings for the calls that need isolation and a configured default would make a call's inputs depend on configuration the host does not see; deciding in tmux-play which calls turn native skills off, because that choice belongs to the host that knows a call's role.

## Consequences

- A host isolates a call by supplying `nativeSkills: false` in its settings, reading `getNativeSkillSupport(adapter)?.disableSupported` first to choose what to do with an adapter that refuses it.
- Calls made without supplied settings keep native discovery on, as before.
- The field is additive, so the change ships in a MINOR release.
