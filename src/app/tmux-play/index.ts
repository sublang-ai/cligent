// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

export {
  TMUX_PLAY_CONFIG_SNAPSHOT,
  TMUX_PLAY_CONFIG_FILE,
  TMUX_PLAY_HOME_CONFIG,
  NOTIFICATION_EVENTS,
  NOTIFICATION_SINKS,
  defaultNotificationConfig,
  createTmuxPlayConfigSnapshot,
  findTmuxPlayConfig,
  loadTmuxPlayConfig,
  writeTmuxPlayConfigSnapshot,
} from './config.js';
export type {
  CaptainConfig,
  JsonPrimitive,
  JsonValue,
  LegacyEffortDeprecation,
  LoadedTmuxPlayConfig,
  LoadTmuxPlayConfigOptions,
  NotificationConfig,
  NotificationEvent,
  NotificationSink,
  TmuxPlayConfig,
} from './config.js';

export type {
  BossTurn,
  CallCaptainOptions,
  CallPlayerOptions,
  Captain,
  CaptainContext,
  CaptainRunResult,
  CaptainSession,
  CaptainTelemetry,
  RecordVisibility,
  RuntimeCaptainConfig,
  PlayerHandle,
  PlayerRunResult,
  RunStatus,
  RunTmuxPlayOptions,
  RuntimePlayerConfig,
} from './contract.js';

export {
  ObserverDispatchError,
  RecordDispatcher,
  telemetryRecord,
} from './records.js';
export type {
  CaptainStatusRecord,
  CaptainTelemetryRecord,
  PlayerViewChangedRecord,
  RecordObserver,
  RuntimeErrorRecord,
  TmuxPlayRecord,
  TmuxPlayRecordType,
} from './records.js';

export { TmuxPlayRuntime, createTmuxPlayRuntime } from './runtime.js';

export {
  NotificationObserver,
  createNotificationObserver,
} from './notification-observer.js';
export type {
  DetachedNotificationSpawner,
  NotificationObserverOptions,
} from './notification-observer.js';

export { KNOWN_PLAYER_ADAPTERS, isKnownPlayerAdapter } from './players.js';
export type {
  ResolvedPlayer,
  ResolvePlayersOptions,
  PlayerAdapterImports,
  PlayerAdapterName,
  PlayerConfig,
} from './players.js';
