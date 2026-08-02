// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  adapterRepairCommands,
  assertConfiguredAdaptersReady,
  configuredAdapterRoles,
  formatNoRuntimeInstalled,
  probeAdapterRuntimes,
  readyAdapters,
  resolveInstallRoot,
  resolveInstallScope,
} from './readiness.js';
import type { PlayerAdapterImports, PlayerAdapterName } from './players.js';

function adapterImportsReporting(
  available: (adapter: PlayerAdapterName) => boolean,
): PlayerAdapterImports {
  const adapterFor = (adapter: PlayerAdapterName) => async () =>
    class {
      async isAvailable(): Promise<boolean> {
        return available(adapter);
      }
    };
  return {
    claude: adapterFor('claude'),
    codex: adapterFor('codex'),
    gemini: adapterFor('gemini'),
    kimi: adapterFor('kimi'),
    opencode: adapterFor('opencode'),
  } as unknown as PlayerAdapterImports;
}

describe('adapterRepairCommands', () => {
  it('scopes peer SDK installs to the cligent installation', () => {
    expect(adapterRepairCommands('claude', 'global')).toEqual([
      'npm install -g @anthropic-ai/claude-agent-sdk',
    ]);
    expect(adapterRepairCommands('claude', 'local')).toEqual([
      'npm install @anthropic-ai/claude-agent-sdk',
    ]);
  });

  it('always installs PATH executables globally', () => {
    // The gemini adapter spawns the `gemini` binary, so a project install
    // would leave nothing on PATH whatever scope cligent itself uses.
    expect(adapterRepairCommands('gemini', 'local')).toEqual([
      'npm install -g @google/gemini-cli',
    ]);
  });

  it('pins the Kimi CLI target and names its login step', () => {
    expect(adapterRepairCommands('kimi', 'global')).toEqual([
      'npm install -g @moonshot-ai/kimi-code@0.27.0',
      'kimi login',
    ]);
  });

  it('names both the SDK and the CLI OpenCode needs', () => {
    expect(adapterRepairCommands('opencode', 'global')).toEqual([
      'npm install -g @opencode-ai/sdk',
      'npm install -g opencode-ai',
    ]);
  });
});

describe('resolveInstallScope', () => {
  it('reads an npm global layout as a global install', () => {
    const prefix = resolve(process.execPath, '..', '..');
    expect(
      resolveInstallScope({
        packageRoot:
          process.platform === 'win32'
            ? join(prefix, 'node_modules', '@sublang', 'cligent')
            : join(prefix, 'lib', 'node_modules', '@sublang', 'cligent'),
        cwd: '/srv/app',
      }),
    ).toBe('global');
  });

  it('reads a configured global prefix as a global install', () => {
    // `npm config set prefix ~/.npm-global` leaves no match against the Node
    // prefix, but the tree still holds no project the command could run from.
    expect(
      resolveInstallScope({
        packageRoot: '/home/dev/.npm-global/lib/node_modules/@sublang/cligent',
        cwd: '/home/dev/work/app',
      }),
    ).toBe('global');
  });

  it('reads a project node_modules as a local install', () => {
    expect(
      resolveInstallScope({
        packageRoot: join('/srv', 'app', 'node_modules', '@sublang', 'cligent'),
        cwd: '/srv/app',
      }),
    ).toBe('local');
  });

  it('reads a local install invoked from a subdirectory as local', () => {
    expect(
      resolveInstallScope({
        packageRoot: join('/srv', 'app', 'node_modules', '@sublang', 'cligent'),
        cwd: '/srv/app/packages/api/src',
      }),
    ).toBe('local');
  });

  it('reads a repository checkout as a local install', () => {
    expect(
      resolveInstallScope({ packageRoot: '/srv/cligent', cwd: '/srv/cligent' }),
    ).toBe('local');
  });
});

describe('resolveInstallRoot', () => {
  it('returns the tree whose node_modules holds the package', () => {
    expect(
      resolveInstallRoot(join('/srv', 'app', 'node_modules', '@sublang', 'cligent')),
    ).toBe(join('/srv', 'app'));
  });

  it('returns the package itself when no node_modules encloses it', () => {
    expect(resolveInstallRoot('/srv/cligent')).toBe('/srv/cligent');
  });
});

describe('probeAdapterRuntimes', () => {
  it('reports each adapter once, treating a failed import as missing', async () => {
    const imports = {
      ...adapterImportsReporting((adapter) => adapter === 'codex'),
      claude: async () => {
        throw new Error('Cannot find package');
      },
    } as unknown as PlayerAdapterImports;

    const probed = await probeAdapterRuntimes(
      ['claude', 'codex', 'codex'],
      { adapterImports: imports },
    );

    expect(probed.get('claude')).toBe(false);
    expect(probed.get('codex')).toBe(true);
    expect(probed.size).toBe(2);
  });
});

describe('readyAdapters', () => {
  it('returns installed runtimes in canonical order', async () => {
    const ready = await readyAdapters({
      adapterImports: adapterImportsReporting(
        (adapter) => adapter === 'kimi' || adapter === 'claude',
      ),
    });

    expect(ready).toEqual(['claude', 'kimi']);
  });
});

describe('configuredAdapterRoles', () => {
  it('groups every role that shares an adapter, in configuration order', () => {
    const roles = configuredAdapterRoles({
      config: {
        captain: { adapter: 'claude' },
        players: [
          { id: 'coder', adapter: 'codex' },
          { id: 'reviewer', adapter: 'claude' },
        ],
      },
    });

    expect(roles).toEqual([
      { adapter: 'claude', roles: ['captain', 'player "reviewer"'] },
      { adapter: 'codex', roles: ['player "coder"'] },
    ]);
  });
});

describe('assertConfiguredAdaptersReady', () => {
  const loaded = {
    path: '/home/dev/.config/tmux-play/config.yaml',
    config: {
      captain: { adapter: 'claude' as const },
      players: [{ id: 'coder', adapter: 'codex' as const }],
    },
  };

  it('resolves when every configured runtime is installed', async () => {
    await expect(
      assertConfiguredAdaptersReady(loaded, {
        adapterImports: adapterImportsReporting(() => true),
      }),
    ).resolves.toBeUndefined();
  });

  it('names the missing adapter, its roles, the repair, and the config', async () => {
    const error = await assertConfiguredAdaptersReady(loaded, {
      packageRoot: '/srv/app/node_modules/@sublang/cligent',
      cwd: '/srv/app',
      adapterImports: adapterImportsReporting((adapter) => adapter !== 'codex'),
    }).then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );

    expect(error?.message).toContain('the codex adapter has no runtime installed');
    expect(error?.message).toContain('codex (player "coder")');
    expect(error?.message).toContain('npm install @openai/codex-sdk');
    expect(error?.message).toContain(loaded.path);
    // A ready adapter is not reported as a repair the user has to make.
    expect(error?.message).not.toContain('@anthropic-ai/claude-agent-sdk');
  });
});

describe('formatNoRuntimeInstalled', () => {
  it('lists a repair for every supported adapter', () => {
    const message = formatNoRuntimeInstalled({
      scope: 'global',
      packageRoot: '/usr/local/lib/node_modules/@sublang/cligent',
    });

    expect(message).toContain('found no agent runtime installed');
    for (const command of [
      'npm install -g @anthropic-ai/claude-agent-sdk',
      'npm install -g @openai/codex-sdk',
      'npm install -g @google/gemini-cli',
      'npm install -g @moonshot-ai/kimi-code@0.27.0',
      'npm install -g @opencode-ai/sdk',
      'npm install -g opencode-ai',
    ]) {
      expect(message).toContain(command);
    }
    // The tree the adapters resolve from, so a layout the canned command
    // cannot repair is still diagnosable.
    expect(message).toContain('/usr/local/lib/node_modules');
  });
});
