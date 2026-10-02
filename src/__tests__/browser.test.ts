// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareBrowserServer, releaseBrowserServer } from '../browser.js';
import type { McpServerConfig } from '../mcp.js';

const directories: string[] = [];
const configurations: McpServerConfig[] = [];
afterEach(async () => {
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
      expect((await pending).message).toMatch(
        kind === 'cancel' ? /interrupted/ : /could not launch/,
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
