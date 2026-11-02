// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
// Real SDK/native Codex with a scripted local provider, not a live-model test.
// The local reviewer approves only this fixture's disposable non-destructive writes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const { CodexAdapter } = await import(
  process.env.CLIGENT_TEST_ADAPTER
    ? pathToFileURL(process.env.CLIGENT_TEST_ADAPTER).href
    : new URL('../dist/adapters/codex.js', import.meta.url).href
);
const { Codex } = await import(
  process.env.CLIGENT_TEST_SDK
    ? pathToFileURL(process.env.CLIGENT_TEST_SDK).href
    : '@openai/codex-sdk'
);
const root = await fs.mkdtemp(join(tmpdir(), 'cligent 原生 权限 '));
const mcp = join(root, 'MCP fixture.mjs');
await fs.writeFile(
  mcp,
  `import {createInterface} from 'node:readline';for await(const line of createInterface({input:process.stdin})){const q=JSON.parse(line);if(q.id===undefined)continue;let result={};if(q.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};if(q.method==='tools/list')result={tools:[{name:'ping',description:'Fixture ping',inputSchema:{type:'object',properties:{}}}]};if(q.method==='tools/call')result={content:[{type:'text',text:'MCP_OK'}]};console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));}`,
);
let active;
const results = [];
function send(res, items) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let n = 0;
  const emit = (type, data) =>
    res.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: n++, ...data })}\n\n`,
    );
  emit('response.created', {
    response: {
      id: 'resp_fixture',
      object: 'response',
      status: 'in_progress',
      output: [],
    },
  });
  for (const [output_index, item] of items.entries()) {
    emit('response.output_item.added', { output_index, item });
    if (item.type === 'message')
      emit('response.output_text.delta', {
        item_id: item.id,
        output_index,
        content_index: 0,
        delta: item.content[0].text,
      });
    emit('response.output_item.done', { output_index, item });
  }
  emit('response.completed', {
    response: {
      id: 'resp_fixture',
      object: 'response',
      status: 'completed',
      output: items,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  });
  res.end();
}
const message = (id, text, channel = 'final') => ({
  id,
  type: 'message',
  role: 'assistant',
  status: 'completed',
  channel,
  content: [{ type: 'output_text', text, annotations: [] }],
});
const server = createServer(async (req, res) => {
  if (req.method === 'GET') {
    active.networkRequests = (active.networkRequests ?? 0) + 1;
    res.writeHead(200);
    res.end('NETWORK_PROOF_OK');
    return;
  }
  try {
    let raw = '';
    for await (const b of req) raw += b;
    const body = JSON.parse(raw);
    active.requests.push(body);
    if (body.model === 'codex-auto-review') {
      send(res, [
        message(
          'review',
          JSON.stringify({
            outcome: 'allow',
            risk_level: 'low',
            user_authorization: 'high',
            rationale: 'Only fixture-owned non-destructive files are used.',
          }),
        ),
      ]);
    } else if (active.requests.length === 1) {
      const tools = body.tools.flatMap((t) =>
        t.type === 'namespace'
          ? t.tools.map((x) => t.name + '__' + x.name)
          : t.name
            ? [t.name]
            : [],
      );
      active.tools = tools;
      const tool = active.mcp
        ? tools.find((t) => t.endsWith('__ping'))
        : 'exec_command';
      assert(tool, JSON.stringify(tools));
      const arguments_ = active.mcp
        ? '{}'
        : JSON.stringify({
            cmd: active.cmd,
            ...(process.platform === 'win32' ? {} : { shell: '/bin/sh' }),
            login: false,
            yield_time_ms: 1000,
            max_output_tokens: 300,
          });
      send(res, [
        message('p1', 'progress one', 'commentary'),
        message('p2', 'progress two', 'commentary'),
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: active.mcp ? 'ping' : tool,
          ...(active.mcp ? { namespace: 'mcp__fixture' } : {}),
          arguments: arguments_,
          status: 'completed',
        },
      ]);
    } else send(res, [message('final', '{"ok":true}')]);
  } catch (e) {
    res.writeHead(500);
    res.end(e.message);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const cases = [
  {
    name: 'network-deny-effect',
    permissions: {
      fileWrite: 'allow',
      shellExecute: 'allow',
      networkAccess: 'deny',
    },
    network: true,
    networkAllowed: false,
  },
  {
    name: 'network-bypass-effect',
    permissions: { mode: 'bypass' },
    network: true,
    networkAllowed: true,
  },
  { name: 'inherit-legacy-bypass', legacy: 'danger-full-access', write: true },
  { name: 'inherit-legacy-readonly', legacy: 'read-only', write: false },
  {
    name: 'auto-overrides-legacy-readonly',
    legacy: 'read-only',
    permissions: { mode: 'auto' },
    write: true,
  },
  {
    name: 'bypass-overrides-legacy-readonly',
    legacy: 'read-only',
    permissions: { mode: 'bypass' },
    write: true,
  },
  {
    name: 'readonly-overrides-legacy-bypass',
    legacy: 'danger-full-access',
    permissions: { fileWrite: 'deny' },
    write: false,
  },
  {
    name: 'network-deny-workspace',
    permissions: {
      fileWrite: 'allow',
      shellExecute: 'allow',
      networkAccess: 'deny',
    },
    write: true,
  },
  {
    name: 'auto-git-default-denied',
    permissions: { mode: 'auto' },
    target: '.git/permission-proof',
    write: false,
  },
  {
    name: 'auto-git-extra-writes',
    legacy: 'read-only',
    permissions: { mode: 'auto', writablePaths: ['.git'] },
    target: '.git/permission-proof',
    write: true,
  },
  {
    name: 'same-modern-field-overridden',
    modern: ':danger-full-access',
    permissions: { fileWrite: 'deny' },
    write: false,
  },
  {
    name: 'inherited-provider-mcp',
    legacy: 'read-only',
    permissions: { mode: 'auto' },
    mcp: true,
  },
];
try {
  for (const c of process.env.CLIGENT_CASE_ONLY
    ? cases.filter((c) => c.name === process.env.CLIGENT_CASE_ONLY)
    : process.env.CLIGENT_MCP_ONLY
      ? cases.filter((c) => c.mcp)
      : cases) {
    const cwd = join(root, c.name);
    const home = join(cwd, 'home');
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(join(cwd, '.git'));
    const target = join(cwd, c.target ?? 'permission-proof.txt');
    const config = `model_provider="fixture"\nmodel="gpt-5"\n${c.legacy ? `sandbox_mode="${c.legacy}"\n` : ''}${c.modern ? `default_permissions="${c.modern}"\n` : ''}[model_providers.fixture]\nname="Existing configured fixture"\nbase_url="http://127.0.0.1:${server.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n${c.mcp ? `[mcp_servers.fixture]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(mcp)}]\nrequired=true\ndefault_tools_approval_mode="approve"\n` : ''}`;
    await fs.writeFile(join(home, 'config.toml'), config);
    active = {
      ...c,
      requests: [],
      cmd:
        process.platform === 'win32'
          ? `Set-Content -LiteralPath '${target}' -Value 'permission-proof' -NoNewline`
          : `printf permission-proof > '${target}'`,
    };
    if (c.network)
      active.cmd = `${process.platform === 'win32' ? 'curl.exe' : '/usr/bin/curl'} --noproxy '*' --connect-timeout 1 --max-time 2 http://127.0.0.1:${server.address().port}/network-proof`;
    const runCase = active;
    const env = {
      ...process.env,
      CODEX_HOME: home,
      HOME: root,
      USERPROFILE: root,
      NO_PROXY: '127.0.0.1,localhost',
    };
    for (const k of [
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'OPENAI_BASE_URL',
      'NODE_OPTIONS',
      'ELECTRON_RUN_AS_NODE',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
    ])
      delete env[k];
    const adapter = new CodexAdapter({
      loadSdk: async () => ({
        Codex: class extends Codex {
          constructor(options) {
            super({ ...options, env });
          }
        },
      }),
    });
    const events = [];
    try {
      for await (const e of adapter.run(
        'Run the fixture tool once, then return final JSON.',
        {
          cwd,
          permissions: c.permissions,
          abortSignal: AbortSignal.timeout(30000),
        },
      ))
        events.push(e);
      const done = events.at(-1)?.payload;
      const wrote = await fs.access(target).then(
        () => true,
        () => false,
      );
      const texts = events
        .filter((e) => e.type === 'text')
        .map((e) => e.payload.content);
      const input = JSON.stringify(runCase.requests.map((r) => r.input));
      const toolOutputs = runCase.requests
        .flatMap((r) => r.input ?? [])
        .filter((i) => i.type === 'function_call_output')
        .map((i) => i.output);
      const row = {
        name: c.name,
        status: done?.status,
        result: done?.result,
        texts,
        wrote,
        expectedWrite: c.write,
        networkReached: Boolean(runCase.networkRequests),
        expectedNetwork: c.networkAllowed,
        requests: runCase.requests.length,
        context: input.match(/Filesystem sandboxing.{0,650}/)?.[0],
        toolOutputs,
        providerInherited: runCase.requests.length > 0,
        mcpToolAdvertised: runCase.tools.some((t) => t.endsWith('__ping')),
        configUnchanged:
          (await fs.readFile(join(home, 'config.toml'), 'utf8')) === config,
        errors: events
          .filter((e) => e.type === 'error')
          .map((e) => e.payload.message),
      };
      row.passed =
        done?.status === 'success' &&
        done.result === '{"ok":true}' &&
        row.configUnchanged &&
        (c.network
          ? Boolean(runCase.networkRequests) === c.networkAllowed
          : c.mcp
            ? row.mcpToolAdvertised &&
              toolOutputs.some((s) => JSON.stringify(s).includes('MCP_OK'))
            : c.name === 'network-deny-workspace' &&
                process.platform === 'win32'
              ? !wrote &&
                toolOutputs.some((s) =>
                  JSON.stringify(s).includes('blocked by policy'),
                )
              : c.name === 'auto-git-default-denied' &&
                  process.platform === 'win32'
                ? wrote &&
                  runCase.requests.some((r) => r.model === 'codex-auto-review')
                : wrote === c.write);
      results.push(row);
    } catch (e) {
      results.push({ name: c.name, passed: false, error: e.message });
    }
    console.log(JSON.stringify(results.at(-1)));
  }
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await fs.writeFile(
    process.env.CLIGENT_TEST_EVIDENCE ??
      join(tmpdir(), 'cligent-native-config-' + process.platform + '.json'),
    JSON.stringify({ platform: process.platform, root, results }, null, 2),
  );
  await fs.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}
assert(
  results.every((r) => r.passed),
  'One or more native permission cases failed',
);
