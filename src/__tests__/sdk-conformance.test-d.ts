// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type {
  CanUseTool as CurrentClaudeCanUseTool,
  Options as CurrentClaudeOptions,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  CodexOptions as CurrentCodexOptions,
  ThreadOptions as CurrentCodexThreadOptions,
  TurnOptions as CurrentCodexTurnOptions,
} from '@openai/codex-sdk';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import type {
  EventSessionError as CurrentOpenCodeSessionError,
  EventSessionIdle as CurrentOpenCodeSessionIdle,
} from '@opencode-ai/sdk/v2';

import {
  loadClaudeAgentSdk,
  mapAgentOptionsToClaudeQueryOptions,
} from '../adapters/claude-code.js';
import type { ClaudePermissionOptions } from '../adapters/claude-code.js';
import {
  loadCodexSdk,
  mapAgentOptionsToCodexOptions,
} from '../adapters/codex.js';

type InstalledClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk');
type LoadedClaudeSdk = Awaited<ReturnType<typeof loadClaudeAgentSdk>>;
type MappedClaudeOptions = ReturnType<
  typeof mapAgentOptionsToClaudeQueryOptions
>['queryOptions'];
type MappedClaudeCanUseTool = NonNullable<
  ClaudePermissionOptions['canUseTool']
>;

declare const installedClaudeSdk: InstalledClaudeSdk;
declare const mappedClaudeOptions: MappedClaudeOptions;
declare const mappedClaudeCanUseTool: MappedClaudeCanUseTool;
const claudeSdkMirror: LoadedClaudeSdk = installedClaudeSdk;
const currentClaudeOptions: CurrentClaudeOptions = mappedClaudeOptions;
const currentClaudeCanUseTool: CurrentClaudeCanUseTool = mappedClaudeCanUseTool;
type CurrentClaudeSettings = Exclude<
  NonNullable<CurrentClaudeOptions['settings']>,
  string
>;
const currentClaudeUltracodeSettings: CurrentClaudeSettings = {
  ultracode: true,
};
const unsupportedClaudeOptionKeys: Record<
  Exclude<keyof MappedClaudeOptions, keyof CurrentClaudeOptions>,
  never
> = {};
void claudeSdkMirror;
void currentClaudeOptions;
void currentClaudeCanUseTool;
void currentClaudeUltracodeSettings;
void unsupportedClaudeOptionKeys;

type InstalledCodexSdk = typeof import('@openai/codex-sdk');
type LoadedCodexSdk = Awaited<ReturnType<typeof loadCodexSdk>>;
type MappedCodexOptions = ReturnType<typeof mapAgentOptionsToCodexOptions>;

declare const installedCodexSdk: Pick<InstalledCodexSdk, 'Codex'>;
declare const mappedCodexOptions: NonNullable<
  MappedCodexOptions['codexOptions']
>;
declare const mappedCodexThreadOptions: MappedCodexOptions['threadOptions'];
declare const mappedCodexTurnOptions: MappedCodexOptions['runOptions'];
const codexSdkMirror: LoadedCodexSdk = installedCodexSdk;
const currentCodexOptions: CurrentCodexOptions = mappedCodexOptions;
const currentCodexUltraConfig: CurrentCodexOptions = {
  config: { model_reasoning_effort: 'ultra' },
};
const currentCodexThreadOptions: CurrentCodexThreadOptions =
  mappedCodexThreadOptions;
const currentCodexTurnOptions: CurrentCodexTurnOptions = mappedCodexTurnOptions;
const unsupportedCodexOptionKeys: Record<
  Exclude<keyof typeof mappedCodexOptions, keyof CurrentCodexOptions>,
  never
> = {};
const unsupportedCodexThreadOptionKeys: Record<
  Exclude<
    keyof typeof mappedCodexThreadOptions,
    keyof CurrentCodexThreadOptions
  >,
  never
> = {};
const unsupportedCodexTurnOptionKeys: Record<
  Exclude<keyof typeof mappedCodexTurnOptions, keyof CurrentCodexTurnOptions>,
  never
> = {};
declare const currentCodex: InstanceType<InstalledCodexSdk['Codex']>;
const currentStartedThread = currentCodex.startThread(mappedCodexThreadOptions);
const currentResumedThread = currentCodex.resumeThread(
  'conformance-thread',
  mappedCodexThreadOptions,
);
const currentStartedRun = currentStartedThread.runStreamed(
  'conformance prompt',
  mappedCodexTurnOptions,
);
const currentResumedRun = currentResumedThread.runStreamed(
  'conformance prompt',
  mappedCodexTurnOptions,
);
type CurrentCodexStreamResult = Awaited<typeof currentStartedRun>;
declare const currentCodexStreamResult: CurrentCodexStreamResult;
const currentCodexEvents: AsyncIterable<unknown> =
  currentCodexStreamResult.events;
void codexSdkMirror;
void currentCodexOptions;
void currentCodexUltraConfig;
void currentCodexThreadOptions;
void currentCodexTurnOptions;
void unsupportedCodexOptionKeys;
void unsupportedCodexThreadOptionKeys;
void unsupportedCodexTurnOptionKeys;
void currentStartedRun;
void currentResumedRun;
void currentCodexEvents;

const currentOpenCodeClient = createOpencodeClient({
  baseUrl: 'http://127.0.0.1:4096',
});
const currentOpenCodeCreate = currentOpenCodeClient.session.create({
  directory: '/tmp/cligent-open-code',
  permission: [{ permission: 'edit', pattern: '*', action: 'ask' }],
});
const currentOpenCodeUpdate = currentOpenCodeClient.session.update({
  sessionID: 'conformance-session',
  directory: '/tmp/cligent-open-code',
  permission: [{ permission: 'edit', pattern: '*', action: 'ask' }],
});
const currentOpenCodePrompt = currentOpenCodeClient.session.promptAsync({
  sessionID: 'conformance-session',
  directory: '/tmp/cligent-open-code',
  model: { providerID: 'openai', modelID: 'gpt-test' },
  variant: 'high',
  tools: { edit: true, bash: false },
  parts: [{ type: 'text', text: 'conformance prompt' }],
});
const currentOpenCodeSubscribe = currentOpenCodeClient.event.subscribe({
  directory: '/tmp/cligent-open-code',
});
const currentOpenCodeSessionError: CurrentOpenCodeSessionError = {
  id: 'conformance-error-event',
  type: 'session.error',
  properties: {
    sessionID: 'conformance-session',
    error: {
      name: 'APIError',
      data: {
        message: 'effort unavailable',
        statusCode: 400,
        isRetryable: false,
      },
    },
  },
};
const currentOpenCodeSessionIdle: CurrentOpenCodeSessionIdle = {
  id: 'conformance-idle-event',
  type: 'session.idle',
  properties: { sessionID: 'conformance-session' },
};
type CurrentOpenCodeCreateResult = Awaited<typeof currentOpenCodeCreate>;
type CurrentOpenCodeUpdateResult = Awaited<typeof currentOpenCodeUpdate>;
type CurrentOpenCodePromptResult = Awaited<typeof currentOpenCodePrompt>;
type CurrentOpenCodeSubscribeResult = Awaited<typeof currentOpenCodeSubscribe>;
void currentOpenCodeCreate;
void currentOpenCodeUpdate;
void currentOpenCodePrompt;
void currentOpenCodeSubscribe;
void currentOpenCodeSessionError;
void currentOpenCodeSessionIdle;
declare const currentOpenCodeCreateResult: CurrentOpenCodeCreateResult;
declare const currentOpenCodeUpdateResult: CurrentOpenCodeUpdateResult;
declare const currentOpenCodePromptResult: CurrentOpenCodePromptResult;
declare const currentOpenCodeSubscribeResult: CurrentOpenCodeSubscribeResult;
const currentOpenCodeCreatedSession = currentOpenCodeCreateResult.data;
const currentOpenCodeCreateError = currentOpenCodeCreateResult.error;
const currentOpenCodeUpdateError = currentOpenCodeUpdateResult.error;
const currentOpenCodePromptError = currentOpenCodePromptResult.error;
const currentOpenCodeEventStream = currentOpenCodeSubscribeResult.stream;
void currentOpenCodeCreatedSession;
void currentOpenCodeCreateError;
void currentOpenCodeUpdateError;
void currentOpenCodePromptError;
void currentOpenCodeEventStream;
