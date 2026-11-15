// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

declare module '@anthropic-ai/claude-agent-sdk' {
  export function query(options: unknown): AsyncIterable<unknown>;
}
