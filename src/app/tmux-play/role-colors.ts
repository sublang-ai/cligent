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

// djb2 — deterministic, fast, no dependencies. Stability across runs is the
// only property we need; cryptographic strength is irrelevant.
function hash(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h;
}
