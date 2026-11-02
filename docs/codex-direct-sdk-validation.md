<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai> -->

# Direct SDK validation, 2026-11-01

This review changes only Codex final-result selection and startup/configuration delivery. It does not merge or release a package, alter SPEX business logic or Playbook, or repeat the testing Skill's business workflow.

## Intentional behavior changes

Both platforms call the official SDK directly. Ordinary Node callers leave platform selection to the SDK; Electron ASAR callers may point `codexPathOverride` at the SDK-owned unpacked native executable. No Cligent shell launcher, Node import hook, intermediary, supervisor, lifecycle files, forced MXC, Windows command prompt, or PowerShell cache override remains.

Supplied permissions no longer imply `--ignore-user-config`. User/provider/MCP configuration loads normally; explicit permission, approval, model and effort controls use public SDK options/config/configOverrides. Configuration files are not rewritten or copied. Existing permission/profile/writable-path validation and ephemeral project-trust overrides remain. Invalid native profiles produce native configuration errors, rather than a fallback to weaker policy.

Final results prefer an explicit string result, including an empty string, and otherwise use only the last completed agent message in that invocation. All progress remains in the event stream. Concurrent and successive invocations do not share fallback state; failed, exhausted and aborted streams retain their prior terminal semantics.

## Validation layers

| Layer | Evidence and limit |
| --- | --- |
| Simulated SDK streams | Progress plus independently parseable final JSON; turn/event result precedence, empty final result, unfinished/absent messages, sequential/concurrent isolation, errors and cancellation. Also SDK option mapping and real native ASAR-path selection at the constructor boundary. |
| Installed SDK with recording executable | `node scripts/verify-codex-sdk.mjs` on macOS arm64 and Windows x64. Complete progress and final JSON, Chinese/space paths, exact prompt and config home, nonzero/malformed errors, cancellation/early return and observed child exit. Recording executables do not prove sandbox enforcement. |
| Real native Codex with scripted local provider | `node scripts/verify-codex-native-config.mjs`, SDK/native 0.159.0 on both platforms. Isolated config files declare a custom provider and MCP server before invocation. Actual file/network operations and an MCP call check native configuration delivery; this is not a paid-model or third-party-provider interoperability test. |
| Account-authenticated native Codex | Existing account configuration, without credential output or config-file changes. Both systems: no-policy output-only progress/JSON task, auto/bypass writes, explicit read-only write rejection, `.git` extra-write task, native configuration-error nonzero exit and cancellation with no remaining observed native child. Mac's no-policy read task also succeeds. Windows's additional no-policy shell-read attempt is denied by native policy; it is not counted as successful file access. |
| SPEX APP host | Isolated copies of the existing beta.22 application code and data, replacing only Cligent, on Mac and Windows. Captain and Inspector use Codex/provider-default model at low effort with `auto` retained. Built-in `/inspect` reads a disposable README, reports its token, completes and returns Captain to idle. Installed APPs and their histories remain untouched. This does not prove every built-in workflow or a new installer. |

Mac's first token-only APP task reached Inspector's successful read but failed the built-in outcome matcher because its response did not affirm inspection completion. The corrected minimal task explicitly asks for completion and passes; no Playbook change was made.

## Configuration and permission observations

Native 0.159.0 accepts higher-priority SDK `default_permissions` with a lower-priority user `sandbox_mode`: read-only overrides a legacy full-access setting and rejects actual writes; auto/workspace and bypass override a legacy read-only setting and permit their tested writes. A same-name modern user field is overridden too. No custom configuration loader or ignore-all-config flag is needed for these reproduced combinations.

`auto` includes Codex's reviewer: it is not a hard ban on every operation outside a base profile. On Windows, the native reviewer can approve the fixture's `.git` write even without an extra-write grant. A bounded capability-only policy without auto-review blocks the tested PowerShell command under the current native Windows configuration. These observations are retained, rather than forcing a backend, approving silently in Cligent, or treating all profiles as equivalent. Native approval failures/tool denials remain visible. The network probe reaches its loopback HTTP endpoint in bypass mode on both platforms; the deny case blocks the socket on Mac and the command before launch on Windows, so it does not establish an independently running Windows shell with network-only restriction.

The native probe's local reviewer is scripted and approves only disposable non-destructive fixture actions. Account-authenticated tasks and APP tasks use the actual reviewer service instead. Native profile selection and actual authorization/operation outcomes are separate evidence.

## Accepted and unverified limits

- Removing the wrapper removes raw U+2028/U+2029 rewriting on Mac too. The pinned SDK can fail parsing such output. This review intentionally adds no encoding patch and makes no all-output claim.
- SDK iterator cleanup does not expose an awaited native-close handle. The probes observe termination of their specific child; they do not establish process-tree containment of intentional tool descendants or crash/power-loss recovery.
- Existing capability-to-profile mappings remain coarse; this is not a new per-tool ACL system. Native policy, managed requirements and approvals can still refuse operations. No broad permission bypass is added.
- Native configuration/effect and live acceptance use 0.159.0. Other supported runtime versions, enterprise-managed configurations, all MCP transports and arbitrary third-party providers are not exhaustively tested here.
- External service latency occurred in Windows APP acceptance. Passing this minimum flow is not a performance guarantee.
