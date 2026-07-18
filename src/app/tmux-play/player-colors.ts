// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

// TMUX-048: stable per-adapter accent colors from the Catppuccin family.
// Each adapter maps to the same role name (green/teal/lavender/pink) across
// flavors, so a Latte session uses the dark-green/dark-teal/etc. variants
// designed for light backgrounds. Used by the presenter for `<playerId>>`
// speaker prefixes (Task 2) and the launcher for per-pane timer accents.
// Keying by adapter (not player id) means a config renaming
// `claude` → `coder` keeps the Claude-green accent.
export type CatppuccinFlavor = 'mocha' | 'latte';

const KNOWN_PLAYER_COLORS_MOCHA: Readonly<Record<string, string>> = {
  claude: '#a6e3a1', // green
  codex: '#94e2d5', // teal
  gemini: '#b4befe', // lavender
  kimi: '#74c7ec', // sapphire
  opencode: '#f5c2e7', // pink
};

const KNOWN_PLAYER_COLORS_LATTE: Readonly<Record<string, string>> = {
  claude: '#40a02b', // green
  codex: '#179299', // teal
  gemini: '#7287fd', // lavender
  kimi: '#209fb5', // sapphire
  opencode: '#ea76cb', // pink
};

// Pool for unknown adapter names (custom Captain implementations, future
// adapters). Avoids overlap with the speaker/tool/status accents reserved
// elsewhere (boss=blue, captain=mauve, tool=peach, ok=green, error=red,
// aborted=yellow).
const FALLBACK_POOL_MOCHA: readonly string[] = [
  '#74c7ec', // sapphire
  '#89dceb', // sky
  '#f5e0dc', // rosewater
  '#eba0ac', // maroon
  '#f2cdcd', // flamingo
];

const FALLBACK_POOL_LATTE: readonly string[] = [
  '#209fb5', // sapphire
  '#04a5e5', // sky
  '#dc8a78', // rosewater
  '#e64553', // maroon
  '#dd7878', // flamingo
];

export function playerAccent(
  adapter: string,
  flavor: CatppuccinFlavor = 'mocha',
): string {
  const known =
    flavor === 'latte'
      ? KNOWN_PLAYER_COLORS_LATTE[adapter]
      : KNOWN_PLAYER_COLORS_MOCHA[adapter];
  if (known !== undefined) return known;
  const pool = flavor === 'latte' ? FALLBACK_POOL_LATTE : FALLBACK_POOL_MOCHA;
  return pool[hash(adapter) % pool.length] ?? pool[0]!;
}

// Captain pane's timer accent and the captain speaker prefix; mauve in both
// flavors but the hex differs (#cba6f7 on Mocha is a soft light-mauve that
// reads against dark; #8839ef on Latte is a saturated dark-mauve that reads
// against light).
export function captainAccent(flavor: CatppuccinFlavor = 'mocha'): string {
  return flavor === 'latte' ? '#8839ef' : '#cba6f7';
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

// TMUX-038/039/049: speaker / status / tool palette per flavor. The presenter
// resolves one of these once at session start (from the snapshot's resolved
// theme) and uses its keys directly, instead of pulling Mocha-only consts.
export interface PresenterPalette {
  readonly speakerBoss: string;
  readonly speakerCaptain: string;
  readonly statusError: string;
  readonly statusAborted: string;
  readonly toolInvoke: string;
  readonly toolOk: string;
  readonly toolFail: string;
  readonly toolDenied: string;
  readonly toolOutputDim: string;
}

const PRESENTER_PALETTE_MOCHA: PresenterPalette = {
  speakerBoss: '#89b4fa', // blue
  speakerCaptain: '#cba6f7', // mauve
  statusError: '#f38ba8', // red
  statusAborted: '#f9e2af', // yellow
  toolInvoke: '#fab387', // peach
  toolOk: '#a6e3a1', // green
  toolFail: '#f38ba8', // red
  toolDenied: '#f9e2af', // yellow
  toolOutputDim: '#6c7086', // overlay0
};

const PRESENTER_PALETTE_LATTE: PresenterPalette = {
  speakerBoss: '#1e66f5', // blue
  speakerCaptain: '#8839ef', // mauve
  statusError: '#d20f39', // red
  statusAborted: '#df8e1d', // yellow
  toolInvoke: '#fe640b', // peach
  toolOk: '#40a02b', // green
  toolFail: '#d20f39', // red
  toolDenied: '#df8e1d', // yellow
  toolOutputDim: '#9ca0b0', // overlay0
};

export function presenterPalette(
  flavor: CatppuccinFlavor = 'mocha',
): PresenterPalette {
  return flavor === 'latte' ? PRESENTER_PALETTE_LATTE : PRESENTER_PALETTE_MOCHA;
}

// Back-compat constants for callers that still want the Mocha defaults
// (e.g., test fixtures, places where flavor plumbing is in progress). New
// code should consume `presenterPalette(flavor)` instead.
export const SPEAKER_BOSS = PRESENTER_PALETTE_MOCHA.speakerBoss;
export const SPEAKER_CAPTAIN = PRESENTER_PALETTE_MOCHA.speakerCaptain;
export const STATUS_ERROR = PRESENTER_PALETTE_MOCHA.statusError;
export const STATUS_ABORTED = PRESENTER_PALETTE_MOCHA.statusAborted;
export const TOOL_INVOKE = PRESENTER_PALETTE_MOCHA.toolInvoke;
export const TOOL_OK = PRESENTER_PALETTE_MOCHA.toolOk;
export const TOOL_FAIL = PRESENTER_PALETTE_MOCHA.toolFail;
export const TOOL_DENIED = PRESENTER_PALETTE_MOCHA.toolDenied;
export const TOOL_OUTPUT_DIM = PRESENTER_PALETTE_MOCHA.toolOutputDim;

// djb2 — deterministic, fast, no dependencies. Stability across runs is the
// only property we need; cryptographic strength is irrelevant.
function hash(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h;
}
