// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { CligentEvent } from '../../types.js';

export function formatCligentEvent(event: CligentEvent): string | null {
  switch (event.type) {
    case 'text_delta':
      return (event.payload as { delta: string }).delta;
    case 'text':
      return (event.payload as { content: string }).content + '\n';
    case 'tool_use':
      return `[tool: ${(event.payload as { toolName: string }).toolName}]\n`;
    case 'tool_result': {
      const output = (event.payload as { output: unknown }).output;
      if (typeof output === 'string') return output + '\n';
      if (typeof output === 'object' && output !== null && 'stdout' in output) {
        return String((output as { stdout: unknown }).stdout) + '\n';
      }
      return JSON.stringify(output) + '\n';
    }
    case 'error':
      return `[error: ${(event.payload as { message: string }).message}]\n`;
    case 'done': {
      const p = event.payload as {
        status: string;
        usage: { inputTokens: number; outputTokens: number };
      };
      return `\n[${p.status} | in: ${p.usage.inputTokens} out: ${p.usage.outputTokens}]\n`;
    }
    default:
      return null;
  }
}
