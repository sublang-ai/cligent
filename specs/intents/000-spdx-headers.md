<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-000: SPDX Headers

## Status

In progress.
The headers are applied.
The header format is not yet stated as a spec item: the legacy form of this record checked that deliverable against `dev/licensing.md`, which never carried a format section, so it is reopened here.

## Intent

Apply [[licensing-1](../packages/licensing.md#licensing-1)], [[licensing-2](../packages/licensing.md#licensing-2)], [[licensing-5](../packages/licensing.md#licensing-5)] to in-scope files and pin the project's header format.

## Deliverables

- [x] Add SPDX headers to in-scope files missing them
- [ ] Add `licensing-9` to the External Behavior of [`packages/licensing.md`](../packages/licensing.md) with the project's actual header format, license, and copyright

## Tasks

1. [x] Resolve scope: detect a project-root license file per [[licensing-8](../packages/licensing.md#licensing-8)]; enumerate in-scope files per [[licensing-7](../packages/licensing.md#licensing-7)].

2. [x] Insert SPDX lines in each file's first comment block (after any shebang), using the file's native comment syntax.

3. [ ] Add `licensing-9` to the `## External Behavior` section of [`packages/licensing.md`](../packages/licensing.md), showing the concrete header per comment style.
   Source code, including specs, carries the project's single Apache-2.0 `LICENSE` in the form every in-scope file already uses:

   ```markdown
   <!-- SPDX-License-Identifier: Apache-2.0 -->
   <!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->
   ```

   ```typescript
   // SPDX-License-Identifier: Apache-2.0
   // SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
   ```

   The legacy form of this record also specified a separate content category — README, docs, blogs — under a different license:

   ```markdown
   <!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->
   <!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->
   ```

   No file carries that second form today, so `licensing-9` states the Apache-2.0 form unless the owner adopts the split.

## Verification

- [[licensing-3](../packages/licensing.md#licensing-3)], [[licensing-4](../packages/licensing.md#licensing-4)] pass on all in-scope files.
