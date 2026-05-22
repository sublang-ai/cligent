// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import {
  queryPaneTargetsByTitle,
  runTmux,
} from '../shared/tmux.js';
import type { TmuxPlayRecord, RecordObserver } from './records.js';
import type { RoleConfig } from './roles.js';
import {
  TmuxPlayTiming,
  formatTimerDuration,
  type TimerValue,
} from './timing.js';

export const TMUX_PANE_TIMER_TEXT_OPTION = '@cligent_pane_timer_text';
export const TMUX_PANE_TIMER_RUNNING_OPTION = '@cligent_pane_timer_running';
export const TMUX_STATUS_TIMER_TEXT_OPTION = '@cligent_status_timer_text';
export const TMUX_STATUS_TIMER_RUNNING_OPTION = '@cligent_status_timer_running';

const REFRESH_INTERVAL_MS = 1000;
const FROZEN_ZERO: TimerValue = { elapsedMs: 0, running: false };

export interface TimingTmuxClient {
  queryPaneTargetsByTitle(sessionName: string): ReadonlyMap<string, string>;
  setSessionOption(sessionName: string, option: string, value: string): void;
  setPaneOption(paneTarget: string, option: string, value: string): void;
}

export interface TimingScheduler {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface CreateTimingObserverOptions {
  readonly sessionName: string;
  readonly captainAdapter: string;
  readonly roles: readonly Pick<RoleConfig, 'id' | 'adapter'>[];
  readonly now?: () => number;
  readonly tmux?: TimingTmuxClient;
  readonly scheduler?: TimingScheduler;
}

export interface TimingObserverHandle extends RecordObserver {
  refresh(now?: number): void;
  dispose(): void;
}

interface RolePaneTimer {
  readonly roleId: string;
  readonly title: string;
}

export class TimingObserver implements TimingObserverHandle {
  private readonly timing = new TmuxPlayTiming();
  private readonly sessionName: string;
  private readonly captainTitle: string;
  private readonly roles: readonly RolePaneTimer[];
  private readonly now: () => number;
  private readonly tmux: TimingTmuxClient;
  private readonly scheduler: TimingScheduler;
  private interval: unknown | undefined;

  constructor(options: CreateTimingObserverOptions) {
    this.sessionName = options.sessionName;
    this.captainTitle = `Captain · ${options.captainAdapter}`;
    this.roles = options.roles.map((role) => ({
      roleId: role.id,
      title: `${titleCaseRoleId(role.id)} · ${role.adapter}`,
    }));
    this.now = options.now ?? Date.now;
    this.tmux = options.tmux ?? spawnTmuxClient;
    this.scheduler = options.scheduler ?? globalTimingScheduler;
  }

  onRecord(record: TmuxPlayRecord): void {
    this.timing.apply(record);

    switch (record.type) {
      case 'turn_started':
        this.startInterval();
        this.refresh(record.timestamp);
        break;
      case 'turn_finished':
      case 'turn_aborted':
        this.refresh(record.timestamp);
        this.stopInterval();
        break;
      case 'role_prompt':
      case 'role_finished':
      case 'captain_prompt':
      case 'captain_finished':
        this.refresh(record.timestamp);
        break;
      default:
        break;
    }
  }

  refresh(now = this.now()): void {
    try {
      this.push(now);
    } catch {
      // Timer updates are display-only. A transient tmux failure should not
      // abort the active Boss turn.
    }
  }

  dispose(): void {
    this.stopInterval();
  }

  private startInterval(): void {
    if (this.interval !== undefined) {
      return;
    }
    this.interval = this.scheduler.setInterval(() => {
      this.refresh();
    }, REFRESH_INTERVAL_MS);
  }

  private stopInterval(): void {
    if (this.interval === undefined) {
      return;
    }
    this.scheduler.clearInterval(this.interval);
    this.interval = undefined;
  }

  private push(now: number): void {
    const snapshot = this.timing.snapshot(now);
    const paneTargets = this.tmux.queryPaneTargetsByTitle(this.sessionName);
    this.pushPane(paneTargets.get(this.captainTitle), snapshot.captain);

    for (const role of this.roles) {
      this.pushPane(
        paneTargets.get(role.title),
        snapshot.roles.get(role.roleId) ?? FROZEN_ZERO,
      );
    }

    this.tmux.setSessionOption(
      this.sessionName,
      TMUX_STATUS_TIMER_TEXT_OPTION,
      formatTimerDuration(snapshot.total.elapsedMs),
    );
    this.tmux.setSessionOption(
      this.sessionName,
      TMUX_STATUS_TIMER_RUNNING_OPTION,
      runningValue(snapshot.total),
    );
  }

  private pushPane(paneTarget: string | undefined, timer: TimerValue): void {
    if (!paneTarget) {
      return;
    }
    this.tmux.setPaneOption(
      paneTarget,
      TMUX_PANE_TIMER_TEXT_OPTION,
      formatTimerDuration(timer.elapsedMs),
    );
    this.tmux.setPaneOption(
      paneTarget,
      TMUX_PANE_TIMER_RUNNING_OPTION,
      runningValue(timer),
    );
  }
}

export function createTimingObserver(
  options: CreateTimingObserverOptions,
): TimingObserver {
  return new TimingObserver(options);
}

const spawnTmuxClient: TimingTmuxClient = {
  queryPaneTargetsByTitle,
  setSessionOption(sessionName, option, value) {
    runTmux('set-option', '-t', sessionName, option, value);
  },
  setPaneOption(paneTarget, option, value) {
    runTmux('set-option', '-p', '-t', paneTarget, option, value);
  },
};

const globalTimingScheduler: TimingScheduler = {
  setInterval(callback, ms) {
    return setInterval(callback, ms);
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

function runningValue(timer: TimerValue): string {
  return timer.running ? '1' : '0';
}

function titleCaseRoleId(roleId: string): string {
  return roleId.charAt(0).toUpperCase() + roleId.slice(1);
}
