// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { locateAgentExecutable } from '../index.js';
import { locateAgentExecutableWith } from '../native-executable.js';

const CLAUDE_SDK = '@anthropic-ai/claude-agent-sdk';

function withTree<T>(body: (modules: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'cligent-native-executable-'));
  try {
    const modules = join(root, 'node_modules');
    mkdirSync(modules, { recursive: true });
    return body(modules);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeManifest(
  modules: string,
  name: string,
  extra: Readonly<Record<string, unknown>> = {},
): string {
  const directory = join(modules, ...name.split('/'));
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    `${JSON.stringify({ name, ...extra })}\n`,
  );
  return directory;
}

function writeFile(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
  return realpathSync(path);
}

// engine-89: every state of engine-88's matrix over fake module trees.
describe('locateAgentExecutable over fake module trees (engine-89)', () => {
  it('reports each Claude state by the SDK rule and its manifest', () => {
    withTree((modules) => {
      const host = {
        platform: 'linux',
        arch: 'x64',
        preferMusl: false,
      } as const;
      expect(
        locateAgentExecutableWith('claude', {
          ...host,
          claude: { anchor: undefined },
        }),
      ).toEqual({ state: 'no-sdk' });

      const sdk = writeManifest(modules, CLAUDE_SDK, {
        optionalDependencies: {
          [`${CLAUDE_SDK}-linux-x64`]: '0.0.0-test',
          [`${CLAUDE_SDK}-linux-x64-musl`]: '0.0.0-test',
          [`${CLAUDE_SDK}-darwin-arm64`]: '0.0.0-test',
        },
      });
      const claude = { anchor: join(sdk, 'package.json') };

      // The SDK publishes nothing for the platform or the architecture.
      expect(
        locateAgentExecutableWith('claude', {
          claude,
          platform: 'freebsd',
          arch: 'x64',
        }),
      ).toEqual({ state: 'unsupported', platform: 'freebsd', arch: 'x64' });
      expect(
        locateAgentExecutableWith('claude', {
          claude,
          platform: 'android',
          arch: 'arm64',
        }),
      ).toEqual({ state: 'unsupported', platform: 'android', arch: 'arm64' });

      // Published but not installed: the package the SDK tries first.
      expect(locateAgentExecutableWith('claude', { ...host, claude })).toEqual({
        state: 'missing',
        package: `${CLAUDE_SDK}-linux-x64`,
        platform: 'linux',
        arch: 'x64',
      });
      expect(
        locateAgentExecutableWith('claude', {
          ...host,
          preferMusl: true,
          claude,
        }),
      ).toEqual({
        state: 'missing',
        package: `${CLAUDE_SDK}-linux-x64-musl`,
        platform: 'linux',
        arch: 'x64',
      });

      writeManifest(modules, `${CLAUDE_SDK}-linux-x64`);
      const binary = writeFile(
        join(modules, ...`${CLAUDE_SDK}-linux-x64`.split('/'), 'claude'),
      );
      expect(locateAgentExecutableWith('claude', { ...host, claude })).toEqual({
        state: 'present',
        path: binary,
      });
    });
  });

  it('reports each Codex state by the launcher rule beside the SDK', () => {
    withTree((modules) => {
      const codex = {
        resolution: {
          importMetaResolve: undefined,
          baseRequire: createRequire(join(dirname(modules), 'probe.mjs')),
        },
      };
      const host = { codex, platform: 'darwin', arch: 'arm64' } as const;
      expect(locateAgentExecutableWith('codex', host)).toEqual({
        state: 'no-sdk',
      });

      const sdk = writeManifest(modules, '@openai/codex-sdk', {
        dependencies: { '@openai/codex': '0.0.0-test' },
      });
      expect(
        locateAgentExecutableWith('codex', {
          codex,
          platform: 'linux',
          arch: 'ia32',
        }),
      ).toEqual({ state: 'unsupported', platform: 'linux', arch: 'ia32' });

      // The SDK resolves but its launcher entry does not.
      expect(locateAgentExecutableWith('codex', host)).toEqual({
        state: 'missing',
        package: '@openai/codex',
        platform: 'darwin',
        arch: 'arm64',
      });

      const launcher = writeManifest(
        join(sdk, 'node_modules'),
        '@openai/codex',
      );
      writeFile(join(launcher, 'bin', 'codex.js'));
      expect(locateAgentExecutableWith('codex', host)).toEqual({
        state: 'missing',
        package: '@openai/codex-darwin-arm64',
        platform: 'darwin',
        arch: 'arm64',
      });

      const platform = writeManifest(modules, '@openai/codex-darwin-arm64');
      const binary = writeFile(
        join(platform, 'vendor', 'aarch64-apple-darwin', 'bin', 'codex'),
      );
      expect(locateAgentExecutableWith('codex', host)).toEqual({
        state: 'present',
        path: binary,
      });
    });
  });
});

describe('locateAgentExecutable in this checkout (engine-89)', () => {
  // The checkout installs both SDKs as devDependencies together with the
  // platform package for its own host, so the public lookup finds each
  // executable with no injected tree.
  it.each(['claude', 'codex'] as const)(
    'finds the %s executable',
    (runtime) => {
      const located = locateAgentExecutable(runtime);
      expect(located.state).toBe('present');
      if (located.state === 'present') {
        expect(existsSync(located.path)).toBe(true);
      }
    },
  );
});
