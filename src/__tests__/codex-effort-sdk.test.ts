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

import {
  CodexAdapter,
  mapAgentOptionsToCodexOptions,
} from '../adapters/codex.js';

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

// codex-89: execute the adapter through the installed SDK, recording the
// actual child process arguments and prompt on fresh and resumed turns.
describe.each([undefined, 'existing-thread'])(
  'Codex SDK subagent delivery (%s)',
  (resume) => {
    const cases = [
      { name: 'untuned', options: {}, expectedModel: undefined },
      {
        name: 'blank parent',
        options: { model: '  ', subagentModel: 'inherit' },
        expectedModel: undefined,
      },
      {
        name: 'known inherit',
        options: { model: 'parent', subagentModel: 'inherit' },
        expectedModel: 'parent',
      },
      {
        name: 'unknown inherit',
        options: { subagentModel: 'inherit' },
        expectedModel: undefined,
      },
      ...(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const).map(
        (subagentEffort) => ({
          name: subagentEffort,
          options: {
            subagentModel: 'child',
            subagentEffort,
            fastMode: true,
            effort: 'high' as const,
          },
          expectedModel: 'child',
        }),
      ),
    ];
    it.each(cases)(
      'delivers $name with the caller image in order',
      async ({ options, expectedModel }) => {
        const dir = mkdtempSync(
          join(tmpdir(), 'cligent-codex-subagent-delivery-'),
        );
        tempDirs.push(dir);
        const executable = join(dir, 'fake-codex.mjs');
        const capture = join(dir, 'capture.json');
        const attachment = join(dir, 'image.png');
        const secondAttachment = join(dir, 'second.png');
        writeFileSync(
          attachment,
          Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMcQAAAAASUVORK5CYII=',
            'base64',
          ),
        );
        writeFileSync(secondAttachment, readFileSync(attachment));
        writeFileSync(
          executable,
          `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  writeFileSync(process.env.CLIGENT_CODEX_ARGV_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), input }));
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'recorded-thread' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } }) + '\\n');
});
`,
          'utf8',
        );
        chmodSync(executable, 0o700);
        const adapter = new CodexAdapter({
          loadSdk: async () => ({
            Codex: class extends Codex {
              constructor(config?: ConstructorParameters<typeof Codex>[0]) {
                super({
                  ...config,
                  codexPathOverride: executable,
                  env: {
                    ...stringEnvironment(),
                    CLIGENT_CODEX_ARGV_CAPTURE: capture,
                  },
                });
              }
            },
          }),
        });
        const events = [];
        for await (const event of adapter.run('Caller prompt.', {
          ...options,
          resume,
          attachments: [{ path: attachment }, { path: secondAttachment }],
        }))
          events.push(event);
        expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
        const recorded = JSON.parse(readFileSync(capture, 'utf8')) as {
          argv: string[];
          input: string;
        };
        if ('fastMode' in options) {
          expect(recorded.argv).toContain('service_tier="fast"');
          expect(recorded.argv).toContain('model_reasoning_effort="high"');
        }
        if (resume) expect(recorded.argv).toContain(resume);
        expect(recorded.argv).toContain(attachment);
        expect(recorded.argv.indexOf(secondAttachment)).toBeGreaterThan(
          recorded.argv.indexOf(attachment),
        );
        if (expectedModel)
          expect(recorded.argv).toContain(
            `agents.default_subagent_model="${expectedModel}"`,
          );
        else
          expect(
            recorded.argv.some((arg) =>
              arg.startsWith('agents.default_subagent_model='),
            ),
          ).toBe(false);
        if ('subagentEffort' in options)
          expect(recorded.argv).toContain(
            `agents.default_subagent_reasoning_effort="${options.subagentEffort}"`,
          );
        else
          expect(
            recorded.argv.some((arg) =>
              arg.startsWith('agents.default_subagent_reasoning_effort='),
            ),
          ).toBe(false);
        if ('subagentModel' in options) {
          expect(recorded.input).toMatch(/bound(?:ed| tightly)/i);
          expect(recorded.input).toMatch(/^When delegating this turn,/);
          expect(recorded.input).toContain('Choose the history each task needs');
          expect(recorded.input).toMatch(/role/i);
          expect(recorded.input).toMatch(/verif/i);
          expect(recorded.input).toMatch(/deep/i);
          expect(recorded.input).toMatch(/\n\nCaller prompt\./);
        } else expect(recorded.input.trim()).toBe('Caller prompt.');
        expect(
          recorded.argv.some((arg) =>
            arg.startsWith('developer_instructions='),
          ),
        ).toBe(false);
      },
    );
  },
);
