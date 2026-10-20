// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// claude-code-91: `nativeSkills: false` crosses the installed SDK's
// serialization boundary as the parent managed-settings tier, the bundled-skill
// flag setting, and the main-thread skill list. A recording CLI fixture stands
// in for the native agent: it records each command line and each stdin
// `initialize` control request, then answers with a plain initialization that
// leaves claude-code-86's readiness check nothing to decide.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { Cligent } from '../cligent.js';
import * as mcp from '../mcp.js';
import type {
  AgentEvent,
  CligentOptions,
  DonePayload,
  ErrorPayload,
} from '../types.js';

const SESSION_ID = '0b6f2d54-9c1e-4a7b-8d3f-5e2a1c9b7d40';
const PLUGIN_PREFIX = 'cligent-claude-skills-';
const RUN_SKILLS = ['cligent:alpha', 'cligent:beta'];
const GRANTS = RUN_SKILLS.map((name) => `Skill(${name})`);
const MANAGED_SETTINGS = '{"strictPluginOnlyCustomization":["skills"]}';
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function collect(
  stream: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

// The native-CLI stand-in. Each launch appends its command line, and each
// `initialize` control request its whole request, keyed by process id.
const FIXTURE_SCRIPT = `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [recording, ...args] = process.argv.slice(2);
const record = (value) => appendFileSync(recording, JSON.stringify({ pid: process.pid, ...value }) + '\\n');
record({ args });
const init = { type: 'system', subtype: 'init', session_id: '${SESSION_ID}', model: 'fixture', tools: ['Skill'] };
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    if (message.request && message.request.subtype === 'initialize') record({ initialize: message.request });
    send({ type: 'control_response', response: {
      subtype: 'success', request_id: message.request_id, response: {}
    } });
  } else if (message.type === 'user') {
    send(init);
    send({ type: 'assistant', session_id: '${SESSION_ID}', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
    send({ type: 'result', subtype: 'success', result: 'Done', session_id: '${SESSION_ID}',
      is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, total_cost_usd: 0 });
  }
});
lines.on('close', () => process.exit(0));
`;

interface Workspace {
  /** The run cwd holding the fixture, its recording, and the skill sources. */
  root: string;
  /** The temporary directory the adapter's plugin roots go under. */
  temp: string;
  /** Run skills: a relative directory and an absolute SKILL.md path. */
  skills: string[];
  script: string;
  recording: string;
}

async function workspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), 'cligent-claude-native-skills-'));
  roots.push(root);
  const temp = join(root, 'tmp');
  await mkdir(temp);
  // os.tmpdir() reads TMPDIR on every call, so each plugin root lands here.
  vi.stubEnv('TMPDIR', temp);
  for (const name of ['alpha', 'beta']) {
    await mkdir(join(root, 'skill-sources', name), { recursive: true });
    await writeFile(
      join(root, 'skill-sources', name, 'SKILL.md'),
      [
        '---',
        `name: ${name}`,
        `description: The ${name} fixture skill.`,
        '---',
        `Reply ${name}.`,
        '',
      ].join('\n'),
    );
  }
  const script = join(root, 'claude-fixture.mjs');
  await writeFile(script, FIXTURE_SCRIPT);
  return {
    root,
    temp,
    skills: [
      'skill-sources/alpha',
      join(root, 'skill-sources', 'beta', 'SKILL.md'),
    ],
    script,
    recording: join(root, 'claude-recording.jsonl'),
  };
}

type QueryParameters = Parameters<typeof query>[0];

function fixtureAdapter(space: Workspace) {
  const loadSdk = vi.fn(async () => ({
    query(parameters: QueryParameters) {
      return query({
        ...parameters,
        options: {
          ...parameters.options,
          spawnClaudeCodeProcess: (options) =>
            spawn(
              process.execPath,
              [space.script, space.recording, ...options.args],
              {
                cwd: space.root,
                env: options.env,
                signal: options.signal,
                stdio: ['pipe', 'pipe', 'pipe'],
              },
            ),
        },
      });
    },
  }));
  const adapter = new ClaudeCodeAdapter({
    probeExecutable: () => ({ state: 'present', path: space.script }),
    loadSdk,
  });
  return { adapter, loadSdk };
}

interface Launch {
  args: string[];
  initialize: Record<string, unknown> | undefined;
}

// One launch per process, in launch order, with the initialize request that
// process received.
async function launches(space: Workspace): Promise<Launch[]> {
  if (!existsSync(space.recording)) return [];
  const records = (await readFile(space.recording, 'utf8'))
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map(
      (line) =>
        JSON.parse(line) as {
          pid: number;
          args?: string[];
          initialize?: Record<string, unknown>;
        },
    );
  const byPid = new Map<number, Launch>();
  for (const record of records) {
    if (record.args !== undefined) {
      byPid.set(record.pid, { args: record.args, initialize: undefined });
    } else if (record.initialize !== undefined) {
      const launch = byPid.get(record.pid);
      expect(launch, `initialize from unknown pid ${record.pid}`).toBeDefined();
      expect(launch!.initialize, 'a second initialize').toBeUndefined();
      launch!.initialize = record.initialize;
    }
  }
  return [...byPid.values()];
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index !== -1) return args[index + 1];
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

function hasFlag(args: string[], name: string): boolean {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function settingsOf(args: string[]): Record<string, unknown> {
  const raw = flagValue(args, '--settings');
  expect(raw, 'no --settings argument').toBeDefined();
  return JSON.parse(raw!) as Record<string, unknown>;
}

// The tool, setting-source, and plugin arguments the run's other options
// select (claude-code-9, claude-code-70, claude-code-85). A plugin root is a
// fresh directory per run, so only its flag and parent are compared.
function selectedControls(args: string[], space: Workspace) {
  const pluginFlags = args.filter((arg) => arg.startsWith('--plugin-dir'));
  const pluginRoot = flagValue(args, '--plugin-dir-no-mcp');
  return {
    tools: flagValue(args, '--tools'),
    allowedTools: flagValue(args, '--allowedTools'),
    disallowedTools: flagValue(args, '--disallowedTools'),
    settingSources: flagValue(args, '--setting-sources'),
    strictMcpConfig: args.includes('--strict-mcp-config'),
    mcpConfig: flagValue(args, '--mcp-config'),
    permissionMode: flagValue(args, '--permission-mode'),
    pluginFlags,
    pluginParent:
      pluginRoot === undefined
        ? undefined
        : dirname(pluginRoot) === space.temp
          ? 'temp'
          : pluginRoot,
  };
}

function payloads<T>(events: AgentEvent[], type: AgentEvent['type']): T[] {
  return events
    .filter((event) => event.type === type)
    .map((event) => event.payload as T);
}

async function pluginRootsIn(temp: string): Promise<string[]> {
  return (await readdir(temp)).filter((name) => name.startsWith(PLUGIN_PREFIX));
}

type ToolOptions = Pick<CligentOptions, 'allowedTools'>;

interface Cell {
  label: string;
  withSkills: boolean;
  tools: ToolOptions;
}

const CELLS: Cell[] = [
  { label: 'run skills, allowedTools omitted', withSkills: true, tools: {} },
  {
    label: 'no run skills, allowedTools omitted',
    withSkills: false,
    tools: {},
  },
  {
    label: 'no run skills, empty allowedTools',
    withSkills: false,
    tools: { allowedTools: [] },
  },
];

// The tool and setting-source arguments claude-code-9 selects for each cell.
function expectedControls(cell: Cell) {
  const empty = cell.tools.allowedTools?.length === 0;
  return {
    tools: empty ? '' : undefined,
    allowedTools: cell.withSkills ? GRANTS.join(',') : undefined,
    settingSources: empty ? '' : undefined,
    strictMcpConfig: true,
    pluginFlags: cell.withSkills ? ['--plugin-dir-no-mcp'] : [],
    pluginParent: cell.withSkills ? 'temp' : undefined,
  };
}

describe('Claude nativeSkills through the installed SDK (claude-code-91)', () => {
  it.each(CELLS)(
    'carries the managed policy, bundled-skill flag, and skill list only when false: $label',
    async (cell) => {
      const space = await workspace();
      const { adapter } = fixtureAdapter(space);
      const shared: Pick<
        CligentOptions,
        'cwd' | 'allowedTools' | 'skills' | 'nativeSkills'
      > = {
        cwd: space.root,
        ...cell.tools,
        ...(cell.withSkills ? { skills: space.skills } : {}),
      };
      const variants = [
        { label: 'false', options: { ...shared, nativeSkills: false } },
        { label: 'omitted', options: shared },
      ];
      for (const variant of variants) {
        const client = new Cligent(adapter, variant.options);
        for (const prompt of ['Fresh turn.', 'Resumed turn.']) {
          const events = await collect(client.run(prompt));
          expect(
            events.at(-1),
            `${variant.label}: ${JSON.stringify(payloads(events, 'error'))}`,
          ).toMatchObject({
            type: 'done',
            payload: { status: 'success', resumeToken: SESSION_ID },
          });
        }
      }

      const recorded = await launches(space);
      expect(recorded).toHaveLength(4);
      const [offFresh, offResumed, onFresh, onResumed] = recorded as [
        Launch,
        Launch,
        Launch,
        Launch,
      ];
      for (const fresh of [offFresh, onFresh]) {
        expect(hasFlag(fresh.args, '--resume')).toBe(false);
      }
      for (const resumed of [offResumed, onResumed]) {
        expect(resumed.args).toContain(`--resume=${SESSION_ID}`);
      }

      const expectedSkills = cell.withSkills ? RUN_SKILLS : [];
      for (const [index, off] of [offFresh, offResumed].entries()) {
        const on = [onFresh, onResumed][index]!;
        const turn = index === 0 ? 'fresh' : 'resumed';

        // The parent policy tier, exactly as claude-code-90 states it.
        expect(
          off.args.filter((arg) => arg.startsWith('--managed-settings')),
          turn,
        ).toEqual(['--managed-settings']);
        expect(flagValue(off.args, '--managed-settings'), turn).toBe(
          MANAGED_SETTINGS,
        );

        // The bundled-skill flag sits beside the connector gate and the
        // attribution object, adding only its own key.
        const offSettings = settingsOf(off.args);
        const onSettings = settingsOf(on.args);
        expect(offSettings, turn).toEqual({
          disableClaudeAiConnectors: true,
          attribution: { commit: '', pr: '', sessionUrl: false },
          disableBundledSkills: true,
        });
        expect(offSettings, turn).toEqual({
          ...onSettings,
          disableBundledSkills: true,
        });

        // The main-thread skill list: the run's skills in list order, or
        // an empty list.
        expect(off.initialize, turn).toBeDefined();
        expect(off.initialize!.skills, turn).toEqual(expectedSkills);

        // An omitted switch carries neither flag key nor a skills member.
        expect(hasFlag(on.args, '--managed-settings'), turn).toBe(false);
        expect(Object.keys(onSettings), turn).not.toContain(
          'disableBundledSkills',
        );
        expect(onSettings, turn).toEqual({
          disableClaudeAiConnectors: true,
          attribution: { commit: '', pr: '', sessionUrl: false },
        });
        expect(on.initialize, turn).toBeDefined();
        expect(Object.keys(on.initialize!), turn).not.toContain('skills');

        // Both keep the tool, setting-source, and plugin arguments their
        // other options select.
        expect(selectedControls(off.args, space), turn).toEqual(
          selectedControls(on.args, space),
        );
        expect(selectedControls(off.args, space), turn).toMatchObject(
          expectedControls(cell),
        );
      }
    },
  );

  // claude-code-85: run skills with an empty allowedTools reject before SDK
  // loading whether or not the switch is set, so no command line exists.
  it.each([
    { label: 'false', nativeSkills: false as const },
    { label: 'omitted', nativeSkills: undefined },
  ])(
    'rejects run skills with an empty allowedTools before spawning: nativeSkills $label',
    async ({ nativeSkills }) => {
      const space = await workspace();
      const prepare = vi.spyOn(mcp, 'prepareMcpServers');
      const { adapter, loadSdk } = fixtureAdapter(space);
      const client = new Cligent(adapter, {
        cwd: space.root,
        skills: space.skills,
        allowedTools: [],
        ...(nativeSkills !== undefined ? { nativeSkills } : {}),
      });
      for (const prompt of ['Fresh turn.', 'Again.']) {
        const events = await collect(client.run(prompt));
        expect(events.map((event) => event.type)).toEqual(['error', 'done']);
        const message = payloads<ErrorPayload>(events, 'error')[0]!.message;
        expect(message).toMatch(/cannot combine skills with/);
        expect(message).toMatch(/an empty allowedTools/);
        expect(payloads<DonePayload>(events, 'done')[0]!.status).toBe('error');
      }
      expect(prepare).not.toHaveBeenCalled();
      expect(loadSdk).not.toHaveBeenCalled();
      expect(await launches(space)).toEqual([]);
      expect(await pluginRootsIn(space.temp)).toEqual([]);
    },
  );

  // skills-10 / claude-code-90: a defined non-boolean value is rejected on the
  // built-in adapter before any provider work, naming the option.
  it.each<{ label: string; value: unknown; withSkills: boolean }>([
    { label: "'false' with run skills", value: 'false', withSkills: true },
    { label: "'false' without run skills", value: 'false', withSkills: false },
    { label: '0 without run skills', value: 0, withSkills: false },
  ])(
    'rejects a malformed nativeSkills value before spawning: $label',
    async ({ value, withSkills }) => {
      const space = await workspace();
      const prepare = vi.spyOn(mcp, 'prepareMcpServers');
      const { adapter, loadSdk } = fixtureAdapter(space);
      const events = await collect(
        new Cligent(adapter, {
          cwd: space.root,
          ...(withSkills ? { skills: space.skills } : {}),
          nativeSkills: value as boolean,
        }).run('Fresh turn.'),
      );
      expect(events.map((event) => event.type)).toEqual(['error', 'done']);
      const message = payloads<ErrorPayload>(events, 'error')[0]!.message;
      expect(message).toMatch(/nativeSkills/);
      expect(message).toMatch(/must be a boolean/);
      expect(payloads<DonePayload>(events, 'done')[0]!.status).toBe('error');
      expect(prepare).not.toHaveBeenCalled();
      expect(loadSdk).not.toHaveBeenCalled();
      expect(await launches(space)).toEqual([]);
      expect(await pluginRootsIn(space.temp)).toEqual([]);
    },
  );
});
