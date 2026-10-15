// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// claude-code-87: run skills cross the installed SDK's serialization
// boundary as one run-private local plugin. A recording CLI fixture stands in
// for the native agent: it records each command line and the plugin root's
// layout at launch, then answers with the initialization a mode selects.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
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
import * as skillsModule from '../skills.js';
import type {
  AgentEvent,
  CligentOptions,
  DonePayload,
  ErrorPayload,
  PermissionPolicy,
} from '../types.js';

const SESSION_ID = '6d1f0c3e-2b7a-4c59-8e14-0a9b3f7d5c21';
// A parent directory's mode does not stop the superuser or Windows removing
// its entries, so forced removal failures run only where it does.
const permissionsUnenforced =
  process.platform === 'win32' || process.getuid?.() === 0;
const PLUGIN_PREFIX = 'cligent-claude-skills-';
const GRANTS = ['Skill(cligent:alpha)', 'Skill(cligent:beta)'];
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

interface PluginEntry {
  path: string;
  mode?: number;
  content?: string;
  link?: string;
}

interface Launch {
  args: string[];
  plugin?: {
    root: string;
    mode: number;
    entries: PluginEntry[];
  };
}

type FixtureMode =
  | 'ok'
  | 'ok-real'
  | 'silent'
  | 'unrelated-error'
  | 'absent'
  | 'plugins-object'
  | 'error-path'
  | 'error-message'
  | 'missing-skill'
  | 'skills-string'
  | 'managed'
  | 'hang';

// The native-CLI stand-in. `managed` plays a managed `disableSideloadFlags`
// that makes the CLI refuse the plugin flag at start; `hang` streams one
// assistant message and never sends a result. With CLIGENT_FIXTURE_EXIT set,
// the process lingers about 1.2 s after its input closes or it receives
// SIGTERM, then records whether the plugin root still exists and exits.
const FIXTURE_SCRIPT = `
import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
const [recording, mode, ...args] = process.argv.slice(2);
const flag = args.indexOf('--plugin-dir-no-mcp');
const plugin = flag === -1 ? undefined : args[flag + 1];
const walk = (dir) => readdirSync(dir).sort().flatMap((name) => {
  const path = join(dir, name);
  const stats = lstatSync(path);
  const rel = relative(plugin, path);
  if (stats.isSymbolicLink()) return [{ path: rel, link: readlinkSync(path) }];
  if (stats.isDirectory()) return [{ path: rel + '/' }, ...walk(path)];
  return [{ path: rel, mode: stats.mode & 0o777, content: readFileSync(path, 'utf8') }];
});
appendFileSync(recording, JSON.stringify({ args, plugin: plugin && {
  root: plugin, mode: statSync(plugin).mode & 0o777, entries: walk(plugin),
} }) + '\\n');
if (mode === 'managed' && plugin !== undefined) {
  process.stderr.write('--plugin-dir-no-mcp is disabled by managed settings (disableSideloadFlags)\\n');
  process.exit(1);
}
const skills = plugin ? readdirSync(join(plugin, 'skills')).sort().map((name) => 'cligent:' + name) : [];
const loaded = [{ name: 'cligent', path: plugin }, { name: 'telemetry', path: 'builtin' }];
const init = { type: 'system', subtype: 'init', session_id: '${SESSION_ID}', model: 'fixture', tools: ['Skill'] };
if (mode === 'ok' || mode === 'hang' || mode === 'managed') Object.assign(init, { plugins: loaded, skills: ['builtin-skill', ...skills] });
if (mode === 'ok-real') Object.assign(init, { plugins: [{ name: 'cligent', path: plugin && realpathSync(plugin) }], skills });
if (mode === 'unrelated-error') Object.assign(init, { plugins: loaded, skills, plugin_errors: [
  { plugin: 'other@market', type: 'generic-error', message: 'Other plugin failed', path: '/elsewhere' },
] });
if (mode === 'absent') Object.assign(init, { plugins: [{ name: 'telemetry', path: 'builtin' }], skills });
if (mode === 'plugins-object') Object.assign(init, { plugins: { cligent: { name: 'cligent', path: plugin } }, skills });
if (mode === 'error-path') Object.assign(init, { plugins: loaded, skills, plugin_errors: [
  { plugin: 'cligent@inline', type: 'hook-load-failed', message: 'Hooks failed to load', path: plugin },
] });
if (mode === 'error-message') Object.assign(init, { plugins: loaded, skills, plugin_errors: [
  { plugin: 'inline[0]', type: 'generic-error', message: 'Cannot read ' + plugin + '/skills' },
] });
if (mode === 'missing-skill') Object.assign(init, { plugins: loaded, skills: skills.slice(1) });
if (mode === 'skills-string') Object.assign(init, { plugins: loaded, skills: skills.join(',') });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    send({ type: 'control_response', response: {
      subtype: 'success', request_id: message.request_id, response: {}
    } });
  } else if (message.type === 'user') {
    send(init);
    send({ type: 'assistant', session_id: '${SESSION_ID}', message: { role: 'assistant', content: [{ type: 'text', text: 'Using the skill.' }] } });
    if (mode === 'hang') return;
    send({ type: 'result', subtype: 'success', result: 'Skill used', session_id: '${SESSION_ID}',
      is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, total_cost_usd: 0 });
  }
});
const exitRecording = process.env.CLIGENT_FIXTURE_EXIT;
let exiting = false;
const finish = () => {
  if (exitRecording === undefined) process.exit(0);
  if (exiting) return;
  exiting = true;
  setTimeout(() => {
    appendFileSync(exitRecording, JSON.stringify({ rootExists: plugin !== undefined && existsSync(plugin) }) + '\\n');
    process.exit(0);
  }, 1200);
};
if (exitRecording !== undefined) process.on('SIGTERM', finish);
lines.on('close', finish);
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

const ALPHA_SKILL = [
  '---',
  'name: alpha',
  'description: Echoes a fixed greeting.',
  'allowed-tools: Bash(echo *)',
  '---',
  'Run `echo alpha` and reply with its output.',
  '',
].join('\n');
const BETA_SKILL = [
  '---',
  'name: beta',
  'description: Runs the bundled script.',
  '---',
  'Run scripts/run.sh and reply with its output.',
  '',
].join('\n');
const BETA_SCRIPT = '#!/bin/sh\necho beta\n';

async function workspace(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), 'cligent-claude-skills-it-'));
  roots.push(root);
  const temp = join(root, 'tmp');
  await mkdir(temp);
  // os.tmpdir() reads TMPDIR on every call, so each plugin root lands here.
  vi.stubEnv('TMPDIR', temp);
  await mkdir(join(root, 'skill-sources', 'alpha'), { recursive: true });
  await writeFile(
    join(root, 'skill-sources', 'alpha', 'SKILL.md'),
    ALPHA_SKILL,
  );
  await mkdir(join(root, 'skill-sources', 'beta', 'scripts'), {
    recursive: true,
  });
  await writeFile(join(root, 'skill-sources', 'beta', 'SKILL.md'), BETA_SKILL);
  const betaScript = join(root, 'skill-sources', 'beta', 'scripts', 'run.sh');
  await writeFile(betaScript, BETA_SCRIPT);
  await chmod(betaScript, 0o755);
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
type ToolOptions = Pick<
  CligentOptions,
  'allowedTools' | 'disallowedTools' | 'mcpServers' | 'browser'
>;

function fixtureAdapter(
  space: Workspace,
  mode: FixtureMode,
  linger?: { exitRecording: string },
) {
  const queries: Array<NonNullable<QueryParameters['options']>> = [];
  const loadSdk = vi.fn(async () => ({
    query(parameters: QueryParameters) {
      queries.push({ ...parameters.options });
      return query({
        ...parameters,
        options: {
          ...parameters.options,
          // A lingering process is spawned without the abort signal, as a
          // custom spawner may be, so only the SDK's own cleanup, which closes
          // its input and waits for its exit, ends it.
          spawnClaudeCodeProcess: (options) =>
            spawn(
              process.execPath,
              [space.script, space.recording, mode, ...options.args],
              {
                cwd: space.root,
                env:
                  linger === undefined
                    ? options.env
                    : {
                        ...options.env,
                        CLIGENT_FIXTURE_EXIT: linger.exitRecording,
                      },
                ...(linger === undefined ? { signal: options.signal } : {}),
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
  return { adapter, loadSdk, queries };
}

async function launches(space: Workspace): Promise<Launch[]> {
  const text = existsSync(space.recording)
    ? await readFile(space.recording, 'utf8')
    : '';
  return text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Launch);
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index !== -1) return args[index + 1];
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

// Every native control a skill must leave as the run's tool list and
// permission policy select (claude-code-85).
function nativeControls(args: string[]) {
  return {
    tools: flagValue(args, '--tools'),
    settingSources: flagValue(args, '--setting-sources'),
    permissionMode: flagValue(args, '--permission-mode'),
    permissionPromptTool: flagValue(args, '--permission-prompt-tool'),
    skipPermissions: args.includes('--allow-dangerously-skip-permissions'),
    strictMcpConfig: args.includes('--strict-mcp-config'),
    disallowedTools: flagValue(args, '--disallowedTools'),
    settings: flagValue(args, '--settings'),
    mcpConfig: flagValue(args, '--mcp-config'),
  };
}

async function pluginRootsIn(temp: string): Promise<string[]> {
  return (await readdir(temp)).filter((name) => name.startsWith(PLUGIN_PREFIX));
}

// claude-code-89: removal follows the terminal once the SDK query settled,
// and Cligent does not wait for the adapter's return() after `done`.
async function expectRemoved(space: Workspace, paths: string[]) {
  await vi.waitFor(
    async () => {
      for (const path of paths) expect(existsSync(path)).toBe(false);
      expect(await pluginRootsIn(space.temp)).toEqual([]);
    },
    { timeout: 5_000, interval: 20 },
  );
}

function expectedLayout(): PluginEntry[] {
  return [
    { path: '.claude-plugin/' },
    {
      path: '.claude-plugin/plugin.json',
      mode: expect.any(Number) as unknown as number,
      content: '{"name":"cligent"}',
    },
    { path: 'skills/' },
    { path: 'skills/alpha/' },
    {
      path: 'skills/alpha/SKILL.md',
      mode: expect.any(Number) as unknown as number,
      content: ALPHA_SKILL,
    },
    { path: 'skills/beta/' },
    {
      path: 'skills/beta/SKILL.md',
      mode: expect.any(Number) as unknown as number,
      content: BETA_SKILL,
    },
    { path: 'skills/beta/scripts/' },
    { path: 'skills/beta/scripts/run.sh', mode: 0o755, content: BETA_SCRIPT },
  ];
}

function payloads<T>(events: AgentEvent[], type: AgentEvent['type']): T[] {
  return events
    .filter((event) => event.type === type)
    .map((event) => event.payload as T);
}

describe('Claude run skills through the installed SDK', () => {
  // claude-code-87: the plugin root, its `plugins` entry, the grants under
  // each admitted tool list on fresh and resumed turns, and every other
  // native control unchanged from the same run without skills.
  it('delivers one private plugin with grants and leaves every other control unchanged', async () => {
    const toolLists: Array<{
      label: string;
      options: ToolOptions;
      base: string[] | undefined;
    }> = [
      { label: 'omitted', options: {}, base: undefined },
      {
        label: 'Skill-bearing',
        options: { allowedTools: ['Read', 'Skill'] },
        base: ['Read', 'Skill'],
      },
      {
        label: 'MCP servers',
        options: {
          mcpServers: { docs: { type: 'stdio', command: 'node' } },
        },
        base: ['mcp__docs__*'],
      },
    ];
    const policies: Array<PermissionPolicy | undefined> = [
      undefined,
      { fileWrite: 'deny', shellExecute: 'allow' },
    ];

    for (const toolList of toolLists) {
      for (const permissions of policies) {
        const space = await workspace();
        const { adapter, queries } = fixtureAdapter(space, 'ok');
        const shared = {
          cwd: space.root,
          ...toolList.options,
          ...(permissions !== undefined ? { permissions } : {}),
        };
        const client = new Cligent(adapter, {
          ...shared,
          skills: space.skills,
        });
        for (const prompt of ['Use alpha.', 'Use beta.']) {
          const events = await collect(client.run(prompt));
          expect(
            events.at(-1),
            `${toolList.label}: ${JSON.stringify(payloads(events, 'error'))}`,
          ).toMatchObject({
            type: 'done',
            payload: { status: 'success', resumeToken: SESSION_ID },
          });
        }
        await collect(new Cligent(adapter, shared).run('No skills.'));

        const [fresh, resumed, baseline] = await launches(space);
        expect(fresh!.args.some((arg) => arg.startsWith('--resume'))).toBe(
          false,
        );
        expect(resumed!.args).toContain(`--resume=${SESSION_ID}`);

        const pluginRoots: string[] = [];
        for (const [index, launch] of [fresh!, resumed!].entries()) {
          // Exactly one local plugin, MCP discovery skipped (claude-code-70).
          expect(
            launch.args.filter((arg) => arg.startsWith('--plugin-dir')),
          ).toEqual(['--plugin-dir-no-mcp']);
          const plugin = launch.plugin!;
          pluginRoots.push(plugin.root);
          expect(queries[index]!.plugins).toEqual([
            { type: 'local', path: plugin.root, skipMcpDiscovery: true },
          ]);
          // A new private temporary directory per run (claude-code-85).
          expect(dirname(plugin.root)).toBe(space.temp);
          expect(plugin.mode).toBe(0o700);
          expect(plugin.entries).toEqual(expectedLayout());
          // claude-code-9: grants follow the MCP grants or the caller's
          // entries, and populate an omitted list.
          expect(flagValue(launch.args, '--allowedTools')).toBe(
            [...(toolList.base ?? []), ...GRANTS].join(','),
          );
          expect(queries[index]!.allowedTools).toEqual([
            ...(toolList.base ?? []),
            ...GRANTS,
          ]);
          expect(nativeControls(launch.args)).toEqual(
            nativeControls(baseline!.args),
          );
          expect(queries[index]!.settingSources).toBe(
            queries[2]!.settingSources,
          );
          expect(queries[index]!.tools).toEqual(queries[2]!.tools);
          expect(queries[index]!.permissionMode).toBe(
            queries[2]!.permissionMode,
          );
          expect(typeof queries[index]!.canUseTool).toBe(
            typeof queries[2]!.canUseTool,
          );
        }
        expect(pluginRoots[0]).not.toBe(pluginRoots[1]);
        expect(baseline!.plugin).toBeUndefined();
        expect(queries[2]!.plugins).toBeUndefined();
        expect(flagValue(baseline!.args, '--allowedTools')).toBe(
          toolList.base?.join(','),
        );
        // The mixed policy keeps its callback, the absent one its default.
        expect(typeof queries[0]!.canUseTool).toBe(
          permissions === undefined ? 'undefined' : 'function',
        );
        await expectRemoved(space, pluginRoots);
      }
    }
  });

  // claude-code-87: every tool restriction that would hide the Skill tool is
  // rejected before browser preparation or SDK loading, leaving no plugin.
  it('rejects tool lists that exclude the Skill tool before browser preparation or SDK loading', async () => {
    const cases: Array<{
      options: ToolOptions;
      conflict: RegExp;
    }> = [
      { options: { allowedTools: [] }, conflict: /an empty allowedTools/ },
      {
        options: { allowedTools: ['Read', 'Bash'] },
        conflict: /an allowedTools without Skill/,
      },
      {
        options: { disallowedTools: ['Skill'], browser: true },
        conflict: /the disallowedTools entry Skill:/,
      },
      {
        options: { disallowedTools: ['Read', 'Skill(cligent:alpha)'] },
        conflict: /the disallowedTools entry Skill\(cligent:alpha\):/,
      },
      {
        options: { disallowedTools: ['Skill(cligent:*)'] },
        conflict: /the disallowedTools entry Skill\(cligent:\*\):/,
      },
    ];
    for (const { options, conflict } of cases) {
      const space = await workspace();
      const prepare = vi.spyOn(mcp, 'prepareMcpServers');
      const { adapter, loadSdk } = fixtureAdapter(space, 'ok');
      const events = await collect(
        new Cligent(adapter, {
          cwd: space.root,
          skills: space.skills,
          ...options,
        }).run('Use alpha.'),
      );
      expect(events.map((event) => event.type)).toEqual(['error', 'done']);
      const message = payloads<ErrorPayload>(events, 'error')[0]!.message;
      expect(message).toMatch(/cannot combine skills with/);
      expect(message).toMatch(conflict);
      expect(message).toMatch(/the Skill tool must stay available/);
      expect(payloads<DonePayload>(events, 'done')[0]!.status).toBe('error');
      expect(prepare).not.toHaveBeenCalled();
      expect(loadSdk).not.toHaveBeenCalled();
      expect(await pluginRootsIn(space.temp)).toEqual([]);
      prepare.mockRestore();
    }
  });

  // claude-code-85: a Skill rule that covers no run skill restricts nothing
  // the run needs, so it reaches the SDK unchanged.
  it('admits Skill rules that cover no run skill', async () => {
    const space = await workspace();
    const { adapter, loadSdk } = fixtureAdapter(space, 'ok');
    const denied = ['Skill(other:thing)', 'Skill(cligent:gamma)'];
    const events = await collect(
      new Cligent(adapter, {
        cwd: space.root,
        skills: space.skills,
        disallowedTools: denied,
      }).run('Use alpha.'),
    );
    expect(events.at(-1)?.payload).toMatchObject({ status: 'success' });
    expect(loadSdk).toHaveBeenCalledTimes(1);
    const [launch] = await launches(space);
    expect(flagValue(launch!.args, '--disallowedTools')).toBe(
      [...denied, 'AskUserQuestion'].join(','),
    );
    expect(flagValue(launch!.args, '--allowedTools')).toBe(GRANTS.join(','));
    await expectRemoved(space, [launch!.plugin!.root]);
  });

  // claude-code-86: the first initialization decides readiness; omitted or
  // unrelated evidence preserves the run.
  it.each<FixtureMode>(['ok', 'ok-real', 'silent', 'unrelated-error'])(
    'preserves the run when initialization %s shows no failure',
    async (mode) => {
      const space = await workspace();
      const { adapter } = fixtureAdapter(space, mode);
      const events = await collect(
        new Cligent(adapter, { cwd: space.root, skills: space.skills }).run(
          'Use alpha.',
        ),
      );
      expect(events.map((event) => event.type)).toEqual([
        'init',
        'text',
        'done',
      ]);
      expect(payloads<DonePayload>(events, 'done')[0]).toMatchObject({
        status: 'success',
        result: 'Skill used',
      });
      const [launch] = await launches(space);
      await expectRemoved(space, [launch!.plugin!.root]);
    },
  );

  // A present member that is not an array holds no matching entry.
  it.each<[FixtureMode, (root: string) => RegExp[]]>([
    ['absent', () => [/no loaded plugin has that path/]],
    ['plugins-object', () => [/no loaded plugin has that path/]],
    [
      'error-path',
      () => [/plugin error hook-load-failed: Hooks failed to load/],
    ],
    ['error-message', (root) => [new RegExp(`Cannot read ${root}/skills`)]],
    ['missing-skill', () => [/missing skills cligent:alpha(?!,)/]],
    ['skills-string', () => [/missing skills cligent:alpha, cligent:beta/]],
  ])('fails the run when initialization reports %s', async (mode, details) => {
    const space = await workspace();
    const { adapter } = fixtureAdapter(space, mode);
    // A live caller signal must not turn the failure into an interruption.
    const controller = new AbortController();
    const events = await collect(
      new Cligent(adapter, { cwd: space.root, skills: space.skills }).run(
        'Use alpha.',
        { abortSignal: controller.signal },
      ),
    );
    expect(events.map((event) => event.type)).toEqual([
      'init',
      'error',
      'done',
    ]);
    const [launch] = await launches(space);
    const root = launch!.plugin!.root;
    const error = payloads<ErrorPayload>(events, 'error')[0]!;
    expect(error).toMatchObject({
      code: 'SDK_STREAM_ERROR',
      recoverable: false,
    });
    expect(error.message).toContain(`Claude skills plugin ${root}`);
    for (const detail of details(root)) expect(error.message).toMatch(detail);
    expect(error.message).toContain(
      'Check the skill directories and native plugin policy',
    );
    if (mode !== 'skills-string') {
      expect(error.message).not.toContain('cligent:beta');
    }
    expect(payloads<DonePayload>(events, 'done')[0]).toMatchObject({
      status: 'error',
      usage: { toolUses: 0 },
    });
    expect(payloads<DonePayload>(events, 'done')[0]!.result).toBeUndefined();
    await expectRemoved(space, [root]);
  });

  // claude-code-87: a managed `disableSideloadFlags` refuses the plugin flag,
  // so the run fails at start through the SDK failure path.
  it('fails at start under managed settings that reject the plugin flag', async () => {
    const space = await workspace();
    const { adapter } = fixtureAdapter(space, 'managed');
    const events = await collect(
      new Cligent(adapter, { cwd: space.root, skills: space.skills }).run(
        'Use alpha.',
      ),
    );
    expect(events.map((event) => event.type)).toEqual(['error', 'done']);
    expect(payloads<ErrorPayload>(events, 'error')[0]).toMatchObject({
      code: 'SDK_STREAM_ERROR',
      message: expect.stringMatching(/exited with code 1/),
      recoverable: false,
    });
    expect(payloads<DonePayload>(events, 'done')[0]!.status).toBe('error');
    const [launch] = await launches(space);
    expect(launch!.args).toContain('--plugin-dir-no-mcp');
    const root = flagValue(launch!.args, '--plugin-dir-no-mcp')!;
    await expectRemoved(space, [root]);

    // The same fixture admits a run without the plugin flag.
    const plain = await collect(
      new Cligent(adapter, { cwd: space.root }).run('No skills.'),
    );
    expect(plain.at(-1)?.payload).toMatchObject({ status: 'success' });
  });

  // claude-code-73 / claude-code-89: cancellation during skill preparation
  // ends with the interrupted terminal, never loads the SDK, and removes the
  // plugin root before that terminal.
  it('removes the plugin root and ends interrupted when cancelled during preparation', async () => {
    const space = await workspace();
    const { adapter, loadSdk } = fixtureAdapter(space, 'ok');
    const client = new Cligent(adapter, {
      cwd: space.root,
      skills: space.skills,
    });
    const first = await collect(client.run('Use alpha.'));
    expect(first.at(-1)?.payload).toMatchObject({
      status: 'success',
      resumeToken: SESSION_ID,
    });
    expect(loadSdk).toHaveBeenCalledTimes(1);

    // The shared materialization itself observes the fired signal, leaving
    // a partly filled root (the manifest and an empty skills directory)
    // whose staging directory it removes.
    const controller = new AbortController();
    const materialized: string[] = [];
    const thrown: unknown[] = [];
    const original = skillsModule.materializeSkills;
    vi.spyOn(skillsModule, 'materializeSkills').mockImplementation(
      async (skills, options) => {
        materialized.push(dirname(options.root));
        controller.abort();
        try {
          return await original(skills, options);
        } catch (error) {
          thrown.push(error);
          throw error;
        }
      },
    );
    const events: AgentEvent[] = [];
    let rootAtDone: boolean | undefined;
    for await (const event of client.run('Use beta.', {
      abortSignal: controller.signal,
    })) {
      events.push(event);
      // Removed before the terminal leaves the adapter: no wait.
      if (event.type === 'done') rootAtDone = existsSync(materialized[0]!);
    }
    expect(thrown).toHaveLength(1);
    expect((thrown[0] as Error).name).toBe('AbortError');
    expect(events.map((event) => event.type)).toEqual(['done']);
    expect(rootAtDone).toBe(false);
    const done = payloads<DonePayload>(events, 'done')[0]!;
    expect(done).toMatchObject({
      status: 'interrupted',
      resumeToken: SESSION_ID,
      usage: { toolUses: 0 },
    });
    expect(typeof done.durationMs).toBe('number');
    expect(done.durationMs).toBeGreaterThanOrEqual(0);
    expect(done.result).toBeUndefined();
    expect(done.usage.tokens).toBeUndefined();
    expect(loadSdk).toHaveBeenCalledTimes(1);
    expect(materialized).toHaveLength(1);
    // The first run's root goes after its terminal, which Cligent does not
    // wait for.
    await expectRemoved(space, materialized);
  });

  // claude-code-89: a mid-stream abort removes the root after the
  // interrupted terminal (claude-code-48).
  it('removes the plugin root after a mid-stream abort', async () => {
    const space = await workspace();
    const { adapter } = fixtureAdapter(space, 'hang');
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    for await (const event of new Cligent(adapter, {
      cwd: space.root,
      skills: space.skills,
    }).run('Use alpha.', { abortSignal: controller.signal })) {
      events.push(event);
      if (event.type === 'text') controller.abort();
    }
    expect(events.map((event) => event.type)).toEqual(['init', 'text', 'done']);
    expect(payloads<DonePayload>(events, 'done')[0]!.status).toBe(
      'interrupted',
    );
    const [launch] = await launches(space);
    await expectRemoved(space, [launch!.plugin!.root]);
  });

  // claude-code-89: the root outlives the SDK query's settlement. A native
  // process that lingers after its input closes or it is signalled still
  // finds the root at its own exit, and the root is gone once the adapter's
  // own stream completes, with no wait.
  it.each<[string, FixtureMode, DonePayload['status']]>([
    ['success', 'ok', 'success'],
    ['a readiness failure', 'absent', 'error'],
    ['an abort', 'hang', 'interrupted'],
  ])(
    'keeps the plugin root until a lingering native process exits after %s',
    async (_label, mode, status) => {
      const space = await workspace();
      const exitRecording = join(space.root, 'claude-exits.jsonl');
      const { adapter } = fixtureAdapter(space, mode, { exitRecording });
      // A live caller signal, fired only on the abort path.
      const controller = new AbortController();
      const events: AgentEvent[] = [];
      for await (const event of adapter.run('Use alpha.', {
        cwd: space.root,
        skills: space.skills,
        abortSignal: controller.signal,
      })) {
        events.push(event);
        if (mode === 'hang' && event.type === 'text') controller.abort();
      }
      expect(events.at(-1)).toMatchObject({
        type: 'done',
        payload: { status },
      });
      const [launch] = await launches(space);
      const root = launch!.plugin!.root;
      expect(existsSync(root)).toBe(false);
      expect(await pluginRootsIn(space.temp)).toEqual([]);
      const exits = (await readFile(exitRecording, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { rootExists: boolean });
      expect(exits).toEqual([{ rootExists: true }]);
    },
    15_000,
  );

  // claude-code-89 / skills-4: an unremovable root is named at the end of a
  // rejection that leaves the adapter after the root exists.
  it.skipIf(permissionsUnenforced)(
    'names an unremovable plugin root at the end of a rejection',
    async () => {
      const space = await workspace();
      let root: string | undefined;
      const loadSdk = vi.fn(async () => {
        const [name] = await pluginRootsIn(space.temp);
        root = join(space.temp, name!);
        await chmod(space.temp, 0o500);
        throw new Error('SDK import failed');
      });
      const adapter = new ClaudeCodeAdapter({
        probeExecutable: () => ({ state: 'present', path: space.script }),
        loadSdk,
      });
      try {
        const error = await collect(
          adapter.run('Use alpha.', { cwd: space.root, skills: space.skills }),
        ).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        const suffix = `; skill carrier cleanup failed: ${root}: `;
        expect(message.startsWith('ClaudeCodeAdapter requires')).toBe(true);
        expect(message.indexOf(suffix)).toBeGreaterThan(0);
        // The suffix is the message's last part: one failure, naming the root.
        const failure = message.slice(message.indexOf(suffix) + suffix.length);
        expect(failure).not.toContain('; ');
        expect(failure).toMatch(/EACCES|EPERM/);
        expect(existsSync(root!)).toBe(true);
      } finally {
        await chmod(space.temp, 0o700);
      }
    },
  );

  // claude-code-89 / skills-4: after the terminal, or once the caller signal
  // fired, a removal failure leaves the root behind and reports nothing.
  it.skipIf(permissionsUnenforced)(
    'keeps a successful terminal unchanged when the plugin root cannot be removed',
    async () => {
      const space = await workspace();
      const { adapter } = fixtureAdapter(space, 'ok');
      const events: AgentEvent[] = [];
      try {
        for await (const event of adapter.run('Use alpha.', {
          cwd: space.root,
          skills: space.skills,
        })) {
          events.push(event);
          if (event.type === 'done') await chmod(space.temp, 0o500);
        }
        expect(events.map((event) => event.type)).toEqual([
          'init',
          'text',
          'done',
        ]);
        expect(payloads<DonePayload>(events, 'done')[0]).toMatchObject({
          status: 'success',
          result: 'Skill used',
          resumeToken: SESSION_ID,
        });
        const [launch] = await launches(space);
        expect(existsSync(launch!.plugin!.root)).toBe(true);
      } finally {
        await chmod(space.temp, 0o700);
      }
    },
  );

  it.skipIf(permissionsUnenforced)(
    'keeps a cancelled terminal unchanged when the plugin root cannot be removed',
    async () => {
      const space = await workspace();
      const { adapter, loadSdk } = fixtureAdapter(space, 'ok');
      const controller = new AbortController();
      const roots: string[] = [];
      const original = skillsModule.materializeSkills;
      vi.spyOn(skillsModule, 'materializeSkills').mockImplementation(
        async (skills, options) => {
          roots.push(dirname(options.root));
          await chmod(space.temp, 0o500);
          controller.abort();
          return original(skills, options);
        },
      );
      try {
        const events = await collect(
          adapter.run('Use alpha.', {
            cwd: space.root,
            skills: space.skills,
            abortSignal: controller.signal,
          }),
        );
        expect(events.map((event) => event.type)).toEqual(['done']);
        expect(payloads<DonePayload>(events, 'done')[0]).toMatchObject({
          status: 'interrupted',
          usage: { toolUses: 0 },
        });
        expect(
          payloads<DonePayload>(events, 'done')[0]!.result,
        ).toBeUndefined();
        expect(loadSdk).not.toHaveBeenCalled();
        expect(roots).toHaveLength(1);
        expect(existsSync(roots[0]!)).toBe(true);
      } finally {
        await chmod(space.temp, 0o700);
      }
    },
  );
});
