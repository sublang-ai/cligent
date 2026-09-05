<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-053: Definite Session Rejection

## Status

Planned; implementation awaits separate owner authorization.

## Intent

Implement [DR-022](../decisions/022-definite-session-rejection.md).

## Deliverables

- [ ] Implement authoritative resume rejection classification at adapter boundaries.
- [ ] Preserve the classification through Captain/player results.
- [ ] Verify definite, ambiguous and misleading-diagnostic cases without automatic retry.

## Tasks

1. Implement authoritative resume rejection classification at adapter boundaries.
2. Preserve the classification through Captain/player results.
3. Verify definite, ambiguous and misleading-diagnostic cases without automatic retry.

## Verification

- Required integration matrices are defined in the owning spec packages.
- No implementation tests or builds have run for this intent.
