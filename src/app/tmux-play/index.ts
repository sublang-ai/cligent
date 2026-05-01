// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

export {
  TMUX_PLAY_CONFIG_SNAPSHOT,
  createTmuxPlayConfigSnapshot,
  defineConfig,
  findTmuxPlayConfig,
  loadTmuxPlayConfig,
  writeTmuxPlayConfigSnapshot,
} from './config.js';
export type {
  CaptainConfig,
  JsonPrimitive,
  JsonValue,
  LoadedTmuxPlayConfig,
  LoadTmuxPlayConfigOptions,
  TmuxPlayConfig,
} from './config.js';

export type {
  BossTurn,
  Captain,
  CaptainContext,
  CaptainRunResult,
  CaptainSession,
  CaptainTelemetry,
  RuntimeCaptainConfig,
  RoleHandle,
  RoleRunResult,
  RunStatus,
  RunTmuxPlayOptions,
  RuntimeRoleConfig,
} from './contract.js';

export {
  ObserverDispatchError,
  RecordDispatcher,
  telemetryRecord,
} from './records.js';
export type {
  CaptainStatusRecord,
  CaptainTelemetryRecord,
  RecordObserver,
  RuntimeErrorRecord,
  TmuxPlayRecord,
  TmuxPlayRecordType,
} from './records.js';

export { TmuxPlayRuntime, createTmuxPlayRuntime } from './runtime.js';

export { KNOWN_ROLE_ADAPTERS, isKnownRoleAdapter } from './roles.js';
export type {
  ResolvedRole,
  ResolveRolesOptions,
  RoleAdapterImports,
  RoleAdapterName,
  RoleConfig,
} from './roles.js';
