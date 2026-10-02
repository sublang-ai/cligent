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

describe('managed browser preparation subprocess', () => {
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
