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

When a real repository checkout and isolated Git worktrees are audited, the verification shall assert the copyright-header and scope matrix:

| Git path                                                                                                | Assertion                                                                                                 |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| tracked or `git add`-able file with comment syntax outside the exclusions [[licensing-7](#licensing-7)] | its first comment block after any shebang contains `SPDX-FileCopyrightText` [[licensing-1](#licensing-1)] |
| file with no comment syntax                                                                             | excluded from the audit [[licensing-7](#licensing-7)]                                                     |
| configuration, including the named dotfile, settings, instruction, workflow, and lock-file examples     | excluded from the audit [[licensing-7](#licensing-7)]                                                     |
| generated or vendor content                                                                             | excluded from the audit [[licensing-7](#licensing-7)]                                                     |
| license or legal document                                                                               | excluded from the audit [[licensing-7](#licensing-7)]                                                     |

### licensing-4

Where included files are selected by the licensing scope [[licensing-7](#licensing-7)], when a real repository checkout and isolated project roots are audited, the verification shall assert this license-detector and included-file header matrix:

| Project-root form                                    | Assertion                                                                                                                                                                                                                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LICENSE`, `LICENSE.txt`, `LICENSE.md`, or `COPYING` | the detector recognizes the form [[licensing-8](#licensing-8)], and every included tracked or `git add`-able file has `SPDX-License-Identifier` in its first comment block after any shebang [[licensing-2](#licensing-2)] |
| a named `LICENSE-*` variant                          | the detector recognizes the form [[licensing-8](#licensing-8)], and every included tracked or `git add`-able file has that header [[licensing-2](#licensing-2)]                                                            |
| `LICENCE` or `LICENCE.txt`                           | the detector recognizes the form [[licensing-8](#licensing-8)], and every included tracked or `git add`-able file has that header [[licensing-2](#licensing-2)]                                                            |
| `LICENSES/` directory                                | the detector recognizes the form [[licensing-8](#licensing-8)], and every included tracked or `git add`-able file has that header [[licensing-2](#licensing-2)]                                                            |

### licensing-6

Where a file's first comment block already contains `SPDX-FileCopyrightText` or `SPDX-License-Identifier` from an upstream source, when checking the prepared file, the verification shall assert the upstream-preservation requirement [[licensing-5](#licensing-5)]:

- every upstream SPDX line remains byte-identical to the upstream original;
- no additional `SPDX-FileCopyrightText` or `SPDX-License-Identifier` line carrying project-specific text is appended or substituted.
