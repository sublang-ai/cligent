// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { McpServerConfig } from './mcp.js';
import { nodeChildEnvironment, ownedChildPath } from './node-child.js';
import type {
  BrowserSetupFailure,
  BrowserSetupOptions,
  BrowserSetupResult,
} from './capabilities.js';
import {
  assertBrowserHost,
  CapabilityError,
  DEFAULT_BROWSER_SETUP_TIMEOUT_MS,
} from './capabilities.js';

/** Internal runtime seam also used by subprocess integration tests. */
export interface BrowserRuntime {
  cli: string;
  executablePath: string;
  /** Fixture seam; production always performs the native launch below. */
  probe?: (signal: AbortSignal | undefined, timeoutMs: number) => Promise<void>;
  playwright?: string;
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
    cli: ownedChildPath(join(dirname(manifest), 'cli.js')),
    executablePath: playwright.chromium.executablePath(),
    playwright: ownedChildPath(runtimeRequire.resolve('playwright')),
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

const proofStepLabels = {
  'load-runtime': 'loading the browser runtime',
  'launch-browser': 'launching the browser',
  'connect-browser': 'connecting to the browser',
  'open-page': 'opening a browser page',
  'set-content': 'setting the page content',
  'capture-screenshot': 'capturing the screenshot',
  'dispose-browser': 'disposing the browser',
} as const;
const proofStepPrefix = '__CLIGENT_BROWSER_PROOF_STEP__=';
const proofDeadlineMarker = '__CLIGENT_BROWSER_PROOF_DEADLINE__';

function runBrowserChild(
  cli: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
  operation: string,
  trackProofSteps = false,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Browser preparation interrupted'));
      return;
    }
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: { ...process.env, ...nodeChildEnvironment() },
    });
    let diagnostics = '';
    let proofLine = '';
    let discardProofLine = false;
    let lastProofStep = 'starting the browser proof';
    let proofDeadlineReported = false;
    let stopped: Error | undefined;
    let settled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const output = (chunk: Buffer, parseProofSteps = false) => {
      const text = chunk.toString('utf8');
      if (parseProofSteps) {
        // Keep the fixed progress protocol independent of stderr truncation.
        // Discard an oversized line through its newline, never parse its tail.
        for (const character of text) {
          if (character === '\n') {
            if (!discardProofLine) {
              const line = proofLine.replace(/\r$/, '');
              if (line === proofDeadlineMarker) proofDeadlineReported = true;
              else if (line.startsWith(proofStepPrefix)) {
                const step = line.slice(proofStepPrefix.length);
                if (Object.hasOwn(proofStepLabels, step))
                  lastProofStep =
                    proofStepLabels[step as keyof typeof proofStepLabels];
              }
            }
            proofLine = '';
            discardProofLine = false;
          } else if (!discardProofLine) {
            if (proofLine.length < 128) proofLine += character;
            else {
              proofLine = '';
              discardProofLine = true;
            }
          }
        }
      }
      diagnostics = (diagnostics + text).slice(-8192);
    };
    const stderrOutput = (chunk: Buffer) => output(chunk, trackProofSteps);
    const timeoutError = () =>
      new Error(
        `${operation} timed out; ${trackProofSteps ? `last reported browser step: ${lastProofStep}; ` : ''}check host prerequisites and retry`,
      );
    child.stdout.on('data', output);
    child.stderr.on('data', stderrOutput);
    const kill = (kind: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid)
          process.kill(-child.pid, kind);
        else if (child.pid) {
          const killer = spawn(
            'taskkill.exe',
            ['/PID', String(child.pid), '/T', '/F'],
            { stdio: 'ignore', timeout: 500 },
          );
          killer.once('error', () => child.kill(kind));
        }
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
      child.stderr.off('data', stderrOutput);
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
    const timeout = setTimeout(() => stop(timeoutError()), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', (error) => finish(stopped ?? error));
    child.once('close', (code) => {
      // A child can exit while an inherited descendant ignores SIGTERM.
      // Finish owned-tree termination before cancelling the escalation timer.
      if (stopped || proofDeadlineReported) kill('SIGKILL');
      finish(
        stopped ??
          (proofDeadlineReported
            ? timeoutError()
            : code === 0
              ? undefined
              : new Error(
                  `${operation} failed (${code ?? 'signal'}). Check network access and host prerequisites, then retry.\n${trackProofSteps ? diagnostics.replace(/^__CLIGENT_BROWSER_PROOF_(?:STEP__=[^\r\n]*|DEADLINE__)\r?\n?/gm, '') : diagnostics}`,
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
  await ensureBrowser(runtime, signal, timeoutMs);
  const outputDir = await mkdtemp(join(tmpdir(), 'cligent-browser-output-'));
  if (signal?.aborted) {
    await rm(outputDir, { recursive: true, force: true });
    throw new Error('Browser preparation interrupted');
  }
  const config: McpServerConfig = {
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
      outputDir,
    ],
    ...(process.versions.electron ? { env: nodeChildEnvironment() } : {}),
  };
  outputDirectories.set(config, outputDir);
  return config;
}

const outputDirectories = new WeakMap<McpServerConfig, string>();

export async function releaseBrowserServer(
  config: McpServerConfig,
): Promise<void> {
  const directory = outputDirectories.get(config);
  if (!directory) return;
  outputDirectories.delete(config);
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

export class BrowserSetupError extends Error {
  constructor(
    readonly code: BrowserSetupFailure,
    message: string,
  ) {
    super(message);
  }
}

async function ensureBrowser(
  runtime: BrowserRuntime,
  signal?: AbortSignal,
  timeoutMs = 180_000,
  progress?: BrowserSetupOptions['onProgress'],
  deadline?: number,
): Promise<void> {
  if (signal?.aborted) throw new Error('Browser preparation interrupted');
  // Feature detection keeps ordinary calls compatible with the older Node floor.
  // eslint-disable-next-line n/no-unsupported-features/node-builtins
  if (typeof URL.canParse !== 'function') {
    throw new BrowserSetupError(
      'node-runtime-unsupported',
      'The managed browser requires URL.canParse (Node 18.17+ or 20+). Upgrade Node to enable browser; ordinary Cligent calls still support Node 18.3.0.',
    );
  }
  assertBrowserHost();
  const installationKey = `${runtime.cli}\0${runtime.executablePath}`;
  if (
    !verifiedInstallations.has(installationKey) ||
    !(await executableExists(runtime.executablePath))
  ) {
    // An executable can exist while another process is still extracting it.
    // Let the pinned runtime verify its completion marker under its own
    // cross-process cache lock, rather than depending on private cache paths.
    progress?.({ stage: 'installing' });
    try {
      await runBrowserChild(
        runtime.cli,
        ['install-browser', 'chromium'],
        signal,
        timeoutMs,
        'Managed Chromium installation',
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new BrowserSetupError(
        'install-failed',
        error instanceof Error
          ? error.message
          : 'Managed browser installation failed',
      );
    }
    if (!(await executableExists(runtime.executablePath))) {
      throw new Error(
        'Managed Chromium installation did not produce its expected executable',
      );
    }
    verifiedInstallations.add(installationKey);
  }
  if (signal?.aborted) throw new Error('Browser preparation interrupted');
  progress?.({ stage: 'launching' });
  try {
    await (
      runtime.probe ?? ((abort, budget) => probeBrowser(runtime, abort, budget))
    )(
      signal,
      Math.min(
        deadline === undefined ? timeoutMs : Math.max(1, deadline - Date.now()),
        10_000,
      ),
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new BrowserSetupError(
      'launch-failed',
      `Managed Chromium could not launch and capture a screenshot. Check host browser prerequisites. ${error instanceof Error ? error.message.slice(-8192) : ''}`,
    );
  }
  signal?.throwIfAborted();
}

async function probeBrowser(
  runtime: BrowserRuntime,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!runtime.playwright)
    throw new Error('Managed Playwright runtime is unavailable');
  const directory = await mkdtemp(join(tmpdir(), 'cligent-browser-probe-'));
  const entry = join(directory, 'probe.cjs');
  // Own a process boundary: the pinned launchServer can remain pending before
  // exposing a BrowserServer handle. On cancellation, normal process.exit
  // invokes Playwright's registered synchronous browser-tree cleanup even at
  // that stage, unlike SIGKILL of an in-process or detached browser parent.
  const source = `
process.on('SIGTERM', () => process.exit(1));
process.on('SIGINT', () => process.exit(1));
const step = value => console.error(${JSON.stringify('\n' + proofStepPrefix)} + value);
const timer = setTimeout(() => { console.error(${JSON.stringify('\n' + proofDeadlineMarker)}); process.exit(1); }, ${timeoutMs});
(async () => {
  step('load-runtime');
  const { chromium } = require(${JSON.stringify(runtime.playwright)});
  let server;
  try {
    step('launch-browser');
    server = await chromium.launchServer({
      executablePath: ${JSON.stringify(runtime.executablePath)},
      headless: true, chromiumSandbox: true,
      downloadsPath: ${JSON.stringify(directory)}, host: '127.0.0.1',
      timeout: ${timeoutMs}, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
    });
    step('connect-browser');
    const browser = await chromium.connect(server.wsEndpoint(), { timeout: ${timeoutMs} });
    step('open-page');
    const page = await browser.newPage();
    step('set-content');
    await page.setContent('<!doctype html><title>Browser readiness</title><p>Ready</p>');
    step('capture-screenshot');
    const png = await page.screenshot({ type: 'png', timeout: ${timeoutMs} });
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Browser returned no PNG screenshot');
  } finally { step('dispose-browser'); await server?.kill(); }
  clearTimeout(timer);
})().then(() => process.exit(0), error => { console.error(String(error)); process.exit(1); });
`;
  try {
    await writeFile(entry, source);
    await runBrowserChild(
      entry,
      [],
      signal,
      timeoutMs,
      'Managed Chromium launch/screenshot proof',
      true,
    );
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

export async function prepareBrowserRuntime(
  options?: Pick<
    BrowserSetupOptions,
    'abortSignal' | 'timeoutMs' | 'onProgress'
  >,
  runtime?: BrowserRuntime,
): Promise<BrowserSetupResult> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  options?.abortSignal?.addEventListener('abort', abort, { once: true });
  if (options?.abortSignal?.aborted) abort();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_BROWSER_SETUP_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, timeoutMs);
  try {
    await ensureBrowser(
      runtime ?? resolveBrowserRuntime(),
      controller.signal,
      timeoutMs,
      options?.onProgress,
      deadline,
    );
    return { status: 'ready', checkedAt: Date.now() };
  } catch (error) {
    if (options?.abortSignal?.aborted) return { status: 'cancelled' };
    return {
      status: 'not-ready',
      code: timedOut
        ? 'timeout'
        : error instanceof BrowserSetupError || error instanceof CapabilityError
          ? error.code
          : 'runtime-layout-unusable',
      message: timedOut
        ? 'Managed browser setup timed out; check host prerequisites and retry'
        : error instanceof Error
          ? error.message.slice(-9000)
          : 'Managed browser setup failed',
    };
  } finally {
    clearTimeout(timer);
    options?.abortSignal?.removeEventListener('abort', abort);
  }
}
