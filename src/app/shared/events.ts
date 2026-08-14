// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { CligentEvent, TokenUsage } from '../../types.js';

/** Render only the exact subsets the producer reported (ENG-031). */
function formatTokenDetails(tokens: TokenUsage): string {
  const parts = [
    ['fresh', tokens.input.uncached],
    ['cache-read', tokens.input.cacheRead],
    ['cache-write', tokens.input.cacheWrite],
    ['visible', tokens.output.visible],
    ['reasoning', tokens.output.reasoning],
  ].flatMap(([label, value]) =>
    typeof value === 'number' ? [`${label} ${value}`] : [],
  );

  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

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
        usage: {
          tokens?: {
            coverage: 'complete' | 'partial';
            totals: TokenUsage;
          };
        };
      };
      if (!p.usage.tokens) {
        return `\n[${p.status} | tokens: unavailable]\n`;
      }
      const { coverage, totals } = p.usage.tokens;
      const detail = formatTokenDetails(totals);
      const scope = coverage === 'partial' ? ' | coverage: partial' : '';
      return `\n[${p.status} | in: ${totals.input.total} out: ${totals.output.total}${detail}${scope}]\n`;
    }
    default:
      return null;
  }
}
