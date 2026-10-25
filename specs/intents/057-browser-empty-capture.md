<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-057: Bounded Browser Empty-Image Recovery

## Status

Implemented, verified locally and independently reviewed; integration pending.

## Intent

Make the existing point-in-time browser proof tolerate one specifically identified empty-image capture failure without relaxing readiness or its deadline.
The packaged-host observation establishes that capture failed, without establishing a timing or compositor cause.

## Deliverables

- [x] Specify the narrow recovery and bounded pre-disposal diagnostics in [[mcp-11](../packages/mcp.md#mcp-11)].
- [x] Implement and verify the controlled subprocess cases in [[mcp-14](../packages/mcp.md#mcp-14)].

## Tasks

1. [x] Add one same-page recapture, preserve the original budget and cleanup, and verify success, refusal and interruption cases.

## Verification

- Focused browser preparation subprocess checks pass 32/32, covering oversized capture diagnostics, recovery, refusal, disposal rejection, deadline and cancellation.
- The native browser/MCP loopback navigation and PNG acceptance case passes 1/1; targeted ESLint and the required pre-push spec lint/typecheck gate pass.
- The initial focused run passed 30/31: its overall-timeout assertion expected proof-stage wording rather than the existing typed overall timeout; the corrected assertion preserves that behavior and the initial failure log.
- Review follow-up retains primary diagnostics before disposal and triggers the accelerated parent proof deadline only after the additional capture is waiting.
- No CI outcome or root cause is claimed by this intent.
