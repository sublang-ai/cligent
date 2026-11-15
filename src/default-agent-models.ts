// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** The models a fresh configuration may pin under this release's runtime floors.
 * Pass the user's home to include their Claude Code settings; omit it when the
 * environment represents a seat and the host account's settings do not apply. */
export function defaultAgentModels(
  adapter: string,
  env: NodeJS.ProcessEnv,
  homeDir?: string,
): { model?: string; subagentModel?: string } {
  if (adapter === 'claude' || adapter === 'claude-code') {
    const effective = homeDir ? claudeEnvironment(env, homeDir) : env;
    if (
      !directApi(effective.ANTHROPIC_BASE_URL, 'https://api.anthropic.com') ||
      CLOUD_PROVIDERS.some((key) =>
        /^(1|true|yes|on)$/i.test(effective[key]?.trim() ?? ''),
      )
    )
      return {};
    return { model: 'claude-fable-5-2', subagentModel: 'claude-opus-5-5' };
  }
  if (
    adapter === 'codex' &&
    directApi(env.OPENAI_BASE_URL, 'https://api.openai.com')
  ) {
    return { model: 'gpt-6-astra', subagentModel: 'gpt-6.1-sol' };
  }
  return {};
}
