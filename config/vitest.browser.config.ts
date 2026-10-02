// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { defineConfig } from 'vitest/config';

// Real browser and SDK/CLI tool loops, with local scripted providers.
// No agent account, API credential, or paid model request is required.
export default defineConfig({
  test: {
    include: [
      'src/browser.acceptance.test.ts',
      'src/__tests__/claude-browser.acceptance.test.ts',
      'src/adapters/codex-mcp.acceptance.test.ts',
      'src/adapters/gemini-attachments.acceptance.test.ts',
      'src/adapters/opencode-questions.acceptance.test.ts',
    ],
    fileParallelism: false,
  },
});
