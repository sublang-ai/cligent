// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Codex } from '@openai/codex-sdk';
import { expect, it } from 'vitest';

import { Cligent } from '../cligent.js';
import { AGENT_RUNTIME_TARGETS } from '../runtime-targets.js';
import type { AgentEvent } from '../types.js';
import { probeCodexExecutable } from './codex-executable.js';
import { CodexAdapter, resolveCodexBinPath } from './codex.js';

let launcher: string | undefined;
try {
  launcher = resolveCodexBinPath();
} catch {
  /* Optional native runtime. */
}
const acceptanceIt = launcher || process.env.CI ? it : it.skip;
const PARENT_PROMPT = 'PARENT_ONLY: Spawn one fresh child, then finish.';
const CHILD_PROMPT = 'CHILD_ONLY: Return CHILD_DONE.';

interface ProviderRequest {
  model: string;
  reasoning: { effort: string };
  input: Array<{
    type: string;
    call_id?: string;
    output?: string;
    content?: Array<{ text?: string }>;
  }>;
  tools: Array<{
    type: string;
    name?: string;
    tools?: Array<{ name: string; parameters: unknown }>;
  }>;
  client_metadata?: Record<string, string>;
}

for (const override of [false, true]) {
  acceptanceIt(
    `runs a fresh native Codex child with ${override ? 'explicit spawn overrides' : 'adapter defaults'} (codex-90)`,
    async () => {
      expect(
        launcher,
        'The native Codex target must be installed in CI',
      ).toBeDefined();
      const version = spawnSync(process.execPath, [launcher!, '--version'], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      if (version.error) throw version.error;
      expect(version.status, version.stderr).toBe(0);
      expect(version.stdout.trim()).toBe(
        `codex-cli ${AGENT_RUNTIME_TARGETS.codex[0]!.tested}`,
      );

      const root = await mkdtemp(join(tmpdir(), 'cligent-codex-subagents-'));
      const home = join(root, 'codex-home');
      const requests: ProviderRequest[] = [];
      const events: AgentEvent[] = [];
      const serverErrors: string[] = [];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      let childFinished!: () => void;
      const childCompletion = new Promise<void>((resolve) => {
        childFinished = resolve;
      });
      const childTimer = setTimeout(childFinished, 10_000);
      const provider = createServer(async (request, response) => {
        try {
          if (request.url !== '/v1/responses')
            throw new Error(`Unexpected provider path: ${request.url}`);
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const body = JSON.parse(
            Buffer.concat(chunks).toString('utf8'),
          ) as ProviderRequest;
          requests.push(body);
          const index = requests.length;
          if (index > 5) throw new Error('Unexpected extra provider request');
          const child =
            body.client_metadata?.['x-openai-subagent'] === 'collab_spawn';
          // Keep the parent alive until the real child has made its own request.
          if (index !== 1 && !child) await childCompletion;
          const item =
            index === 1
              ? {
                  id: 'fc_spawn',
                  type: 'function_call',
                  call_id: 'call_spawn',
                  namespace: 'multi_agent_v1',
                  name: 'spawn_agent',
                  status: 'completed',
                  arguments: JSON.stringify({
                    message: CHILD_PROMPT,
                    fork_context: false,
                    ...(override
                      ? { model: 'gpt-6-sol', reasoning_effort: 'medium' }
                      : {}),
                  }),
                }
              : {
                  id: `msg_${index}`,
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [
                    {
                      type: 'output_text',
                      text: child ? 'CHILD_DONE' : 'PARENT_DONE',
                      annotations: [],
                    },
                  ],
                };
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          let sequence = 0;
          const send = (type: string, value: Record<string, unknown>) =>
            response.write(
              `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...value })}\n\n`,
            );
          send('response.created', {
            response: {
              id: `resp_${index}`,
              object: 'response',
              status: 'in_progress',
              output: [],
            },
          });
          send('response.output_item.added', { output_index: 0, item });
          if (index !== 1)
            send('response.output_text.delta', {
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: child ? 'CHILD_DONE' : 'PARENT_DONE',
            });
          send('response.output_item.done', { output_index: 0, item });
          send('response.completed', {
            response: {
              id: `resp_${index}`,
              object: 'response',
              status: 'completed',
              output: [item],
              usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
            },
          });
          response.end();
          if (child) childFinished();
        } catch (error) {
          serverErrors.push(String(error));
          response.writeHead(500).end();
        }
      });
      try {
        await mkdir(home);
        await new Promise<void>((resolve, reject) => {
          provider.once('error', reject);
          provider.listen(0, '127.0.0.1', resolve);
        });
        const address = provider.address();
        if (!address || typeof address === 'string')
          throw new Error('No local provider address');
        const configuration = [
          'model_provider = "fixture"',
          '[model_providers.fixture]',
          'name = "Local fixture provider"',
          `base_url = "http://127.0.0.1:${address.port}/v1"`,
          'wire_api = "responses"',
          'requires_openai_auth = false',
        ].join('\n');
        await writeFile(join(home, 'config.toml'), configuration);
        // Pass only platform plumbing, with fresh homes and no provider credentials.
        const env = Object.fromEntries(
          Object.entries({
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            PATHEXT: process.env.PATHEXT,
            HOME: root,
            CODEX_HOME: home,
            TMPDIR: root,
            TEMP: root,
            TMP: root,
          }).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        );
        const adapter = new CodexAdapter({
          probeExecutable: () => probeCodexExecutable(),
          loadSdk: async () => ({
            Codex: class extends Codex {
              constructor(options: ConstructorParameters<typeof Codex>[0]) {
                super({
                  ...options,
                  env,
                  config: {
                    ...options?.config,
                    features: { multi_agent: true, tool_search: false },
                  },
                });
              }
            },
          }),
        });
        for await (const event of new Cligent(adapter, {
          cwd: root,
          model: 'gpt-5.4',
          effort: 'high',
          subagentModel: 'gpt-6-luna',
          subagentEffort: 'low',
        }).run(PARENT_PROMPT, { abortSignal: controller.signal }))
          events.push(event);

        const diagnostics = JSON.stringify({
          events,
          serverErrors,
          requests: requests.map(
            ({ model, reasoning, client_metadata, input }) => ({
              model,
              reasoning,
              client_metadata,
              results: input.filter(
                (item) => item.type === 'function_call_output',
              ),
            }),
          ),
        });
        expect(serverErrors, diagnostics).toEqual([]);
        expect(
          events.filter((event) => event.type === 'error'),
          diagnostics,
        ).toEqual([]);
        expect(requests.length, diagnostics).toBeGreaterThanOrEqual(3);
        const parents = requests.filter(
          (body) => !body.client_metadata?.['x-openai-subagent'],
        );
        const children = requests.filter(
          (body) =>
            body.client_metadata?.['x-openai-subagent'] === 'collab_spawn',
        );
        // A child completion notification can produce another parent request.
        expect(parents.length, diagnostics).toBeGreaterThanOrEqual(2);
        expect(children, diagnostics).toHaveLength(1);
        for (const parent of parents)
          expect(parent).toMatchObject({
            model: 'gpt-5.4',
            reasoning: { effort: 'high' },
          });
        expect(children[0], diagnostics).toMatchObject({
          model: override ? 'gpt-6-sol' : 'gpt-6-luna',
          reasoning: { effort: override ? 'medium' : 'low' },
        });
        const spawn = requests[0]?.tools
          .flatMap((tool) => tool.tools ?? [])
          .find((tool) => tool.name === 'spawn_agent');
        expect(spawn?.parameters, diagnostics).toMatchObject({
          properties: { fork_context: { type: 'boolean' } },
        });
        const parentInput = JSON.stringify(parents[0]?.input);
        expect(parentInput).toContain(PARENT_PROMPT);
        expect(parentInput).toContain('fork_context=false');
        expect(parentInput).not.toContain('fork_turns');
        expect(parentInput).toContain('gpt-6-luna');
        expect(parentInput).toContain('low reasoning effort');
        expect(JSON.stringify(children[0]?.input)).toContain(CHILD_PROMPT);
        expect(JSON.stringify(children[0]?.input)).not.toContain('PARENT_ONLY');
        const result = parents[1]?.input.find(
          (item) =>
            item.type === 'function_call_output' &&
            item.call_id === 'call_spawn',
        )?.output;
        expect(JSON.parse(result ?? '{}'), diagnostics).toHaveProperty(
          'agent_id',
        );
        expect(events.at(-1)?.payload, diagnostics).toMatchObject({
          status: 'success',
          result: 'PARENT_DONE',
        });
        expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(
          configuration,
        );
      } finally {
        clearTimeout(timer);
        clearTimeout(childTimer);
        childFinished();
        controller.abort();
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 100,
        });
      }
    },
    60_000,
  );
}
