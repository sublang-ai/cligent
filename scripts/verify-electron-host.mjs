// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// Credential-free proof in a real Electron main process, not a simulated
// process.versions value. Install Electron separately and set its executable.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('--cligent-electron-host')) {
  const externalRequire = process.env.CLIGENT_ELECTRON_PACKAGE
    ? createRequire(join(process.env.CLIGENT_ELECTRON_PACKAGE, 'package.json'))
    : undefined;
  const executable =
    process.env.CLIGENT_ELECTRON_PATH ?? externalRequire?.('electron');
  assert(executable, 'Set CLIGENT_ELECTRON_PATH to the Electron 44 executable');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let staged;
  let entry = fileURLToPath(import.meta.url);
  if (process.argv.includes('--packaged')) {
    assert(
      externalRequire,
      'Set CLIGENT_ELECTRON_PACKAGE beside an installed @electron/asar',
    );
    const { createPackageWithOptions } = await import(
      pathToFileURL(externalRequire.resolve('@electron/asar')).href
    );
    staged = await mkdtemp(join(tmpdir(), 'cligent-asar-'));
    await mkdir(join(staged, 'scripts'));
    await cp(entry, join(staged, 'scripts/verify-electron-host.mjs'));
    await cp(join(root, 'dist'), join(staged, 'dist'), { recursive: true });
    await writeFile(
      join(staged, 'package.json'),
      JSON.stringify({
        type: 'module',
        main: 'scripts/verify-electron-host.mjs',
      }),
    );
    for (const name of [
      '@openai',
      '@anthropic-ai',
      '@playwright',
      'playwright',
      'playwright-core',
      '@agentclientprotocol',
      'zod',
      'yaml',
    ])
      await cp(
        join(root, 'node_modules', name),
        join(staged, 'node_modules', name),
        { recursive: true },
      );
    entry = `${staged}.asar`;
    await createPackageWithOptions(staged, entry, {
      unpackDir: 'node_modules',
    });
  }
  const child = spawn(executable, [entry, '--cligent-electron-host'], {
    stdio: 'inherit',
    env,
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(code, 0, 'Electron browser host proof failed');
  } finally {
    clearTimeout(timer);
    if (staged)
      await Promise.all(
        [staged, `${staged}.asar`, `${staged}.asar.unpacked`].map((path) =>
          rm(path, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 100,
          }),
        ),
      );
  }
} else {
  void (async () => {
    const { app } = await import('electron');
    await app.whenReady();
    try {
      assert.match(process.versions.electron, /^44\./);
      const { Cligent } = await import(
        pathToFileURL(join(root, 'dist/index.js')).href
      );
      const { CodexAdapter } = await import(
        pathToFileURL(join(root, 'dist/adapters/codex.js')).href
      );
      const { Codex } = await import('@openai/codex-sdk');
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const { ClaudeCodeAdapter } = await import(
        pathToFileURL(join(root, 'dist/adapters/claude-code.js')).href
      );
      const { probeClaudeExecutable } = await import(
        pathToFileURL(join(root, 'dist/adapters/claude-executable.js')).href
      );
      const { probeCodexExecutable } = await import(
        pathToFileURL(join(root, 'dist/adapters/codex-executable.js')).href
      );
      const directory = await mkdtemp(join(tmpdir(), 'cligent-electron-'));
      const workspace = join(directory, 'workspace');
      const home = join(directory, 'codex-home');
      await mkdir(workspace);
      await mkdir(home);
      const events = [];
      const requests = [];
      const errors = [];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      const provider = createServer(async (request, response) => {
        if (request.url?.startsWith('/v1/messages')) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          const send = (type, value) =>
            response.write(
              `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`,
            );
          send('message_start', {
            message: {
              id: 'msg_host',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-4-6',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          });
          send('content_block_start', {
            index: 0,
            content_block: { type: 'text', text: '' },
          });
          send('content_block_delta', {
            index: 0,
            delta: {
              type: 'text_delta',
              text: 'Packaged Claude native execution confirmed.',
            },
          });
          send('content_block_stop', { index: 0 });
          send('message_delta', {
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 10 },
          });
          send('message_stop', {});
          response.end();
          return;
        }
        if (request.url === '/favicon.ico') {
          response.writeHead(204).end();
          return;
        }
        if (request.url === '/preview') {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(
            '<!doctype html><title>Electron preview</title><h1>Browser proof</h1>',
          );
          return;
        }
        try {
          assert.equal(request.url, '/v1/responses');
          const chunks = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          const index = requests.length;
          assert(index <= 3, 'Unexpected extra model call');
          const address = provider.address();
          const item =
            index < 3
              ? {
                  id: `fc_${index}`,
                  type: 'function_call',
                  call_id: `call_${index}`,
                  namespace: 'mcp__cligent_browser',
                  name:
                    index === 1
                      ? 'browser_navigate'
                      : 'browser_take_screenshot',
                  arguments: JSON.stringify(
                    index === 1
                      ? { url: `http://127.0.0.1:${address.port}/preview` }
                      : { type: 'png' },
                  ),
                  status: 'completed',
                }
              : {
                  id: 'msg_explanation',
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [
                    {
                      type: 'output_text',
                      text: 'Browser proof completed.',
                      annotations: [],
                    },
                  ],
                };
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          let sequence = 0;
          const send = (type, value) =>
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
          if (index === 3)
            send('response.output_text.delta', {
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: item.content[0].text,
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
        } catch (error) {
          errors.push(error);
          response.writeHead(500).end();
        }
      });
      try {
        await new Promise((resolve, reject) => {
          provider.once('error', reject);
          provider.listen(0, '127.0.0.1', resolve);
        });
        const port = provider.address().port;
        const adapter = new CodexAdapter({
          probeExecutable: probeCodexExecutable,
          loadSdk: async () => ({
            Codex: class extends Codex {
              constructor(options) {
                super({
                  ...options,
                  env: Object.fromEntries(
                    Object.entries({
                      PATH: '',
                      HOME: directory,
                      CODEX_HOME: home,
                      SystemRoot: process.env.SystemRoot,
                      WINDIR: process.env.WINDIR,
                      TMPDIR: tmpdir(),
                      TEMP: tmpdir(),
                      TMP: tmpdir(),
                    }).filter(([, value]) => value !== undefined),
                  ),
                  config: {
                    features: { tool_search: false },
                    model_provider: 'fixture',
                    model_providers: {
                      fixture: {
                        name: 'Local provider',
                        base_url: `http://127.0.0.1:${port}/v1`,
                        wire_api: 'responses',
                        requires_openai_auth: false,
                      },
                    },
                  },
                });
              }
            },
          }),
        });
        const client = new Cligent(adapter, { cwd: workspace });
        assert.equal(
          (await client.getCapabilities()).browser.status,
          'supported',
        );
        const progress = [];
        const ready = await client.prepareBrowser({
          onProgress: ({ stage }) => progress.push(stage),
          abortSignal: controller.signal,
        });
        assert.equal(ready.status, 'ready', JSON.stringify(ready));
        assert.equal(typeof ready.checkedAt, 'number');
        assert.equal(progress.at(-1), 'launching');
        const outputBefore = (await readdir(tmpdir()))
          .filter((name) => name.startsWith('cligent-browser-output-'))
          .sort();
        for await (const event of client.run(
          'Open the preview, capture a screenshot, and explain what it shows.',
          {
            browser: true,
            model: 'gpt-5',
            abortSignal: controller.signal,
            // Exercise the POSIX wrapper as well as raw MCP overrides. Native
            // Windows has an explicit, accurately reported isolation restriction.
            ...(process.platform === 'win32'
              ? {}
              : { permissions: { fileWrite: 'deny' } }),
          },
        ))
          events.push(event);
        assert.deepEqual(errors, []);
        assert.deepEqual(
          events.filter((event) => event.type === 'error'),
          [],
        );
        assert.equal(
          events.at(-1)?.payload.status,
          'success',
          JSON.stringify(events),
        );
        assert.equal(requests.length, 3);
        assert.match(
          JSON.stringify(requests[2].input),
          /data:image\/png;base64,/,
        );
        assert(
          events.some(
            (event) =>
              event.type === 'media' && event.payload.mimeType === 'image/png',
          ),
        );
        assert.deepEqual(await readdir(workspace), []);
        assert.deepEqual(
          (await readdir(tmpdir()))
            .filter((name) => name.startsWith('cligent-browser-output-'))
            .sort(),
          outputBefore,
        );
        const claude = new Cligent(
          new ClaudeCodeAdapter({
            probeExecutable: probeClaudeExecutable,
            loadSdk: async () => ({
              query: (parameters) =>
                query({
                  ...parameters,
                  options: {
                    ...parameters.options,
                    settingSources: [],
                    persistSession: false,
                    env: {
                      PATH: '',
                      HOME: directory,
                      CLAUDE_CONFIG_DIR: home,
                      TMPDIR: tmpdir(),
                      SystemRoot: process.env.SystemRoot,
                      WINDIR: process.env.WINDIR,
                      ANTHROPIC_API_KEY: 'local-fixture-not-a-real-key',
                      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
                      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
                      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
                      DISABLE_TELEMETRY: '1',
                      DISABLE_ERROR_REPORTING: '1',
                      ENABLE_TOOL_SEARCH: 'false',
                    },
                  },
                }),
            }),
          }),
          { cwd: workspace },
        );
        const claudeEvents = [];
        for await (const event of claude.run('Confirm native execution.', {
          model: 'claude-sonnet-4-6',
          allowedTools: [],
          abortSignal: controller.signal,
        }))
          claudeEvents.push(event);
        assert.equal(
          claudeEvents.at(-1)?.payload.status,
          'success',
          JSON.stringify(claudeEvents),
        );
        assert(
          claudeEvents.some(
            (event) =>
              event.type === 'text' &&
              event.payload.content.includes(
                'Packaged Claude native execution confirmed.',
              ),
          ),
        );
        console.log(
          JSON.stringify({
            electron: process.versions.electron,
            host: `${process.platform}-${process.arch}`,
            readiness: ready.status,
            modelRequests: requests.length,
            screenshotToModelAndHost: true,
            unchangedWorkspace: true,
            managedOutputCleaned: true,
            globalNodeRequired: false,
            claudeNativeExecution: true,
          }),
        );
      } finally {
        clearTimeout(timer);
        controller.abort();
        provider.closeAllConnections();
        await new Promise((resolve) => provider.close(resolve));
        // Native background tasks may release home/cache handles just after done.
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 100,
        });
      }
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  })();
}
