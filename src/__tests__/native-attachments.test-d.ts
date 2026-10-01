// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Input } from '@openai/codex-sdk';
import type { loadClaudeAgentSdk } from '../adapters/claude-code.js';
import type { loadCodexSdk } from '../adapters/codex.js';

type ClaudeSdk = Awaited<ReturnType<typeof loadClaudeAgentSdk>>;
type ClaudePrompt = Parameters<ClaudeSdk['query']>[0]['prompt'];
type CodexSdk = Awaited<ReturnType<typeof loadCodexSdk>>;
type CodexThread = ReturnType<InstanceType<CodexSdk['Codex']>['startThread']>;
type CodexInput = Parameters<NonNullable<CodexThread['runStreamed']>>[0];

declare const claudePrompt: ClaudePrompt;
declare const codexInput: CodexInput;
const currentClaudePrompt: string | AsyncIterable<SDKUserMessage> =
  claudePrompt;
const currentCodexInput: Input = codexInput;
void currentClaudePrompt;
void currentCodexInput;
