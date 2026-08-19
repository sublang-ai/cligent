<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# licensing: Licensing Headers

## Intent

This package lets contributors and reviewers identify the copyright and license of included project files through consistent SPDX headers.
It owns header scope and content, not the project's license choice.
It is project-local.

## External Behavior

### licensing-7

When a project file is classified for licensing headers, the licensing scope shall exclude exactly these categories:

- files with no comment syntax, such as JSON and binaries;
- configuration such as `.gitignore`, `.editorconfig`, `**/settings.json`, `AGENTS.md`, `.github/workflows/ci.yml`, and lock files;
- generated or vendor content such as `dist/`, `node_modules/`, and vendor directories; and
- license and legal documents.

### licensing-8

When the project root is inspected for its license, the license-file detector shall recognize these patterns:

- `LICENSE`, `LICENSE.txt`, `LICENSE.md`, `COPYING`
- `LICENSE-CONTENT`, `LICENSE-APACHE`, etc. (named variants)
- `LICENCE`, `LICENCE.txt` (British spelling)
- `LICENSES/` folder (REUSE convention)

### licensing-1

Where the file has comment syntax and is not excluded by the licensing scope [[licensing-7](#licensing-7)], while the file is git-tracked or `git add`-able, when preparing the file for inclusion in the repo, the file shall include `SPDX-FileCopyrightText` in its first comment block after any shebang.

### licensing-2

Where the file has comment syntax, is not excluded by the licensing scope [[licensing-7](#licensing-7)], and one or more project-root license files match the license-file detector patterns [[licensing-8](#licensing-8)], while the file is git-tracked or `git add`-able, when preparing the file for inclusion in the repo, the file shall include `SPDX-License-Identifier` in its first comment block after any shebang.

### licensing-5

Where a file's first comment block already contains `SPDX-FileCopyrightText` or `SPDX-License-Identifier` from an upstream source (e.g., a template or vendored file copied from another project), when preparing the file for inclusion in the repo, those existing SPDX lines shall be preserved unmodified, even when the project root carries a different license — the preserved upstream headers satisfying the copyright-header requirement [[licensing-1](#licensing-1)] and the license-header requirement [[licensing-2](#licensing-2)], with no project-license header appended or substituted.

## Verification

### licensing-3

Where the file has comment syntax and is included by the licensing scope [[licensing-7](#licensing-7)], while git-tracked or `git add`-able, when checking its first comment block after any shebang, the verification shall assert the copyright-header requirement [[licensing-1](#licensing-1)] by finding `SPDX-FileCopyrightText`.

### licensing-4

Where the file has comment syntax, is included by the licensing scope [[licensing-7](#licensing-7)], and the license-file detector [[licensing-8](#licensing-8)] recognizes a project-root license, while git-tracked or `git add`-able, when checking its first comment block after any shebang, the verification shall assert the license-header requirement [[licensing-2](#licensing-2)] by finding `SPDX-License-Identifier`.

### licensing-6

Where a file's first comment block already contains `SPDX-FileCopyrightText` or `SPDX-License-Identifier` from an upstream source, when checking the prepared file, the verification shall assert the upstream-preservation requirement [[licensing-5](#licensing-5)]:

- every upstream SPDX line remains byte-identical to the upstream original;
- no additional `SPDX-FileCopyrightText` or `SPDX-License-Identifier` line carrying project-specific text is appended or substituted.
