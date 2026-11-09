# 0.2.0: offline verification, replay and cache limits

[English README](<../README.md>) | [中文说明](<../README.zh.md>)

This document describes the technical verification boundary of the 0.2.0 host-compatibility release. It preserves OAuth and replay contracts while adapting dependencies and tool isolation to DSH 0.2.2-rc.1. It is not a deployment record or evidence that a particular account, running process or upstream service has been verified.

## Version and verification scope

The package requires Node.js 24.9 or newer and DSH `0.2.2-rc.1`. Shared framework and service packages resolve from the host through peer dependencies; they are not included in the archive. Source development dependencies pin the matching versions.

The [packed-entry smoke test](<../scripts/smoke-package.mjs>) defines 82 scenarios: 41 each through `ctx.llm.stream` and `ctx.llm.prepareCall(...).stream`. It extracts the archive, imports its public root, applies the real plugin with `ctx.plugin(plugin)`, resolves independent libraries inside the extracted package and verifies shared peers against the supplied host. Before mounting host peers, it also runs standalone CLI status against a synthetic old installation record with network disabled. The archive check rejects dependency links and inclusion of BC or OptChat.

Synthetic grants exist only in temporary test storage. Before module import and plugin application, a fail-closed fetch mock accepts only the expected Responses requests; unexpected URLs fail. The smoke report distinguishes mocked HTTP requests from real requests and records zero real-provider calls, zero real-network requests and no real credentials read. It does not log in, install a profile or start the DSH application. A passing report applies to the exact archive hash and host modules named in that report, not to another build.

Source tests additionally cover protocol handling, images, account binding, cancellation and refresh concurrency. Host-backed image tests require an explicit host and otherwise skip. Passing synthetic instruction, skill-result and history-forwarding tests proves that content reaches the final request, not that a real model reads or follows it.

## Current execution and historical replay

These are separate boundaries:

- **Current execution:** new executable blocks stay buffered until original call/item identity, name, local `dsh` namespace and declared function/custom kind agree. A bare Pi tool name is not enough to route a remote call to a local tool. In 0.1.8, evidence sharing either `call_id` or native item ID must remain consistent across added, done and terminal events. Contradictory IDs, names, types or namespaces fail before an executable block or successful replay is released. The existing trusted item-done fallback remains available when terminal output is incomplete.
- **Historical replay:** successful Responses output, Pi metadata and visible-content integrity bindings retain native history where trustworthy. Tool identity is bound to call IDs with namespace and function/custom kind, including remote and custom historical calls. Ordinary JSON persistence and a new plugin instance must preserve that identity.
- **Degraded replay:** after edits, cropping, damage or a model change, the current visible text, arguments, images and results are authoritative. Valid independent identity records can survive, but deleted text, hidden old arguments and unbound reasoning are not restored. Missing or ambiguous tool provenance fails before HTTP rather than guessing a namespace or kind. Plain text can still degrade safely.

Terminal events omit absent replay state rather than emitting an own property with `undefined`. Failed, cancelled or incomplete responses do not retain stale successful replay. Raw chunks enter `AssistantStreamAccumulator` before any JSON cleanup; expansion and assembly must preserve blocks, usage, terminal outcome and replay state. The archive smoke requires an actual DSH root and sends raw chunks through its persistence classes. It records both the pinned provider SDK version and the host adapter SDK version.

The detailed [namespace contract](<namespace-contract.md>) and [durable tool-identity contract](<durable-tool-identity.md>) remain the authoritative product contracts for declarations and historical provenance.

## Request and error policy

- The final Responses projection uses `store:false`, `stream:true` and client-supplied history. It does not add `previous_response_id`, an output cap or explicit cache controls.
- Main requests retain controlled native `web_search`. Compaction ends with `tool_choice: none` even after caller hooks. An unexpected tool response does not expose a local executable block or become a successful summary/replay. A local failure cannot prove that an upstream hosted operation never executed.
- Compatible tool namespaces merge stably; conflicting declarations and unconfirmed function/custom forced selectors fail before HTTP. A general Responses API schema is not proof that the SIWC route accepts a selector.
- Standard HTTP 400 and SSE `context_length_exceeded` map to DSH `CONTEXT_WINDOW_EXCEEDED`. Existing trusted partial content and usage remain available. Cancellation and prior typed failures keep their safe classification; the plugin does not add a provider retry loop.
- Only complete, consistent usage reports are forwarded as trusted accounting. Missing reports are not presented as exact zero; an explicitly reported, consistent zero remains valid. The SDK’s internal numeric sentinel is not a balance or entitlement signal.

Both call paths bind the prepared request to the account identity and check the grant again before sending. Account or authorization changes reject the old binding before HTTP; same-account token renewal may continue. `optchat/request-policy` v1 producer facts describe a published request projection and lifecycle, not billing or proof of cache hits. Facts are unavailable while missing, updating or disposed. They do not provide an admission token for arbitrary delayed consumers.

## Cache, capacity and consumer limits

The 0.2.0 projection identifier contains:

```text
subscription@0.2.0/native-replay-v2;tool-identity=v1;pi-replay-body-state=v1
```

`native-replay-v2` names the projection/replay algorithm revision, not a new envelope schema. Private identity/body-state bindings and public producer facts remain v1. The prompt-cache-key algorithm is unchanged, but consumers may revalidate when versioned facts change. Neither stable input prefixes nor a stable same-session key promises cache continuity across releases, server cache hits or subscription savings.

The exact model ID `gpt-6.1-sol` has a local context configuration of 500,000 tokens and a producer fact of 128,000 total output tokens including reasoning. Those are implementation declarations, not measured server capacity, an entitlement guarantee or an output budget sent with requests. Other models do not inherit those values by name.

The package ships a [legal `dsh.run_code` namespace fixture](<../test/fixtures/bc-namespace-contract.json>) and a [read-only BC scanner](<../scripts/verify-bc-namespace.mjs>). It does not flatten the protocol to satisfy a consumer or bundle BC. Recorded BC `0.1.209` scanner behavior sees `dsh` but not the nested `run_code`, leaving ordinary compression unreachable in that check. Adapter tests do not establish that BC compression works or that low cache-hit rates have improved. OptChat and other consumers require their own integration acceptance.

Real model behavior, account/workspace search rights, service-side selector acceptance, actual quota/credits use and cache performance are outside offline acceptance. Users keep their own existing credits settings.

## Reproduce the offline checks

From the source directory, with Node.js 24.9 or newer:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

`check` runs type checks, offline tests and a build. Dependency download is not an offline operation. Tests use synthetic protocol material and mocked transport or local test peers, not real subscription credentials.

For optional host-backed image and stream checks, set `HOST` to an already installed, audited DSH package root that provides the required attachment and LLM modules. This opt-in reads host modules, not host credentials or profiles:

```sh
DSH_IMAGE_TEST_HOST="${HOST:?}" DSH_STREAM_TEST_HOST="${HOST:?}" npm run check
```

Given an already built 0.2.0 archive, set `ARCHIVE` to its file path and verify the packed public entry:

```sh
node scripts/smoke-package.mjs "${ARCHIVE:?}" "${HOST:?}"
```

The smoke test extracts and executes packaged code. Use an audited archive; this is not an untrusted-code sandbox. Its temporary public-SDK hook spy is serial, restores the original descriptor and does not claim concurrent safety. Pre-dispatch identity refusals report zero mocked HTTP calls instead of a fabricated hook hit.

## Public artifact checks

Before distribution, verify the final archive itself, not only the source checkout. Check the version, file allowlist, required contracts and fixture, independent runtime dependencies and host-peer resolution, lack of external links and absence of real accounts or credentials. Packing from linked dependencies can omit hoisted transitive packages; do not treat a source-check pass as proof of an installable archive.

Bind any published verification result to the archive SHA-256, command, Node.js version, scenario counts and any supplied host version. Remove account details and machine-specific paths from public reports. Rebuild and repeat archive checks after artifact changes. Installation, process loading, browser behavior and real-service acceptance are separate checks; none can be inferred from an offline report. Direct GitHub installation remains unaccepted until separately verified.
