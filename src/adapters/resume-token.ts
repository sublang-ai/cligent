// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { DonePayload } from '../types.js';

export function doneResumeTokenPayload(
  status: DonePayload['status'],
  backendProvidedSessionId: boolean,
  sessionId: string,
  resume: string | undefined,
): { resumeToken?: string } {
  if (status === 'interrupted') {
    const resumeToken = backendProvidedSessionId ? sessionId : resume;
    return resumeToken ? { resumeToken } : {};
  }

  return backendProvidedSessionId ? { resumeToken: sessionId } : {};
}
