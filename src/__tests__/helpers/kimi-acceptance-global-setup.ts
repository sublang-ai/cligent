// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

import type { TestProject } from 'vitest/node';
import {
  createIsolatedKimiAcceptance,
  probeKimiCredential,
  resolveKimiAcceptance,
} from './kimi-acceptance.js';

export default async function setupKimiAcceptance(
  project: TestProject,
): Promise<() => void> {
  const source = resolveKimiAcceptance();
  if (source.missing.length > 0) {
    project.provide('kimiAcceptance', source);
    return () => undefined;
  }

  const isolated = createIsolatedKimiAcceptance(
    source,
    'cligent-kimi-acceptance-',
  );

  // Presence of config.toml and credentials/kimi-code.json says nothing about
  // whether the OAuth credential still works: Kimi rotates the refresh token
  // on every refresh, so a credential restored from an immutable CI secret is
  // spent as soon as any earlier run refreshed it. Probe once, up front, so an
  // expired credential self-skips the Kimi legs with a precise reason instead
  // of failing them mid-suite — and so a single failed refresh cannot write a
  // revoked tombstone into the shared clone and cascade into every later leg.
  const unusable = await probeKimiCredential(isolated.context);
  if (unusable) {
    console.warn(`kimi acceptance: ${unusable}`);
    isolated.cleanup();
    project.provide('kimiAcceptance', {
      ...source,
      missing: [...source.missing, unusable],
      unusable,
    });
    return () => undefined;
  }

  project.provide('kimiAcceptance', isolated.context);
  return isolated.cleanup;
}
