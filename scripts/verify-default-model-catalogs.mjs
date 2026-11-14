// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
// Inspect the actual installed official runtimes, without credentials or a model call.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { probeClaudeExecutable } from '../dist/adapters/claude-executable.js';
import { probeCodexExecutable } from '../dist/adapters/codex-executable.js';

const claude = probeClaudeExecutable();
const codex = probeCodexExecutable();
assert.equal(claude.state, 'present', `Claude executable: ${claude.state}`);
assert.equal(codex.state, 'present', `Codex executable: ${codex.state}`);
for (const [binary, models] of [
  [claude.path, ['claude-fable-5-2', 'claude-opus-5-5']],
  [codex.path, ['gpt-6-astra', 'gpt-6.1-sol']],
]) {
  const bytes = await readFile(binary);
  for (const model of models)
    assert(
      bytes.includes(Buffer.from(model)),
      `${binary}: missing catalog model ${model}`,
    );
}
console.log(
  'Installed native catalogs contain every pinned default parent and subagent model.',
);
