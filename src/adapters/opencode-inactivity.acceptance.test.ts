// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// opencode-54: a real managed OpenCode server supplies the session.status
// recovery seam while the adapter deliberately receives no terminal SSE
// event. This keeps the regression probe short and credential-free while
// exercising the vendor status endpoint, SDK disposal, iterator cancellation,
// and managed-process shutdown used by a genuine inactivity recovery.

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { describe, expect, it } from 'vitest';

import type { AgentEvent, DonePayload, ErrorPayload } from '../index.js';
import { OpenCodeAdapter, wrapOpencodeClient } from './opencode.js';

const available = isExecutableAvailable();
const acceptanceIt = available || process.env.CI ? it : it.skip;

describe('OpenCode inactivity real-server acceptance (opencode-54)', () => {
  acceptanceIt(
    'recovers a real idle status and releases the stream, client, and server',
    async () => {
      if (!available) {
        throw new Error('Missing OpenCode CLI required by acceptance CI');
      }

      const cwd = mkdtempSync(join(process.cwd(), 'cligent-ocinactivity-'));
      let serverProcess: ChildProcessWithoutNullStreams | undefined;
      let serverClose: Promise<void> | undefined;
      let clientCloseCalls = 0;

      try {
        const adapter = new OpenCodeAdapter(
          {
            mode: 'managed',
            eventInactivityTimeoutMs: 1_000,
            readyTimeoutMs: 10_000,
          },
          {
            spawnProcess(command, args, options) {
              serverProcess = spawn(command, [...args], {
                ...options,
                env: {
                  ...process.env,
                  XDG_CACHE_HOME: join(cwd, 'xdg-cache'),
                  XDG_CONFIG_HOME: join(cwd, 'xdg-config'),
                  XDG_DATA_HOME: join(cwd, 'xdg-data'),
                },
              }) as ChildProcessWithoutNullStreams;
              serverClose = new Promise<void>((resolve) => {
                serverProcess!.once('close', () => resolve());
              });
              return serverProcess;
            },
            async loadSdk() {
              return {
                createClient({ baseUrl } = {}) {
                  const real = createOpencodeClient({ baseUrl });
                  const wrapped = wrapOpencodeClient(real, {
                    apiVersion: 'v2',
                  });

                  return {
                    ...wrapped,
                    async run(options: Record<string, unknown>) {
                      const cwdOption =
                        typeof options.cwd === 'string'
                          ? options.cwd
                          : undefined;
                      const created = await real.session.create(
                        cwdOption ? { directory: cwdOption } : undefined,
                      );
                      if (created.error) {
                        throw new Error(
                          `OpenCode session.create failed: ${JSON.stringify(created.error)}`,
                        );
                      }
                      const session = created.data;
                      if (!session?.id) {
                        throw new Error(
                          'OpenCode session.create returned no session id',
                        );
                      }

                      const signal = options.signal as AbortSignal | undefined;
                      const subscription = await real.event.subscribe(
                        cwdOption ? { directory: cwdOption } : undefined,
                        signal ? { signal } : undefined,
                      );
                      return {
                        id: session.id,
                        sessionId: session.id,
                        events: subscription.stream,
                      };
                    },
                    async close() {
                      clientCloseCalls++;
                      await wrapped.close?.();
                    },
                  };
                },
              };
            },
          },
        );

        const events: AgentEvent[] = [];
        for await (const event of adapter.run('status-only liveness probe', {
          cwd,
        })) {
          events.push(event);
        }

        expect(events.map((event) => event.type)).toEqual([
          'init',
          'error',
          'done',
        ]);
        const diagnostic = events[1]!.payload as ErrorPayload & {
          code?: string;
        };
        expect(diagnostic, diagnostic.message).toMatchObject({
          code: 'OPENCODE_INACTIVITY_IDLE_RECOVERED',
          recoverable: true,
        });
        expect(diagnostic.message).toContain(
          'queriedSessionState={"type":"idle"}',
        );
        expect((events[2]!.payload as DonePayload).status).toBe('success');
        expect(clientCloseCalls).toBe(1);
        expect(serverClose).toBeDefined();
        await serverClose;
        expect(serverProcess).toBeDefined();
        expect(
          serverProcess!.exitCode !== null ||
            serverProcess!.signalCode !== null,
        ).toBe(true);
      } finally {
        if (serverProcess && serverProcess.exitCode === null) {
          serverProcess.kill('SIGTERM');
        }
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    15_000,
  );
});

function isExecutableAvailable(): boolean {
  const result = spawnSync('opencode', ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  return (result.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT';
}
