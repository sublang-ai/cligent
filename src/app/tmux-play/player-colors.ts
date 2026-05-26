// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// TMUX-048: stable per-adapter accent colors from the Catppuccin Mocha palette.
// Used by the presenter for `<playerId>>` speaker prefixes (Task 2) and any
// other adapter-keyed coloring. Keying by adapter (not player id) means a config
// renaming `claude` → `coder` keeps the Claude-green accent.
const KNOWN_PLAYER_COLORS: Readonly<Record<string, string>> = {
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

export function playerAccent(adapter: string): string {
  const known = KNOWN_PLAYER_COLORS[adapter];
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

// Plain 24-bit foreground (no bold). Used for the dim tool-output body
// per TMUX-049 — bold would defeat the "calm reading" intent.
export function fg24bit(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

// TMUX-038/039: fixed accents for the non-player speakers and status kinds.
// Kept here next to the player-color map so a future palette swap is a
// single-file change.
export const SPEAKER_BOSS = '#89b4fa'; // blue
export const SPEAKER_CAPTAIN = '#cba6f7'; // mauve
export const STATUS_ERROR = '#f38ba8'; // red
export const STATUS_ABORTED = '#f9e2af'; // yellow

// TMUX-049: tool lifecycle palette.
export const TOOL_INVOKE = '#fab387'; // peach (tool>)
export const TOOL_OK = '#a6e3a1'; // green (tool< ✓)
export const TOOL_FAIL = '#f38ba8'; // red (tool< ✗)
export const TOOL_DENIED = '#f9e2af'; // yellow (tool< ·)
export const TOOL_OUTPUT_DIM = '#6c7086'; // overlay0 (tool stdout)

// djb2 — deterministic, fast, no dependencies. Stability across runs is the
// only property we need; cryptographic strength is irrelevant.
function hash(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h;
}
