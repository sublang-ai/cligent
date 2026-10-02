// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { defineConfig } from 'vitest/config';

// Portable native-protocol peers need no provider account or OS privacy grant.
// These run on every supported desktop/server OS in addition to the full suite.
export default defineConfig({
  test: {
    include: [
      'src/__tests__/approval-input.test.ts',
      'src/__tests__/claude-approvals.test.ts',
      'src/__tests__/kimi-approvals.test.ts',
      'src/__tests__/opencode-approvals.test.ts',
      'src/__tests__/opencode-questions.test.ts',
      'src/app/tmux-play/approval.integration.test.ts',
    ],
  },
});
