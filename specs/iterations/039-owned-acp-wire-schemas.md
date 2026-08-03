<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-039: Owned ACP Wire Schemas

## Goal

Move the Kimi conformance target to Agent Client Protocol SDK `1.3.0` and
Kimi Code CLI `0.31.1` by giving the adapter its own wire schemas for the
protocol subset it consumes, so validation no longer depends on an
unpublished SDK build artifact.

## Status

Done

## Deliverables

- [x] The adapter validates inbound ACP traffic against schemas this project
      owns, covering exactly the fields it consumes, rejecting a payload that
      violates them and ignoring everything else.
- [x] DR-011 records that wire-schema ownership sits with the adapter rather
      than with the protocol SDK, and why the SDK's generated schemas cannot
      hold that role.
- [x] The ACP SDK and Kimi CLI conformance targets move to `1.3.0` and
      `0.31.1`, with the pairing verified through a real `kimi acp`
      initialization.
- [x] Documentation and canonical items name the moved Kimi target.

## Tasks

Each task is one commit and keeps build, typecheck, lint, unit, and smoke
checks green at its boundary.

1. [x] **Own the ACP wire schemas.**
       Add the adapter-owned schema module, switch the Kimi adapter's
       validation and its config-option and usage types to it, and cover the
       consumed contract with unit tests.
2. [x] **Move the ACP and Kimi conformance targets.**
       Pin ACP `1.3.0` and Kimi Code `0.31.1` across the manifest, lockfile,
       target verifier, distributable verification, and CI, and amend the
       canonical items and documentation that name either version.
3. [x] **Record the decision and the change.**
       Amend DR-011 with the wire-schema ownership consequence, record this
       iteration, and record the change in the unreleased changelog.

## Acceptance criteria

- The adapter imports no path inside another package's `dist/` directory.
- Malformed inbound traffic — a `session/update` without its parameters, a
  response carrying neither result nor error, an unrecognized prompt stop
  reason — still produces the actionable malformed-traffic error rather than
  being silently repaired.
- Every field the adapter reads off a message is covered by the owned
  schemas, because the protocol SDK parses the same traffic behind them and
  since `1.3.0` salvages what it cannot read: a consumed field left
  unvalidated is dropped there instead of rejected here, and the turn ends
  reporting success. A text chunk missing its text, a tool call carrying a
  status or title of the wrong type, nested tool content missing its own text,
  a permission request without its tool call or with an option missing a name
  or carrying an unrecognized kind, a plan whose entry carries an
  unrecognized status or whose update names no plan, and a `select`
  configuration option missing its current value are each rejected.
  A payload the adapter forwards whole, such as a plan, is consumed in its
  entirety and validated in its entirety, because a consumer receives whatever
  arrives.
- An agent may add unknown fields, and unknown `session/update` cases, without
  the adapter reporting valid traffic as malformed. A case the adapter acts on
  none of reaches neither the adapter nor the protocol SDK, whose closed union
  would reject it and log an error for traffic that changes nothing.
- `kimi acp` from CLI `0.31.1` initializes against SDK `1.3.0`, and the
  binary `off | on` thinking control still resolves through the CLI's
  per-model default effort.
- Build, lint, typecheck, unit, smoke, package, distributable, and live
  acceptance checks pass.
