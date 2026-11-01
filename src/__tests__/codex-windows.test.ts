// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe.skipIf(process.platform !== 'win32')(
  'native Windows Codex transport (codex-81)',
  () => {
    it('preserves SDK data and reaps the native child on cancellation and early return', async () => {
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL('../../scripts/verify-codex-windows.mjs', import.meta.url),
          ),
        ],
        { env: process.env, windowsHide: true },
      );
      let output = '';
      child.stdout.on('data', (data) => {
        output += data;
      });
      child.stderr.on('data', (data) => {
        output += data;
      });
      const code = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', resolve);
      });
      expect(code, output).toBe(0);
      expect(JSON.parse(output).passed).toBe(true);
    }, 30000);
  },
);
