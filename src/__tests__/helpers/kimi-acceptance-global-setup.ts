// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { TestProject } from 'vitest/node';
import {
  createIsolatedKimiAcceptance,
  resolveKimiAcceptance,
} from './kimi-acceptance.js';

export default function setupKimiAcceptance(project: TestProject): () => void {
  const source = resolveKimiAcceptance();
  if (source.missing.length > 0) {
    project.provide('kimiAcceptance', source);
    return () => undefined;
  }

  const isolated = createIsolatedKimiAcceptance(
    source,
    'cligent-kimi-acceptance-',
  );
  project.provide('kimiAcceptance', isolated.context);
  return isolated.cleanup;
}
