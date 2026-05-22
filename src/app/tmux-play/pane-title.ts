// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

export const CAPTAIN_PANE_DISPLAY = 'Captain';

export function paneTitle(display: string, adapter: string): string {
  return `${display} · ${adapter}`;
}

export function captainPaneTitle(adapter: string): string {
  return paneTitle(CAPTAIN_PANE_DISPLAY, adapter);
}

export function rolePaneTitle(roleId: string, adapter: string): string {
  return paneTitle(titleCaseRoleId(roleId), adapter);
}

export function titleCaseRoleId(roleId: string): string {
  return roleId.charAt(0).toUpperCase() + roleId.slice(1);
}
