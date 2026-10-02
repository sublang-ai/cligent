// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { Cligent, createEvent } from '../index.js';
import type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  CligentOptions,
  RunOptions,
} from '../index.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { CodexAdapter } from '../adapters/codex.js';
import { GeminiAdapter } from '../adapters/gemini.js';

const approvalHandler: ApprovalHandler = async (request, { signal }) => {
  void signal.aborted;
  void request.details;
  return request.choices.includes('allow_once') ? 'allow_once' : 'deny';
};
const options = { approvalHandler } satisfies RunOptions;
void new Cligent(new ClaudeCodeAdapter()).run('work', options);
void new Cligent(new CodexAdapter()).run('work', { approvalHandler });
void new Cligent(new GeminiAdapter()).run('work', { approvalHandler });
// @ts-expect-error Callbacks are never retained as instance defaults.
const defaults: CligentOptions = { approvalHandler };
// @ts-expect-error Persistent grants are not portable live decisions.
const persistent: ApprovalDecision = 'allow_always';
declare const request: ApprovalRequest;
// @ts-expect-error The host cannot rewrite the request identity.
request.id = 'replacement';
// @ts-expect-error The host cannot add native or persistent actions.
request.choices.push('allow_once');
void createEvent('approval_request', 'claude-code', request);
void createEvent('approval_response', 'claude-code', {
  requestId: request.id,
  decision: 'deny',
  source: 'cancelled',
});
void defaults;
void persistent;
