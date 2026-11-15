// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse } from 'smol-toml';

const CLOUD_PROVIDERS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD',
] as const;

function directApi(endpoint: string | undefined, origin: string): boolean {
  if (!endpoint?.trim()) return true;
  try {
    const url = new URL(endpoint);
    return (
      url.origin === origin &&
      url.href === url.origin + url.pathname &&
      /^\/(?:v1\/?)?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function claudeEnvironment(
  env: NodeJS.ProcessEnv,
  homeDir: string,
): NodeJS.ProcessEnv {
  const directory = env.CLAUDE_CONFIG_DIR?.trim() || join(homeDir, '.claude');
  try {
    const settings = JSON.parse(
      readFileSync(join(directory, 'settings.json'), 'utf8'),
    );
    if (
      !settings?.env ||
      typeof settings.env !== 'object' ||
      Array.isArray(settings.env)
    )
      return env;
    return {
      ...env,
      ...Object.fromEntries(
        Object.entries(settings.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
    };
  } catch {
    return env;
  }
}

type ModelSettingsScope = string | { readonly codexHome: string };

function directCodexProvider(
  env: NodeJS.ProcessEnv,
  scope?: ModelSettingsScope,
): boolean {
  const selectedHome = env.CODEX_HOME?.trim();
  if (scope === undefined) return !selectedHome;
  const seat = typeof scope !== 'string';
  const home = seat ? scope.codexHome : selectedHome || join(scope, '.codex');
  if (seat && (!isAbsolute(home) || (selectedHome && selectedHome !== home)))
    return false;
  let fd: number | undefined;
  try {
    if (seat && !lstatSync(home).isDirectory()) return false;
    const file = join(home, 'config.toml');
    // A seat may supply config contents, but only its own regular file is in scope.
    if (seat && !lstatSync(file).isFile()) return false;
    fd = openSync(
      file,
      constants.O_RDONLY |
        constants.O_NONBLOCK |
        (seat ? constants.O_NOFOLLOW : 0),
    );
    if (!fstatSync(fd).isFile()) return false;
    const config = parse(readFileSync(fd, 'utf8'));
    // Native Codex rejects the retired selector before choosing a provider.
    if (config.profile !== undefined) return false;
    if (
      config.model_provider !== undefined &&
      config.model_provider !== 'openai'
    )
      return false;
    if (
      config.openai_base_url !== undefined &&
      (typeof config.openai_base_url !== 'string' ||
        !directApi(config.openai_base_url, 'https://api.openai.com'))
    )
      return false;
    return true;
  } catch (error) {
    // A missing config uses native defaults. Indeterminate routing gets no model pins.
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The models a fresh configuration may pin under this release's runtime floors.
 * Pass a local user home, a trusted seat-owned Codex home, or no filesystem scope. */
export function defaultAgentModels(
  adapter: string,
  env: NodeJS.ProcessEnv,
  scope?: ModelSettingsScope,
): { model?: string; subagentModel?: string } {
  if (adapter === 'claude' || adapter === 'claude-code') {
    const effective =
      typeof scope === 'string' ? claudeEnvironment(env, scope) : env;
    if (
      !directApi(effective.ANTHROPIC_BASE_URL, 'https://api.anthropic.com') ||
      CLOUD_PROVIDERS.some((key) =>
        /^(1|true|yes|on)$/i.test(effective[key]?.trim() ?? ''),
      )
    )
      return {};
    return { model: 'claude-fable-5-2', subagentModel: 'claude-opus-5-5' };
  }
  if (adapter === 'codex' && directCodexProvider(env, scope)) {
    return { model: 'gpt-6-astra', subagentModel: 'gpt-6.1-sol' };
  }
  return {};
}
