// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

declare module '@openai/codex-sdk' {
  export type CodexDefaultPermissions =
    | ':danger-full-access'
    | ':workspace'
    | ':read-only';
  export type CodexApprovalsReviewer = 'auto_review';
  export type CodexConfigValue =
    | string
    | number
    | boolean
    | CodexConfigValue[]
    | { [key: string]: CodexConfigValue | undefined };

  export interface CodexOptions {
    codexPathOverride?: string;
    baseUrl?: string;
    apiKey?: string;
    config?: {
      [key: string]: CodexConfigValue | undefined;
      default_permissions?: CodexDefaultPermissions;
      approvals_reviewer?: CodexApprovalsReviewer;
    };
    env?: Record<string, string>;
  }

  export class Codex {
    constructor(options?: CodexOptions);
    startThread(options?: unknown): unknown;
    resumeThread?(threadId: string, options?: unknown): unknown;
  }
}
