// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as browser from '../browser.js';
import { Cligent } from '../cligent.js';
import type { AgentAdapter } from '../types.js';
import { prepareBrowserServer, releaseBrowserServer } from '../browser.js';
import type { McpServerConfig } from '../mcp.js';

const directories: string[] = [];
const configurations: McpServerConfig[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(configurations.splice(0).map(releaseBrowserServer));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(body: string) {
  const dir = await mkdtemp(join(tmpdir(), 'cligent-browser-'));
  directories.push(dir);
  const cli = join(dir, 'installer.cjs');
  await writeFile(
    cli,
    `const fs = require('node:fs'); const path = require('node:path');\n${body}`,
  );
  return {
    cli,
    executablePath: join(dir, 'chromium'),
    dir,
    probe: async () => {},
  };
}

async function captureFixture(
  outcomes: readonly string[],
  rejectDisposal = false,
) {
  const runtime = await fixture(
    "fs.writeFileSync(path.join(__dirname, 'chromium'), 'fixture', {mode:0o700});",
  );
  const playwright = join(runtime.dir, 'playwright.cjs');
  // Run the production generated proof in its real owned child, controlling
  // only the native runtime boundary where Chromium reports capture outcomes.
  await writeFile(
    playwright,
    `
const fs = require('node:fs');
const path = require('node:path');
const record = value => fs.appendFileSync(path.join(__dirname, 'events'), JSON.stringify(value) + '\\n');
fs.writeFileSync(path.join(__dirname, 'pid'), String(process.pid));
const outcomes = ${JSON.stringify(outcomes)};
let connected = true, closed = false, attempt = 0;
const page = {
  setContent: async () => record({event:'content', page:'owned-page'}),
  isClosed: () => closed,
  viewportSize: () => ({width:1280, height:720}),
  screenshot: async options => {
    record({event:'capture', page:'owned-page', timeout:options.timeout});
    const outcome = outcomes[attempt++];
    const empty = 'page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot';
    if (outcome === 'empty' || outcome === 'closed-page' || outcome === 'disconnected') {
      if (outcome === 'closed-page') closed = true;
      if (outcome === 'disconnected') connected = false;
      // Oversized native call logs must leave both bounded causes observable.
      throw new Error(empty + '\\nCall log:\\n  - capture-' + attempt + '\\n' + 'x'.repeat(12000));
    }
    if (outcome === 'other') throw new Error('page.screenshot: Protocol error (Page.captureScreenshot): Permission denied');
    if (outcome === 'prefixed') throw new Error('unrelated ' + empty);
    if (outcome === 'suffixed') throw new Error(empty + ' on another operation');
    if (outcome === 'invalid') return Buffer.from('not a PNG');
    if (outcome === 'hang') {
      fs.writeFileSync(path.join(__dirname, 'capture-waiting'), 'waiting');
      return new Promise(() => {});
    }
    // A third capture succeeding would expose an unbounded recovery policy.
    return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64');
  },
};
const browser = {
  isConnected: () => connected,
  newPage: async () => { record({event:'page', page:'owned-page'}); return page; },
};
module.exports = {chromium:{
  launchServer: async options => {
    record({event:'launch', headless:options.headless, sandbox:options.chromiumSandbox});
    return {wsEndpoint:()=> 'ws://owned-browser', kill:async()=> {
      record({event:'dispose'}); connected = false; closed = true;
      if (${rejectDisposal}) throw new Error('fixture disposal rejected ' + 'z'.repeat(12000));
    }};
  },
  connect: async endpoint => { record({event:'connect', endpoint}); return browser; },
}};
`,
  );
  return { ...runtime, probe: undefined, playwright };
}

async function captureEvents(runtime: { dir: string }) {
  return (await readFile(join(runtime.dir, 'events'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('managed browser preparation subprocess', () => {
  it('recovers one exact empty-image failure on the same live page before disposal', async () => {
    const runtime = await captureFixture(['empty', 'png']);
    configurations.push(await prepareBrowserServer(undefined, runtime));
    const events = await captureEvents(runtime);
    const launches = events.filter((event) => event.event === 'launch');
    expect(launches.length).toBeLessThanOrEqual(1);
    expect(launches[0]).toMatchObject({ headless: true, sandbox: true });
    expect(events.find((event) => event.event === 'connect')?.endpoint).toBe(
      'ws://owned-browser',
    );
    const captures = events.filter((event) => event.event === 'capture');
    expect(captures.length).toBeLessThanOrEqual(2);
    expect(captures.every((event) => event.page === 'owned-page')).toBe(true);
    expect(captures[1].timeout).toBeLessThanOrEqual(captures[0].timeout);
    expect(captures[0].timeout).toBeLessThanOrEqual(10_000);
    expect(
      events.findIndex((event) => event.event === 'dispose'),
    ).toBeGreaterThan(
      events.findLastIndex((event) => event.event === 'capture'),
    );
  });

  it.each(['empty', 'other', 'invalid'])(
    'retains both diagnostics and pre-disposal live facts after additional capture %s',
    async (additional) => {
      const runtime = await captureFixture(['empty', additional]);
      const failure = await prepareBrowserServer(undefined, runtime).catch(
        (error) => error as Error,
      );
      expect(failure).toMatchObject({ code: 'launch-failed' });
      expect(failure.message).toContain(
        'First PNG capture: Error: page.screenshot:',
      );
      expect(failure.message).toContain('capture-1');
      expect(failure.message).toContain('Additional PNG capture: Error:');
      expect(failure.message).toContain(
        additional === 'empty'
          ? 'capture-2'
          : additional === 'invalid'
            ? 'Browser returned no PNG screenshot'
            : 'Permission denied',
      );
      expect(failure.message).toContain(
        'Browser proof failure facts: {"step":"capture-screenshot","browserConnected":true,"pageClosed":false,"viewport":{"width":1280,"height":720}}',
      );
      expect(failure.message.length).toBeLessThan(9000);
      const events = await captureEvents(runtime);
      expect(
        events.filter((event) => event.event === 'capture').length,
      ).toBeLessThanOrEqual(2);
      expect(events.at(-1)?.event).toBe('dispose');
    },
  );

  it.each([
    'other',
    'prefixed',
    'suffixed',
    'invalid',
    'closed-page',
    'disconnected',
  ])(
    'does not recapture after %s and observes the failed state before cleanup',
    async (outcome) => {
      const runtime = await captureFixture([outcome, 'png']);
      const failure = await prepareBrowserServer(undefined, runtime).catch(
        (error) => error as Error,
      );
      expect(failure).toMatchObject({ code: 'launch-failed' });
      expect(failure.message).not.toContain('Additional PNG capture:');
      expect(failure.message).toContain(
        `"browserConnected":${outcome !== 'disconnected'},"pageClosed":${outcome === 'closed-page'}`,
      );
      const events = await captureEvents(runtime);
      expect(
        events.filter((event) => event.event === 'capture').length,
      ).toBeLessThanOrEqual(1);
      expect(events.at(-1)?.event).toBe('dispose');
    },
  );

  it('retains both bounded capture failures when disposal also rejects', async () => {
    const runtime = await captureFixture(['empty', 'empty'], true);
    const failure = await prepareBrowserServer(undefined, runtime).catch(
      (error) => error as Error,
    );
    expect(failure.message).toContain('First PNG capture:');
    expect(failure.message).toContain('capture-1');
    expect(failure.message).toContain('Additional PNG capture:');
    expect(failure.message).toContain('capture-2');
    expect(failure.message).toContain(
      'Browser disposal failure: Error: fixture disposal rejected',
    );
    expect(failure.message).toContain(
      '"browserConnected":true,"pageClosed":false',
    );
    expect(failure.message.length).toBeLessThan(6000);
    expect(failure.message.indexOf('First PNG capture:')).toBeLessThan(
      failure.message.indexOf('Browser disposal failure:'),
    );
  });

  it.each(['timeout', 'cancel'])(
    'keeps the original deadline and owned cleanup during additional capture %s',
    async (kind) => {
      const runtime = await captureFixture(['empty', 'hang']);
      const controller = new AbortController();
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const pending = browser.prepareBrowserRuntime(
        { timeoutMs: 900_000, abortSignal: controller.signal },
        runtime,
      );
      try {
        let captureWaiting = false;
        for (let attempt = 0; attempt < 1000; attempt++) {
          try {
            await readFile(join(runtime.dir, 'capture-waiting'));
            captureWaiting = true;
            break;
          } catch {
            await delay(10);
          }
        }
        expect(captureWaiting).toBe(true);
        if (kind === 'timeout') await vi.advanceTimersByTimeAsync(10_000);
        if (kind === 'cancel') controller.abort();
        expect(await pending).toMatchObject(
          kind === 'cancel'
            ? { status: 'cancelled' }
            : {
                status: 'not-ready',
                code: 'launch-failed',
                message: expect.stringContaining(
                  'last reported browser step: capturing the screenshot',
                ),
              },
        );
        const pid = Number(await readFile(join(runtime.dir, 'pid'), 'utf8'));
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        controller.abort();
        vi.useRealTimers();
        await pending;
      }
    },
    15_000,
  );

  it.skipIf(process.platform === 'win32').each(['timeout', 'cancel'])(
    'terminates a nonresponsive native browser launch and descendant on %s',
    async (kind) => {
      const runtime = await fixture('');
      const launcher = join(runtime.dir, 'browser.cjs');
      await writeFile(
        launcher,
        `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(join(runtime.dir, 'browser.pid'))}, String(process.pid));
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(join(runtime.dir, 'descendant.pid'))},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`)}], {stdio:'ignore'});
      process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);
    `,
      );
      await writeFile(
        runtime.cli,
        `require('node:fs').writeFileSync(${JSON.stringify(runtime.executablePath)}, ${JSON.stringify(`#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${launcher.replaceAll("'", "'\\''")}'\n`)}, {mode:0o700});`,
      );
      const controller = new AbortController();
      const pending = prepareBrowserServer(
        controller.signal,
        {
          ...runtime,
          probe: undefined,
          playwright: createRequire(import.meta.url).resolve('playwright'),
        },
        kind === 'timeout' ? 4000 : 10_000,
      ).catch((error) => error as Error);
      if (kind === 'cancel') {
        await expect
          .poll(
            async () => {
              try {
                await readFile(join(runtime.dir, 'descendant.pid'));
                return true;
              } catch {
                return false;
              }
            },
            { timeout: 5000 },
          )
          .toBe(true);
        controller.abort();
      }
      const failure = await pending;
      expect(failure.message).toMatch(
        kind === 'cancel' ? /interrupted/ : /could not launch/,
      );
      if (kind === 'timeout')
        expect(failure.message).toContain(
          'last reported browser step: launching the browser',
        );
      for (const name of ['browser.pid', 'descendant.pid']) {
        const pid = Number(await readFile(join(runtime.dir, name), 'utf8'));
        // Native process-group termination may be observed one scheduling tick
        // before the child is reaped. Never leave a real descendant running.
        await expect
          .poll(
            () => {
              try {
                process.kill(pid, 0);
                return false;
              } catch {
                return true;
              }
            },
            { timeout: 2000 },
          )
          .toBe(true);
      }
    },
    10_000,
  );

  it.each(['outer', 'inner'])(
    'keeps the last fixed proof step across split markers and diagnostic truncation on %s deadline',
    async (deadline) => {
      const runtime = await fixture(
        "fs.writeFileSync(path.join(__dirname, 'chromium'), 'fixture', {mode:0o700});",
      );
      const playwright = join(runtime.dir, 'playwright.cjs');
      await writeFile(
        playwright,
        `
      const fs = require('node:fs');
      module.exports = { chromium: { launchServer: async () => {
        fs.writeFileSync(${JSON.stringify(join(runtime.dir, 'proof.pid'))}, String(process.pid));
        process.stderr.write('__CLIGENT_BROWSER_PROOF_');
        await new Promise(resolve => setTimeout(resolve, 20));
        process.stderr.write('STEP__=open-');
        await new Promise(resolve => setTimeout(resolve, 20));
        process.stderr.write('page\\n');
        process.stdout.write('__CLIGENT_BROWSER_PROOF_STEP__=capture-screenshot\\n');
        process.stderr.write('__CLIGENT_BROWSER_PROOF_STEP__=secret-sentinel\\n');
        process.stderr.write('x'.repeat(200) + '__CLIGENT_BROWSER_PROOF_STEP__=capture-screenshot\\n');
        process.stderr.write('secret-sentinel'.repeat(3000));
        ${
          deadline === 'inner'
            ? `
        require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(join(runtime.dir, 'proof-descendant.pid'))}, String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`)}], {stdio:'ignore'});
        for (let attempt = 0; attempt < 100 && !fs.existsSync(${JSON.stringify(join(runtime.dir, 'proof-descendant.pid'))}); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
        if (!fs.existsSync(${JSON.stringify(join(runtime.dir, 'proof-descendant.pid'))})) throw new Error('fixture descendant did not start');
        process.stderr.write('\\n__CLIGENT_BROWSER_PROOF_DEADLINE__\\n'); process.exit(1);
        `
            : ''
        }
        await new Promise(() => {});
      } } };
      `,
      );
      const failure = await prepareBrowserServer(
        undefined,
        { ...runtime, probe: undefined, playwright },
        2000,
      ).catch((error) => error as Error);
      expect(failure).toMatchObject({
        code: 'launch-failed',
        message: expect.stringContaining(
          'last reported browser step: opening a browser page',
        ),
      });
      expect((failure as Error).message).not.toContain('secret-sentinel');
      expect((failure as Error).message).not.toContain(
        '__CLIGENT_BROWSER_PROOF_STEP__',
      );
      expect((failure as Error).message.length).toBeLessThan(1000);
      const pid = Number(
        await readFile(join(runtime.dir, 'proof.pid'), 'utf8'),
      );
      expect(() => process.kill(pid, 0)).toThrow();
      if (deadline === 'inner') {
        const descendant = Number(
          await readFile(join(runtime.dir, 'proof-descendant.pid'), 'utf8'),
        );
        await expect
          .poll(() => {
            try {
              process.kill(descendant, 0);
              return false;
            } catch {
              return true;
            }
          })
          .toBe(true);
      }
    },
  );

  it('installs missing Chromium once and returns isolated screenshot-capable MCP arguments', async () => {
    const runtime = await fixture(
      `
      if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['install-browser','chromium'])) process.exit(3);
      fs.appendFileSync(path.join(__dirname, 'calls'), 'install\n');
      fs.writeFileSync(path.join(__dirname, 'chromium'), 'fixture', {mode: 0o700});
    `.replace("'install\n'", "'install\\n'"),
    );
    const first = await prepareBrowserServer(undefined, runtime);
    const second = await prepareBrowserServer(undefined, runtime);
    configurations.push(first, second);
    expect(second).not.toEqual(first);
    expect(await readFile(join(runtime.dir, 'calls'), 'utf8')).toBe(
      'install\n',
    );
    expect(first).toEqual({
      type: 'stdio',
      command: process.execPath,
      args: [
        runtime.cli,
        '--executable-path',
        runtime.executablePath,
        '--headless',
        '--sandbox',
        '--isolated',
        '--image-responses',
        'allow',
        '--output-dir',
        expect.stringContaining('cligent-browser-output-'),
      ],
    });
  });

  it('verifies native installation completion even when an extracted executable already exists', async () => {
    const runtime = await fixture(
      "setTimeout(() => fs.writeFileSync(path.join(__dirname, 'complete'), 'done'), 30);",
    );
    await writeFile(runtime.executablePath, 'partially extracted browser', {
      mode: 0o700,
    });
    configurations.push(await prepareBrowserServer(undefined, runtime));
    expect(await readFile(join(runtime.dir, 'complete'), 'utf8')).toBe('done');
  });

  it('fails with bounded actionable diagnostics and does not claim readiness', async () => {
    const runtime = await fixture(
      "process.stderr.write('x'.repeat(20000)); process.exitCode = 2;",
    );
    const error = await prepareBrowserServer(undefined, runtime).catch(
      (value) => value as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('installation failed');
    expect((error as Error).message.length).toBeLessThan(9000);
  });

  it('rejects an installer that exits successfully without producing the browser', async () => {
    const runtime = await fixture('process.exit(0);');
    await expect(prepareBrowserServer(undefined, runtime)).rejects.toThrow(
      'expected executable',
    );
  });

  it.each(['cancel', 'timeout'])(
    'terminates an unresponsive owned installer on %s',
    async (kind) => {
      const runtime = await fixture(`
      fs.writeFileSync(path.join(__dirname, 'pid'), String(process.pid));
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `);
      const controller = new AbortController();
      const pending = prepareBrowserServer(
        controller.signal,
        runtime,
        kind === 'timeout' ? 400 : 5000,
      );
      // Attach rejection handling before triggering cancellation.
      const result = pending.catch((value) => value as Error);
      let pid: number | undefined;
      for (let i = 0; i < 100; i++) {
        try {
          pid = Number(await readFile(join(runtime.dir, 'pid'), 'utf8'));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(pid).toBeTypeOf('number');
      if (kind === 'cancel') controller.abort();
      expect(await result).toMatchObject({
        message: expect.stringMatching(
          kind === 'cancel' ? /interrupted/ : /timed out/,
        ),
      });
      expect(() => process.kill(pid!, 0)).toThrow();
    },
  );

  it('reports the browser-only Node requirement before starting an installer', async () => {
    const runtime = await fixture(
      "fs.writeFileSync(path.join(__dirname, 'unexpected'), 'called');",
    );
    const descriptor = Object.getOwnPropertyDescriptor(URL, 'canParse')!;
    Reflect.deleteProperty(URL, 'canParse');
    try {
      await expect(prepareBrowserServer(undefined, runtime)).rejects.toThrow(
        'Node 18.17+',
      );
      await expect(
        readFile(join(runtime.dir, 'unexpected')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      Object.defineProperty(URL, 'canParse', descriptor);
    }
  });

  it('does not start installation for a pre-aborted request', async () => {
    const runtime = await fixture(
      "fs.writeFileSync(path.join(__dirname, 'unexpected'), 'called');",
    );
    await expect(
      prepareBrowserServer(AbortSignal.abort(), runtime),
    ).rejects.toThrow('interrupted');
    await expect(
      readFile(join(runtime.dir, 'unexpected')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function installerPid(runtime: { dir: string }): Promise<number> {
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      return Number(await readFile(join(runtime.dir, 'pid'), 'utf8'));
    } catch {
      await delay(10);
    }
  }
  throw new Error('Controlled installer did not start');
}

const controlledInstaller = `
fs.writeFileSync(path.join(__dirname, 'pid'), String(process.pid));
const timer = setInterval(() => {
  if (fs.existsSync(path.join(__dirname, 'finish'))) {
    fs.writeFileSync(path.join(__dirname, 'chromium'), 'fixture', {mode: 0o700});
    clearInterval(timer);
  }
}, 10);
`;

function setupClient(available: () => Promise<boolean> = async () => true) {
  return new Cligent({
    agent: 'fixture',
    getCapabilities: () => ({ browser: { status: 'supported' } }),
    isAvailable: available,
    async *run() {
      throw new Error('Browser setup must not start a provider');
    },
  } satisfies AgentAdapter);
}

describe('explicit browser setup overall budget', () => {
  it.each(['caller', 'default', 'runtime-default'] as const)(
    'honors the %s budget beyond the previous installer cap and shares it with discovery and launch',
    async (kind) => {
      const runtime = await fixture(controlledInstaller);
      const budgets: number[] = [];
      const realPrepare = browser.prepareBrowserRuntime;
      const fixtureRuntime = {
        ...runtime,
        probe: async (_signal: AbortSignal | undefined, timeoutMs: number) => {
          budgets.push(timeoutMs);
        },
      };
      vi.spyOn(browser, 'prepareBrowserRuntime').mockImplementation((options) =>
        realPrepare(options, fixtureRuntime),
      );
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const controller = new AbortController();
      let completeDiscovery!: () => void;
      const discovery = new Promise<boolean>((resolve) => {
        completeDiscovery = () => resolve(true);
      });
      const budget = kind === 'caller' ? 900_000 : 600_000;
      const options = {
        abortSignal: controller.signal,
        ...(kind === 'caller' ? { timeoutMs: budget } : {}),
      };
      const stages: string[] = [];
      const pending =
        kind === 'runtime-default'
          ? realPrepare(
              { ...options, onProgress: (value) => stages.push(value.stage) },
              fixtureRuntime,
            )
          : setupClient(() => discovery).prepareBrowser({
              ...options,
              onProgress: (value) => stages.push(value.stage),
            });
      let settled = false;
      void pending.finally(() => {
        settled = true;
      });
      try {
        const discoveryElapsed = kind === 'runtime-default' ? 0 : 45_000;
        if (discoveryElapsed) {
          await vi.advanceTimersByTimeAsync(discoveryElapsed);
          completeDiscovery();
        }
        const pid = await installerPid(runtime);
        await vi.advanceTimersByTimeAsync(195_001 - discoveryElapsed);
        expect(settled).toBe(false);
        expect(() => process.kill(pid, 0)).not.toThrow();
        // The remaining overall budget, rather than a fresh launch allowance,
        // is passed to the readiness probe after a slow successful install.
        await vi.advanceTimersByTimeAsync(budget - 5000 - 195_001);
        expect(settled).toBe(false);
        await writeFile(join(runtime.dir, 'finish'), 'finish');
        expect(await pending).toMatchObject({ status: 'ready' });
        expect(budgets).toEqual([5000]);
        expect(stages).toEqual(
          kind === 'runtime-default'
            ? ['installing', 'launching']
            : ['checking', 'installing', 'launching'],
        );
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        controller.abort();
        vi.useRealTimers();
        await pending;
      }
    },
  );

  it.each(['timeout', 'cancel'] as const)(
    'retires the owned installer on explicit setup %s without launching a provider',
    async (kind) => {
      const runtime = await fixture(controlledInstaller);
      const realPrepare = browser.prepareBrowserRuntime;
      vi.spyOn(browser, 'prepareBrowserRuntime').mockImplementation((options) =>
        realPrepare(options, runtime),
      );
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      const controller = new AbortController();
      const stages: string[] = [];
      const pending = setupClient().prepareBrowser({
        timeoutMs: kind === 'timeout' ? 1200 : 900_000,
        abortSignal: controller.signal,
        onProgress: (value) => stages.push(value.stage),
      });
      let settled = false;
      void pending.finally(() => {
        settled = true;
      });
      try {
        const pid = await installerPid(runtime);
        await vi.advanceTimersByTimeAsync(kind === 'timeout' ? 1199 : 200_000);
        expect(settled).toBe(false);
        expect(() => process.kill(pid, 0)).not.toThrow();
        if (kind === 'timeout') await vi.advanceTimersByTimeAsync(1);
        else controller.abort();
        expect(await pending).toMatchObject(
          kind === 'timeout'
            ? { status: 'not-ready', code: 'timeout' }
            : { status: 'cancelled' },
        );
        expect(stages).toEqual(['checking', 'installing']);
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        controller.abort();
        vi.useRealTimers();
        await pending;
      }
    },
  );

  it('retains the ordinary-call three-minute installer deadline', async () => {
    const runtime = await fixture(controlledInstaller);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    const pending = prepareBrowserServer(controller.signal, runtime).catch(
      (error) => error as Error,
    );
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    try {
      const pid = await installerPid(runtime);
      await vi.advanceTimersByTimeAsync(179_999);
      expect(settled).toBe(false);
      expect(() => process.kill(pid, 0)).not.toThrow();
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toMatchObject({
        message: expect.stringContaining('installation timed out'),
      });
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      controller.abort();
      vi.useRealTimers();
      await pending;
    }
  });

  it('retains the ten-second launch cap when explicit setup has ample time', async () => {
    const runtime = await fixture(
      "fs.writeFileSync(path.join(__dirname, 'chromium'), 'fixture', {mode: 0o700});",
    );
    const budgets: number[] = [];
    expect(
      await browser.prepareBrowserRuntime(
        { timeoutMs: 900_000 },
        {
          ...runtime,
          probe: async (_signal, budget) => {
            budgets.push(budget);
          },
        },
      ),
    ).toMatchObject({ status: 'ready' });
    expect(budgets).toEqual([10_000]);
  });
});
