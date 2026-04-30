// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

export function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:=@-]+$/.test(value)) {
    return value;
  }
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
