// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AdapterRegistry,
  ATTACHMENT_SUPPORT,
  Cligent,
  createEvent,
  getAttachmentSupport,
  runAgent,
  runParallel,
} from '../index.js';
import type {
  AgentAdapter,
  AgentEvent,
  AgentOptions,
  Attachment,
} from '../index.js';
import { prepareAttachments, readAttachment } from '../attachments.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cligent-attachments-'));
  await writeFile(join(directory, 'picture.PNG'), Buffer.from([0, 1, 2, 255]));
  await writeFile(join(directory, 'clip.mp4'), 'video bytes');
  await writeFile(join(directory, 'opaque'), 'opaque bytes');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function collect(
  stream: AsyncIterable<AgentEvent>,
): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

describe('local attachment request preparation', () => {
  it('resolves cwd, keeps file order, infers extensions, and reads exact bytes', async () => {
    const input = Object.freeze([
      Object.freeze({ path: 'picture.PNG' }),
      Object.freeze({ path: 'opaque', mimeType: 'VIDEO/MP4' }),
    ]);
    const files = await prepareAttachments('opencode', input, directory);
    expect(files).toEqual([
      { path: join(directory, 'picture.PNG'), mimeType: 'image/png' },
      { path: join(directory, 'opaque'), mimeType: 'video/mp4' },
    ]);
    expect(await readAttachment(files[0])).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(input[1].mimeType).toBe('VIDEO/MP4');
    expect(
      await prepareAttachments('codex', [
        { path: join(directory, 'picture.PNG') },
      ]),
    ).toEqual([files[0]]);
  });

  it.each([
    [null, 'must be an array'],
    ['picture.PNG', 'must be an array'],
    [[null], '.path'],
    [new Array(1), 'attachments[0]'],
    [[{ path: ' ' }], '.path'],
    [[{ path: 'bad\0.png' }], '.path'],
    [[{ path: 'opaque' }], 'unknown file extension'],
    [[{ path: 'picture.PNG', mimeType: 'image/png;evil=value' }], '.mimeType'],
    [[{ path: 'picture.PNG', mimeType: 3 }], '.mimeType'],
    [[{ path: 'picture.PNG', mimeType: 'application/zip' }], 'not supported'],
  ])(
    'rejects invalid dynamic input %j before file access',
    async (value, message) => {
      await expect(
        prepareAttachments('opencode', value, directory),
      ).rejects.toThrow(message);
    },
  );

  it('rejects missing files and directories without opening a provider', async () => {
    await mkdir(join(directory, 'folder.png'));
    for (const path of ['absent.png', 'folder.png']) {
      await expect(
        prepareAttachments('claude-code', [{ path }], directory),
      ).rejects.toThrow('readable regular file');
    }
  });

  it.skipIf(process.platform === 'win32')(
    'follows a regular-file symlink and rejects broken or directory links',
    async () => {
      await symlink(
        join(directory, 'picture.PNG'),
        join(directory, 'linked.png'),
      );
      await symlink(
        join(directory, 'absent.png'),
        join(directory, 'broken.png'),
      );
      await symlink(directory, join(directory, 'folder-link.png'));
      const [attachment] = await prepareAttachments(
        'kimi',
        [{ path: 'linked.png' }],
        directory,
      );
      expect(attachment.path).toBe(join(directory, 'linked.png'));
      expect(await readAttachment(attachment)).toEqual(
        Buffer.from([0, 1, 2, 255]),
      );
      for (const path of ['broken.png', 'folder-link.png']) {
        await expect(
          prepareAttachments('kimi', [{ path }], directory),
        ).rejects.toThrow('readable regular file');
      }
    },
  );

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'rejects files the current process cannot read',
    async () => {
      const path = join(directory, 'picture.PNG');
      await chmod(path, 0);
      try {
        await expect(prepareAttachments('codex', [{ path }])).rejects.toThrow(
          'attachments[0].path for adapter "codex" must name a readable regular file',
        );
      } finally {
        await chmod(path, 0o600);
      }
    },
  );

  it('validates the full MIME list before filesystem work and rejects unsupported adapters', async () => {
    await expect(
      prepareAttachments(
        'codex',
        [{ path: 'missing.png' }, { path: 'clip.mp4' }],
        directory,
      ),
    ).rejects.toThrow('attachments[1]');
    await expect(
      prepareAttachments('custom', [{ path: 'clip.mp4' }], directory),
    ).rejects.toThrow('not supported');
    expect(
      await prepareAttachments('gemini', [{ path: 'clip.mp4' }], directory),
    ).toEqual([{ path: join(directory, 'clip.mp4'), mimeType: 'video/mp4' }]);
    expect(await prepareAttachments('gemini', [], directory)).toEqual([]);
    expect(await prepareAttachments('codex', undefined)).toEqual([]);
  });

  it('honors cancellation while preparing and reading content', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareAttachments(
        'codex',
        [{ path: 'picture.PNG' }],
        directory,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      readAttachment(
        { path: join(directory, 'picture.PNG'), mimeType: 'image/png' },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('publishes immutable transport metadata without claiming model support', () => {
    expect(getAttachmentSupport('claude')).toBe(
      ATTACHMENT_SUPPORT['claude-code'],
    );
    expect(getAttachmentSupport('custom')).toBeUndefined();
    expect(getAttachmentSupport('__proto__')).toBeUndefined();
    expect(Object.isFrozen(ATTACHMENT_SUPPORT)).toBe(true);
    for (const descriptor of Object.values(ATTACHMENT_SUPPORT)) {
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(Object.isFrozen(descriptor.mimeTypes)).toBe(true);
    }
    expect(ATTACHMENT_SUPPORT.opencode.mimeTypes).toContain('video/*');
    expect(ATTACHMENT_SUPPORT.codex.mimeTypes).not.toContain('video/*');
  });
});

function recordingAdapter(agent = 'custom') {
  const calls: Array<{ prompt: string; options?: AgentOptions }> = [];
  const adapter: AgentAdapter = {
    agent,
    isAvailable: async () => true,
    async *run(prompt, options) {
      calls.push({ prompt, options });
      yield createEvent(
        'done',
        agent,
        {
          status: 'success',
          resumeToken: 'session',
          durationMs: 0,
          usage: { toolUses: 0 },
        },
        'session',
      );
    },
  };
  return { calls, adapter };
}

describe('attachment forwarding through public engine entry points', () => {
  it('ignores a dynamic constructor attachment property', async () => {
    const { adapter, calls } = recordingAdapter();
    const defaults = { cwd: directory, attachments: [{ path: 'picture.PNG' }] };
    const agent = new Cligent(adapter, defaults);
    await collect(agent.run('plain'));
    expect(calls[0].options?.attachments).toBeUndefined();
  });

  it('passes attachments once and never adds them to a resumed turn', async () => {
    const { adapter, calls } = recordingAdapter();
    const agent = new Cligent(adapter, { cwd: directory });
    const attachments: readonly Attachment[] = Object.freeze([
      { path: 'picture.PNG' },
    ]);
    await collect(agent.run('inspect', { attachments }));
    await collect(agent.run('continue'));
    expect(calls[0].options?.attachments).toBe(attachments);
    expect(calls[0].prompt).toBe('inspect');
    expect(calls[1].options?.attachments).toBeUndefined();
    expect(calls[1].options?.resume).toBe('session');
  });

  it('forwards independent lists through registry and both parallel APIs', async () => {
    const a = recordingAdapter('custom-a');
    const b = recordingAdapter('custom-b');
    const first = [{ path: 'picture.PNG' }];
    const second = [{ path: 'clip.mp4' }];
    const registry = new AdapterRegistry();
    registry.register(a.adapter);
    await collect(
      runAgent('custom-a', 'registered', { attachments: first }, registry),
    );
    await collect(
      runParallel([
        { adapter: a.adapter, prompt: 'a', options: { attachments: first } },
        { adapter: b.adapter, prompt: 'b', options: { attachments: second } },
      ]),
    );
    await collect(
      Cligent.parallel([
        {
          agent: new Cligent(a.adapter),
          prompt: 'a',
          overrides: { attachments: first },
        },
        {
          agent: new Cligent(b.adapter),
          prompt: 'b',
          overrides: { attachments: second },
        },
      ]),
    );
    expect(a.calls.map((call) => call.options?.attachments)).toEqual([
      first,
      first,
      first,
    ]);
    expect(b.calls.map((call) => call.options?.attachments)).toEqual([
      second,
      second,
    ]);
  });

  it('isolates an unsupported attachment failure from another parallel agent', async () => {
    const rejecting: AgentAdapter = {
      agent: 'codex',
      isAvailable: async () => true,
      async *run(_prompt, options) {
        await prepareAttachments('codex', options?.attachments, options?.cwd);
        yield createEvent(
          'done',
          'codex',
          {
            status: 'success',
            usage: { toolUses: 0 },
            durationMs: 0,
          },
          'session',
        );
      },
    };
    const working = recordingAdapter('custom-video');
    const events = await collect(
      Cligent.parallel([
        {
          agent: new Cligent(rejecting),
          prompt: 'clip',
          overrides: { attachments: [{ path: 'clip.mp4' }] },
        },
        {
          agent: new Cligent(working.adapter),
          prompt: 'clip',
          overrides: { attachments: [{ path: 'clip.mp4' }] },
        },
      ]),
    );
    expect(
      events
        .filter((event) => event.type === 'done')
        .map((event) => [event.agent, event.payload.status]),
    ).toEqual(
      expect.arrayContaining([
        ['codex', 'error'],
        ['custom-video', 'success'],
      ]),
    );
    expect(events.filter((event) => event.type === 'done')).toHaveLength(2);
  });
});
