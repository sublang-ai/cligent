<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-053: Definite Session Rejection

## Status

Completed (2026-09-05).

## Intent

Implement [DR-022](../decisions/022-definite-session-rejection.md).

## Deliverables

- [x] Implement authoritative resume rejection classification at adapter boundaries.
- [x] Preserve the classification through Captain/player results.
- [x] Verify definite, ambiguous and misleading-diagnostic cases without automatic retry.

## Tasks

1. Implement authoritative resume rejection classification at adapter boundaries.
2. Preserve the classification through Captain/player results.
3. Verify definite, ambiguous and misleading-diagnostic cases without automatic retry.

## Verification

- Required integration matrices are defined in the owning spec packages.
- `npm test`: 1,323 tests pass, including real OpenCode SDK and Kimi ACP rejection matrices and Captain/player result propagation.
- Typecheck, ESLint, spec lint and SPDX audit pass.
