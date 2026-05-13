// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// TMUX-048: stable per-adapter accent colors from the Catppuccin Mocha palette.
// Used by the presenter for `<roleId>>` speaker prefixes (Task 2) and any
// other adapter-keyed coloring. Keying by adapter (not role id) means a config
// renaming `claude` → `coder` keeps the Claude-green accent.
const KNOWN_ROLE_COLORS: Readonly<Record<string, string>> = {
  claude: '#a6e3a1', // green
  codex: '#94e2d5', // teal
  gemini: '#b4befe', // lavender
  opencode: '#f5c2e7', // pink
};

// Pool for unknown adapter names (custom Captain implementations, future
// adapters). Avoids overlap with the speaker/tool/status accents reserved
// elsewhere (boss=blue, captain=mauve, tool=peach, ok=green, error=red,
// aborted=yellow).
const FALLBACK_POOL: readonly string[] = [
  '#74c7ec', // sapphire
  '#89dceb', // sky
  '#f5e0dc', // rosewater
  '#eba0ac', // maroon
  '#f2cdcd', // flamingo
];

export function roleAccent(adapter: string): string {
  const known = KNOWN_ROLE_COLORS[adapter];
  if (known !== undefined) return known;
  return FALLBACK_POOL[hash(adapter) % FALLBACK_POOL.length] ?? FALLBACK_POOL[0]!;
}

// SGR helpers — single source of styling so the presenter doesn't hand-craft
// ANSI byte sequences.
export const SGR_RESET = '\x1b[0m';

// Bold + 24-bit foreground. The terminal must advertise RGB (which TMUX-047
// enables via terminal-overrides). Hex is `#RRGGBB`.
export function bold24bitFg(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[1;38;2;${r};${g};${b}m`;
}

// TMUX-038/039: fixed accents for the non-role speakers and status kinds.
// Kept here next to the role-color map so a future palette swap is a
// single-file change.
export const SPEAKER_BOSS = '#89b4fa'; // blue
export const SPEAKER_CAPTAIN = '#cba6f7'; // mauve
export const STATUS_ERROR = '#f38ba8'; // red
export const STATUS_ABORTED = '#f9e2af'; // yellow

// djb2 — deterministic, fast, no dependencies. Stability across runs is the
// only property we need; cryptographic strength is irrelevant.
function hash(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h;
}
