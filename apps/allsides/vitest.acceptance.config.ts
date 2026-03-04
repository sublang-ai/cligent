// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.acceptance.test.ts'],
    testTimeout: 120_000,
  },
});
