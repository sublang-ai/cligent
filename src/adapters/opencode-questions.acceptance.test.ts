// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// The real SDK, CLI, question tool, registry and rejection endpoint run here.
// Only the model is replaced with a loopback chat-completions provider.
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import {
  createOpencodeClient,
  type QuestionRequest,
} from '@opencode-ai/sdk/v2';
import { describe, expect, it } from 'vitest';

import { Cligent } from '../cligent.js';
import { AGENT_RUNTIME_TARGETS } from '../runtime-targets.js';
import type { AgentEvent } from '../types.js';
import { OpenCodeAdapter, wrapOpencodeClient } from './opencode.js';

// npm's Windows command shim is not directly executable by node.spawn. Resolve
// the package's actual binary from global/local npm PATH layouts without a shell.
// This fixture owns an external server; managed Windows command discovery is
// a separate contract and is not bypassed or claimed by this acceptance test.
const nativePath = Object.entries(process.env).find(
  ([key]) => key.toLowerCase() === 'path',
)?.[1];
const command =
  process.platform === 'win32'
    ? ((nativePath ?? '')
        .split(delimiter)
        .flatMap((directory) => [
          join(directory, 'opencode.exe'),
          join(directory, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
          resolve(directory, '..', 'opencode-ai', 'bin', 'opencode.exe'),
        ])
        .find(existsSync) ?? 'opencode')
    : 'opencode';
const version = spawnSync(command, ['--version'], {
  encoding: 'utf8',
  timeout: 10_000,
});
const available =
  (version.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT';
const acceptanceIt = available || process.env.CI ? it : it.skip;
const MODEL = 'cligent-fixture/question';
const FINISHED =
  'The unsupported question was declined; continuing without an answer.';
const QUESTION = {
  questions: [
    {
      question: 'Which inspection mode should this isolated fixture use?',
      header: 'Mode',
      options: [
        { label: 'Read', description: 'Inspect existing files.' },
        { label: 'Stop', description: 'Do not inspect files.' },
      ],
      multiple: false,
    },
  ],
};

interface ProviderRequest {
  stream?: boolean;
  tools?: Array<{ function?: { name?: string } }>;
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
}

async function settles(promise: Promise<void>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('OpenCode native structured-question refusal (opencode-66)', () => {
  acceptanceIt(
    'rejects a real question, preserves permission rules, and supports a resumed next turn without asking the host',
    async () => {
      if (version.error) throw version.error;
      expect(version.status, version.stderr).toBe(0);
      expect(version.stdout.trim()).toBe(
        AGENT_RUNTIME_TARGETS.opencode.find((target) => target.kind === 'cli')!
          .tested,
      );

      const root = await mkdtemp(join(tmpdir(), 'cligent-opencode-question-'));
      const cwd = join(root, 'workspace');
      const home = join(root, 'home');
      await Promise.all([mkdir(cwd), mkdir(home)]);
      const requests: ProviderRequest[] = [];
      const errors: unknown[] = [];
      const nativeEvents: unknown[] = [];
      const events: AgentEvent[] = [];
      const promptRequests: Array<Record<string, unknown>> = [];
      const rejectedRequests: unknown[] = [];
      const permissionSnapshots: unknown[] = [];
      const observations: Array<{
        turn: number;
        time: number;
        kind: string;
        data: unknown;
      }> = [];
      let currentTurn = 0;
      let lastClient: ReturnType<typeof createOpencodeClient> | undefined;
      let finalNativeState: unknown;
      const observe = (kind: string, data: unknown) =>
        observations.push({ turn: currentTurn, time: Date.now(), kind, data });
      let approvalCalls = 0;
      let modelCalls = 0;
      let sessionID: string | undefined;
      let child: ChildProcessWithoutNullStreams | undefined;
      let childClosed: Promise<void> | undefined;
      let childLog = '';
      let passed = false;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      const provider = createServer(async (request, response) => {
        try {
          if (request.url !== '/v1/chat/completions') {
            throw new Error(`Unexpected local provider path: ${request.url}`);
          }
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const body = JSON.parse(
            Buffer.concat(chunks).toString('utf8'),
          ) as ProviderRequest;
          requests.push(body);
          observe('provider.request', {
            index: requests.length,
            modelCalls,
            tools: body.tools?.map((tool) => tool.function?.name),
          });
          const workingCall = body.tools?.some(
            (tool) => tool.function?.name === 'question',
          );
          if (workingCall) modelCalls++;
          if (modelCalls > 3)
            throw new Error('Unexpected repeated working call');
          const asksQuestion = workingCall && modelCalls <= 2;
          const content = workingCall ? FINISHED : 'Question refusal fixture';
          const toolCall = {
            id: `call_native_question_${modelCalls}`,
            type: 'function',
            function: { name: 'question', arguments: JSON.stringify(QUESTION) },
          };
          if (!body.stream) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({
                id: 'chatcmpl-question',
                object: 'chat.completion',
                created: 1,
                model: 'question',
                choices: [
                  {
                    index: 0,
                    message: asksQuestion
                      ? {
                          role: 'assistant',
                          content: null,
                          tool_calls: [toolCall],
                        }
                      : { role: 'assistant', content },
                    finish_reason: asksQuestion ? 'tool_calls' : 'stop',
                  },
                ],
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 5,
                  total_tokens: 15,
                },
              }),
            );
            return;
          }
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          for (const [delta, finishReason] of [
            [{ role: 'assistant' }, null],
            [
              asksQuestion
                ? { tool_calls: [{ index: 0, ...toolCall }] }
                : { content },
              null,
            ],
            [{}, asksQuestion ? 'tool_calls' : 'stop'],
          ]) {
            response.write(
              `data: ${JSON.stringify({
                id: 'chatcmpl-question',
                object: 'chat.completion.chunk',
                created: 1,
                model: 'question',
                choices: [{ index: 0, delta, finish_reason: finishReason }],
              })}\n\n`,
            );
          }
          response.end('data: [DONE]\n\n');
        } catch (error) {
          errors.push(error);
          response.writeHead(500).end();
        }
      });

      try {
        await new Promise<void>((resolve, reject) => {
          provider.once('error', reject);
          provider.listen(0, '127.0.0.1', resolve);
        });
        const address = provider.address();
        if (!address || typeof address === 'string') {
          throw new Error('Local provider did not bind a TCP port');
        }
        const configuration = {
          model: MODEL,
          small_model: MODEL,
          enabled_providers: ['cligent-fixture'],
          provider: {
            'cligent-fixture': {
              npm: '@ai-sdk/openai-compatible',
              name: 'Cligent local question fixture',
              options: {
                apiKey: 'local-fixture-only',
                baseURL: `http://127.0.0.1:${address.port}/v1`,
              },
              models: {
                question: {
                  name: 'Question fixture',
                  tool_call: true,
                  limit: { context: 32_000, output: 2_000 },
                },
              },
            },
          },
        };
        const env: NodeJS.ProcessEnv = {
          ...Object.fromEntries(
            [
              'PATH',
              'SystemRoot',
              'WINDIR',
              'PATHEXT',
              'TMPDIR',
              'TEMP',
              'TMP',
            ].map((key) => [
              key,
              Object.entries(process.env).find(
                ([name]) => name.toLowerCase() === key.toLowerCase(),
              )?.[1],
            ]),
          ),
          HOME: home,
          USERPROFILE: home,
          XDG_CACHE_HOME: join(root, 'cache'),
          XDG_CONFIG_HOME: join(root, 'config'),
          XDG_DATA_HOME: join(root, 'data'),
          XDG_STATE_HOME: join(root, 'state'),
          OPENCODE_CONFIG_DIR: join(root, 'config'),
          OPENCODE_CONFIG_CONTENT: JSON.stringify(configuration),
          OPENCODE_DISABLE_MODELS_FETCH: 'true',
          OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
          OPENCODE_DISABLE_CLAUDE_CODE: 'true',
          NO_COLOR: '1',
        };
        child = spawn(
          command,
          ['serve', '--hostname', '127.0.0.1', '--port', '0'],
          {
            cwd,
            env,
            stdio: 'pipe',
          },
        ) as ChildProcessWithoutNullStreams;
        childClosed = new Promise((resolve) =>
          child!.once('close', () => resolve()),
        );
        child.stdout.on('data', (chunk) => {
          childLog += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
          childLog += String(chunk);
        });
        const baseUrl = await new Promise<string>((resolve, reject) => {
          const finish = (error?: Error, url?: string) => {
            clearTimeout(timer);
            child!.stdout.off('data', onData);
            child!.off('error', onError);
            child!.off('close', onClose);
            if (error) reject(error);
            else resolve(url!);
          };
          const onData = () => {
            const match = childLog.match(/http:\/\/127\.0\.0\.1:\d+/);
            if (match) finish(undefined, match[0]);
          };
          const onError = (error: Error) => finish(error);
          const onClose = () =>
            finish(new Error(`OpenCode exited during startup: ${childLog}`));
          const timer = setTimeout(
            () => finish(new Error(`OpenCode startup timed out: ${childLog}`)),
            10_000,
          );
          child!.stdout.on('data', onData);
          child!.once('error', onError);
          child!.once('close', onClose);
        });
        const adapter = new OpenCodeAdapter(
          { mode: 'external', serverUrl: baseUrl },
          {
            async loadSdk() {
              return {
                createClient({ baseUrl } = {}) {
                  const real = createOpencodeClient({ baseUrl });
                  lastClient = real;
                  const nativeGet = real.session.get.bind(real.session);
                  real.session.get = async (...args) => {
                    const result = await nativeGet(...args);
                    observe('session.get', {
                      parameters: args[0],
                      status: result.response.status,
                      data: result.data,
                      error: result.error,
                    });
                    return result;
                  };
                  const nativeChildren = real.session.children.bind(
                    real.session,
                  );
                  real.session.children = async (...args) => {
                    const result = await nativeChildren(...args);
                    observe('session.children', {
                      parameters: args[0],
                      status: result.response.status,
                      data: result.data,
                      error: result.error,
                    });
                    return result;
                  };
                  const nativeDispose = real.instance.dispose.bind(
                    real.instance,
                  );
                  real.instance.dispose = async (...args) => {
                    const result = await nativeDispose(...args);
                    observe('instance.dispose', {
                      parameters: args[0],
                      status: result.response.status,
                      data: result.data,
                      error: result.error,
                    });
                    return result;
                  };
                  const nativeCreate = real.session.create.bind(real.session);
                  real.session.create = async (...args) => {
                    const result = await nativeCreate(...args);
                    observe('session.create', {
                      parameters: args[0],
                      status: result.response.status,
                      data: result.data,
                      error: result.error,
                    });
                    if (result.data) {
                      sessionID = result.data.id;
                      permissionSnapshots.push(
                        structuredClone(result.data.permission),
                      );
                    }
                    return result;
                  };
                  const nativePrompt = real.session.promptAsync.bind(
                    real.session,
                  );
                  real.session.promptAsync = async (...args) => {
                    promptRequests.push(structuredClone(args[0]));
                    observe('session.prompt.start', args[0]);
                    const result = await nativePrompt(...args);
                    observe('session.prompt.finish', {
                      status: result.response.status,
                      data: result.data,
                      error: result.error,
                    });
                    return result;
                  };
                  const nativeReject = real.question.reject.bind(real.question);
                  real.question.reject = async (...args) => {
                    rejectedRequests.push(structuredClone(args[0]));
                    const result = await nativeReject(...args);
                    if (sessionID) {
                      const session = await real.session.get({
                        sessionID,
                        directory: cwd,
                      });
                      if (session.error)
                        throw new Error(JSON.stringify(session.error));
                      permissionSnapshots.push(
                        structuredClone(session.data.permission),
                      );
                    }
                    return result;
                  };
                  const nativeSubscribe = real.event.subscribe.bind(real.event);
                  real.event.subscribe = async (...args) => {
                    const subscription = await nativeSubscribe(...args);
                    return {
                      ...subscription,
                      stream: (async function* () {
                        for await (const event of subscription.stream) {
                          nativeEvents.push(event);
                          observe('native.event', event);
                          yield event;
                        }
                      })(),
                    };
                  };
                  return wrapOpencodeClient(real, { apiVersion: 'v2' });
                },
              };
            },
          },
        );
        const cligent = new Cligent(adapter, {
          cwd,
          model: MODEL,
        });
        const approvalHandler = async () => {
          approvalCalls++;
          return 'allow_once' as const;
        };
        const assertSettledTurn = (
          start: number,
          expectedModelCalls: number,
        ) => {
          const turnEvents = events.slice(start);
          const diagnostics = JSON.stringify(
            {
              turn: currentTurn,
              root,
              sessionID,
              modelCalls,
              promptRequests,
              turnEvents,
              recentObservations: observations.slice(-12),
              childLog: childLog.slice(-4000),
            },
            null,
            2,
          );
          expect(errors, diagnostics).toEqual([]);
          expect(
            turnEvents.filter((event) => event.type === 'error'),
            diagnostics,
          ).toEqual([]);
          expect(
            turnEvents.filter((event) => event.type === 'done'),
            diagnostics,
          ).toHaveLength(1);
          expect(turnEvents.at(-1), diagnostics).toMatchObject({
            type: 'done',
            payload: { status: 'success', resumeToken: sessionID },
          });
          expect(modelCalls, diagnostics).toBe(expectedModelCalls);
        };
        currentTurn = 1;
        for await (const event of cligent.run(
          'Ask the fixture question, then continue if the user declines it.',
          {
            permissions: {
              fileWrite: 'deny',
              shellExecute: 'deny',
              networkAccess: 'deny',
            },
            abortSignal: controller.signal,
            approvalHandler,
          },
        )) {
          events.push(event);
          observe('cligent.event', event);
        }

        // Native QuestionTool dismissal ends the current turn. Do not enable
        // continue-on-deny or invent a model retry; a later ordinary user turn
        // proves native history and continuation survive that settlement.
        assertSettledTurn(0, 1);
        expect(child.exitCode).toBeNull();
        currentTurn = 2;
        const secondTurnStart = events.length;
        for await (const event of cligent.run(
          'Ask the fixture question again in this resumed turn.',
          {
            resume: sessionID,
            abortSignal: controller.signal,
            approvalHandler,
          },
        )) {
          events.push(event);
          observe('cligent.event', event);
        }
        assertSettledTurn(secondTurnStart, 2);
        currentTurn = 3;
        const thirdTurnStart = events.length;
        for await (const event of cligent.run(
          'Continue without answering the dismissed question.',
          {
            resume: sessionID,
            abortSignal: controller.signal,
            approvalHandler,
          },
        )) {
          events.push(event);
          observe('cligent.event', event);
        }
        assertSettledTurn(thirdTurnStart, 3);

        expect(errors).toEqual([]);
        expect(
          events.filter((event) => event.type === 'error'),
          childLog,
        ).toEqual([]);
        expect(modelCalls).toBe(3);
        const continuation = requests.find((request) =>
          request.messages.some(
            (message) =>
              message.role === 'tool' &&
              message.tool_call_id === 'call_native_question_2',
          ),
        );
        expect(continuation).toBeDefined();
        for (const callId of [
          'call_native_question_1',
          'call_native_question_2',
        ]) {
          expect(
            continuation!.messages.find(
              (message) =>
                message.role === 'tool' && message.tool_call_id === callId,
            )?.content,
          ).toMatch(/dismissed|rejected|declined/i);
        }
        const questionEvents = nativeEvents.filter(
          (event) =>
            typeof event === 'object' &&
            event !== null &&
            'type' in event &&
            event.type === 'question.asked',
        ) as Array<{ properties: QuestionRequest }>;
        expect(questionEvents).toHaveLength(2);
        expect(rejectedRequests).toHaveLength(2);
        expect(promptRequests).toHaveLength(3);
        expect(
          new Set(promptRequests.map((prompt) => prompt.messageID)).size,
        ).toBe(3);
        for (const prompt of promptRequests) {
          expect(prompt).not.toHaveProperty('tools');
          expect(prompt.messageID).toEqual(expect.stringMatching(/^msg_/));
        }
        for (const [index, questionEvent] of questionEvents.entries()) {
          const nativeQuestion = questionEvent.properties;
          const toolUseId = `call_native_question_${index + 1}`;
          expect(nativeQuestion).toMatchObject({
            ...QUESTION,
            sessionID,
            tool: { callID: toolUseId },
          });
          expect(nativeEvents).toContainEqual(
            expect.objectContaining({
              type: 'question.rejected',
              properties: { sessionID, requestID: nativeQuestion.id },
            }),
          );
          expect(rejectedRequests[index]).toEqual({
            requestID: nativeQuestion.id,
            directory: cwd,
          });
          // The native assistant owning the question names the exact outgoing
          // prompt ID. Identical text in another client's turn is not authority.
          expect(nativeEvents).toContainEqual(
            expect.objectContaining({
              type: 'message.updated',
              properties: expect.objectContaining({
                info: expect.objectContaining({
                  id: nativeQuestion.tool!.messageID,
                  parentID: promptRequests[index]!.messageID,
                  role: 'assistant',
                  sessionID,
                }),
              }),
            }),
          );
          expect(
            events.filter((event) => event.type === 'tool_result'),
          ).toContainEqual(
            expect.objectContaining({
              payload: expect.objectContaining({ toolUseId, status: 'error' }),
            }),
          );
        }
        expect(permissionSnapshots).toHaveLength(3);
        expect(permissionSnapshots[0]).toEqual(
          expect.arrayContaining([
            { permission: 'edit', pattern: '*', action: 'deny' },
            { permission: 'bash', pattern: '*', action: 'deny' },
            { permission: 'webfetch', pattern: '*', action: 'deny' },
          ]),
        );
        for (const snapshot of permissionSnapshots.slice(1))
          expect(snapshot).toEqual(permissionSnapshots[0]);
        expect(approvalCalls).toBe(0);
        expect(
          events.filter(
            (event) =>
              event.type === 'approval_request' ||
              event.type === 'approval_response',
          ),
        ).toEqual([]);
        expect(
          events
            .flatMap((event) =>
              event.type === 'text'
                ? [event.payload.text]
                : event.type === 'text_delta'
                  ? [event.payload.delta]
                  : [],
            )
            .join(''),
        ).toContain(FINISHED);
        expect(events.filter((event) => event.type === 'done')).toHaveLength(3);
        expect(events.at(-1)).toMatchObject({
          type: 'done',
          payload: { status: 'success' },
        });
        expect(child.exitCode).toBeNull();
        passed = true;
      } finally {
        clearTimeout(timeout);
        const abortedBeforeCleanup = controller.signal.aborted;
        controller.abort();
        // Query only after the test body settles, so diagnostics cannot add a
        // delay between native turns or mask ordering/timing failures.
        if (!passed && lastClient && sessionID && child?.exitCode === null) {
          const diagnosticAbort = new AbortController();
          const diagnosticTimer = setTimeout(
            () => diagnosticAbort.abort(),
            2_000,
          );
          try {
            const options = { signal: diagnosticAbort.signal };
            finalNativeState = await Promise.allSettled([
              lastClient.session.get({ sessionID, directory: cwd }, options),
              lastClient.session.messages(
                { sessionID, directory: cwd },
                options,
              ),
              lastClient.session.children(
                { sessionID, directory: cwd },
                options,
              ),
              lastClient.session.status({ directory: cwd }, options),
            ]);
          } finally {
            clearTimeout(diagnosticTimer);
          }
        }
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill('SIGTERM');
          if (childClosed && !(await settles(childClosed, 2_000))) {
            child.kill('SIGKILL');
            await settles(childClosed, 1_000);
          }
        }
        const childStopped = childClosed
          ? await settles(childClosed, 1_000)
          : true;
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
        if (passed) {
          expect(childStopped).toBe(true);
          await rm(root, {
            recursive: true,
            force: true,
            maxRetries: 4,
            retryDelay: 100,
          });
        } else {
          await writeFile(
            join(root, 'failure.json'),
            JSON.stringify(
              {
                requests,
                errors: errors.map(String),
                nativeEvents,
                events,
                promptRequests,
                rejectedRequests,
                permissionSnapshots,
                observations,
                finalNativeState,
                fixture: {
                  command,
                  version: version.stdout.trim(),
                  platform: process.platform,
                  root,
                  cwd,
                  home,
                  sessionID,
                  currentTurn,
                  modelCalls,
                  abortedBeforeCleanup,
                },
                childLog,
              },
              null,
              2,
            ),
          );
          process.stderr.write(
            `OpenCode question acceptance evidence: ${root}\n`,
          );
          // Keep the original native workspace/home path, including Windows
          // temp aliases. Only the evidence copy belongs in the CI artifact
          // directory; changing cwd would mask the path-sensitive failure.
          if (process.env.RUNNER_TEMP) {
            const artifactRoot = await mkdtemp(
              join(process.env.RUNNER_TEMP, 'cligent-opencode-question-'),
            );
            await copyFile(
              join(root, 'failure.json'),
              join(artifactRoot, 'failure.json'),
            );
            process.stderr.write(
              `OpenCode question CI artifact: ${artifactRoot}\n`,
            );
          }
        }
      }
    },
    40_000,
  );
});
