// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { getAttachmentSupport, type AttachmentSupport } from './attachments.js';
import { normalizeMcpServers, type McpOptions } from './mcp.js';
import type { AgentOptions, RunOptions } from './types.js';

export type CapabilityRestriction =
  | 'unsupported-transport'
  | 'unsupported-host'
  | 'unsupported-server-mode'
  | 'tool-restriction'
  | 'native-sandbox'
  | 'workspace-is-home'
  | 'unsupported-permissions'
  | 'unsupported-option';
export type CapabilityState =
  | { readonly status: 'supported' }
  | {
      readonly status: 'unsupported';
      readonly code: CapabilityRestriction;
      readonly message: string;
    }
  | { readonly status: 'unknown'; readonly message?: string };
export interface AgentCapabilities {
  /** Absent means unknown; an empty known MIME set means unsupported. */
  readonly attachments?: AttachmentSupport;
  /** Native host-decision transport; absent means unknown. */
  readonly approvals?: CapabilityState;
  /** Admission support only, independent of installation, model and account. */
  readonly browser: CapabilityState;
  /** Absent means unknown; an empty known source set means unsupported. */
  readonly media?: {
    readonly sources: readonly ('base64' | 'uri')[];
    readonly notes?: string;
  };
}
export type CapabilityOptions<
  E extends string = string,
  FM extends boolean = boolean,
  SM extends string = string,
  SE extends string = string,
> = Omit<
  RunOptions<E, FM, SM, SE>,
  'attachments' | 'resume' | 'approvalHandler'
>;
export type AdapterCapabilityOptions<
  E extends string = string,
  FM extends boolean = boolean,
  SM extends string = string,
  SE extends string = string,
> = Omit<
  AgentOptions<E, FM, SM, SE>,
  'attachments' | 'resume' | 'approvalHandler'
>;
export interface BrowserSetupProgress {
  readonly stage: 'checking' | 'installing' | 'launching';
}
export type BrowserSetupFailure =
  | CapabilityRestriction
  | 'unknown-capability'
  | 'runtime-unavailable'
  | 'node-runtime-unsupported'
  | 'runtime-layout-unusable'
  | 'install-failed'
  | 'launch-failed'
  | 'timeout';
export type BrowserSetupResult =
  | { readonly status: 'ready'; readonly checkedAt: number }
  | {
      readonly status: 'not-ready';
      readonly code: BrowserSetupFailure;
      readonly message: string;
    }
  | { readonly status: 'cancelled' };
export type BrowserSetupOptions<
  E extends string = string,
  FM extends boolean = boolean,
  SM extends string = string,
  SE extends string = string,
> = Omit<CapabilityOptions<E, FM, SM, SE>, 'browser'> & {
  readonly timeoutMs?: number;
  readonly onProgress?: (progress: BrowserSetupProgress) => void;
};

export class CapabilityError extends Error {
  constructor(
    readonly code: CapabilityRestriction,
    message: string,
  ) {
    super(message);
    this.name = 'CapabilityError';
  }
}

export function assertBrowserHost(): void {
  if (
    !['darwin', 'linux', 'win32'].includes(process.platform) ||
    !['x64', 'arm64'].includes(process.arch)
  )
    throw new CapabilityError(
      'unsupported-host',
      `The managed browser is not supported on ${process.platform}-${process.arch}`,
    );
}

/** Built-ins call their own admission validator; custom names imply nothing. */
export async function describeCapabilities(
  agent: string,
  validate: () => void | Promise<void>,
  options?: McpOptions,
): Promise<AgentCapabilities> {
  let browser: CapabilityState = { status: 'supported' };
  try {
    assertBrowserHost();
    const servers = normalizeMcpServers(options?.mcpServers);
    if (options?.browser !== undefined && typeof options.browser !== 'boolean')
      throw new Error('browser must be a boolean');
    if (servers && Object.hasOwn(servers, 'cligent_browser'))
      throw new Error('cligent_browser is reserved when browser is enabled');
    await validate();
  } catch (error) {
    browser = {
      status: 'unsupported',
      code:
        error instanceof CapabilityError ? error.code : 'unsupported-option',
      message:
        error instanceof Error
          ? error.message
          : 'Browser configuration is unsupported',
    };
  }
  return Object.freeze({
    attachments: getAttachmentSupport(agent),
    browser: Object.freeze(browser),
    approvals: Object.freeze(
      agent === 'codex' || agent === 'gemini'
        ? {
            status: 'unsupported' as const,
            code: 'unsupported-transport' as const,
            message: `${agent === 'codex' ? 'Codex exec SDK' : 'Gemini NDJSON'} cannot return live host permission decisions.`,
          }
        : { status: 'supported' as const },
    ),
    media: Object.freeze({
      sources: Object.freeze(
        agent === 'gemini' ? [] : (['base64', 'uri'] as const),
      ),
      ...(agent === 'gemini'
        ? {
            notes:
              'The native model loop can receive screenshots, but the CLI stream omits their bytes.',
          }
        : {}),
    }),
  });
}
