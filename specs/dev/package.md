<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# PKG: Package Configuration

This component defines packaging, TypeScript configuration, and dependency constraints per [DR-001](../decisions/001-unified-cli-agent-interface-architecture.md) and [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md).

## Module System

### PKG-001

The package shall set `"type": "module"` for native ESM.

### PKG-002

The package shall require Node >= 18 via `"engines": { "node": ">=18" }`.

## Dependencies

### PKG-003

The package's runtime `dependencies` shall be limited to single-purpose, zero-transitive-dep packages required by the bundled CLI; build-time and test-time packages shall be `devDependencies`.

### PKG-004

Agent SDKs (`@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@opencode-ai/sdk`) shall be listed as optional peer dependencies.

## TypeScript

### PKG-005

The TypeScript configuration shall enable `strict: true`, `declaration: true`, `declarationMap: true`, target `ES2022`, module `Node16`, module resolution `Node16`, and output to `dist/`.

## Exports

### PKG-006

The package shall expose a root entry point via the `"exports"` map with `import` and `types` conditions.

### PKG-007

Each adapter shall have a sub-path export in the `"exports"` map (e.g., `"./adapters/claude-code"`).

## Verification

### PKG-008

The project shall include type-level tests verifying discriminated union narrowing and interface assignability for [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md) types.
