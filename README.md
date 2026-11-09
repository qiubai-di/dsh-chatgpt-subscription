# ChatGPT Subscription for DSH

English | [简体中文](<README.zh.md>)

Use your own ChatGPT subscription as a main-model provider in DeepSeek Harness (DSH). DSH keeps control of sessions, history and local tool execution. The plugin reuses DSH’s PiAiAdapter for message conversion and uses Sign in with ChatGPT (SIWC) OAuth for the Responses API. It does not start a second agent.

Version **0.2.0** supports **DSH 0.2.2-rc.1**. Shared DSH packages now come from the host, tool isolation follows the new prompt and batch-execution APIs, and login lock timeouts explain the recovery step. Existing authorization records remain readable. This is an independent integration, not an OpenAI-certified or officially endorsed product.

## What it does

- Adds the `ChatGPT subscription` provider (`openai-chatgpt`) to DSH. Available models are the intersection of your account’s model directory and the pinned adapter’s supported catalog. No API key is required, and the route does not fall back to API-key billing.
- Supports streamed replies, local function/custom tools, durable tool-history replay and image input for models whose catalog declares image support. Images use DSH attachments and data URLs, not the Files upload API.
- Adds controlled native `web_search` to the same main-model Responses request. The model decides when to search. This route filters and blocks DSH’s local `web_search`; it does not replace the global search backend or start a separate search agent. Other providers are unaffected.
- Shows `Using ChatGPT plan` and a `Manage usage` link in the main conversation when this provider is selected. The notice does not display an account identity or remaining allowance.
- Enforces no-tool compaction, preserves trusted usage and typed context-overflow errors, and rejects conflicting or untrustworthy tool identities before local execution.

Other hosted capabilities, including image generation, Files/File Search, Code Interpreter and MCP, are not enabled. Model access, native search, server-side parameter acceptance and service availability depend on your account, workspace and upstream service. Offline tests do not guarantee those entitlements.

## Requirements and compatibility

- **Node.js 24.9 or newer**.
- The supported host is **DSH `0.2.2-rc.1`**, with Cordis `4.1.0` and Schemastery `3.19.0`. Shared host packages are peer dependencies and are not bundled. Independent protocol libraries remain pinned. Older DSH releases are not supported by 0.2.0.
- The installer creates a POSIX shell launcher. Windows installation, command shims and permissions have not been verified.

## Build and install from source

**Use the built release archive or the source installer.** No verified one-line GitHub install command is provided here. The repository is not a promise of npm-registry availability. The following commands refer to the source checkout, not an extracted runtime package.

From the 0.2.0 source directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

`check` runs type checks, offline tests and the build. It does not sign in or call a real model. Host-backed image tests are skipped unless explicitly enabled; see [offline verification and delivery limits](<docs/candidate-delivery.md>). Dependency download may require network access.

Close DSH processes using this provider before installing or changing authorization. With the required DSH version available, install the dedicated profile and maintenance command:

```sh
npm run install:local
```

The [installer](<scripts/install.mjs>) builds and packs independent runtime libraries, then uses the native DSH plugin manager to resolve host peers, verifies archive copies with SHA-256 and creates a dedicated data directory and launcher. It does not replace the DSH executable, start DSH or sign in. Package installation uses `--ignore-scripts`. Existing destinations not managed by this plugin are refused.

Make sure the reported launcher directory is on your `PATH`, then create your own authorization:

```sh
dsh-chatgpt login
```

Complete the browser OAuth flow. The command receives a local loopback callback, saves your authorization and reads your account’s supported model directory without sending an inference request.

### Use the existing DSH Web profile

The native `web` profile must already exist. From the source directory, while DSH is stopped:

```sh
npm run integrate:web
```

The [integration script](<scripts/integrate-web.mjs>) backs up the existing profile files, installs the archive produced by `install:local` and sets this plugin’s `credentialHome`. It preserves the existing default model and other providers, and shares the dedicated authorization store without copying tokens into the native profile. It does not sign in or send model requests.

Then start DSH and select a model under `ChatGPT subscription` in the conversation model picker:

```sh
dsh web
```

Alternatively, `dsh-chatgpt run` starts the dedicated `chatgpt` profile instead of integrating with the native Web profile.

## Authorization commands

| Command | Effect |
| --- | --- |
| `dsh-chatgpt login` | Sign in and refresh the supported account model directory. |
| `dsh-chatgpt status` | Read local authorization status and cached models without network access. Output can include your account identity; redact it before sharing. |
| `dsh-chatgpt models` | Refresh the account model directory without inference. |
| `dsh-chatgpt logout` | Revoke this application’s authorization and clear local tokens after successful revocation. |
| `dsh-chatgpt run` | Start DSH with the dedicated profile. |
| `dsh-chatgpt help` | Show command help. |

If the recorded DSH installation has been removed, use `dsh-chatgpt login --dsh /path/to/current/dsh` (or `status`) to select the current supported host without deleting authorization. The CLI accepts `--home` for a dedicated data directory. The source installer accepts `--home`, `--bin-dir` and `--dsh`; the Web integration script accepts `--home`, `--dsh-home` and `--dsh`. Consult their source before customizing locations. A failed model-directory refresh does not discard a saved grant. If revocation fails, tokens remain available for a retry. Stop the running provider before login, logout, reinstallation or reintegration.

## Login lock timeout

If login reports `.operation-lock.lock`, acquisition timed out before OAuth started. Stop DSH instances and login processes using the same authorization directory. An empty or incomplete lock requires inspection; move it aside only after confirming no writer owns it, then retry. Keep the authorization files. The plugin does not delete uncertain locks automatically.

## Accounts, privacy and subscription limits

The OAuth implementation is generic. The distributed package contains no real account, subscription grant, access token or refresh token. Each user creates their own authorization data by signing in. The plugin does not import an existing Pi or Codex login cache.

Authorization is stored in the dedicated data directory through DSH’s local credentials service. It is a local credentials file, not OS-keychain-encrypted storage. Do not publish, share or commit the data directory, credentials, authorization URLs or unredacted status output. The native Web profile and maintenance CLI share that store and its refresh lock.

Requests consume your existing ChatGPT plan limits. Credits may also be consumed if you allow them in ChatGPT usage settings. This plugin does not provide a free or unlimited subscription and does not change your credits settings. An API cost estimate of zero is not a balance or an allowance check.

Prompts, selected history and supplied content are sent to OpenAI. `store:false` does not mean zero data retention or enterprise Zero Data Retention (ZDR). Do not treat the integration or its offline checks as official certification or a complete legal-compliance assessment.

## Technical contracts and verification

- [0.2.0 offline verification, replay and cache limits](<docs/candidate-delivery.md>)
- [Tool namespace contract](<docs/namespace-contract.md>)
- [Durable tool-identity replay contract](<docs/durable-tool-identity.md>)
- [Legal namespace fixture for BC interoperability](<test/fixtures/bc-namespace-contract.json>)
- [Changelog](<CHANGELOG.md>)

The 0.1.8 fix rejects contradictory evidence for a single tool item before releasing an executable block. Replay, stable request prefixes and offline persistence checks do not prove real model compliance, cache hits, subscription savings or a server context window. BC and OptChat are not bundled or modified.

## License

[MIT](<LICENSE>).
