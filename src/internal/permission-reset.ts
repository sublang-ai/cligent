// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { PermissionPolicy } from '../types.js';

/**
 * Private bridge for a runtime that must remove provider-persisted permission
 * state rather than merely omit a per-call policy. Public PermissionPolicy
 * values cannot carry this symbol, and tmux-play rejects symbol fields before
 * constructing the marker.
 */
export const PERMISSION_POLICY_RESET = Symbol(
  'cligent.permission-policy-reset',
);

export function createPermissionPolicyReset(): PermissionPolicy {
  return Object.freeze({
    [PERMISSION_POLICY_RESET]: true,
  }) as PermissionPolicy;
}

export function isPermissionPolicyReset(
  policy: PermissionPolicy | undefined,
): boolean {
  return (
    policy !== undefined &&
    (
      policy as PermissionPolicy & {
        readonly [PERMISSION_POLICY_RESET]?: unknown;
      }
    )[PERMISSION_POLICY_RESET] === true
  );
}
