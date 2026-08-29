// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>

export function formatMissingAcceptanceDependencies(
  adapter: string,
  missing: readonly string[],
): string {
  return `Missing ${adapter} auto-mode acceptance dependencies: ${missing.join(', ')}`;
}

export function gateAcceptanceTest<Run, Skip>(
  run: Run,
  skip: Skip,
  adapter: string,
  missing: readonly string[],
  ci = Boolean(process.env.CI),
): Run | Skip {
  if (missing.length === 0 || ci) return run;

  process.stderr.write(
    `${formatMissingAcceptanceDependencies(adapter, missing)}; skipping locally\n`,
  );
  return skip;
}

export function assertAcceptanceDependencies(
  adapter: string,
  missing: readonly string[],
): void {
  if (missing.length > 0) {
    throw new Error(formatMissingAcceptanceDependencies(adapter, missing));
  }
}
