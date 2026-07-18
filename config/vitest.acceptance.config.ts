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
    globalSetup: ['src/__tests__/helpers/kimi-acceptance-global-setup.ts'],
    // Safe-write and fanout share one writable Kimi OAuth clone. Serialize
    // acceptance files so that mutable credential state has one writer.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 480_000,
  },
});
