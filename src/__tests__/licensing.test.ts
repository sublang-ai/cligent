// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const verifier = join(projectRoot, 'scripts', 'verify-license-headers.mjs');
const temporaryRoots: string[] = [];

interface VerificationResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

function temporaryRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'cligent-licensing-'));
  temporaryRoots.push(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  return root;
}

function writeFixture(
  root: string,
  relativePath: string,
  content: string | Uint8Array,
): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function runVerifier(
  root?: string,
  extraArguments: readonly string[] = [],
): VerificationResult {
  const arguments_ = [verifier];
  if (root !== undefined) arguments_.push('--root', root);
  arguments_.push(...extraArguments);
  const result = spawnSync(process.execPath, arguments_, {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function resultText(result: VerificationResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

function expectPass(result: VerificationResult): void {
  expect(result.status, resultText(result)).toBe(0);
}

function expectFailure(
  result: VerificationResult,
  ...expectedFragments: readonly string[]
): void {
  const output = resultText(result);
  expect(result.status, output).toBe(1);
  for (const fragment of expectedFragments) {
    expect(output).toContain(fragment);
  }
}

function projectHeader(body = 'export {};\n'): string {
  return (
    '// SPDX-License-Identifier: Apache-2.0\n' +
    '// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>\n' +
    body
  );
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('repository licensing verification', () => {
  it('audits the real checkout and stays wired into CI (licensing-3, licensing-4)', () => {
    expectPass(runVerifier());

    const workflow = readFileSync(
      join(projectRoot, '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    expect(workflow).toMatch(
      /^\s+run: node scripts\/verify-license-headers\.mjs\s*$/m,
    );
  });

  it('audits tracked and untracked addable files after a shebang and only in the first block (licensing-3)', () => {
    const root = temporaryRepository();
    writeFixture(root, 'LICENSE', 'fixture license\n');
    writeFixture(root, 'tracked.ts', projectHeader());
    writeFixture(root, 'addable.ts', projectHeader());
    writeFixture(root, '.tool.ts', projectHeader());
    writeFixture(
      root,
      'styles/site.css',
      '/*\n * SPDX-License-Identifier: Apache-2.0\n' +
        ' * SPDX-FileCopyrightText: 2026 Fixture Author\n */\nbody {}\n',
    );
    writeFixture(
      root,
      'bin/tool',
      `#!/usr/bin/env node\n${projectHeader("console.log('ok');\n")}`,
    );

    writeFixture(
      root,
      'styles/site.css',
      '// SPDX-License-Identifier: Apache-2.0\n' +
        '// SPDX-FileCopyrightText: 2026 Fixture Author\nbody {}\n',
    );
    expectFailure(
      runVerifier(root),
      'styles/site.css',
      'SPDX-FileCopyrightText',
    );
    writeFixture(
      root,
      'styles/site.css',
      '/*\n * SPDX-License-Identifier: Apache-2.0\n' +
        ' * SPDX-FileCopyrightText: 2026 Fixture Author\n */\nbody {}\n',
    );
    execFileSync('git', ['add', 'LICENSE', 'tracked.ts'], { cwd: root });

    expectPass(runVerifier(root));

    writeFixture(root, 'addable.ts', 'export {};\n');
    expectFailure(runVerifier(root), 'addable.ts', 'SPDX-FileCopyrightText');
    writeFixture(root, 'addable.ts', projectHeader());

    writeFixture(root, 'tracked.ts', 'export {};\n');
    expectFailure(runVerifier(root), 'tracked.ts', 'SPDX-FileCopyrightText');
    writeFixture(root, 'tracked.ts', projectHeader());

    writeFixture(root, '.tool.ts', 'export {};\n');
    expectFailure(runVerifier(root), '.tool.ts', 'SPDX-FileCopyrightText');
    writeFixture(root, '.tool.ts', projectHeader());

    writeFixture(
      root,
      'bin/tool',
      '#!/usr/bin/env node\nconsole.log("no header");\n',
    );
    expectFailure(runVerifier(root), 'bin/tool', 'SPDX-FileCopyrightText');
    writeFixture(
      root,
      'bin/tool',
      `#!/usr/bin/env node\n${projectHeader("console.log('ok');\n")}`,
    );

    writeFixture(
      root,
      'late.ts',
      '// ordinary first comment\n\n' + projectHeader(),
    );
    expectFailure(runVerifier(root), 'late.ts', 'SPDX-FileCopyrightText');
  });

  it('excludes every licensing-scope category (licensing-7)', () => {
    const root = temporaryRepository();

    // No-comment-syntax files.
    writeFixture(root, 'data.json', '{}\n');
    writeFixture(root, 'asset.bin', new Uint8Array([0, 1, 2, 3]));
    writeFixture(root, 'binary.ts', new Uint8Array([0, 1, 2, 3]));

    // The listed configuration examples and their broader workflow/lock forms.
    writeFixture(root, '.gitignore', '# fixture configuration\n');
    writeFixture(root, '.editorconfig', 'root = true\n');
    writeFixture(root, 'nested/settings.json', '{}\n');
    writeFixture(root, 'AGENTS.md', '# Fixture instructions\n');
    writeFixture(root, '.github/workflows/ci.yml', 'name: fixture\n');
    writeFixture(root, '.github/workflows/release.yml', 'name: fixture\n');
    writeFixture(root, 'config/vitest.config.ts', 'export default {};\n');
    writeFixture(root, 'config/tool.ts', 'export {};\n');
    writeFixture(root, 'eslint.config.js', 'export default {};\n');
    writeFixture(root, 'bun.lockb', new Uint8Array([0, 1, 2, 3]));
    writeFixture(root, 'package-lock.json', '{}\n');
    writeFixture(root, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');

    // Generated and vendor directories.
    writeFixture(root, 'build/output.js', 'export {};\n');
    writeFixture(root, 'coverage/output.js', 'export {};\n');
    writeFixture(root, 'dist/output.js', 'export {};\n');
    writeFixture(root, 'generated/output.js', 'export {};\n');
    writeFixture(root, 'node_modules/example/index.js', 'export {};\n');
    writeFixture(root, 'out/output.js', 'export {};\n');
    writeFixture(root, 'vendor/example.js', 'export {};\n');
    writeFixture(root, 'vendors/example.js', 'export {};\n');

    // License and broader legal documents.
    writeFixture(root, 'LICENSE', 'fixture license\n');
    writeFixture(root, 'LICENSE.md', '# Fixture license\n');
    writeFixture(root, 'COPYING', 'fixture copying terms\n');
    writeFixture(root, 'NOTICE.md', '# Fixture legal notice\n');
    writeFixture(root, 'LEGAL.md', '# Fixture legal terms\n');

    // Names containing category words remain included outside those categories.
    writeFixture(root, 'src/config.ts', projectHeader());
    writeFixture(root, 'src/vendor-helper.ts', projectHeader());
    execFileSync('git', ['add', '--all', '--force'], { cwd: root });

    expectPass(runVerifier(root));

    writeFixture(root, 'src/config.ts', 'export {};\n');
    expectFailure(runVerifier(root), 'src/config.ts', 'SPDX-FileCopyrightText');
    writeFixture(root, 'src/config.ts', projectHeader());

    writeFixture(root, 'src/vendor-helper.ts', 'export {};\n');
    expectFailure(
      runVerifier(root),
      'src/vendor-helper.ts',
      'SPDX-FileCopyrightText',
    );
    writeFixture(root, 'src/vendor-helper.ts', projectHeader());

    // A nearby ordinary document is not absorbed by the exclusions.
    writeFixture(root, 'docs/guide.md', '# Missing SPDX header\n');
    expectFailure(runVerifier(root), 'docs/guide.md', 'SPDX-FileCopyrightText');
  });

  it.each([
    ['LICENSE', false],
    ['LICENSE.txt', false],
    ['LICENSE.md', false],
    ['COPYING', false],
    ['LICENSE-CONTENT', false],
    ['LICENSE-APACHE', false],
    ['LICENSE-MIT', false],
    ['LICENCE', false],
    ['LICENCE.txt', false],
    ['LICENSES', true],
  ] as const)(
    'recognizes the project-root detector form %s (licensing-4, licensing-8)',
    (entry, directory) => {
      const root = temporaryRepository();
      if (directory) {
        mkdirSync(join(root, entry));
      } else {
        writeFixture(root, entry, 'fixture license\n');
      }
      writeFixture(
        root,
        'source.ts',
        '// SPDX-FileCopyrightText: 2026 Fixture Author\nexport {};\n',
      );

      expectFailure(runVerifier(root), 'source.ts', 'SPDX-License-Identifier');

      writeFixture(root, 'source.ts', projectHeader());
      expectPass(runVerifier(root));
    },
  );

  it.each(['docs/LICENSE', 'LICENSED', 'license'])(
    'does not treat %s as a project-root license detector',
    (entry) => {
      const root = temporaryRepository();
      writeFixture(root, entry, 'fixture legal text\n');
      writeFixture(
        root,
        'source.ts',
        '// SPDX-FileCopyrightText: 2026 Fixture Author\nexport {};\n',
      );

      expectPass(runVerifier(root));
    },
  );

  it.each([
    [
      'copyright only',
      '// SPDX-FileCopyrightText: 2024 Upstream Author\nexport {};\n',
      '// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>\nexport {};\n',
      '// SPDX-License-Identifier: Apache-2.0\n',
    ],
    [
      'license only',
      '// SPDX-License-Identifier: MIT\nexport {};\n',
      '// SPDX-License-Identifier: Apache-2.0\nexport {};\n',
      '// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>\n',
    ],
    [
      'copyright and license',
      '// SPDX-License-Identifier: MIT\n' +
        '// SPDX-FileCopyrightText: 2024 Upstream Author\n' +
        'export {};\n',
      '// SPDX-License-Identifier: Apache-2.0\n' +
        '// SPDX-FileCopyrightText: 2024 Upstream Author\n' +
        'export {};\n',
      '// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>\n',
    ],
  ])(
    'preserves upstream %s SPDX headers byte-for-byte (licensing-6)',
    (_label, upstream, substituted, addition) => {
      const root = temporaryRepository();
      writeFixture(root, 'LICENSE', 'fixture project license\n');
      writeFixture(root, 'upstream.ts', upstream);
      execFileSync('git', ['add', 'LICENSE', 'upstream.ts'], { cwd: root });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Licensing Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '--quiet',
          '--message=record upstream header',
        ],
        { cwd: root },
      );

      expectPass(runVerifier(root, ['--upstream-ref', 'HEAD']));

      writeFixture(root, 'upstream.ts', substituted);
      expectFailure(
        runVerifier(root, ['--upstream-ref', 'HEAD']),
        'upstream.ts',
        'leading SPDX lines differ',
      );

      writeFixture(
        root,
        'upstream.ts',
        upstream.replace('export {};', `${addition}export {};`),
      );
      expectFailure(
        runVerifier(root, ['--upstream-ref', 'HEAD']),
        'upstream.ts',
        'leading SPDX lines differ',
      );
    },
  );
});
