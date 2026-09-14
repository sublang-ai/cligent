// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import eslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';
import node from 'eslint-plugin-n';

export default [
  {
    files: ['src/**/*.ts', 'bin/**/*.mjs'],
    languageOptions: {
      parser,
      globals: node.configs['flat/recommended-module'].languageOptions.globals,
    },
    plugins: {
      '@typescript-eslint': eslint,
      n: node,
    },
    rules: {
      ...eslint.configs.recommended.rules,
      // Resolve the floor from engines.node; parseArgs/fetch shipped experimental.
      'n/no-unsupported-features/node-builtins': [
        'error',
        { allowExperimental: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    ignores: ['dist/'],
  },
];
