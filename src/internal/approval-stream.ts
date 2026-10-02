// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { AgentEvent } from '../types.js';

/** Wake the event consumer even while a native iterator waits for permission. */
export class ApprovalEventStream {
  private readonly events: AgentEvent[] = [];
  private wake: (() => void) | undefined;
  readonly emit = (event: AgentEvent): void => {
    this.events.push(event);
    this.wake?.();
    this.wake = undefined;
  };

  drain(): AgentEvent[] {
    return this.events.splice(0);
  }

  async *merge<T>(
    source: AsyncIterable<T>,
    close: () => void,
    cancel?: () => void,
  ): AsyncGenerator<{ event: AgentEvent } | { message: T }> {
    const iterator = source[Symbol.asyncIterator]();
    const read = () =>
      iterator.next().then(
        (result) => ({ kind: 'message' as const, result }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      );
    let next = read();
    let ended = false;
    try {
      while (true) {
        while (this.events.length) yield { event: this.events.shift()! };
        const ready = await Promise.race([
          next,
          new Promise<{ kind: 'event' }>((resolve) => {
            this.wake = () => resolve({ kind: 'event' });
          }),
        ]);
        this.wake = undefined;
        if (ready.kind === 'event') continue;
        if (ready.kind === 'error' || ready.result.done) close();
        // Native settlement and callback events can resolve in the same tick.
        while (this.events.length) yield { event: this.events.shift()! };
        if (ready.kind === 'error') {
          ended = true;
          throw ready.error;
        }
        if (ready.result.done) {
          ended = true;
          return;
        }
        yield { message: ready.result.value };
        next = read();
      }
    } finally {
      close();
      this.wake = undefined;
      if (!ended) {
        cancel?.();
        // An upstream iterator may ignore cancellation while next() is pending.
        // Do not leave the host's generator.return() behind that native wait.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve(iterator.return?.()).catch(() => undefined),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 500);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
    }
  }
}
