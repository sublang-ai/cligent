// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { clearCaches, parseForESLint } from '@typescript-eslint/parser';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

// These exercise the consumers of the scoped matcher substitutions, rather
// than asserting the overridden package's implementation or version string.
describe('audited development-tool compatibility (package-36)', () => {
  it('selects TypeScript and CLI files and retains ignored build output and active rules', async () => {
    const eslint = new ESLint({
      cwd: root,
      overrideConfigFile: join(root, 'config/eslint.config.js'),
    });
    for (const file of [
      'src/probe.ts',
      'src/.hidden.ts',
      'src/nested/probe.test.ts',
      'bin/probe.mjs',
    ]) {
      const [result] = await eslint.lintText('const unused = 1;\n', {
        filePath: join(root, file),
      });
      expect(result.errorCount, file).toBe(1);
      expect(result.messages[0]?.ruleId, file).toBe(
        '@typescript-eslint/no-unused-vars',
      );
    }
    expect(await eslint.isPathIgnored(join(root, 'dist/probe.ts'))).toBe(true);
    const [unsupported] = await eslint.lintText(
      "import { DatabaseSync } from 'node:sqlite';\nvoid DatabaseSync;\n",
      { filePath: join(root, 'src/probe.ts') },
    );
    expect(
      unsupported.messages.some(
        (message) =>
          message.ruleId === 'n/no-unsupported-features/node-builtins',
      ),
    ).toBe(true);
  });

  it('retains flat-config include, ignore, negation and re-inclusion behavior', async () => {
    const eslint = new ESLint({
      cwd: root,
      overrideConfigFile: true,
      overrideConfig: [
        { ignores: ['**/generated/**/*', '!**/generated/keep.ts'] },
        {
          files: ['src/**/*.{js,ts}'],
          ignores: ['**/skip.*'],
          rules: { 'no-debugger': 'error' },
        },
      ],
    });
    for (const [file, expectedErrorCount] of [
      ['src/probe.ts', 1],
      ['src/nested/probe.js', 1],
      ['src/.hidden.ts', 1],
      ['src/skip.ts', 0],
      ['src/generated/drop.ts', 0],
      ['src/generated/keep.ts', 1],
    ] as const) {
      const [result] = await eslint.lintText('debugger;\n', {
        filePath: join(root, file),
      });
      expect(result.errorCount, file).toBe(expectedErrorCount);
      if (expectedErrorCount) {
        expect(result.messages[0]?.ruleId, file).toBe('no-debugger');
      }
    }
  });

  it('allows only matching out-of-project files through the TypeScript project service', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'cligent-lint-project-'));
    try {
      mkdirSync(join(fixture, 'src'));
      writeFileSync(join(fixture, 'src/included.ts'), 'export {};\n');
      writeFileSync(
        join(fixture, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { strict: true },
          include: ['src/**/*.ts'],
        }),
      );
      for (const name of ['allowed.ts', 'denied.ts']) {
        writeFileSync(join(fixture, name), 'const value = 1;\n');
      }
      const options = {
        tsconfigRootDir: fixture,
        projectService: { allowDefaultProject: ['allowed.ts'] },
      };
      const allowed = parseForESLint('const value = 1;\n', {
        ...options,
        filePath: join(fixture, 'allowed.ts'),
      });
      expect(allowed.services.program).toBeDefined();
      expect(() =>
        parseForESLint('const value = 1;\n', {
          ...options,
          filePath: join(fixture, 'denied.ts'),
        }),
      ).toThrow(/not found.*project service|allowDefaultProject/s);
    } finally {
      clearCaches();
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
