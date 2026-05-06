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

function errorEvent(message: string): CligentEvent {
  return createEvent('error', 'codex', { message, recoverable: false }, 'sid');
}

function doneEvent(): CligentEvent {
  return createEvent(
    'done',
    'codex',
    {
      status: 'interrupted',
      usage: { inputTokens: 1, outputTokens: 0, toolUses: 0 },
      durationMs: 100,
    },
    'sid',
  );
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

    presenter.onRecord(rolePrompt('coder', 'implement\nfeature'));
    presenter.onRecord(roleEvent('coder', textEvent('done\nagain')));
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
      'captain> implement\n' +
        'captain> feature\n' +
        'coder> done\n' +
        'coder> again\n',
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
      'captain> [status] reviewing {"roleCount":1}\n' +
        'captain> answer\n' +
        'captain> [runtime error: observer failed]\n',
    );
    expect(coder.text()).toBe('');
  });

  it('renders final failures once with speaker prefixes', () => {
    const boss = new MemoryWriter();
    const coder = new MemoryWriter();
    const presenter = createTmuxPresenter({
      boss,
      roles: new Map([['coder', coder]]),
    });

    presenter.onRecord(roleEvent('coder', errorEvent('role failed')));
    presenter.onRecord({
      type: 'role_finished',
      turnId: 1,
      timestamp: 100,
      roleId: 'coder',
      result: {
        status: 'error',
        roleId: 'coder',
        turnId: 1,
        error: 'role failed',
      },
    });
    presenter.onRecord({
      type: 'captain_event',
      turnId: 1,
      timestamp: 101,
      event: errorEvent('captain failed'),
    });
    presenter.onRecord({
      type: 'captain_finished',
      turnId: 1,
      timestamp: 102,
      result: {
        status: 'error',
        turnId: 1,
        error: 'captain failed',
      },
    });
    presenter.onRecord({
      type: 'role_finished',
      turnId: 2,
      timestamp: 103,
      roleId: 'coder',
      result: {
        status: 'aborted',
        roleId: 'coder',
        turnId: 2,
      },
    });
    presenter.onRecord({
      type: 'captain_event',
      turnId: 2,
      timestamp: 104,
      event: doneEvent(),
    });
    presenter.onRecord({
      type: 'captain_finished',
      turnId: 2,
      timestamp: 105,
      result: {
        status: 'aborted',
        turnId: 2,
      },
    });

    expect(coder.text()).toBe(
      'coder> [error: role failed]\n' +
        'coder> [aborted]\n',
    );
    expect(boss.text()).toBe(
      'captain> [error: captain failed]\n' +
        'captain> [aborted]\n',
    );
  });

  it('omits Boss prompt re-echo and Captain prompt bodies', () => {
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
      type: 'captain_prompt',
      turnId: 1,
      timestamp: 101,
      prompt: '=== role:coder status:ok ===\nraw role text\n=== /role:coder ===',
    });

    expect(boss.text()).toBe('');
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

    expect(boss.text()).toBe('captain> [status] ready [unserializable data]\n');
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
