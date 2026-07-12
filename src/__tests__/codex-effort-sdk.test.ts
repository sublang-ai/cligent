// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Codex } from '@openai/codex-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { mapAgentOptionsToCodexOptions } from '../adapters/codex.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

describe('Codex SDK native effort config', () => {
  it.each(['ultra'] as const)(
    'serializes %s through the installed SDK as model_reasoning_effort',
    async (effort) => {
      const dir = mkdtempSync(join(tmpdir(), 'cligent-codex-effort-sdk-'));
      tempDirs.push(dir);
      const executable = join(dir, 'fake-codex.mjs');
      const capture = join(dir, 'argv.json');
      writeFileSync(
        executable,
        `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  writeFileSync(process.env.CLIGENT_CODEX_ARGV_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), input }));
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'effort-sdk-thread' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } }) + '\\n');
});
`,
        'utf8',
      );
      chmodSync(executable, 0o700);

      const mapped = mapAgentOptionsToCodexOptions({ effort });
      const codex = new Codex({
        ...mapped.codexOptions,
        codexPathOverride: executable,
        env: {
          ...stringEnvironment(),
          CLIGENT_CODEX_ARGV_CAPTURE: capture,
        },
      });

      await codex.startThread(mapped.threadOptions).run('verify effort');

      const recorded = JSON.parse(readFileSync(capture, 'utf8')) as {
        argv: string[];
        input: string;
      };
      const configIndex = recorded.argv.indexOf('--config');
      expect(configIndex).toBeGreaterThanOrEqual(0);
      expect(recorded.argv[configIndex + 1]).toBe(
        `model_reasoning_effort="${effort}"`,
      );
      expect(recorded.input).toContain('verify effort');
    },
  );
});
