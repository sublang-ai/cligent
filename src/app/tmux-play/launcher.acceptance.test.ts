// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isTmuxAvailable } from '../shared/tmux.js';
import { launchTmuxPlay } from './launcher.js';

interface PaneRow {
  readonly index: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly inputOff: string;
}

const TMUX_AVAILABLE = isTmuxAvailable();
const acceptanceIt = TMUX_AVAILABLE ? it : it.skip;

const BUILT_CLI_PATH = join(
  process.cwd(),
  'dist/app/tmux-play/cli.js',
);

describe('tmux-play real-tmux acceptance', () => {
  let sessionName: string | undefined;
  let workDir: string | undefined;
  let cwd: string | undefined;

  afterEach(() => {
    if (sessionName) {
      spawnSync('tmux', ['kill-session', '-t', sessionName], {
        stdio: 'ignore',
      });
      sessionName = undefined;
    }
    for (const dir of [workDir, cwd]) {
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    workDir = undefined;
    cwd = undefined;
  });

  acceptanceIt(
    'creates a 240x67 session with 60/90/90 panes, titled, role panes read-only',
    async () => {
      if (!existsSync(BUILT_CLI_PATH)) {
        throw new Error(
          `Missing ${BUILT_CLI_PATH}; run \`npm run build\` before the acceptance suite.`,
        );
      }

      cwd = mkdtempSync(join(tmpdir(), 'tmux-play-accept-cwd-'));
      workDir = mkdtempSync(join(tmpdir(), 'tmux-play-accept-work-'));
      const configPath = join(cwd, 'tmux-play.config.yaml');
      writeFileSync(configPath, defaultYamlConfig());

      const result = await launchTmuxPlay({
        cwd,
        configPath,
        sessionId: `accept-${randomBytes(4).toString('hex')}`,
        workDir,
        selfBin: BUILT_CLI_PATH,
        attach: false,
      });
      sessionName = result.sessionName;

      // TTMUX-030: 240x67 grid
      expect(displayMessage(sessionName, '#{window_width}x#{window_height}'))
        .toBe('240x67');

      const panes = listPanes(sessionName);
      expect(panes).toHaveLength(3);

      const captain = paneByTitle(panes, 'Captain');
      const coder = paneByTitle(panes, 'Coder');
      const reviewer = paneByTitle(panes, 'Reviewer');

      // TTMUX-031: layout — 60/90/90 columns within tmux's border accounting.
      // Two 1-cell separators eat 1 col from coder (border with captain) and
      // 1 col from reviewer (border with coder). pane_left advances by the
      // pane width plus its right-side border, so reviewer.left is 60+90=150.
      expect(captain.left).toBe(0);
      expect(captain.width).toBe(59);
      expect(coder.left).toBe(60);
      expect(coder.width).toBe(89);
      expect(reviewer.left).toBe(150);
      expect(reviewer.width).toBe(90);

      // TTMUX-032: pane titles
      expect(captain.title).toBe('Captain');
      expect(coder.title).toBe('Coder');
      expect(reviewer.title).toBe('Reviewer');

      // TTMUX-033: role panes read-only, captain pane writable
      expect(captain.inputOff).toBe('0');
      expect(coder.inputOff).toBe('1');
      expect(reviewer.inputOff).toBe('1');

      const probe = `probe-${randomBytes(4).toString('hex')}`;
      const sendResult = spawnSync(
        'tmux',
        [
          'send-keys',
          '-t',
          `${sessionName}:0.${coder.index}`,
          probe,
        ],
        { stdio: 'ignore' },
      );
      expect(sendResult.status).toBe(0);

      const capture = capturePane(sessionName, coder.index);
      expect(capture).not.toContain(probe);
    },
    60_000,
  );
});

function defaultYamlConfig(): string {
  return [
    'captain:',
    "  from: '@sublang/cligent/captains/fanout'",
    '  adapter: claude',
    '  options:',
    '    maxRoleOutputChars: 4000',
    'roles:',
    '  - id: coder',
    '    adapter: codex',
    '  - id: reviewer',
    '    adapter: claude',
    '',
  ].join('\n');
}

function displayMessage(session: string, format: string): string {
  const result = spawnSync(
    'tmux',
    ['display-message', '-t', session, '-p', format],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `tmux display-message failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

// tmux 3.6 substitutes tab with `_` in -F output, so use `|` as the field
// separator. Pane titles cannot contain `|` because tmux-play sets them from
// `Captain` and config role ids (validated by the schema).
const FIELD_SEP = '|';

function listPanes(session: string): readonly PaneRow[] {
  const format = [
    '#{pane_index}',
    '#{pane_left}',
    '#{pane_top}',
    '#{pane_width}',
    '#{pane_height}',
    '#{pane_title}',
    '#{pane_input_off}',
  ].join(FIELD_SEP);
  const result = spawnSync(
    'tmux',
    ['list-panes', '-t', session, '-F', format],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`tmux list-panes failed: ${result.stderr.trim()}`);
  }
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line): PaneRow => {
      const [
        index,
        left,
        top,
        width,
        height,
        title,
        inputOff,
      ] = line.split(FIELD_SEP);
      return {
        index: Number(index),
        left: Number(left),
        top: Number(top),
        width: Number(width),
        height: Number(height),
        title: title ?? '',
        inputOff: inputOff ?? '',
      };
    });
}

function paneByTitle(panes: readonly PaneRow[], title: string): PaneRow {
  const found = panes.find((pane) => pane.title === title);
  if (!found) {
    const titles = panes.map((pane) => pane.title).join(', ');
    throw new Error(`No pane titled ${title}; saw ${titles}`);
  }
  return found;
}

function capturePane(session: string, paneIndex: number): string {
  const result = spawnSync(
    'tmux',
    ['capture-pane', '-t', `${session}:0.${paneIndex}`, '-p'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`tmux capture-pane failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}
