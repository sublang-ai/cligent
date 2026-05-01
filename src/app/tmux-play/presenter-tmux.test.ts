// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { describe, expect, it } from 'vitest';
import { createEvent } from '../../events.js';
import type { CligentEvent } from '../../types.js';
import { createTmuxPresenter } from './presenter-tmux.js';
import type { TmuxPlayRecord } from './records.js';

class MemoryWriter {
  readonly chunks: string[] = [];

  write(value: string): void {
    this.chunks.push(value);
  }

  text(): string {
    return this.chunks.join('');
  }
}

function textEvent(content: string): CligentEvent {
  return createEvent('text', 'codex', { content }, 'sid');
}

describe('TmuxPresenter', () => {
  it('routes role records to the matching role log', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const reviewer = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map([
        ['coder', coder],
        ['reviewer', reviewer],
      ]),
    });

    presenter.onRecord(rolePrompt('coder', 'implement feature'));
    presenter.onRecord(roleEvent('coder', textEvent('done')));
    presenter.onRecord({
      type: 'role_finished',
      turnId: 1,
      timestamp: 102,
      roleId: 'coder',
      result: {
        status: 'ok',
        roleId: 'coder',
        turnId: 1,
        finalText: 'done',
      },
    });

    expect(coder.text()).toBe(
      '[captain prompt]\nimplement feature\n\ndone\n[role coder ok]\n',
    );
    expect(reviewer.text()).toBe('');
    expect(boss.text()).toBe('');
  });

  it('routes Boss and Captain records to the Boss pane', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord({
      type: 'turn_started',
      turnId: 1,
      timestamp: 100,
      turn: {
        id: 1,
        prompt: 'ship it',
        timestamp: 100,
      },
    });
    presenter.onRecord({
      type: 'captain_status',
      turnId: 1,
      timestamp: 101,
      message: 'reviewing',
      data: { roleCount: 1 },
    });
    presenter.onRecord({
      type: 'captain_prompt',
      turnId: 1,
      timestamp: 102,
      prompt: 'summarize role output',
    });
    presenter.onRecord({
      type: 'captain_event',
      turnId: 1,
      timestamp: 103,
      event: textEvent('answer'),
    });
    presenter.onRecord({
      type: 'captain_finished',
      turnId: 1,
      timestamp: 104,
      result: {
        status: 'ok',
        turnId: 1,
        finalText: 'answer',
      },
    });
    presenter.onRecord({
      type: 'runtime_error',
      turnId: 1,
      timestamp: 105,
      message: 'observer failed',
    });
    presenter.onRecord({
      type: 'turn_finished',
      turnId: 1,
      timestamp: 106,
    });

    expect(boss.text()).toBe(
      'boss> ship it\n\n' +
        '[status] reviewing {"roleCount":1}\n' +
        '[captain prompt]\nsummarize role output\n\n' +
        'answer\n' +
        '[captain ok]\n' +
        '[runtime error: observer failed]\n' +
        '[turn finished]\n',
    );
    expect(coder.text()).toBe('');
  });

  it('ignores captain telemetry', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord({
      type: 'captain_telemetry',
      turnId: null,
      timestamp: 100,
      topic: 'sketch.highlight',
      payload: { state: 'done' },
    });

    expect(boss.text()).toBe('');
    expect(coder.text()).toBe('');
  });

  it('does not fail on unserializable status data', () => {
    const boss = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map(),
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    presenter.onRecord({
      type: 'captain_status',
      turnId: null,
      timestamp: 100,
      message: 'ready',
      data: circular,
    });

    expect(boss.text()).toBe('[status] ready [unserializable data]\n');
  });

  it('fails when a role log writer is missing', () => {
    const presenter = createTmuxPresenter({
      boss: new MemoryWriter(),
      roles: new Map(),
    });

    expect(() =>
      presenter.onRecord(rolePrompt('coder', 'implement feature')),
    ).toThrow('Missing tmux presenter writer for role: coder');
  });
});

function rolePrompt(roleId: string, prompt: string): TmuxPlayRecord {
  return {
    type: 'role_prompt',
    turnId: 1,
    timestamp: 100,
    roleId,
    prompt,
  };
}

function roleEvent(roleId: string, event: CligentEvent): TmuxPlayRecord {
  return {
    type: 'role_event',
    turnId: 1,
    timestamp: 101,
    roleId,
    event,
  };
}
