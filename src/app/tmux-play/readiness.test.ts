// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  adapterRepairCommands,
  assertConfiguredAdaptersReady,
  configuredAdapterRoles,
  formatNoRuntimeInstalled,
  probeAdapterRuntimes,
  readyAdapters,
  resolveInstallRoot,
  resolveInstallTarget,
} from './readiness.js';
import type { PlayerAdapterImports, PlayerAdapterName } from './players.js';

/** npm's classic default global root, for fixture layouts. */
const NPM_DEFAULT_GLOBAL_ROOT = join('/usr', 'local', 'lib', 'node_modules');

/** Only the paths named exist — manifests and `node_modules` markers alike. */
function manifestsAt(...paths: string[]) {
  const present = new Set(paths);
  return (path: string): boolean => present.has(path);
}

function targetFor(packageRoot: string, ...manifests: string[]) {
  return resolveInstallTarget({
    packageRoot,
    fileExists: manifestsAt(...manifests),
  });
}

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

const GLOBAL = {
  scope: 'global',
  moduleRoot: NPM_DEFAULT_GLOBAL_ROOT,
  prefix: join('/usr', 'local'),
} as const;
const LOCAL = {
  scope: 'local',
  moduleRoot: join('/srv', 'app', 'node_modules'),
  prefix: join('/srv', 'app'),
} as const;

describe('adapterRepairCommands', () => {
  it('pins every peer SDK install to the cligent installation', () => {
    // Every peer command names its tree: where a bare install lands is a
    // property of the paste-time shell — its npm environment and its working
    // directory — which nothing observable here can witness, while `--prefix`
    // outranks both. `-g` still marks the global scope; `--prefix` marks the
    // tree in both scopes.
    expect(adapterRepairCommands('claude', GLOBAL)).toEqual([
      'npm install -g --prefix /usr/local @anthropic-ai/claude-agent-sdk',
    ]);
    // The project form pins scope as well as tree: npm's globalness is
    // `global || location === 'global'`, either operand settable by the
    // paste-time environment, so both are pinned false — otherwise an
    // inherited `npm_config_global=true` lands the SDK in
    // `/srv/app/lib/node_modules`, outside the reported tree.
    expect(adapterRepairCommands('claude', LOCAL)).toEqual([
      'npm install --global=false --location=project --prefix /srv/app @anthropic-ai/claude-agent-sdk',
    ]);
    expect(
      adapterRepairCommands('codex', {
        scope: 'global',
        moduleRoot: '/opt/pfx/lib/node_modules',
        prefix: '/opt/pfx',
      }),
    ).toEqual(['npm install -g --prefix /opt/pfx @openai/codex-sdk']);
  });

  it('quotes a prefix a shell would split', () => {
    // Unquoted, `npm install -g --prefix /opt/my pfx <sdk>` reads `pfx` as a
    // second package spec: the printed command must survive copy-paste.
    expect(
      adapterRepairCommands('codex', {
        scope: 'global',
        moduleRoot: '/opt/my pfx/lib/node_modules',
        prefix: '/opt/my pfx',
      }),
    ).toEqual(["npm install -g --prefix '/opt/my pfx' @openai/codex-sdk"]);
  });

  it('names a manual placement instead of a command for unreachable trees', () => {
    const unreachable = {
      scope: 'global',
      moduleRoot: '/odd/node_modules',
      unreachable: true,
    } as const;
    // An install command here would land in npm's own prefix, not the tree
    // the error just said it resolves from.
    expect(adapterRepairCommands('claude', unreachable)).toEqual([
      'place @anthropic-ai/claude-agent-sdk in /odd/node_modules',
    ]);
    // Only the peer is unreachable; the PATH executable stays a real command.
    expect(adapterRepairCommands('opencode', unreachable)).toEqual([
      'place @opencode-ai/sdk in /odd/node_modules',
      'npm install -g opencode-ai',
    ]);
    expect(adapterRepairCommands('gemini', unreachable)).toEqual([
      'npm install -g @google/gemini-cli',
    ]);
  });

  it('always installs PATH executables globally and unpinned', () => {
    // The gemini adapter spawns the `gemini` binary, so it belongs in whichever
    // global prefix the user's shell reads — never pinned to cligent's tree.
    expect(adapterRepairCommands('gemini', LOCAL)).toEqual([
      'npm install -g @google/gemini-cli',
    ]);
    expect(
      adapterRepairCommands('gemini', {
        scope: 'global',
        moduleRoot: '/opt/pfx/lib/node_modules',
        prefix: '/opt/pfx',
      }),
    ).toEqual(['npm install -g @google/gemini-cli']);
  });

  it('pins the Kimi CLI target and names its login step', () => {
    expect(adapterRepairCommands('kimi', GLOBAL)).toEqual([
      'npm install -g @moonshot-ai/kimi-code@0.27.0',
      'kimi login',
    ]);
  });

  it('names both the SDK and the CLI OpenCode needs', () => {
    expect(adapterRepairCommands('opencode', GLOBAL)).toEqual([
      'npm install -g --prefix /usr/local @opencode-ai/sdk',
      'npm install -g opencode-ai',
    ]);
  });
});

describe('resolveInstallTarget', () => {
  const APP_MANIFEST = join('/srv', 'app', 'package.json');

  it('pins every global tree, npm’s classic default root included', () => {
    // The regression: a probe of this process — even asking npm itself —
    // once licensed a bare `npm install -g` here. npm injects transient
    // prefix configuration into every lifecycle child's environment, so no
    // such probe witnesses the shell where the command is pasted; the pinned
    // form holds in every context because npm's command line outranks its
    // environment.
    expect(
      targetFor(join(NPM_DEFAULT_GLOBAL_ROOT, '@sublang', 'cligent')),
    ).toEqual({
      scope: 'global',
      moduleRoot: NPM_DEFAULT_GLOBAL_ROOT,
      prefix: join('/usr', 'local'),
    });
    // A prefix supplied out of band persists nothing for a later bare
    // `npm install -g` to rediscover — pinned all the same.
    expect(targetFor('/opt/pfx/lib/node_modules/@sublang/cligent')).toEqual({
      scope: 'global',
      moduleRoot: '/opt/pfx/lib/node_modules',
      prefix: '/opt/pfx',
    });
  });

  it('pins a project tree wherever the command will be pasted from', () => {
    // The launching working directory is not the pasting one — a wrapper
    // that cds before launching, or a paste into another terminal, walks
    // npm's project discovery to whatever project encloses the paste
    // directory — so a project install is pinned to its root, which
    // `--prefix` delivers from anywhere.
    expect(
      targetFor(
        join('/srv', 'app', 'node_modules', '@sublang', 'cligent'),
        APP_MANIFEST,
      ),
    ).toEqual({
      scope: 'local',
      moduleRoot: join('/srv', 'app', 'node_modules'),
      prefix: join('/srv', 'app'),
    });
  });

  it('reads a repository checkout as its own pinned project tree', () => {
    expect(
      targetFor('/srv/cligent', join('/srv', 'cligent', 'package.json')),
    ).toEqual({
      scope: 'local',
      moduleRoot: join('/srv', 'cligent', 'node_modules'),
      prefix: '/srv/cligent',
    });
  });

  it('reports a tree no install command reaches rather than guessing', () => {
    // `<prefix>/node_modules` on a POSIX host: not npm's global layout, and no
    // manifest makes it a project, so no canned command targets it.
    expect(
      process.platform === 'win32'
        ? { unreachable: true }
        : targetFor('/opt/odd/node_modules/@sublang/cligent'),
    ).toMatchObject({ unreachable: true });
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
      fileExists: manifestsAt(join('/srv', 'app', 'package.json')),
      adapterImports: adapterImportsReporting((adapter) => adapter !== 'codex'),
    }).then(
      () => undefined,
      (thrown: unknown) => thrown as Error,
    );

    expect(error?.message).toContain('the codex adapter has no runtime installed');
    expect(error?.message).toContain('codex (player "coder")');
    expect(error?.message).toContain(
      'npm install --global=false --location=project --prefix /srv/app @openai/codex-sdk',
    );
    expect(error?.message).toContain(loaded.path);
    // A ready adapter is not reported as a repair the user has to make.
    expect(error?.message).not.toContain('@anthropic-ai/claude-agent-sdk');
  });
});

describe('formatNoRuntimeInstalled', () => {
  it('lists a repair for every supported adapter', () => {
    const message = formatNoRuntimeInstalled({
      target: GLOBAL,
      packageRoot: '/usr/local/lib/node_modules/@sublang/cligent',
    });

    expect(message).toContain('found no agent runtime installed');
    for (const command of [
      // Peer SDKs pin the tree; PATH executables stay bare `-g`.
      'npm install -g --prefix /usr/local @anthropic-ai/claude-agent-sdk',
      'npm install -g --prefix /usr/local @openai/codex-sdk',
      'npm install -g @google/gemini-cli',
      'npm install -g @moonshot-ai/kimi-code@0.27.0',
      'npm install -g --prefix /usr/local @opencode-ai/sdk',
      'npm install -g opencode-ai',
    ]) {
      expect(message).toContain(command);
    }
    // The tree the adapters resolve from, so a layout the canned command
    // cannot repair is still diagnosable.
    expect(message).toContain('/usr/local/lib/node_modules');
  });

  it('prints no peer install command for an unreachable tree', () => {
    const message = formatNoRuntimeInstalled({
      target: {
        scope: 'global',
        moduleRoot: '/odd/node_modules',
        unreachable: true,
      },
      packageRoot: '/odd/node_modules/@sublang/cligent',
    });

    // A command would land in npm's prefix, contradicting the note below it.
    expect(message).not.toContain('npm install -g @anthropic-ai/claude-agent-sdk');
    expect(message).not.toContain('npm install -g @openai/codex-sdk');
    expect(message).toContain(
      'place @anthropic-ai/claude-agent-sdk in /odd/node_modules',
    );
    expect(message).toContain('No npm install command targets that tree');
    // PATH executables are reached through the shell, not cligent's tree, so
    // their commands survive unreachability.
    expect(message).toContain('npm install -g @google/gemini-cli');
  });
});
