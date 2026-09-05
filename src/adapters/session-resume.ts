// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

/** Only adapter-owned pre-prompt proof may produce this classification. */
export class SessionResumeRejectedError extends Error {}

/** Provider error codes cannot impersonate Cligent's recovery signal. */
export function ordinaryErrorCode(
  code: string | undefined,
  fallback: string,
): string | undefined {
  return code === 'SESSION_RESUME_REJECTED' ? fallback : code;
}
