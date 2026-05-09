<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# IR-001: Project Scaffold and Core Types

## Status

Done

## Goal

Set up the project scaffold (package.json, TypeScript, linting, testing) and define all core TypeScript interfaces from [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md) so that subsequent iterations can build on a compilable, testable foundation.

## Deliverables

- [x] `package.json` — ESM package, Node 18+ engine requirement, no runtime dependencies
- [x] `tsconfig.json` — strict mode, declaration emit, ESM module resolution
- [x] ESLint + Prettier configuration
- [x] `src/types.ts` — all [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md) TypeScript interfaces
- [x] `src/index.ts` — package entry point re-exporting all types
- [x] Vitest setup with type-level tests

## Tasks

1. **Initialize package.json**
   - Set `"type": "module"` for ESM
   - Set `"engines": { "node": ">=18" }` per [DR-001](../decisions/001-unified-cli-agent-interface-architecture.md#consequences)
   - Set `"main"` and `"types"` entry points to `dist/`
   - Add `"exports"` map for the root entry point
   - No runtime dependencies; all deps are devDependencies

2. **Configure TypeScript**
   - `"strict": true`, `"declaration": true`, `"declarationMap": true`
   - `"module": "Node16"`, `"moduleResolution": "Node16"`, `"target": "ES2022"`
   - Output to `dist/`

3. **Configure ESLint + Prettier**
   - ESLint with `@typescript-eslint` recommended rules
   - Prettier with consistent style (e.g., single quotes, trailing commas)
   - Add `build`, `lint`, and `format` scripts to package.json

4. **Define core types in `src/types.ts`**
   - `AgentEventType` — union of 9 event type literals per [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md#unified-event-stream)
   - `AgentType` — union of known agent identifiers plus `string`
   - `BaseEvent` — `type: AgentEventType | string` (string allows namespaced extensions), `agent`, `timestamp`, `sessionId`, `metadata?`
   - All payload interfaces: `InitPayload`, `TextPayload`, `TextDeltaPayload`, `ThinkingPayload`, `ErrorPayload`, `PermissionRequestPayload`, `ToolUsePayload`, `ToolResultPayload`, `DonePayload`
   - `AgentEvent` — discriminated union of 9 core event branches plus namespaced extension branch `(BaseEvent & { type: \`${string}:${string}\`; payload: unknown })` per [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md#key-payloads)
   - `PermissionLevel`, `PermissionPolicy` per [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md#unified-permission-model-upm)
   - `AgentAdapter`, `AgentOptions` per [DR-002](../decisions/002-unified-event-stream-and-adapter-interface.md#adapter-interface)

5. **Create package entry point `src/index.ts`**
   - Re-export all types from `src/types.ts`

6. **Set up Vitest**
   - Install Vitest as devDependency
   - Add `vitest.config.ts`
   - Add `test` script to package.json
   - Write type-level tests verifying discriminated union narrowing and interface assignability

## Acceptance criteria

- `tsc --noEmit` passes with no errors
- `vitest run` passes all type-level tests
- `npm run lint` reports no errors
- Package exports resolve correctly (`node --conditions=import -e "import('cligent')"`)
