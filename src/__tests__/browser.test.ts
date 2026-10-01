// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareBrowserServer } from '../browser.js';

const directories: string[] = [];
afterEach(async () => {
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
  return { cli, executablePath: join(dir, 'chromium'), dir };
}

describe('managed browser preparation subprocess', () => {
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
    expect(second).toEqual(first);
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
        '--isolated',
        '--image-responses',
        'allow',
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
    await prepareBrowserServer(undefined, runtime);
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
