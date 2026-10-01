// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { Cligent } from '../cligent.js';
import { createEvent } from '../events.js';
import { mediaFromMcpContent, mediaFromUri } from '../media.js';
import type { AgentAdapter, AgentEvent, MediaPayload } from '../types.js';

function outputAdapter(agent: string, payload: MediaPayload): AgentAdapter {
  return {
    agent,
    async isAvailable() {
      return true;
    },
    async *run() {
      yield createEvent('media', agent, payload, `${agent}-session`);
      yield createEvent(
        'text',
        agent,
        { content: 'Explanation.' },
        `${agent}-session`,
      );
      yield createEvent(
        'done',
        agent,
        {
          status: 'success',
          result: 'Explanation.',
          usage: { toolUses: 0 },
          durationMs: 1,
        },
        `${agent}-session`,
      );
    },
  };
}

describe('normalized media through the engine', () => {
  it('preserves inline media and opaque URI sources independently across parallel roles', async () => {
    const image = mediaFromMcpContent({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'cGl4ZWw=' },
    })[0]!;
    const file = mediaFromUri('file:///a/remote-runtime/private%20screen.png', {
      mimeType: 'image/png',
      name: 'Screen',
    })!;
    const events: AgentEvent[] = [];
    for await (const event of Cligent.parallel([
      {
        agent: new Cligent(outputAdapter('image-agent', image), {
          role: 'visual',
        }),
        prompt: 'Inspect',
      },
      {
        agent: new Cligent(outputAdapter('file-agent', file), {
          role: 'reader',
        }),
        prompt: 'Explain',
      },
    ]))
      events.push(event);
    const media = events.filter((event) => event.type === 'media');
    expect(media).toHaveLength(2);
    expect(media).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent: 'image-agent',
          role: 'visual',
          sessionId: 'image-agent-session',
          payload: image,
        }),
        expect.objectContaining({
          agent: 'file-agent',
          role: 'reader',
          sessionId: 'file-agent-session',
          payload: file,
        }),
      ]),
    );
    for (const agent of ['image-agent', 'file-agent']) {
      const own = events.filter((event) => event.agent === agent);
      expect(own.map((event) => event.type)).toEqual(['media', 'text', 'done']);
      expect(own.at(-1)?.payload).toMatchObject({
        result: 'Explanation.',
        usage: { toolUses: 0 },
      });
    }
  });

  it('normalizes only explicit native sources, preserving URLs and skipping malformed bytes', async () => {
    const content = [
      { type: 'text', text: '![image](file:///not-read.png)' },
      { arbitrary: { type: 'image', mimeType: 'image/png', data: 'cGl4ZWw=' } },
      { type: 'image', data: 'invalid!' },
      { type: 'image', data: '   ' },
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.test/screen' },
      },
      { type: 'resource_link', name: 'opaque', uri: 'custom:resource' },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'cGRm' },
      },
    ];
    const payloads = mediaFromMcpContent(content, 'tool-1');
    expect(payloads).toEqual([
      {
        mimeType: 'application/octet-stream',
        source: { type: 'uri', uri: 'https://example.test/screen' },
        toolUseId: 'tool-1',
      },
      {
        mimeType: 'application/octet-stream',
        source: { type: 'uri', uri: 'custom:resource' },
        name: 'opaque',
        toolUseId: 'tool-1',
      },
      {
        mimeType: 'application/pdf',
        source: { type: 'base64', data: 'cGRm' },
        toolUseId: 'tool-1',
      },
    ]);
    expect(
      mediaFromUri('data:image/png;base64,cGl4ZWw=', {
        mimeType: 'image/jpeg',
      }),
    ).toEqual({
      mimeType: 'image/png',
      source: { type: 'base64', data: 'cGl4ZWw=' },
    });
    expect(mediaFromUri('data:image/png;base64,broken')).toBeUndefined();
    expect(mediaFromUri('data:image/png,not-base64')).toBeUndefined();
    expect(content[0]).toEqual({
      type: 'text',
      text: '![image](file:///not-read.png)',
    });
  });
});
