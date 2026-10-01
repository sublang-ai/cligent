// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOpencodeClient as createV1Client } from '@opencode-ai/sdk';
import { createOpencodeClient as createV2Client } from '@opencode-ai/sdk/v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Codex } from '@openai/codex-sdk';

import { CodexAdapter } from '../adapters/codex.js';
import { GeminiAdapter } from '../adapters/gemini.js';
import { KimiAdapter } from '../adapters/kimi.js';
import { OpenCodeAdapter, wrapOpencodeClient } from '../adapters/opencode.js';
import type { AgentEvent } from '../types.js';
import type { McpServers } from '../mcp.js';

const fixturePaths = vi.hoisted(() => ({ codex: '' }));
const browserPreparation = vi.hoisted(() => vi.fn());
vi.mock('../browser.js', () => ({ prepareBrowserServer: browserPreparation }));
vi.mock('../adapters/codex-executable.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../adapters/codex-executable.js')>();
  return {
    ...actual,
    resolveCodexBinPath: () =>
      fixturePaths.codex || actual.resolveCodexBinPath(),
  };
});
beforeEach(() => {
  vi.stubEnv('CLIGENT_RUNTIME_GATE', 'off');
  browserPreparation.mockReset();
});
const dirs: string[] = [];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'cligent-mcp-adapters-'));
  dirs.push(dir);
  return dir;
}
async function collect(stream: AsyncIterable<AgentEvent>) {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const servers: McpServers = {
  browser: {
    type: 'stdio',
    command: process.execPath,
    args: ['a space', 'a"quote', 'a\nline'],
    env: { MCP_FIXTURE: 'value"\n' },
  },
  remote: {
    type: 'http',
    url: 'https://example.test/mcp?test=1',
    headers: { Authorization: 'Bearer fixture' },
  },
};

describe('per-run MCP native boundaries', () => {
  it('Codex delivers whole-entry MCP overrides through the installed SDK and executable wrapper (codex-71)', async () => {
    const cwd = await temp();
    const capture = join(cwd, 'codex-args.json');
    fixturePaths.codex = join(cwd, 'codex-fixture.mjs');
    await writeFile(
      fixturePaths.codex,
      `import { writeFileSync } from 'node:fs';
      let prompt = ''; process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { prompt += chunk; });
      process.stdin.on('end', () => {
        writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), prompt }));
        console.log(JSON.stringify({type:'thread.started',thread_id:'mcp-codex'}));
        console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,cached_input_tokens:0,output_tokens:0}}));
      });`,
    );
    let wrapper: string | undefined;
    const adapter = new CodexAdapter({
      loadSdk: async () => ({
        Codex: class extends Codex {
          constructor(options?: ConstructorParameters<typeof Codex>[0]) {
            super(options);
            wrapper = options?.codexPathOverride;
          }
        },
      }),
    });
    const events = await collect(
      adapter.run('Use the supplied tools', { cwd, mcpServers: servers }),
    );
    expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
    const captured = JSON.parse(await readFile(capture, 'utf8')) as {
      args: string[];
      prompt: string;
    };
    expect(captured.prompt).toBe('Use the supplied tools');
    const overrides = captured.args.filter((arg) =>
      arg.startsWith('mcp_servers.'),
    );
    expect(overrides).toHaveLength(2);
    expect(overrides[0]).toBe(
      'mcp_servers.browser={"command" = ' +
        JSON.stringify(process.execPath) +
        ', "args" = ["a space", "a\\"quote", "a\\nline"], "env" = {"MCP_FIXTURE" = "value\\"\\n"}, "required" = true, "default_tools_approval_mode" = "approve"}',
    );
    expect(overrides[1]).toBe(
      'mcp_servers.remote={"url" = "https://example.test/mcp?test=1", "http_headers" = {"Authorization" = "Bearer fixture"}, "required" = true, "default_tools_approval_mode" = "approve"}',
    );
    expect(existsSync(wrapper!)).toBe(false);
  });

  it('Gemini child receives a temporary merged settings file and keeps tool policy restrictions (gemini-49)', async () => {
    const cwd = await temp();
    const home = join(cwd, 'home');
    await mkdir(join(home, '.gemini'), { recursive: true });
    const original = JSON.stringify({
      custom: 'keep',
      mcpServers: {
        ambient: { command: 'ambient' },
        browser: { httpUrl: 'https://old.test' },
      },
    });
    await writeFile(join(home, '.gemini', 'settings.json'), original);
    vi.stubEnv('GEMINI_CLI_HOME', home);
    vi.stubEnv('SANDBOX', 'fixture-outside-sandbox');
    const capture = join(cwd, 'captured.json');
    const script = join(cwd, 'gemini-fixture.mjs');
    await writeFile(
      script,
      `import { readFileSync, writeFileSync } from 'node:fs';
      const settings = JSON.parse(readFileSync(process.env.GEMINI_CLI_HOME + '/.gemini/settings.json', 'utf8'));
      const args = process.argv.slice(2); const policyArg = args.find((arg) => arg.startsWith('--policy='));
      writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ settings, home: process.env.GEMINI_CLI_HOME, args, policy: !policyArg ? '' : readFileSync(policyArg.slice('--policy='.length), 'utf8') }));
      console.log(JSON.stringify({type:'init',session_id:'gemini-mcp'}));
      console.log(JSON.stringify({type:'result',status:'success',result:'done'}));`,
    );
    const adapter = new GeminiAdapter({
      spawnProcess: (_cmd, args, options) =>
        spawn(process.execPath, [script, ...args], {
          ...options,
          stdio: 'pipe',
        }),
    });
    const events = await collect(
      adapter.run('Use the browser', {
        cwd,
        mcpServers: servers,
        disallowedTools: ['write_file'],
      }),
    );
    expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
    const captured = JSON.parse(await readFile(capture, 'utf8')) as {
      settings: Record<string, unknown>;
      home: string;
      policy: string;
    };
    expect(captured.settings).toMatchObject({
      custom: 'keep',
      mcpServers: {
        ambient: { command: 'ambient' },
        browser: {
          command: process.execPath,
          args: ['a space', 'a"quote', 'a\nline'],
          env: { MCP_FIXTURE: 'value"\n' },
          trust: true,
        },
        remote: {
          httpUrl: 'https://example.test/mcp?test=1',
          headers: { Authorization: 'Bearer fixture' },
          trust: true,
        },
      },
    });
    expect(
      (captured.settings.mcpServers as Record<string, unknown>).browser,
    ).not.toHaveProperty('httpUrl');
    expect(captured.policy).toContain('write_file');
    expect(captured.policy).toContain('deny');
    expect(await readFile(join(home, '.gemini', 'settings.json'), 'utf8')).toBe(
      original,
    );
    expect(existsSync(captured.home)).toBe(false);
  });

  it.each(['new', 'resume'] as const)(
    'Kimi sends ACP MCP transports on %s and approves only unique admitted tool requests (kimi-44)',
    async (mode) => {
      const cwd = await temp();
      const capture = join(cwd, 'kimi-requests.jsonl');
      const script = join(cwd, 'kimi-fixture.mjs');
      await writeFile(
        script,
        `import { createInterface } from 'node:readline';
      import { appendFileSync } from 'node:fs';
      let selected = []; let promptId; let requestIndex = 0;
      const send = (value) => console.log(JSON.stringify({ jsonrpc: '2.0', ...value }));
      const ask = () => { const alias = selected[0].name;
        const titles = ['mcp__' + alias + '__navigate', 'mcp__browser__navigate', 'Shell', 'mcp__' + alias + '__close'];
        send({id: 1000 + requestIndex, method:'session/request_permission', params:{sessionId:'kimi-mcp',toolCall:{toolCallId:'tool-' + requestIndex,title:titles[requestIndex],status:'pending'},options:[...(requestIndex === 3 ? [] : [{optionId:'yes-once',name:'Yes',kind:'allow_once'}]),{optionId:'no',name:'No',kind:'reject_once'}]}});
      };
      for await (const line of createInterface({input:process.stdin})) {
        const req = JSON.parse(line); appendFileSync(${JSON.stringify(capture)}, JSON.stringify(req) + '\\n');
        if (!req.method) { if (++requestIndex < 4) ask(); else send({id:promptId,result:{stopReason:'end_turn'}}); continue; }
        if (req.method === 'initialize') send({id:req.id,result:{protocolVersion:1,agentCapabilities:{mcpCapabilities:{http:true}}}});
        else if (req.method === 'session/new' || req.method === 'session/resume') {selected=req.params.mcpServers;send({id:req.id,result:req.method === 'session/new' ? {sessionId:'kimi-mcp'} : {}});}
        else if (req.method === 'session/prompt') {promptId=req.id;ask();}
      }`,
      );
      const adapter = new KimiAdapter({
        spawnProcess: (_cmd, _args, options) =>
          spawn(process.execPath, [script], { ...options, stdio: 'pipe' }),
      });
      const events = await collect(
        adapter.run('Use the tools', {
          cwd,
          mcpServers: servers,
          ...(mode === 'resume' ? { resume: 'kimi-mcp' } : {}),
        }),
      );
      expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
      expect(
        events.filter((event) => event.type === 'permission_request'),
      ).toHaveLength(3);
      const requests = (await readFile(capture, 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              method?: string;
              id: number;
              params: { mcpServers: unknown };
              result: { outcome: { optionId: string } };
            },
        );
      const setup = requests.find(
        (request) => request.method === `session/${mode}`,
      )!;
      expect(setup.params.mcpServers).toEqual([
        {
          name: expect.stringMatching(/^browser-[a-f0-9]{20}$/),
          command: process.execPath,
          args: ['a space', 'a"quote', 'a\nline'],
          env: [{ name: 'MCP_FIXTURE', value: 'value"\n' }],
        },
        {
          name: expect.stringMatching(/^remote-[a-f0-9]{20}$/),
          type: 'http',
          url: 'https://example.test/mcp?test=1',
          headers: [{ name: 'Authorization', value: 'Bearer fixture' }],
        },
      ]);
      expect(
        requests
          .filter((request) => request.id >= 1000)
          .map((request) => request.result.outcome.optionId),
      ).toEqual(['yes-once', 'no', 'no', 'no']);
    },
  );

  it.each(['v1', 'v2'] as const)(
    'OpenCode %s SDK registers exact native transports and classifies only unambiguous admitted tool names (opencode-62)',
    async (apiVersion) => {
      const received: Record<string, unknown>[] = [];
      const directories: Array<string | null> = [];
      let failedStatus = false;
      const registry: Record<string, unknown> = {
        browser_extra: { status: 'connected' },
      };
      const server = createServer((request, response) => {
        void (async () => {
          let text = '';
          for await (const chunk of request) text += String(chunk);
          directories.push(
            new URL(request.url!, 'http://localhost').searchParams.get(
              'directory',
            ),
          );
          const body = JSON.parse(text) as Record<string, unknown>;
          received.push(body);
          registry[String(body.name)] = failedStatus
            ? { status: 'failed', error: 'fixture failed' }
            : { status: 'connected' };
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(registry));
        })().catch((error: unknown) =>
          response.writeHead(500).end(String(error)),
        );
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No port');
      const real =
        apiVersion === 'v1'
          ? createV1Client({ baseUrl: `http://127.0.0.1:${address.port}` })
          : createV2Client({ baseUrl: `http://127.0.0.1:${address.port}` });
      const wrapped = wrapOpencodeClient(
        real as unknown as Record<string, unknown>,
        { apiVersion },
      );
      try {
        await wrapped.addMcpServers!({
          servers,
          cwd: '/test/working directory',
        });
        expect(received).toEqual([
          {
            name: 'browser',
            config: {
              type: 'local',
              command: [process.execPath, 'a space', 'a"quote', 'a\nline'],
              environment: { MCP_FIXTURE: 'value"\n' },
              enabled: true,
            },
          },
          {
            name: 'remote',
            config: {
              type: 'remote',
              url: 'https://example.test/mcp?test=1',
              headers: { Authorization: 'Bearer fixture' },
              oauth: false,
              enabled: true,
            },
          },
        ]);
        expect(wrapped.isAdmittedMcpTool!('browser_navigate')).toBe(true);
        expect(wrapped.isAdmittedMcpTool!('remote_search')).toBe(true);
        expect(wrapped.isAdmittedMcpTool!('browser_extra_tool')).toBe(false);
        expect(wrapped.isAdmittedMcpTool!('bash')).toBe(false);
        expect(directories).toEqual([
          '/test/working directory',
          '/test/working directory',
        ]);
        failedStatus = true;
        await expect(
          wrapped.addMcpServers!({ servers: { failed: servers.browser! } }),
        ).rejects.toThrow('did not connect (failed)');
        expect(wrapped.isAdmittedMcpTool!('browser_navigate')).toBe(false);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it('rejects OpenCode external browser use before SDK loading or bootstrap (opencode-62)', async () => {
    const loadSdk = vi.fn();
    const adapter = new OpenCodeAdapter({ mode: 'external' }, { loadSdk });
    await expect(
      collect(adapter.run('browser', { browser: true })),
    ).rejects.toThrow('require managed mode');
    expect(loadSdk).not.toHaveBeenCalled();
    expect(browserPreparation).not.toHaveBeenCalled();
  });

  it('rejects Gemini browser when native sandbox or the home workspace prevents delivery (gemini-49)', async () => {
    const cwd = await temp();
    const home = join(cwd, 'home');
    await mkdir(home);
    vi.stubEnv('GEMINI_CLI_HOME', home);
    const spawnProcess = vi.fn();
    const adapter = new GeminiAdapter({ spawnProcess });
    const homeEvents = await collect(
      adapter.run('browser', { browser: true, cwd: home }),
    );
    expect(
      homeEvents.find((event) => event.type === 'error')?.payload,
    ).toMatchObject({
      message: expect.stringContaining('different from its user home'),
    });
    vi.stubEnv('SANDBOX', '');
    vi.stubEnv('GEMINI_SANDBOX', 'true');
    const sandboxEvents = await collect(
      adapter.run('browser', { browser: true, cwd }),
    );
    expect(
      sandboxEvents.find((event) => event.type === 'error')?.payload,
    ).toMatchObject({ message: expect.stringContaining('native sandbox') });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(browserPreparation).not.toHaveBeenCalled();
  });

  it('Kimi rejects unadvertised HTTP MCP before session setup (kimi-44)', async () => {
    const cwd = await temp();
    const capture = join(cwd, 'requests.jsonl');
    const script = join(cwd, 'kimi-no-http.mjs');
    await writeFile(
      script,
      `import { createInterface } from 'node:readline';
      import { appendFileSync } from 'node:fs';
      for await (const line of createInterface({input:process.stdin})) {
        const req = JSON.parse(line); appendFileSync(${JSON.stringify(capture)}, line + '\\n');
        console.log(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{protocolVersion:1,agentCapabilities:{}}}));
      }`,
    );
    const adapter = new KimiAdapter({
      spawnProcess: (_cmd, _args, options) =>
        spawn(process.execPath, [script], { ...options, stdio: 'pipe' }),
    });
    const events = await collect(
      adapter.run('tools', { cwd, mcpServers: { remote: servers.remote! } }),
    );
    expect(events.at(-1)?.payload).toMatchObject({ status: 'error' });
    expect(
      events.find((event) => event.type === 'error')?.payload,
    ).toMatchObject({
      message: expect.stringContaining('did not advertise HTTP MCP'),
    });
    expect((await readFile(capture, 'utf8')).trim().split('\n')).toHaveLength(
      1,
    );
  });

  it('Gemini refuses an injected settings writer that cannot deliver admitted servers (gemini-49)', async () => {
    const cwd = await temp();
    const home = join(cwd, 'home');
    await mkdir(home);
    vi.stubEnv('GEMINI_CLI_HOME', home);
    vi.stubEnv('SANDBOX', 'fixture-outside-sandbox');
    const spawnProcess = vi.fn();
    const cleanup = vi.fn(async () => {});
    const adapter = new GeminiAdapter({
      spawnProcess,
      createSettingsOverride: async () => ({ env: {}, cleanup }),
    });
    const events = await collect(
      adapter.run('tools', { cwd, mcpServers: servers }),
    );
    expect(events.at(-1)?.payload).toMatchObject({ status: 'error' });
    expect(
      events.find((event) => event.type === 'error')?.payload,
    ).toMatchObject({ message: expect.stringContaining('cannot deliver') });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each(['codex', 'gemini', 'kimi', 'opencode'] as const)(
    '%s interrupts browser preparation without starting an agent',
    async (agent) => {
      const cwd = await temp();
      const home = join(cwd, 'home');
      await mkdir(home);
      vi.stubEnv('GEMINI_CLI_HOME', home);
      vi.stubEnv('SANDBOX', 'fixture-outside-sandbox');
      const loadSdk = vi.fn();
      const spawnProcess = vi.fn();
      const adapter =
        agent === 'codex'
          ? new CodexAdapter({ loadSdk })
          : agent === 'gemini'
            ? new GeminiAdapter({ spawnProcess })
            : agent === 'kimi'
              ? new KimiAdapter({ spawnProcess })
              : new OpenCodeAdapter({}, { loadSdk, spawnProcess });
      const abort = new AbortController();
      let notifyStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        notifyStarted = resolve;
      });
      browserPreparation.mockImplementation(
        (signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new Error('fixture browser preparation aborted')),
              { once: true },
            );
            notifyStarted();
          }),
      );
      const result = collect(
        adapter.run('browser', {
          cwd,
          browser: true,
          abortSignal: abort.signal,
        }),
      );
      await started;
      abort.abort();
      const events = await result;
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
      expect(events.at(-1)?.payload).toMatchObject({ status: 'interrupted' });
      expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
      expect(loadSdk).not.toHaveBeenCalled();
      expect(spawnProcess).not.toHaveBeenCalled();
    },
  );
});
