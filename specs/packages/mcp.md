<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# mcp: Caller Tools and Managed Browser

## Intent

This package defines caller-selected MCP server configuration and the managed browser capability, per [DR-032](../decisions/032-browser-tools-and-media-output.md).
Its public vocabulary is `McpServerConfig`, `McpServers`, and the `mcpServers` and `browser` options; adapters own native admission and approval mappings.

## External Behavior

### mcp-1

When a caller supplies `mcpServers`, the configuration shall describe a readonly map of server names to one of these shapes:

| Type | Required fields | Optional fields |
| --- | --- | --- |
| `stdio` | nonblank executable `command` | string-array `args`, string-map `env` |
| `http` | HTTP or HTTPS `url` | string-map `headers` |

### mcp-2

When server configuration is prepared, preparation shall validate and clone every entry before starting a server or downloading a browser, rejecting malformed maps or fields, unsafe server names outside letters/digits/underscores/hyphens or equal to `__proto__`, `constructor`, or `prototype`, NUL-containing strings, invalid environment-variable names, invalid header names or newline-containing header values, and URLs with embedded credentials or fragments, without exposing secret values in diagnostics.

### mcp-3

When `browser` is resolved, preparation shall select this behavior:

| Value | Behavior |
| --- | --- |
| omitted or `false` | preserve the supplied server map without loading or installing a browser runtime |
| `true` | add the prepared managed-browser stdio server under reserved name `cligent_browser`, rejecting a caller entry with that name |
| any other value | reject before downloading a browser or invoking the agent |

### mcp-10

When a managed browser is requested on a Node runtime without `URL.canParse`, preparation shall reject with an upgrade diagnostic before starting its installer, without affecting ordinary calls that omit the browser.

### mcp-4

When the managed browser is prepared, preparation shall use the pinned packaged Playwright MCP runtime and its matching Chromium executable, verifying installation through the native idempotent installer before first use in each process and after a verified executable disappears, allowing that installer to download only missing browser components under its cross-process cache lock, without changing agent configuration, installing system packages, replacing system browsers, or modifying personal browser profiles.

### mcp-5

When a managed-browser installation runs, preparation shall bound its duration and captured diagnostic output, terminate its owned process on cancellation or timeout with bounded escalation, and reject with an actionable failure unless installation completes and the executable becomes available.

### mcp-6

When managed-browser configuration is returned, the server shall run through the current absolute Node executable and resolved MCP entrypoint with the matching Chromium executable, headless operation, Chromium sandbox enabled, isolated temporary profile, and image responses enabled, without selecting a global permission-bypass mode.

### mcp-11

When managed-browser preparation completes, it shall first prove a bounded isolated headless launch and in-memory PNG screenshot with the managed runtime's sandbox posture, disposing the browser before success and retaining independent caller cancellation without installing operating-system packages.

### mcp-12

When an owned JavaScript child or managed MCP server is configured, its invocation shall use the current absolute runtime executable with child-local Electron Node mode where applicable and physical unpacked runtime paths for archived Electron dependencies, refusing an unusable packaged layout without requiring a global Node executable or mutating the parent environment.

### mcp-13

When a managed browser server is admitted, its configuration shall select a run-owned temporary output directory outside the user workspace and release it after preceding media consumption before terminal delivery, or when a stream closes early, without interpreting textual artifact paths or claiming to confine explicit native filename requests.

## Verification

### mcp-14

When real browser and Electron host fixtures prepare and execute a browser, integration checks shall verify launch/screenshot proof and cancellation cleanup [[mcp-11](#mcp-11)], Node/Electron child execution without global Node [[mcp-12](#mcp-12)], and automatic artifacts outside an unchanged workspace with release after consumption [[mcp-13](#mcp-13)].

### mcp-7

Given valid and invalid server maps and browser options, when a real `Cligent` call reaches its selected adapter, integration verification shall assert configuration validation and cloning [[mcp-1](#mcp-1)], [[mcp-2](#mcp-2)] and browser selection [[mcp-3](#mcp-3)], including rejection before provider invocation or browser preparation and independent parallel failures.

### mcp-8

Given a managed-browser installation fixture with successful, failing, hanging, and cancelled subprocesses, when preparation executes its installer, integration verification shall assert executable discovery and installation selection [[mcp-4](#mcp-4)], bounded diagnostics and process cleanup [[mcp-5](#mcp-5)], returned server arguments [[mcp-6](#mcp-6)], and pre-install rejection of an unsupported Node runtime [[mcp-10](#mcp-10)].

### mcp-9

Given the packaged browser runtime and managed Chromium, when a real MCP client navigates to a loopback page and takes a screenshot, acceptance verification shall assert a successful native browser action and nonempty screenshot image output from the configured server [[mcp-6](#mcp-6)].
