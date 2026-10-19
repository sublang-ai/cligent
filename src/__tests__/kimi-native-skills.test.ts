// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// kimi-55: `nativeSkills: false` rejects before browser preparation and
// before `kimi acp` is spawned, while `true` and an omitted value reach the
// spawn. The browser preparation and the spawner record whether they ran.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KimiAdapter } from '../adapters/kimi.js';
import type { AgentEvent } from '../types.js';

const browserPreparation = vi.hoisted(() => vi.fn());
vi.mock('../browser.js', () => ({
  prepareBrowserServer: browserPreparation,
  releaseBrowserServer: async () => {},
}));

async function settle(
  run: AsyncGenerator<AgentEvent, void, void>,
): Promise<{ events: AgentEvent[]; thrown?: unknown }> {
  const events: AgentEvent[] = [];
  try {
    for await (const event of run) events.push(event);
  } catch (thrown) {
    return { events, thrown };
  }
  return { events };
}

describe('Kimi native skills (kimi-55)', () => {
  beforeEach(() => {
    vi.stubEnv('CLIGENT_RUNTIME_GATE', 'off');
    browserPreparation.mockReset();
    browserPreparation.mockRejectedValue(new Error('browser reached'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function adapter(): { kimi: KimiAdapter; spawns: string[] } {
    const spawns: string[] = [];
    const kimi = new KimiAdapter({
      spawnProcess: (command: string) => {
        spawns.push(command);
        throw new Error('spawn reached');
      },
    });
    return { kimi, spawns };
  }

  it('rejects false before browser preparation and spawning', async () => {
    const { kimi, spawns } = adapter();
    const outcome = await settle(
      kimi.run('p', { nativeSkills: false, browser: true }),
    );
    const message =
      outcome.thrown instanceof Error
        ? outcome.thrown.message
        : (
            outcome.events.find((event) => event.type === 'error')?.payload as
              { message: string } | undefined
          )?.message;
    expect(message).toBe(
      'nativeSkills: false for adapter "kimi" cannot be honored: its runtime offers no per-run lever that turns its own skill discovery off',
    );
    expect(browserPreparation).not.toHaveBeenCalled();
    expect(spawns).toEqual([]);
  });

  it('reaches the spawn with true or an omitted value', async () => {
    for (const options of [{ nativeSkills: true }, {}]) {
      const { kimi, spawns } = adapter();
      await settle(kimi.run('p', options));
      expect(spawns).toEqual(['kimi']);
    }
  });
});
