// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { defineConfig } from 'vitest/config';
import { config } from 'dotenv';
import { join } from 'node:path';
import { homedir } from 'node:os';

config({ path: join(homedir(), '.cligent.env'), quiet: true });

export default defineConfig({
  test: {
    include: ['src/**/*.acceptance.test.ts'],
    testTimeout: 120_000,
  },
});
