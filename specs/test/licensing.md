<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# LIC: Licensing Headers

## Intent

This spec defines acceptance tests for SPDX copyright and license headers.

## Header Checks

### LIC-3
Verifies: [LIC-1](../dev/licensing.md#lic-1)

Where the file has comment syntax and is not [excluded](../dev/licensing.md#exclusions), while git-tracked or `git add`-able, when checking its first comment block after any shebang, the file shall contain `SPDX-FileCopyrightText`.

### LIC-4
Verifies: [LIC-2](../dev/licensing.md#lic-2)

Where the file has comment syntax, is not [excluded](../dev/licensing.md#exclusions), and a [license file](../dev/licensing.md#license-file-detection) exists at project root, while git-tracked or `git add`-able, when checking its first comment block after any shebang, the file shall contain `SPDX-License-Identifier`.

### LIC-6
Verifies: [LIC-5](../dev/licensing.md#lic-5)

Where a file's first comment block already contains `SPDX-FileCopyrightText` or `SPDX-License-Identifier` from an upstream source, when checking the prepared file, the upstream SPDX lines shall remain byte-identical to the upstream original, and no additional `SPDX-FileCopyrightText` or `SPDX-License-Identifier` line carrying project-specific text shall be appended or substituted.
