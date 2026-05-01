#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Writable } from 'node:stream';
import { launchTmuxPlay, type LaunchTmuxPlayOptions } from './launcher.js';
import {
  runTmuxPlaySession,
  type TmuxPlaySessionOptions,
} from './session.js';

type Output = Pick<Writable, 'write'>;

export interface RunTmuxPlayCliOptions {
  readonly argv?: readonly string[];
  readonly stdout?: Output;
  readonly stderr?: Output;
  readonly selfBin?: string;
  readonly launch?: (options: LaunchTmuxPlayOptions) => Promise<unknown>;
  readonly runSession?: (options: TmuxPlaySessionOptions) => Promise<void>;
}

export async function runTmuxPlayCli(
  options: RunTmuxPlayCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const argv = options.argv ?? process.argv.slice(2);

  try {
    const { values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: {
        config: { type: 'string' },
        cwd: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        session: { type: 'string' },
        'work-dir': { type: 'string' },
      },
      strict: true,
    });

    if (values.help) {
      stdout.write(usage());
      return 0;
    }

    if (values.session) {
      validateSessionOptions(values);
      validateWorkDir(values['work-dir']);
      await (options.runSession ?? runTmuxPlaySession)({
        sessionId: values.session,
        workDir: values['work-dir'],
        cwd: values.cwd,
      });
      return 0;
    }

    if (values['work-dir']) {
      throw new Error('--work-dir is only valid with --session');
    }

    await (options.launch ?? launchTmuxPlay)({
      configPath: values.config,
      cwd: values.cwd,
      selfBin: options.selfBin ?? process.argv[1],
    });
    return 0;
  } catch (error) {
    stderr.write(`Error: ${errorMessage(error)}\n`);
    return 1;
  }
}

function validateSessionOptions(values: {
  readonly config?: string;
  readonly session?: string;
  readonly 'work-dir'?: string;
}): void {
  if (values.config) {
    throw new Error('--config is only valid in launcher mode');
  }
  if (!values['work-dir']) {
    throw new Error('--work-dir is required in session mode');
  }
}

function validateWorkDir(workDir: string | undefined): asserts workDir is string {
  if (!workDir) {
    throw new Error('--work-dir is required in session mode');
  }
  if (!existsSync(workDir) || !statSync(workDir).isDirectory()) {
    throw new Error(
      `work dir does not exist or is not a directory: ${workDir}`,
    );
  }
  try {
    accessSync(workDir, constants.W_OK | constants.X_OK);
  } catch {
    throw new Error(`work dir is not writable: ${workDir}`);
  }
}

function usage(): string {
  return [
    'Usage:',
    '  tmux-play [--config <path>] [--cwd <path>]',
    '  tmux-play --session <id> --work-dir <path> [--cwd <path>]',
    '',
  ].join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCliEntry(): boolean {
  return process.argv[1]
    ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
    : false;
}

if (isCliEntry()) {
  process.exitCode = await runTmuxPlayCli();
}
