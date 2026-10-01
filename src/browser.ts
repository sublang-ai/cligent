// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { McpServerConfig } from './mcp.js';

/** Internal runtime seam also used by subprocess integration tests. */
export interface BrowserRuntime {
  cli: string;
  executablePath: string;
}

const verifiedInstallations = new Set<string>();

function resolveBrowserRuntime(): BrowserRuntime {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve('@playwright/mcp/package.json');
  const runtimeRequire = createRequire(manifest);
  const playwright = runtimeRequire('playwright') as {
    chromium: { executablePath(): string };
  };
  return {
    cli: join(dirname(manifest), 'cli.js'),
    executablePath: playwright.chromium.executablePath(),
  };
}

async function executableExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error(
      `Managed browser executable is inaccessible: ${String(error)}`,
    );
  }
}

function installChromium(
  cli: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Browser preparation interrupted'));
      return;
    }
    const child = spawn(
      process.execPath,
      [cli, 'install-browser', 'chromium'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    );
    let diagnostics = '';
    let stopped: Error | undefined;
    let settled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const output = (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString('utf8')).slice(-8192);
    };
    child.stdout.on('data', output);
    child.stderr.on('data', output);
    const kill = (kind: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid)
          process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch {
        // Exit can race cancellation.
      }
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(escalation);
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      child.stdout.off('data', output);
      child.stderr.off('data', output);
      if (error) reject(error);
      else resolve();
    };
    const stop = (error: Error) => {
      if (stopped || settled) return;
      stopped = error;
      kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 250);
      deadline = setTimeout(() => {
        kill('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        finish(error);
      }, 1000);
    };
    const abort = () => stop(new Error('Browser preparation interrupted'));
    const timeout = setTimeout(
      () =>
        stop(
          new Error(
            'Managed Chromium installation timed out; check network access and retry',
          ),
        ),
      timeoutMs,
    );
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', (error) => finish(stopped ?? error));
    child.once('close', (code) => {
      finish(
        stopped ??
          (code === 0
            ? undefined
            : new Error(
                `Managed Chromium installation failed (${code ?? 'signal'}). Check network access and host prerequisites, then retry.\n${diagnostics}`,
              )),
      );
    });
  });
}

/** Install only managed Chromium; never install OS packages or change Chrome. */
export async function prepareBrowserServer(
  signal?: AbortSignal,
  runtime: BrowserRuntime = resolveBrowserRuntime(),
  timeoutMs = 180_000,
): Promise<McpServerConfig> {
  if (signal?.aborted) throw new Error('Browser preparation interrupted');
  // Feature detection keeps ordinary calls compatible with the older Node floor.
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  if (typeof URL.canParse !== 'function') {
    throw new Error(
      'The managed browser requires URL.canParse (Node 18.17+ or 20+). Upgrade Node to enable browser; ordinary Cligent calls still support Node 18.3.0.',
    );
  }
  const installationKey = `${runtime.cli}\0${runtime.executablePath}`;
  if (
    !verifiedInstallations.has(installationKey) ||
    !(await executableExists(runtime.executablePath))
  ) {
    // An executable can exist while another process is still extracting it.
    // Let the pinned runtime verify its completion marker under its own
    // cross-process cache lock, rather than depending on private cache paths.
    await installChromium(runtime.cli, signal, timeoutMs);
    if (!(await executableExists(runtime.executablePath))) {
      throw new Error(
        'Managed Chromium installation did not produce its expected executable',
      );
    }
    verifiedInstallations.add(installationKey);
  }
  if (signal?.aborted) throw new Error('Browser preparation interrupted');
  return {
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
  };
}
