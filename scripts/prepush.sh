#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
# The pre-push check (release-20, DR-039): no conflict marker in the
# tree, then the spec lint and the type check, so a push carries neither
# what the first CI minutes would refuse nor a spec item id another
# branch took.
set -euo pipefail
cd "$(dirname "$0")/.."

status=0
markers="$(git grep -nE '^(<<<<<<< |=======$|>>>>>>> )')" || status=$?
if [ "$status" -eq 0 ]; then
  echo "prepush: conflict markers left in the tree:" >&2
  printf '%s\n' "$markers" >&2
  exit 1
elif [ "$status" -ne 1 ]; then
  echo "prepush: could not search the tree for conflict markers" >&2
  exit "$status"
fi

npx --yes @sublang/spex lint
npm run -s typecheck
echo "prepush: clean"
