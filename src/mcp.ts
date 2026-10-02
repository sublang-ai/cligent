// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

export type McpServerConfig =
  | {
      readonly type: 'stdio';
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly type: 'http';
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>>;
    };

export type McpServers = Readonly<Record<string, McpServerConfig>>;

export interface McpOptions {
  mcpServers?: McpServers;
  browser?: boolean;
  abortSignal?: AbortSignal;
}

const resourceScope = Symbol('managed MCP resources');
interface ResourceScope {
  closed: boolean;
  cleanups: Set<() => Promise<void>>;
}
type ScopedOptions = McpOptions & { [resourceScope]?: ResourceScope };

/** Keeps automatic browser artifacts alive until the adapter stream is consumed. */
export async function* withMcpResources<
  T extends McpOptions,
  E extends { type: string },
>(
  options: T | undefined,
  run: (options: T) => AsyncGenerator<E, void, void>,
): AsyncGenerator<E, void, void> {
  const resources: ResourceScope = { closed: false, cleanups: new Set() };
  const scoped = { ...options, [resourceScope]: resources } as unknown as T;
  const cleanup = async () => {
    if (resources.closed) return;
    resources.closed = true;
    const results = await Promise.allSettled(
      [...resources.cleanups].map((release) => release()),
    );
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('Managed browser output cleanup failed');
  };
  try {
    for await (const event of run(scoped)) {
      // Cligent deliberately doesn't wait for arbitrary adapter return() after
      // a terminal event. By this point every preceding media yield has been
      // consumed, so finish owned artifact cleanup before exposing done.
      if (event.type === 'done') await cleanup();
      yield event;
    }
  } finally {
    await cleanup();
  }
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function string(value: unknown, field: string, nonblank = false): string {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    (nonblank && !value.trim())
  ) {
    throw new Error(`Invalid MCP ${field}`);
  }
  return value;
}

function stringMap(
  value: unknown,
  field: 'env' | 'headers',
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new Error(`Invalid MCP ${field} map`);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const pattern =
        field === 'env'
          ? /^[A-Za-z_][A-Za-z0-9_]*$/
          : /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
      if (!pattern.test(key)) throw new Error(`Invalid MCP ${field} name`);
      const result = string(item, `${field} value`);
      if (field === 'headers' && /[\r\n]/.test(result)) {
        throw new Error('Invalid MCP header value');
      }
      return [key, result];
    }),
  );
}

/** Validate the complete configuration without executing any server. */
export function normalizeMcpServers(value: unknown): McpServers | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new Error('mcpServers must be a server map');
  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => {
      if (
        !/^[A-Za-z0-9_-]+$/.test(name) ||
        ['__proto__', 'constructor', 'prototype'].includes(name)
      ) {
        throw new Error('Invalid MCP server name');
      }
      if (!record(entry)) throw new Error(`Invalid MCP server ${name}`);
      if (entry.type === 'stdio') {
        const command = string(entry.command, 'command', true);
        let args: string[] | undefined;
        if (entry.args !== undefined) {
          if (!Array.isArray(entry.args)) throw new Error('Invalid MCP args');
          args = Array.from(entry.args, (arg) => string(arg, 'argument'));
        }
        const env = stringMap(entry.env, 'env');
        return [
          name,
          {
            type: 'stdio',
            command,
            ...(args && { args }),
            ...(env && { env }),
          },
        ];
      }
      if (entry.type === 'http') {
        const url = string(entry.url, 'URL', true);
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error('Invalid MCP HTTP URL');
        }
        if (
          !['http:', 'https:'].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password ||
          parsed.hash
        ) {
          throw new Error('Invalid MCP HTTP URL');
        }
        const headers = stringMap(entry.headers, 'headers');
        return [name, { type: 'http', url, ...(headers && { headers }) }];
      }
      throw new Error(
        `Unsupported MCP transport for ${name}; use stdio or http`,
      );
    }),
  );
}

/** Preparation is lazy: ordinary text calls never import the browser runtime. */
export async function prepareMcpServers(
  options?: McpOptions,
): Promise<McpServers | undefined> {
  const servers = normalizeMcpServers(options?.mcpServers);
  if (options?.browser !== undefined && typeof options.browser !== 'boolean') {
    throw new Error('browser must be a boolean');
  }
  if (!options?.browser) return servers;
  if (servers && Object.hasOwn(servers, 'cligent_browser')) {
    throw new Error('cligent_browser is reserved when browser is enabled');
  }
  if (options.abortSignal?.aborted)
    throw new Error('Browser preparation interrupted');
  const { prepareBrowserServer, releaseBrowserServer } =
    await import('./browser.js');
  const browser = await prepareBrowserServer(options.abortSignal);
  const scope = (options as ScopedOptions)[resourceScope];
  if (scope?.closed) {
    await releaseBrowserServer(browser);
    throw new Error('Browser preparation interrupted');
  }
  scope?.cleanups.add(() => releaseBrowserServer(browser));
  return { ...servers, cligent_browser: browser };
}
