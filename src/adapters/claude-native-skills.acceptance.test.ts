// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// claude-code-92: real-run verification that `nativeSkills: false` leaves a
// Claude run, and every subagent it starts, listing only the run's own
// `cligent:<name>` skill. The recording-fixture tests (claude-code-91) prove
// what crosses the SDK boundary; only the real runtime shows that the parent
// policy tier drops the project and user skill directories in the main thread
// and in subagents, which the SDK's main-thread skill list alone cannot do.
//
// The evidence is the skill listing the runtime itself attaches to each
// thread's session transcript under a throwaway configuration directory, so
// the account's own skills and plugins never reach the run. The project skill
// and the user skill each hold a token no prompt shows, so a token reaching
// any event could only come through a native skill. A control run without the
// switch shows both native skills are discoverable in the same setup.

import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, DonePayload, ErrorPayload } from '../index.js';
import { ClaudeCodeAdapter } from './claude-code.js';

const RUN_SKILL = 'run-probe';
const PROJECT_SKILL = 'native-probe';
const USER_SKILL = 'user-probe';
const MODEL = 'claude-haiku-4-5';
const PROBE_TIMEOUT_MS = 300_000;
const MAX_ATTEMPTS = 3;

const missing = process.env.ANTHROPIC_API_KEY ? [] : ['ANTHROPIC_API_KEY'];
const MISSING = `Missing Claude native-skills acceptance dependencies: ${missing.join(', ')}`;

// claude-code-219's gate: self-skip locally with one stderr diagnostic when
// the credential is absent, and hard-fail instead under CI.
const acceptanceIt = (() => {
  if (missing.length === 0 || process.env.CI) return it;
  process.stderr.write(`${MISSING}; skipping locally\n`);
  return it.skip;
})();

// Retry only on explicit upstream-capacity failures, as claude-code-219 does,
// so a genuine regression still surfaces instead of being retried.
const TRANSIENT_UPSTREAM_MARKERS = [
  /\b(?:API Error:\s*Repeated|HTTP(?:[ _-]+status)?|status[ _-]+code)[ :=_-]*(?:429|503|529)\b/i,
  /\boverload(?:ed|ing)?\b/i,
  /\bover[ _-]?capacity\b/i,
  /\bservice[ _-]?unavailable\b/i,
  /\brate[ _-]?limit(?:ed|ing|[ _-]?exceeded)?\b/i,
  /\btoo[ _-]?many[ _-]?requests\b/i,
];

const SUBAGENT_PROMPT = [
  'Call the Agent tool exactly once, in the foreground, with subagent_type "general-purpose" and this prompt:',
  '"Reply with the exact names of every skill your context lists as available (your skill listing), comma-separated, nothing else; if there is none, reply NONE. Use no tools."',
  'Then reply with exactly what the subagent returned, nothing else.',
].join(' ');
const CONTROL_PROMPT = 'Reply with the single word OK and nothing else.';

interface Listing {
  /** The transcript file, relative to the project transcript directory. */
  readonly file: string;
  readonly subagent: boolean;
  readonly names: readonly string[];
}

interface ProbeOutcome {
  readonly events: readonly AgentEvent[];
  readonly tokens: readonly string[];
  readonly listings: readonly Listing[];
  /** Every transcript file found, relative to the project directory. */
  readonly transcripts: readonly string[];
}

describe('Claude native-skill switch real-run acceptance (claude-code-92)', () => {
  acceptanceIt(
    'lists only the run skill in the main thread and every subagent with nativeSkills false',
    async () => {
      if (missing.length > 0) throw new Error(MISSING);

      // The control: the same setup without the switch discovers both native
      // skills, so their absence below is the switch's doing.
      const control = await runWithRetries(false, CONTROL_PROMPT);
      expectSuccess(control);
      const controlMain = control.listings.filter((entry) => !entry.subagent);
      expect(
        controlMain.length,
        `no main-thread listing in ${JSON.stringify(control.transcripts)}`,
      ).toBeGreaterThan(0);
      const controlNames = new Set(controlMain.flatMap((entry) => entry.names));
      expect([...controlNames], JSON.stringify(controlMain)).toEqual(
        expect.arrayContaining([PROJECT_SKILL, USER_SKILL]),
      );

      const outcome = await runWithRetries(true, SUBAGENT_PROMPT);
      expectSuccess(outcome);
      const diagnostics = JSON.stringify({
        transcripts: outcome.transcripts,
        listings: outcome.listings,
      });
      const main = outcome.listings.filter((entry) => !entry.subagent);
      const subagents = outcome.listings.filter((entry) => entry.subagent);
      process.stderr.write(
        `Claude native-skills acceptance: control ${JSON.stringify(control.listings)}; switched ${diagnostics}\n`,
      );
      expect(main.length, diagnostics).toBeGreaterThan(0);
      expect(subagents.length, diagnostics).toBeGreaterThan(0);
      // The main thread's and every subagent's listing name only the run's
      // skill (claude-code-90).
      for (const listing of outcome.listings) {
        expect(listing.names, diagnostics).toEqual([`cligent:${RUN_SKILL}`]);
      }
      // Neither native token reaches any event.
      const serialized = outcome.events.map((event) => JSON.stringify(event));
      for (const token of outcome.tokens) {
        expect(
          serialized.filter((text) => text.includes(token)),
          `native token ${token} reached an event`,
        ).toEqual([]);
      }
    },
    2 * PROBE_TIMEOUT_MS * MAX_ATTEMPTS,
  );
});

function expectSuccess(outcome: ProbeOutcome): void {
  const done = outcome.events.find((event) => event.type === 'done')
    ?.payload as DonePayload | undefined;
  const errors = outcome.events
    .filter((event) => event.type === 'error')
    .map((event) => (event.payload as ErrorPayload).message);
  expect(done?.status, `errors: ${errors.join(' | ')}`).toBe('success');
  expect(errors).toEqual([]);
}

async function runWithRetries(
  nativeSkillsOff: boolean,
  prompt: string,
): Promise<ProbeOutcome> {
  let outcome: ProbeOutcome | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    outcome = await runProbe(nativeSkillsOff, prompt);
    const transient = transientFailure(outcome.events);
    if (!transient || attempt === MAX_ATTEMPTS) break;
    process.stderr.write(
      `Claude native-skills acceptance attempt ${attempt} hit a transient upstream error: ${transient}\n`,
    );
  }
  return outcome!;
}

function writeSkill(
  directory: string,
  name: string,
  description: string,
  body: string,
): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      '---',
      body,
      '',
    ].join('\n'),
  );
}

async function runProbe(
  nativeSkillsOff: boolean,
  prompt: string,
): Promise<ProbeOutcome> {
  // The runtime names a project's transcript directory after the working
  // directory's real path.
  const cwd = realpathSync(
    mkdtempSync(join(tmpdir(), 'cligent-claude-native-skills-acceptance-')),
  );
  const config = realpathSync(
    mkdtempSync(join(tmpdir(), 'cligent-claude-native-skills-config-')),
  );
  // A sibling of the working directory, so the runtime can find the run
  // skill only through the plugin.
  const sources = realpathSync(
    mkdtempSync(join(tmpdir(), 'cligent-claude-native-skills-sources-')),
  );
  const projectToken = `NATIVETOKEN-${randomBytes(6).toString('hex').toUpperCase()}`;
  const userToken = `USERTOKEN-${randomBytes(6).toString('hex').toUpperCase()}`;
  // The project root bounds the runtime's upward skill discovery.
  mkdirSync(join(cwd, '.git'));
  writeSkill(
    join(cwd, '.claude', 'skills', PROJECT_SKILL),
    PROJECT_SKILL,
    "Replies with this project's probe token. Use when asked for the project probe token.",
    `Reply with exactly this token and nothing else: ${projectToken}`,
  );
  writeSkill(
    join(config, 'skills', USER_SKILL),
    USER_SKILL,
    "Replies with this user's probe token. Use when asked for the user probe token.",
    `Reply with exactly this token and nothing else: ${userToken}`,
  );
  const runSkill = join(sources, RUN_SKILL);
  writeSkill(
    runSkill,
    RUN_SKILL,
    'Replies RUN. Use when asked for the run probe.',
    'Reply with exactly the word RUN and nothing else.',
  );

  const events: AgentEvent[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  // The adapter copies the environment when it maps the run, so the child
  // reads this configuration directory and nothing else of the account's.
  vi.stubEnv('CLAUDE_CONFIG_DIR', config);
  try {
    const adapter = new ClaudeCodeAdapter();
    for await (const event of adapter.run(prompt, {
      cwd,
      model: MODEL,
      skills: [runSkill],
      ...(nativeSkillsOff ? { nativeSkills: false } : {}),
      abortSignal: controller.signal,
    })) {
      events.push(event);
    }
    const project = join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    const { listings, transcripts } = readListings(project);
    return {
      events,
      tokens: [projectToken, userToken],
      listings,
      transcripts,
    };
  } finally {
    clearTimeout(timer);
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
    rmSync(sources, { recursive: true, force: true });
  }
}

// Every `skill_listing` attachment in the project's transcripts, the main
// session's and each subagent's under `subagents/`.
function readListings(project: string): {
  listings: Listing[];
  transcripts: string[];
} {
  const listings: Listing[] = [];
  const transcripts: string[] = [];
  if (!existsSync(project)) return { listings, transcripts };
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!name.endsWith('.jsonl')) continue;
      const file = relative(project, path);
      transcripts.push(file);
      const subagent = file.split(sep).includes('subagents');
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (line.trim().length === 0) continue;
        const entry = JSON.parse(line) as {
          type?: unknown;
          attachment?: { type?: unknown; names?: unknown; content?: unknown };
        };
        if (
          entry.type !== 'attachment' ||
          entry.attachment?.type !== 'skill_listing'
        ) {
          continue;
        }
        listings.push({
          file,
          subagent,
          names: listingNames(entry.attachment),
        });
      }
    }
  };
  walk(project);
  return { listings, transcripts };
}

function listingNames(attachment: {
  names?: unknown;
  content?: unknown;
}): string[] {
  if (Array.isArray(attachment.names)) return attachment.names.map(String);
  // Without `names`, the listing's own lines carry one `- <name>` each.
  const content =
    typeof attachment.content === 'string' ? attachment.content : '';
  return content
    .split('\n')
    .map((line) => /^- ([^\s:]+(?::[^\s:]+)?)(?::|\s|$)/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

function transientFailure(events: readonly AgentEvent[]): string | undefined {
  const done = events.find((event) => event.type === 'done')?.payload as
    DonePayload | undefined;
  if (done?.status === 'success') return undefined;
  const texts = [
    ...events
      .filter((event) => event.type === 'error')
      .map((event) => (event.payload as ErrorPayload).message),
    done?.result ?? '',
  ];
  return texts.find((text) =>
    TRANSIENT_UPSTREAM_MARKERS.some((marker) => marker.test(text)),
  );
}
