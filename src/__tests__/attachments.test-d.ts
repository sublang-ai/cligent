// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { Cligent, runParallel } from '../index.js';
import type {
  AgentOptions,
  Attachment,
  CligentOptions,
  CodexEffort,
  RunOptions,
} from '../index.js';
import { CodexAdapter } from '../adapters/codex.js';

const attachments: readonly Attachment[] = [{ path: 'photo.png' }] as const;
const options: AgentOptions<CodexEffort, boolean> = { attachments };
const overrides: RunOptions<CodexEffort, boolean> = { attachments };
const agent = new Cligent(new CodexAdapter());
void agent.run('describe', overrides);
void runParallel([
  { adapter: new CodexAdapter(), prompt: 'describe', options },
]);
// @ts-expect-error Attachments belong to a turn, never instance defaults.
const defaults: CligentOptions = { attachments };
// @ts-expect-error Attachment bytes are supplied through a local file path.
const invalid: Attachment = { data: 'base64' };
void defaults;
void invalid;
