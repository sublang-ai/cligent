// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

declare module '@anthropic-ai/claude-agent-sdk' {
  export function getSessionMessages(
    sessionId: string,
    options: { dir: string },
  ): Promise<ReadonlyArray<{ type: string; message: unknown }>>;
  export function query(options: unknown): AsyncIterable<unknown>;
}
