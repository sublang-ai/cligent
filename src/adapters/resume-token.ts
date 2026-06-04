// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { DonePayload } from '../types.js';

export function doneResumeTokenPayload(
  status: DonePayload['status'],
  resumableSessionIdKnown: boolean,
  sessionId: string,
  resume: string | undefined,
): { resumeToken?: string } {
  if (status === 'interrupted') {
    const resumeToken = resumableSessionIdKnown ? sessionId : resume;
    return resumeToken ? { resumeToken } : {};
  }

  return resumableSessionIdKnown ? { resumeToken: sessionId } : {};
}
