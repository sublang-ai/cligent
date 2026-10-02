// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { getEffortSupport } from './effort.js';
import {
  AGENT_RUNTIME_TARGETS,
  type AgentRuntimeName,
} from './runtime-targets.js';
import { assertRuntimeSupported } from './runtime-version.js';
import { nodeChildEnvironment } from './node-child.js';

export interface DiscoveredModel {
  readonly id: string;
  /** The runtime's human name for this choice, otherwise its `id`. */
  readonly name: string;
  /** The runtime's own description of this choice, verbatim, when reported. */
  readonly description?: string;
  /** Canonical model behind a provider alias, when reported. */
  readonly resolvedModel?: string;
  /** Known model choices this adapter transports; absent means unknown. */
  readonly effortValues?: readonly string[];
  readonly defaultEffort?: string;
  /** Model capability only; account entitlement can still differ. */
  readonly fastModeSupported?: boolean;
}

export type ModelDiscovery =
  | {
      readonly status: 'available';
      readonly models: readonly DiscoveredModel[];
      /**
       * The model value the runtime's own configuration selects when the
       * caller configures none, resolved as a run in the discovery context
       * would resolve it. It may name a value absent from `models`, is absent
       * whenever the runtime cannot report it, and describes configuration
       * rather than account entitlement.
       */
      readonly defaultModel?: string;
      /** Adapter choices this catalog cannot describe; not model eligibility. */
      readonly unreportedEffortValues?: readonly string[];
    }
  | { readonly status: 'unavailable'; readonly reason: string };

export interface ModelDiscoveryOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  /** Discovery deadline, default 10 seconds, excluding bounded cleanup. */
  readonly timeoutMs?: number;
}

type ModelAdapter = AgentRuntimeName | 'claude-code';
type Row = Record<string, unknown>;
type Command = { executable: string; args: string[]; nodeEntry?: boolean };
type DiscoveryContext = ModelDiscoveryOptions & { signal: AbortSignal };
interface Catalog {
  models: DiscoveredModel[];
  defaultModel?: string;
}
interface ClaudeQuery {
  supportedModels?(): Promise<unknown>;
  close(): void;
}
type ClaudeSettingsResolver = (options: unknown) => Promise<unknown>;
interface DiscoveryDeps {
  checkRuntime?: (adapter: AgentRuntimeName) => void;
  claudeQuery?: (options: unknown) => ClaudeQuery | Promise<ClaudeQuery>;
  /** The Agent SDK's settings resolver, or undefined when it exports none. */
  claudeSettings?: () => Promise<ClaudeSettingsResolver | undefined>;
  command?: (adapter: AgentRuntimeName) => Command | Promise<Command>;
}
// Verbose OpenCode listings carry a JSON detail object for every model.
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
// Claude's settings resolver runs in this process, which locates Claude's
// configuration through these variables; an overlay changing them cannot be
// followed.
const CLAUDE_CONFIG_LOCATION = ['CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE'];
const KIMI_DEFAULT_PREFIX = 'Default model: ';

/** Provider-owned catalog; never validates or replaces a configured model. */
export function discoverAgentModels(
  adapter: ModelAdapter,
  options: ModelDiscoveryOptions = {},
): Promise<ModelDiscovery> {
  return discoverAgentModelsWithDeps(adapter, options);
}

/** Internal transport seams for hermetic integration coverage. */
export async function discoverAgentModelsWithDeps(
  input: ModelAdapter,
  options: ModelDiscoveryOptions = {},
  deps: DiscoveryDeps = {},
): Promise<ModelDiscovery> {
  const adapter = input === 'claude-code' ? 'claude' : input;
  if (!Object.hasOwn(AGENT_RUNTIME_TARGETS, adapter)) {
    return unavailable('Model discovery is unavailable for this adapter.');
  }
  if (adapter === 'gemini') {
    return unavailable(
      'Gemini CLI has no supported non-session model listing. Enter a model ID.',
    );
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return unavailable('Model discovery timeout must be positive.');
  }
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Model discovery cancelled.'));
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(new Error('Model discovery timed out.')),
    timeoutMs,
  );
  // Discovery owns its answer once its last listing settles: teardown cannot
  // turn it into a timeout or replace it when the caller cancels afterwards.
  const settle = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  };
  const context = { ...options, signal: controller.signal };
  try {
    checkAbort(controller.signal);
    (deps.checkRuntime ?? checkRuntime)(adapter);
    const catalog =
      adapter === 'claude'
        ? await discoverClaude(context, controller, deps)
        : await discoverListing(adapter, context, deps, settle);
    checkAbort(controller.signal);
    return {
      status: 'available',
      models: uniqueModels(catalog.models),
      ...(catalog.defaultModel === undefined
        ? {}
        : { defaultModel: catalog.defaultModel }),
      ...(adapter === 'claude'
        ? {
            unreportedEffortValues:
              getEffortSupport(adapter)!.orchestrationValues,
          }
        : {}),
    };
  } catch (error) {
    const cause = controller.signal.aborted ? controller.signal.reason : error;
    return unavailable(
      cause instanceof Error ? cause.message : 'Model discovery failed.',
    );
  } finally {
    settle();
  }
}

function unavailable(reason: string): ModelDiscovery {
  return { status: 'unavailable', reason };
}
function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
function row(value: unknown): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Malformed model catalog.');
  }
  return value as Row;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Malformed model catalog.');
  return value;
}
function uniqueModels(models: DiscoveredModel[]): DiscoveredModel[] {
  const seen = new Set<string>();
  return models.filter(({ id }) => !seen.has(id) && !!seen.add(id));
}
function efforts(adapter: ModelAdapter, values: unknown): string[] {
  const reported = list(values);
  if (reported.some((value) => typeof value !== 'string'))
    throw new Error('Malformed model effort choices.');
  const accepted = getEffortSupport(adapter)?.values ?? [];
  // Claude's minimal is its existing low alias, not a new provider tier.
  return accepted.filter((value) =>
    reported.includes(
      adapter === 'claude' && value === 'minimal' ? 'low' : value,
    ),
  );
}
function checkRuntime(adapter: AgentRuntimeName): void {
  // CLI-only listings report their own availability and honor the caller's PATH.
  if (adapter !== 'claude' && adapter !== 'codex') return;
  for (const target of AGENT_RUNTIME_TARGETS[adapter]) {
    assertRuntimeSupported(
      target,
      `npm install ${target.kind === 'cli' ? '-g ' : ''}${target.repairSpec}`,
    );
  }
}
async function commandFor(adapter: AgentRuntimeName): Promise<Command> {
  if (adapter === 'codex') {
    const { resolveCodexBinPath } = await import('./adapters/codex.js');
    return {
      executable: process.execPath,
      args: [resolveCodexBinPath(), 'app-server'],
      nodeEntry: true,
    };
  }
  // Kimi's human listing prints its default; `--json` selects the aliases.
  return adapter === 'kimi'
    ? { executable: 'kimi', args: ['provider', 'list'] }
    : { executable: 'opencode', args: ['models', '--verbose'] };
}

async function discoverListing(
  adapter: AgentRuntimeName,
  options: DiscoveryContext,
  deps: DiscoveryDeps,
  settle: () => void,
): Promise<Catalog> {
  const command = await abortable(
    Promise.resolve((deps.command ?? commandFor)(adapter)),
    options.signal,
  );
  if (adapter === 'kimi') {
    const models = kimiModels(
      await listingOutput(
        { ...command, args: [...command.args, '--json'] },
        options,
      ),
    );
    // Run after the JSON listing so the two never initialize Kimi's
    // configuration concurrently.
    const child = new DiscoveryProcess(command, options);
    let defaultModel: string | undefined;
    try {
      defaultModel = kimiDefaultModel(await child.output(), models);
    } catch {
      // A failed default listing omits only the default; cancellation still
      // fails discovery once it settles.
    } finally {
      settle();
      await child.close();
    }
    return { models, ...(defaultModel === undefined ? {} : { defaultModel }) };
  }
  const child = new DiscoveryProcess(command, options);
  try {
    return adapter === 'codex'
      ? await discoverCodex(child, options)
      : { models: opencodeModels(await child.output()) };
  } finally {
    settle();
    await child.close();
  }
}

/** One listing process run to stream closure and retired. */
async function listingOutput(
  command: Command,
  options: DiscoveryContext,
): Promise<string> {
  const child = new DiscoveryProcess(command, options);
  try {
    return await child.output();
  } finally {
    await child.close();
  }
}

async function discoverClaude(
  options: DiscoveryContext,
  controller: AbortController,
  deps: DiscoveryDeps,
): Promise<Catalog> {
  // Settings resolve beside the catalog; a failure omits only the default.
  const defaultModel = claudeDefaultModel(options, deps).catch(() => undefined);
  let query: ClaudeQuery | undefined;
  let finishInput!: () => void;
  const inputFinished = new Promise<void>((resolve) => {
    finishInput = resolve;
  });
  // Keep stdin open for initialization but never deliver a user message.
  async function* input(): AsyncGenerator<never> {
    await inputFinished;
  }
  try {
    const createQuery =
      deps.claudeQuery ??
      (async (input: unknown) => {
        const sdk = await import('@anthropic-ai/claude-agent-sdk');
        checkAbort(options.signal);
        return sdk.query(
          input as Parameters<typeof sdk.query>[0],
        ) as unknown as ClaudeQuery;
      });
    // Do not race creation: a late SDK import must not leave an unowned query.
    const opening = Promise.resolve(
      createQuery({
        prompt: input(),
        options: {
          cwd: options.cwd,
          env: { ...process.env, ...options.env },
          abortController: controller,
          persistSession: false,
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: [],
          settings: { disableAllHooks: true },
          permissionMode: 'dontAsk',
        },
      }),
    );
    opening.then(
      (value) => {
        if (options.signal.aborted) value.close();
      },
      () => {},
    );
    query = await abortable(opening, options.signal);
    checkAbort(options.signal);
    if (typeof query.supportedModels !== 'function') {
      throw new Error('This Claude Agent SDK does not expose model discovery.');
    }
    const catalog = list(
      await abortable(query.supportedModels(), options.signal),
    );
    const models = catalog.map((value): DiscoveredModel => {
      const model = row(value);
      const id = text(model.value);
      if (!id) throw new Error('Malformed Claude model identifier.');
      const levels =
        model.supportsEffort === false
          ? []
          : model.supportedEffortLevels === undefined
            ? undefined
            : efforts('claude', model.supportedEffortLevels);
      const description = text(model.description);
      return {
        id,
        name: text(model.displayName) ?? id,
        ...(description ? { description } : {}),
        ...(text(model.resolvedModel)
          ? { resolvedModel: text(model.resolvedModel) }
          : {}),
        ...(levels === undefined ? {} : { effortValues: levels }),
        ...(typeof model.supportsFastMode === 'boolean'
          ? { fastModeSupported: model.supportsFastMode }
          : {}),
      };
    });
    const selected = await abortable(defaultModel, options.signal);
    return {
      models,
      ...(selected === undefined ? {} : { defaultModel: selected }),
    };
  } finally {
    finishInput();
    query?.close();
  }
}

/**
 * What an unconfigured run selects: `ANTHROPIC_MODEL`, then the settings
 * `model` a run for this cwd would load, then the runtime's `default` alias.
 */
async function claudeDefaultModel(
  options: DiscoveryContext,
  deps: DiscoveryDeps,
): Promise<string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...options.env,
  };
  if (CLAUDE_CONFIG_LOCATION.some((key) => env[key] !== process.env[key])) {
    return undefined;
  }
  const resolveSettings = await (
    deps.claudeSettings ?? claudeSettingsResolver
  )();
  if (!resolveSettings) return undefined;
  // Without a cwd, never read project settings from this process's cwd.
  const settings = row(
    row(
      await resolveSettings(
        options.cwd ? { cwd: options.cwd } : { settingSources: ['user'] },
      ),
    ).effective,
  );
  const settingsEnv = settings.env;
  // The raw cascade cannot establish whether a run applies this value.
  if (
    typeof settingsEnv === 'object' &&
    settingsEnv !== null &&
    Object.hasOwn(settingsEnv, 'ANTHROPIC_MODEL')
  ) {
    return undefined;
  }
  const configured = text(settings.model);
  if (settings.model !== undefined && !configured) return undefined;
  return text(env.ANTHROPIC_MODEL) ?? configured ?? 'default';
}

async function claudeSettingsResolver(): Promise<
  ClaudeSettingsResolver | undefined
> {
  const sdk =
    (await import('@anthropic-ai/claude-agent-sdk')) as unknown as Row;
  return typeof sdk.resolveSettings === 'function'
    ? (sdk.resolveSettings as ClaudeSettingsResolver)
    : undefined;
}

async function discoverCodex(
  child: DiscoveryProcess,
  options: DiscoveryContext,
): Promise<Catalog> {
  await child.request('initialize', {
    clientInfo: { name: 'cligent-models', version: '1' },
  });
  child.notify('initialized');
  const configured = await codexConfiguredModel(child, options.cwd);
  const models: DiscoveredModel[] = [];
  let flagged: string | undefined;
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    checkAbort(options.signal);
    const result = row(
      await child.request('model/list', {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      }),
    );
    for (const value of list(result.data)) {
      const model = row(value);
      if (model.hidden === true) continue;
      const id = text(model.model) ?? text(model.id);
      if (!id) throw new Error('Malformed Codex model identifier.');
      const levels =
        model.supportedReasoningEfforts === undefined
          ? undefined
          : efforts(
              'codex',
              list(model.supportedReasoningEfforts).map(
                (value) => row(value).reasoningEffort,
              ),
            );
      const speedTiers =
        model.additionalSpeedTiers === undefined
          ? undefined
          : list(model.additionalSpeedTiers);
      if (speedTiers?.some((value) => typeof value !== 'string')) {
        throw new Error('Malformed Codex speed tiers.');
      }
      const defaultEffort = text(model.defaultReasoningEffort);
      const description = text(model.description);
      if (model.isDefault === true) flagged ??= id;
      models.push({
        id,
        name: text(model.displayName) ?? id,
        ...(description ? { description } : {}),
        ...(levels === undefined ? {} : { effortValues: levels }),
        ...(defaultEffort && levels?.includes(defaultEffort)
          ? { defaultEffort }
          : {}),
        ...(speedTiers === undefined
          ? {}
          : { fastModeSupported: speedTiers.includes('fast') }),
      });
    }
    cursor =
      result.nextCursor === null || result.nextCursor === undefined
        ? undefined
        : text(result.nextCursor);
    if (
      result.nextCursor !== null &&
      result.nextCursor !== undefined &&
      cursor === undefined
    )
      throw new Error('Malformed model catalog cursor.');
    if (cursor && (seenCursors.has(cursor) || seenCursors.size >= 100))
      throw new Error('Model catalog pagination did not finish.');
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
  // The listing's flag counts only when configuration names no model.
  const defaultModel =
    configured === undefined ? undefined : (configured ?? flagged);
  return { models, ...(defaultModel === undefined ? {} : { defaultModel }) };
}
/** The configured model; null when none is configured, undefined if unread. */
async function codexConfiguredModel(
  child: DiscoveryProcess,
  cwd: string | undefined,
): Promise<string | null | undefined> {
  try {
    const config = row(
      row(
        await child.request(
          'config/read',
          cwd ? { cwd: resolvePath(cwd) } : {},
        ),
      ).config,
    );
    if (config.model === null || config.model === undefined) return null;
    return text(config.model);
  } catch {
    // A refused or malformed read omits only the default; transport failures
    // resurface on the model listing.
    return undefined;
  }
}
function kimiModels(output: string): DiscoveredModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    // JSON syntax errors can quote credential-bearing provider output.
    throw new Error('Malformed Kimi model listing.');
  }
  const models = row(row(parsed).models);
  return Object.entries(models).map(([id, value]) => {
    if (!id.trim()) throw new Error('Malformed Kimi model identifier.');
    // providers contains credentials; only each alias's identity leaves here.
    const alias =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Row)
        : {};
    const resolvedModel = text(alias.model);
    return {
      id,
      name: text(alias.displayName) ?? id,
      ...(resolvedModel ? { resolvedModel } : {}),
    };
  });
}
/** The sole default line naming a listed alias; no other text leaves. */
function kimiDefaultModel(
  output: string,
  models: readonly DiscoveredModel[],
): string | undefined {
  const named = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith(KIMI_DEFAULT_PREFIX))
    .map((line) => line.slice(KIMI_DEFAULT_PREFIX.length));
  return named.length === 1 && models.some(({ id }) => id === named[0])
    ? named[0]
    : undefined;
}
function opencodeModels(output: string): DiscoveredModel[] {
  const malformed = () => new Error('Malformed OpenCode model listing.');
  const lines = output.split(/\r?\n/);
  const models: DiscoveredModel[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const id = lines[index]!;
    if (!id.trim()) continue;
    if (!/^[^\s/]+\/\S+$/.test(id)) throw malformed();
    let name: string | undefined;
    const start = index + 1;
    // `--verbose` follows each ID with its JSON detail, pretty-printed so
    // that only its top-level closing brace starts a line.
    if (lines[start]?.startsWith('{')) {
      let end = start;
      while (
        end < lines.length &&
        !lines[end]!.startsWith('}') &&
        !(end === start && lines[end]!.endsWith('}'))
      )
        end += 1;
      if (end === lines.length) throw malformed();
      let detail: Row;
      try {
        detail = JSON.parse(lines.slice(start, end + 1).join('\n')) as Row;
      } catch {
        // Details can carry provider headers and options; never quote them.
        throw malformed();
      }
      name = text(detail.name);
      index = end;
    }
    models.push({ id, name: name ?? id });
  }
  return models;
}

/** One owned read-only metadata process, drained and retired on every outcome. */
class DiscoveryProcess {
  private child: ChildProcessWithoutNullStreams;
  private finished: Promise<void>;
  private finish!: () => void;
  private failure: Error | undefined;
  private stdout = '';
  private buffered = '';
  private bytes = 0;
  private id = 0;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private abort: () => void;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  private exited = false;

  constructor(
    command: Command,
    private options: DiscoveryContext,
  ) {
    checkAbort(options.signal);
    this.child = spawn(command.executable, command.args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        // Electron's process.execPath needs Node mode for the SDK's JS entry.
        ...(command.nodeEntry ? nodeChildEnvironment() : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    this.finished = new Promise((resolve) => {
      this.finish = resolve;
      this.child.on('error', (error) => {
        this.fail(error);
      });
      this.child.on('close', (code) => {
        this.exited = true;
        if (code !== 0 && !this.failure)
          this.fail(
            new Error(`Model listing process exited with code ${code}.`),
          );
        this.rejectPending(
          new Error('Model listing process closed before responding.'),
        );
        resolve();
      });
    });
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.bytes += Buffer.byteLength(chunk);
      if (this.bytes > MAX_OUTPUT_BYTES) {
        this.fail(new Error('Model catalog exceeded the output limit.'));
        return;
      }
      this.stdout += chunk;
      this.buffered += chunk;
      if (this.pending.size) this.parseReplies();
    });
    // Never include provider stderr/config output in a public error.
    this.child.stderr.resume();
    this.abort = () =>
      this.fail(
        options.signal.reason instanceof Error
          ? options.signal.reason
          : new Error('Model discovery cancelled.'),
      );
    options.signal.addEventListener('abort', this.abort, { once: true });
    if (options.signal.aborted) this.abort();
  }
  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ method })}\n`);
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.exited)
      return Promise.reject(new Error('Model listing process is closed.'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      this.parseReplies();
    });
  }
  private parseReplies(): void {
    try {
      while (this.buffered.includes('\n')) {
        const end = this.buffered.indexOf('\n');
        const line = this.buffered.slice(0, end);
        this.buffered = this.buffered.slice(end + 1);
        if (!line.trim()) continue;
        const message = row(JSON.parse(line));
        const pending =
          typeof message.id === 'number'
            ? this.pending.get(message.id)
            : undefined;
        if (!pending) continue;
        this.pending.delete(message.id as number);
        if (message.error !== undefined)
          pending.reject(
            new Error('The installed Codex runtime refused model discovery.'),
          );
        else if (!Object.hasOwn(message, 'result'))
          pending.reject(new Error('Malformed Codex model response.'));
        else pending.resolve(message.result);
      }
    } catch {
      this.fail(new Error('Malformed Codex model response.'));
    }
  }
  async output(): Promise<string> {
    this.child.stdin.end();
    await this.finished;
    if (this.failure) throw this.failure;
    return this.stdout;
  }
  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  private fail(error: Error): void {
    this.failure ??= error;
    this.rejectPending(this.failure);
    this.stop();
  }
  private signal(signal: NodeJS.Signals): void {
    if (this.exited || this.child.pid === undefined) return;
    try {
      if (process.platform !== 'win32') process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch {
      /* close/error owns the final outcome. */
    }
  }
  private stop(): void {
    if (this.exited || this.killTimer) return;
    this.child.stdin.end();
    this.signal('SIGTERM');
    this.killTimer = setTimeout(() => this.signal('SIGKILL'), 250);
    // A descendant can keep inherited pipes open after its launcher exits.
    // Bound both close() and output(), which await this same transport lifetime.
    this.cleanupTimer = setTimeout(() => {
      this.failure ??= new Error('Model listing cleanup timed out.');
      this.rejectPending(this.failure);
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      this.child.unref();
      this.finish();
    }, 500);
  }
  async close(): Promise<void> {
    this.stop();
    await this.finished;
    clearTimeout(this.killTimer);
    clearTimeout(this.cleanupTimer);
    this.options.signal.removeEventListener('abort', this.abort);
  }
}
