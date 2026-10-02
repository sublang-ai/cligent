// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { defineConfig } from 'vitest/config';

// Portable preparation/cleanup and real browser/SDK/CLI tool loops.
// Scripted providers remain local on the three supported CI platforms.
// No agent account, API credential, or paid model request is required.
export default defineConfig({
  test: {
    include: [
      'src/__tests__/browser.test.ts',
      'src/__tests__/mcp.test.ts',
      'src/browser.acceptance.test.ts',
      'src/__tests__/claude-browser.acceptance.test.ts',
      'src/adapters/codex-mcp.acceptance.test.ts',
      'src/adapters/gemini-attachments.acceptance.test.ts',
      'src/adapters/opencode-questions.acceptance.test.ts',
    ],
    fileParallelism: false,
  },
});
