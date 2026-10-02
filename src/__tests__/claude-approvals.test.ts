// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { Cligent } from '../cligent.js';
import { runParallel } from '../engine.js';
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
} from '../types.js';

const roots: string[] = [];
const sessionId = '1b65d7e3-aa5f-4c32-b291-45df6b366123';
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      }),
    ),
  );
});
async function collect(source: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}
async function fixture(toolName = 'Bash', cancel = false) {
  const root = await mkdtemp(join(tmpdir(), 'cligent-approval-'));
  roots.push(root);
  const script = join(root, 'peer.mjs');
  const effect = join(root, 'effect');
  const reply = join(root, 'reply.json');
  await writeFile(
    script,
    `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const done = () => send({type:'result',subtype:'success',result:'fixture complete',session_id:${JSON.stringify(sessionId)},is_error:false,duration_ms:1,duration_api_ms:1,num_turns:1,usage:{input_tokens:1,output_tokens:1},modelUsage:{},total_cost_usd:0});
const lines = createInterface({input:process.stdin});
lines.on('line', line => {
 const value = JSON.parse(line);
 if(value.type==='control_request') send({type:'control_response',response:{subtype:'success',request_id:value.request_id,response:{}}});
 if(value.type==='user') {
  send({type:'system',subtype:'init',session_id:${JSON.stringify(sessionId)},model:'fixture',tools:[${JSON.stringify(toolName)}]});
  send({type:'control_request',request_id:'native-ask',request:{subtype:'can_use_tool',tool_name:${JSON.stringify(toolName)},tool_use_id:'tool-native-1',input:{command:'write fixture effect',nested:{original:true}},decision_reason:'Native policy requires a decision'}});
  ${cancel ? "setTimeout(() => {send({type:'control_cancel_request',request_id:'native-ask'});done();},100);" : ''}
 }
 if(value.type==='control_response' && value.response.request_id==='native-ask') {
  writeFileSync(${JSON.stringify(reply)},JSON.stringify(value.response));
  if(value.response.response?.behavior==='allow') writeFileSync(${JSON.stringify(effect)},'approved native effect');
  ${cancel ? '' : 'done();'}
 }
});
lines.on('close',()=>process.exit(0));
`,
  );
  const adapter = new ClaudeCodeAdapter({
    probeExecutable: () => ({ state: 'present', path: script }),
    loadSdk: async () => ({
      query(parameters) {
        return query({
          ...parameters,
          options: {
            ...parameters.options,
            spawnClaudeCodeProcess: (options) =>
              spawn(process.execPath, [script, ...options.args], {
                cwd: root,
                env: options.env,
                signal: options.signal,
                stdio: ['pipe', 'pipe', 'pipe'],
              }),
          },
        });
      },
    }),
  });
  return { adapter, effect, reply };
}

describe('live Claude approval through installed SDK control protocol', () => {
  it('streams an authentic immutable ask before a native effect, then records one host allowance', async () => {
    const { adapter, effect, reply } = await fixture();
    let resolve!: (decision: ApprovalDecision) => void;
    let request: ApprovalRequest | undefined;
    const stream = new Cligent(adapter).run('perform fixture operation', {
      approvalHandler: async (value) => {
        request = value;
        return new Promise((answer) => {
          resolve = answer;
        });
      },
    });
    expect((await stream.next()).value?.type).toBe('init');
    const ask = await stream.next();
    expect(ask.value?.type).toBe('approval_request');
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    expect(request).toMatchObject({
      kind: 'tool',
      agent: 'claude-code',
      sessionId,
      toolUseId: 'tool-native-1',
      toolName: 'Bash',
      choices: ['allow_once', 'deny'],
      reason: 'Native policy requires a decision',
    });
    expect(request!.expiresAt - request!.createdAt).toBe(600_000);
    expect(Object.isFrozen(request!.input.nested)).toBe(true);
    await expect(readFile(effect)).rejects.toMatchObject({ code: 'ENOENT' });
    resolve('allow_once');
    const events = await collect(stream);
    expect(
      events.filter((event) => event.type === 'approval_response'),
    ).toMatchObject([
      {
        payload: {
          requestId: request!.id,
          decision: 'allow_once',
          source: 'host',
        },
      },
    ]);
    expect(events.at(-1)?.type).toBe('done');
    expect(await readFile(effect, 'utf8')).toBe('approved native effect');
    const native = JSON.parse(await readFile(reply, 'utf8'));
    expect(native.response).toEqual({
      behavior: 'allow',
      toolUseID: 'tool-native-1',
      updatedInput: {
        command: 'write fixture effect',
        nested: { original: true },
      },
    });
  });

  it('retains SDK fail-closed behavior without a host handler', async () => {
    const { adapter, effect } = await fixture();
    const events = await collect(adapter.run('operate'));
    expect(
      events.some(
        (event) =>
          event.type === 'approval_request' ||
          event.type === 'approval_response',
      ),
    ).toBe(false);
    expect(events.at(-1)?.type).toBe('done');
    await expect(readFile(effect)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['deny', 'error', 'invalid'] as const)(
    'fails closed for a %s host outcome',
    async (outcome) => {
      const { adapter, effect, reply } = await fixture();
      const events = await collect(
        adapter.run('operate', {
          approvalHandler: async () => {
            if (outcome === 'error') throw new Error('host disconnected');
            return outcome === 'invalid'
              ? ('always' as ApprovalDecision)
              : 'deny';
          },
        }),
      );
      expect(
        events.filter((event) => event.type === 'approval_response'),
      ).toMatchObject([
        {
          payload: {
            decision: 'deny',
            source: outcome === 'deny' ? 'host' : 'error',
          },
        },
      ]);
      expect(JSON.parse(await readFile(reply, 'utf8')).response.behavior).toBe(
        'deny',
      );
      await expect(readFile(effect)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('closes the host request when the real SDK receives native cancellation', async () => {
    const { adapter, effect } = await fixture('Bash', true);
    let contextSignal: AbortSignal | undefined;
    const events = await collect(
      adapter.run('operate', {
        approvalHandler: async (_request, { signal }) => {
          contextSignal = signal;
          return new Promise(() => {});
        },
      }),
    );
    expect(contextSignal?.aborted).toBe(true);
    expect(
      events.filter((event) => event.type === 'approval_response'),
    ).toMatchObject([{ payload: { decision: 'deny', source: 'cancelled' } }]);
    await expect(readFile(effect)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['Bash', 'AskUserQuestion'])(
    'retains hard denial or structured-question refusal for %s',
    async (tool) => {
      const { adapter, effect, reply } = await fixture(tool);
      const handler = vi.fn(async () => 'allow_once' as const);
      const events = await collect(
        adapter.run('operate', {
          approvalHandler: handler,
          permissions: { shellExecute: 'deny' },
        }),
      );
      expect(handler).not.toHaveBeenCalled();
      expect(events.some((event) => event.type === 'approval_request')).toBe(
        false,
      );
      expect(JSON.parse(await readFile(reply, 'utf8')).response.behavior).toBe(
        'deny',
      );
      await expect(readFile(effect)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );
});

describe('bounded Claude approval lifecycle', () => {
  function waitingAdapter(stallAfterDecision = false) {
    let nativeDecision: unknown;
    const adapter = new ClaudeCodeAdapter({
      loadSdk: async () => ({
        async *query({ options }) {
          yield {
            type: 'system',
            subtype: 'init',
            session_id: sessionId,
            tools: ['Bash'],
          };
          nativeDecision = await options?.canUseTool?.(
            'Bash',
            { command: 'fixture' },
            {
              signal: options.abortController!.signal,
              toolUseID: 'bounded-tool',
              blockedPath: '/review/scope',
              title: 'Write files in /review/scope',
            },
          );
          if (stallAfterDecision) await new Promise(() => {});
          options?.abortController?.signal.throwIfAborted();
          yield {
            type: 'result',
            subtype: 'success',
            session_id: sessionId,
            result: 'complete',
          };
        },
      }),
    });
    return { adapter, decision: () => nativeDecision };
  }

  it('denies a ten-minute unanswered native ask and ignores its late answer', async () => {
    vi.useFakeTimers();
    const { adapter, decision } = waitingAdapter();
    let answer!: (value: ApprovalDecision) => void;
    let signal!: AbortSignal;
    const stream = adapter.run('operate', {
      approvalHandler: async (request, context) => {
        signal = context.signal;
        expect(request.details).toMatchObject({
          blockedPath: '/review/scope',
          title: 'Write files in /review/scope',
        });
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    });
    expect((await stream.next()).value?.type).toBe('init');
    expect((await stream.next()).value?.type).toBe('approval_request');
    const rest = collect(stream);
    await vi.advanceTimersByTimeAsync(600_000);
    const events = await rest;
    expect(signal.aborted).toBe(true);
    expect(decision()).toMatchObject({ behavior: 'deny' });
    expect(
      events.filter((event) => event.type === 'approval_response'),
    ).toMatchObject([{ payload: { decision: 'deny', source: 'timeout' } }]);
    answer('allow_once');
    await Promise.resolve();
    expect(
      events.filter((event) => event.type === 'approval_response'),
    ).toHaveLength(1);
  });

  it('returns within bounded cleanup even when a native iterator ignores the denied ask', async () => {
    vi.useFakeTimers();
    const { adapter, decision } = waitingAdapter(true);
    let signal!: AbortSignal;
    const stream = adapter.run('operate', {
      approvalHandler: async (_request, context) => {
        signal = context.signal;
        return new Promise(() => {});
      },
    });
    await stream.next();
    expect((await stream.next()).value?.type).toBe('approval_request');
    await Promise.resolve();
    const closing = stream.return();
    await vi.advanceTimersByTimeAsync(500);
    await expect(closing).resolves.toMatchObject({ done: true });
    expect(signal.aborted).toBe(true);
    expect(decision()).toMatchObject({ behavior: 'deny' });
  });

  it('preserves a cancelled approval response through the real Cligent abort drain', async () => {
    const { adapter, decision } = waitingAdapter();
    const abort = new AbortController();
    const stream = new Cligent(adapter).run('operate', {
      abortSignal: abort.signal,
      approvalHandler: async () => new Promise(() => {}),
    });
    await stream.next();
    expect((await stream.next()).value?.type).toBe('approval_request');
    abort.abort();
    const events = await collect(stream);
    expect(
      events.filter((event) => event.type === 'approval_response'),
    ).toMatchObject([{ payload: { decision: 'deny', source: 'cancelled' } }]);
    expect(decision()).toMatchObject({ behavior: 'deny' });
    expect(events.at(-1)?.payload).toMatchObject({ status: 'interrupted' });
  });

  it('cancels all pending raw parallel native asks without leaving host callbacks alive', async () => {
    const first = waitingAdapter();
    const second = waitingAdapter();
    const abort = new AbortController();
    const signals: AbortSignal[] = [];
    const approvalHandler = async (
      _request: ApprovalRequest,
      context: { signal: AbortSignal },
    ): Promise<ApprovalDecision> => {
      signals.push(context.signal);
      return new Promise(() => {});
    };
    const events: AgentEvent[] = [];
    let asks = 0;
    for await (const event of runParallel([
      {
        adapter: first.adapter,
        prompt: 'first',
        options: { approvalHandler, abortSignal: abort.signal },
      },
      {
        adapter: second.adapter,
        prompt: 'second',
        options: { approvalHandler },
      },
    ])) {
      events.push(event);
      if (event.type === 'approval_request' && ++asks === 2) abort.abort();
    }
    expect(asks).toBe(2);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(first.decision()).toMatchObject({ behavior: 'deny' });
    expect(second.decision()).toMatchObject({ behavior: 'deny' });
    expect(
      events.filter((event) => event.type === 'approval_response'),
    ).toHaveLength(2);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(2);
  });

  it('continues approval handling after a resumed native no-op repair result', async () => {
    let nativeDecision: unknown;
    const adapter = new ClaudeCodeAdapter({
      loadSdk: async () => ({
        async *query({ options }) {
          yield { type: 'system', subtype: 'init', session_id: sessionId };
          yield {
            type: 'result',
            subtype: 'success',
            session_id: sessionId,
            usage: { input_tokens: 0, output_tokens: 0 },
          };
          nativeDecision = await options!.canUseTool!(
            'Bash',
            { command: 'fixture' },
            {
              signal: options!.abortController!.signal,
              toolUseID: 'after-repair',
            },
          );
          yield {
            type: 'result',
            subtype: 'success',
            session_id: sessionId,
            result: 'real turn',
          };
        },
      }),
    });
    const events = await collect(
      adapter.run('continue', {
        resume: sessionId,
        approvalHandler: async () => 'allow_once',
      }),
    );
    expect(nativeDecision).toMatchObject({ behavior: 'allow' });
    expect(
      events.filter((event) => event.type === 'approval_request'),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(events.at(-1)?.payload).toMatchObject({ result: 'real turn' });
  });

  it('retains a real SDK failure as error when the host approval route is installed', async () => {
    const adapter = new ClaudeCodeAdapter({
      loadSdk: async () => ({
        async *query() {
          yield { type: 'system', subtype: 'init', session_id: sessionId };
          throw new Error('native SDK failed');
        },
      }),
    });
    const events = await collect(
      adapter.run('operate', { approvalHandler: async () => 'deny' }),
    );
    expect(events.at(-2)?.payload).toMatchObject({
      code: 'SDK_STREAM_ERROR',
      message: 'native SDK failed',
    });
    expect(events.at(-1)?.payload).toMatchObject({ status: 'error' });
  });

  it('does not reuse the handler on the next automatically resumed call', async () => {
    const seen: unknown[] = [];
    const adapter = new ClaudeCodeAdapter({
      loadSdk: async () => ({
        async *query({ options }) {
          seen.push(options?.canUseTool);
          yield { type: 'system', subtype: 'init', session_id: sessionId };
          yield {
            type: 'result',
            subtype: 'success',
            session_id: sessionId,
            result: 'complete',
          };
        },
      }),
    });
    const client = new Cligent(adapter);
    await collect(client.run('first', { approvalHandler: async () => 'deny' }));
    await collect(client.run('second'));
    expect(seen[0]).toBeTypeOf('function');
    expect(seen[1]).toBeUndefined();
  });
});
