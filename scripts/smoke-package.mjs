// Serial, offline acceptance through the packed public root and actual host SDK.
// Usage: node scripts/smoke-package.mjs <candidate.tgz> <actual-dsh-root>
// The host supplies peer packages only; no host config or credentials are loaded.
// The temporary public SDK spy injects legal onPayload options; it never replaces dispatch.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

assert.ok(process.argv[2] && process.argv[3], 'Pass the candidate .tgz and DSH installation paths');
const archive = resolve(process.argv[2]);
// macOS default temp paths may traverse /var -> /private/var: compare canonical roots.
const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-subscription-package-smoke-')));
const originalFetch = globalThis.fetch;
const mounts = [];
const cases = [];
const bodies = [];
const MODEL = 'gpt-6.1-sol';
const PRIVATE = 'SYNTHETIC_PRIVATE_DIAGNOSTIC';
const USAGE = { input_tokens: 20, output_tokens: 7, total_tokens: 27,
  input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } };
const expectedUsage = { inputTokens: 13, outputTokens: 7, totalTokens: 27, cacheReadTokens: 5, cacheWriteTokens: 2 };
const clone = value => JSON.parse(JSON.stringify(value));
let respond, activeInjection, target, descriptor, original, plugin, ctx, subscription, facts, manifest;
let sdkVersions;
const persistence = {
  host: { status: 'not-run', cases: 0, rawChunks: 0 },
};
let intercepted = 0, injectedHooks = 0, openedContexts = 0;
const sse = events => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''),
  { headers: { 'content-type': 'text/event-stream' } });
const textItem = () => ({ id: 'msg_packed', type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'Packed offline answer.', annotations: [] }] });
function events(output = [textItem()]) {
  return [...output.flatMap((item, output_index) => [
    { type: 'response.output_item.added', output_index, item: { ...item, ...(item.type === 'message' ? { content: [] } : {}) } },
    ...(item.type === 'message' ? [{ type: 'response.output_text.delta', output_index, content_index: 0,
      delta: item.content[0].text }] : []),
    { type: 'response.output_item.done', output_index, item },
  ]), { type: 'response.completed', response: { id: 'resp_packed', status: 'completed', output, usage: USAGE } }];
}
// Fail closed from before module import/apply/hydration until the entire test ends.
globalThis.fetch = async (input, init) => {
  assert.equal(String(input), 'https://api.openai.com/v1/responses', 'unexpected URL: real network is prohibited');
  assert.equal(init?.method, 'POST');
  assert.equal(typeof respond, 'function', 'HTTP outside an active smoke scenario');
  const body = JSON.parse(String(init.body));
  assert.equal(body.model, MODEL); assert.equal(body.store, false); assert.equal(body.stream, true);
  for (const key of ['previous_response_id', 'max_output_tokens', 'max_tokens', 'prompt_cache_retention',
    'cache_control', 'temperature', 'top_p']) assert.equal(Object.hasOwn(body, key), false, key);
  assert.ok(body.tools.some(tool => tool.type === 'web_search'));
  assert.doesNotMatch(JSON.stringify(body.input), /msg_dsh_start_|msg_dsh_end_/);
  bodies.push(body);
  return respond(body);
};
try {
  execFileSync('tar', ['-xzf', archive, '-C', root]);
  const packed = join(root, 'package');
  manifest = JSON.parse(await readFile(join(packed, 'package.json')));
  assert.equal(manifest.name, 'dsh-chatgpt-subscription');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  const detailedListing = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(detailedListing.split('\n').some(line => line.startsWith('l') || line.startsWith('h')), false,
    'archive must not contain external dependency symlinks or hard links');
  assert.doesNotMatch(listing, new RegExp('(?:^|/)(?:billion-context|dsh-optchat)(?:/|$)', 'im'));
  const hostRoot = await realpath(resolve(process.argv[3]));
  const hostRequire = createRequire(join(hostRoot, 'package.json'));
  // Exercise the standalone CLI before mounting any peers into the archive.
  const cliHome = join(root, 'synthetic-cli-home');
  await mkdir(cliHome, { mode: 0o700 });
  const hostBin = hostRequire.resolve('@deepseek-ai/dsh/lib/bin.js');
  await writeFile(join(cliHome, 'installation.json'), JSON.stringify({
    marker: 'dsh-chatgpt-subscription', version: '0.1.8', dshVersion: '0.2.1-rc.2',
    dshExecutable: hostBin, dshRealPath: hostBin,
  }));
  const noNetwork = join(root, 'no-network.mjs');
  await writeFile(noNetwork, 'globalThis.fetch = async () => { throw new Error("CLI smoke prohibits network"); };\n');
  const cliStatus = execFileSync(process.execPath, ['--import', noNetwork, join(packed, 'dist/cli.js'),
    'status', '--home', cliHome], { encoding: 'utf8' });
  assert.ok(cliStatus.includes('DSH ChatGPT 订阅 ' + manifest.version));
  assert.ok(cliStatus.includes('可用模型：0'));
  const peerRoots = new Map();
  for (const name of [...Object.keys(manifest.peerDependencies), '@deepseek-ai/cosmokit']) {
    assert.ok(!listing.includes(`package/node_modules/${name}/`), 'host peer was bundled: ' + name);
    const peerRoot = await realpath(resolve(hostRequire.resolve(name + '/package.json'), '..'));
    peerRoots.set(name, peerRoot);
    await mkdir(join(packed, 'node_modules', '@deepseek-ai'), { recursive: true });
    await symlink(peerRoot, join(packed, 'node_modules', name));
  }
  for (const file of ['docs/namespace-contract.md', 'docs/durable-tool-identity.md', 'docs/candidate-delivery.md',
    'test/fixtures/bc-namespace-contract.json', 'scripts/verify-bc-namespace.mjs', 'CHANGELOG.md']) {
    assert.ok((await readFile(join(packed, file))).length > 0, 'missing packed contract: ' + file);
  }
  const bc = JSON.parse(await readFile(join(packed, 'test/fixtures/bc-namespace-contract.json')));
  assert.equal(bc.tools[0].name, 'dsh'); assert.equal(bc.tools[0].tools[0].name, 'run_code');
  assert.equal(bc.bcCompressReachable, false);
  await writeFile(join(packed, 'public-entry-smoke.mjs'), "export * from 'dsh-chatgpt-subscription';\n");
  // Pi exposes its public root to ESM imports only; resolve it under import conditions
  // from the same extracted package rather than inventing a private file path.
  await writeFile(join(packed, 'dependency-resolver-smoke.mjs'),
    'export const resolve = name => import.meta.resolve(name);\n');
  const { resolve: resolveImport } = await import(pathToFileURL(join(packed, 'dependency-resolver-smoke.mjs')));
  const require = createRequire(join(packed, 'package.json'));
  const dependencyEntries = {};
  const load = async name => {
    const resolved = name === '@earendil-works/pi-ai' ? fileURLToPath(resolveImport(name)) : require.resolve(name);
    const actual = await realpath(resolved);
    const boundary = peerRoots.get(name) ?? packed;
    assert.ok(!relative(boundary, actual).startsWith('..'), 'dependency escaped its declared owner: ' + name);
    dependencyEntries[name] = { owner: peerRoots.has(name) ? 'host' : 'archive', entry: relative(boundary, actual) };
    return import(pathToFileURL(actual));
  };
  const [{ Context }, { default: Credentials }, { default: Llm, AssistantStreamAccumulator, BlockAssembler, expandAssistantStream, assembleAssistantStream }, , publicRoot] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-credentials-local'), load('@deepseek-ai/dsh-llm'),
    load('@earendil-works/pi-ai'), import(pathToFileURL(join(packed, 'public-entry-smoke.mjs'))),
    load('@deepseek-ai/cosmokit'),
  ]);
  const hostManifest = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-llm/package.json')));
  persistence.host = { status: 'incomplete', version: hostManifest.version, cases: 0, rawChunks: 0 };
  // The adapter creates Models from its host SDK, while this plugin supplies
  // a pinned provider implementation. Intercept the adapter's actual SDK.
  const hostSdkDirectory = join(root, 'host-sdk');
  await mkdir(hostSdkDirectory);
  await symlink(join(hostRoot, 'node_modules'), join(hostSdkDirectory, 'node_modules'));
  await writeFile(join(hostSdkDirectory, 'resolve.mjs'),
    'export const entry = import.meta.resolve("@earendil-works/pi-ai");\n');
  const { entry: hostSdkEntry } = await import(pathToFileURL(join(hostSdkDirectory, 'resolve.mjs')));
  const hostSdk = await import(hostSdkEntry);
  sdkVersions = {
    provider: JSON.parse(await readFile(join(packed, 'node_modules/@earendil-works/pi-ai/package.json'))).version,
    adapter: JSON.parse(await readFile(join(hostRoot, 'node_modules/@earendil-works/pi-ai/package.json'))).version,
  };
  assert.ok(!relative(hostRoot, await realpath(fileURLToPath(hostSdkEntry))).startsWith('..'));
  plugin = publicRoot;
  const probe = hostSdk.createModels({ credentials: new hostSdk.InMemoryCredentialStore(), modelsStore: new hostSdk.InMemoryModelsStore(),
    authContext: { env: async () => undefined, fileExists: async () => false } });
  target = Object.getPrototypeOf(probe);
  descriptor = Object.getOwnPropertyDescriptor(target, 'streamSimple');
  assert.equal(typeof descriptor?.value, 'function'); assert.equal(descriptor.writable, true);
  original = descriptor.value;
  target.streamSimple = function (model, context, options = {}) {
    if (model.provider !== plugin.PROVIDER_ID || !activeInjection) return original.call(this, model, context, options);
    const inject = activeInjection, callerHook = options.onPayload;
    intercepted++;
    return original.call(this, model, context, { ...options, onPayload: async (payload, hookModel) => {
      injectedHooks++;
      const prior = await callerHook?.(payload, hookModel);
      return inject(prior ?? payload, hookModel);
    } });
  };
  async function openContext() {
    ctx = new Context(); openedContexts++;
    mounts.push(await ctx.plugin(Credentials, { dshHome: join(root, 'synthetic-home-' + openedContexts), watch: false }));
    mounts.push(await ctx.plugin(Llm));
    await ctx.credentials.modifyRecord(plugin.SUBSCRIPTION_KEY, async () => ({ kind: 'grant', payload: { version: 1,
      credential: { type: 'oauth', access: 'synthetic-packed-access', refresh: 'synthetic-packed-refresh',
        expires: Date.now() + 3600000, issuer: 'https://auth.openai.com', clientId: 'oaiapp_packed', subject: 'synthetic-packed-subject',
        idToken: 'synthetic-packed-id', scopes: ['openid', 'email', 'profile', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'],
        hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001' }, models: [{ id: MODEL, name: 'Synthetic GPT' }] } }));
    subscription = await ctx.plugin(plugin); mounts.push(subscription);
    facts = ctx.bail('optchat/request-policy', plugin.PROVIDER_ID, MODEL, 'compaction');
    assert.equal(facts.compactionTools, 'none'); assert.equal(facts.capacity.totalOutputTokens, 128000);
    assert.equal(facts.capacity.includesReasoning, true); assert.equal(facts.cache.mode, 'automatic');
    assert.ok(facts.cache.projection.includes('subscription@' + manifest.version + '/native-replay-v2;tool-identity=v1;pi-replay-body-state=v1;'));
    assert.ok(Object.isFrozen(facts)); assert.ok(Object.isFrozen(facts.cache)); assert.ok(Object.isFrozen(facts.capacity));
    assert.doesNotMatch(JSON.stringify(facts), /synthetic-packed-(?:access|refresh|subject|id)|oaiapp_packed/);
    assert.equal(ctx.bail('optchat/request-policy', 'other-provider', MODEL, 'compaction'), undefined);
    assert.equal(ctx.bail('optchat/request-policy', plugin.PROVIDER_ID, 'unknown-model', 'compaction'), undefined);
  }
  async function closeContexts() {
    const captured = facts;
    await subscription.dispose();
    assert.equal(captured.lifetime.aborted, true);
    assert.equal(ctx.bail('optchat/request-policy', plugin.PROVIDER_ID, MODEL, 'compaction'), undefined);
    for (const mount of mounts.splice(0).reverse()) await mount.dispose();
  }
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Owned synthetic packed input.' }] }];
  function roundtrip(accumulator, api, raw, assembled, label) {
    const records = accumulator.snapshot();
    const expanded = api.expandAssistantStream(records);
    assert.deepEqual(expanded, raw, label + ': persisted expansion preserves every raw chunk and timestamp');
    const restored = api.assembleAssistantStream(records);
    assert.deepEqual(restored.blocks(), assembled.blocks(), label + ': restored blocks');
    assert.deepEqual(restored.interruptedBlocks(), assembled.interruptedBlocks(), label + ': restored interrupted blocks');
    assert.deepEqual(restored.usage, assembled.usage, label + ': restored usage');
    assert.deepEqual(restored.finish, assembled.finish, label + ': restored terminal outcome');
    assert.deepEqual(restored.replayState, assembled.replayState, label + ': restored replay state');
    return expanded;
  }
  async function run(entry, name, options = {}) {
    const beforeHttp = bodies.length, beforeSpy = intercepted, beforeHook = injectedHooks;
    activeInjection = options.inject ?? (payload => payload);
    respond = options.respond ?? (() => sse(events()));
    const config = { provider: plugin.PROVIDER_ID, model: MODEL };
    const generate = { ...config, sessionId: 'packed-identity-stable-session', purpose: options.purpose,
      messages: clone(options.messages ?? messages), signal: options.signal, tools: options.tools };
    const assembled = new BlockAssembler(), persisted = new AssistantStreamAccumulator(), chunks = [];
    try {
      const stream = entry === 'stream' ? ctx.llm.stream(generate) : (await ctx.llm.prepareCall(config)).stream(generate);
      for await (const chunk of stream) {
        const raw = { time: chunks.length, chunk };
        // The actual host receives the original object before assembly or JSON cleanup.
        persisted.push(raw); persistence.host.rawChunks++;
        chunks.push(chunk); assembled.push(chunk);
        if (chunk.type === 'usage') options.abortOnUsage?.();
      }
    } finally { activeInjection = undefined; respond = undefined; }
    const raw = chunks.map((chunk, time) => ({ time, chunk }));
    roundtrip(persisted, { expandAssistantStream, assembleAssistantStream }, raw, assembled, name + ': actual host');
    persistence.host.cases++;
    assert.equal(bodies.length - beforeHttp, options.http ?? 1, name + ': final mock HTTP count');
    assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1, name + ': one terminal outcome');
    if (options.hook !== false) {
      assert.equal(intercepted - beforeSpy, 1, name + ': public SDK spy reached');
      assert.equal(injectedHooks - beforeHook, 1, name + ': legal caller hook reached');
    }
    cases.push({ entry, name, passed: true, mockHttp: bodies.length - beforeHttp,
      publicSdkIntercepts: intercepted - beforeSpy, callerHooks: injectedHooks - beforeHook });
    return { assembled, chunks, wire: bodies.at(-1) };
  }
  function failure(result, code) {
    assert.equal(result.assembled.finish.kind, 'error');
    if (code) assert.equal(result.assembled.finish.failure.code, code);
    assert.equal(result.assembled.replayState, undefined);
    assert.doesNotMatch(JSON.stringify(result.chunks), /SYNTHETIC_PRIVATE_DIAGNOSTIC|PRIVATE_DIAGNOSTIC_OLD_CUSTOM|synthetic-packed-(?:access|refresh)/);
  }
  function stop(result) { assert.equal(result.assembled.finish.kind, 'stop'); }
  const READ = { type: 'function', name: 'read', parameters: { type: 'object' } };
  const RUN = bc.tools[0].tools[0];
  const CUSTOM = { type: 'custom', name: 'edit', format: { type: 'text' } };
  const mixed = { tools: [READ, { type: 'namespace', name: 'remote', tools: [READ] },
    { type: 'namespace', name: 'dsh', description: 'Existing harness metadata', tools: [RUN] }, CUSTOM], tool_choice: 'required' };
  const incremental = { type: 'additional_tools', tools: [{ type: 'function', name: 'late', parameters: { type: 'object' } }] };
  const mixedHook = payload => ({ ...payload, ...mixed,
    input: [payload.input[0], incremental, ...payload.input.slice(1)] });
  const callOutput = [
    { type: 'function_call', id: 'fc_local', call_id: 'call_local', name: 'same', namespace: 'dsh', arguments: '{"value":"local"}' },
    { type: 'function_call', id: 'fc_remote', call_id: 'call_remote', name: 'same', namespace: 'remote', arguments: '{"value":"remote"}' },
    { type: 'custom_tool_call', id: 'ctc_remote', call_id: 'call_custom', name: 'same', namespace: 'custom', input: 'PRIVATE_DIAGNOSTIC_OLD_CUSTOM' },
  ];
  const localCallTools = [{ name: 'same', description: 'Synthetic declared local function', parameters: { type: 'object' } }];
  const callTools = [{ type: 'function', name: 'same', parameters: { type: 'object' } },
    { type: 'namespace', name: 'remote', tools: [{ type: 'function', name: 'same', parameters: { type: 'object' } }] },
    { type: 'namespace', name: 'custom', tools: [{ type: 'custom', name: 'same', format: { type: 'text' } }] }];
  // Legacy 0.1.6 persisted-envelope fixture, not a new remote execution. The shape
  // follows PiAiReplayResponse v2 plus readNative/readToolIdentity; fingerprints
  // are constructed independently, without importing production replay helpers.
  function persistedToolHistory(output) {
    const canonical = value => Array.isArray(value) ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
    const content = [], blocks = [];
    for (const item of output) {
      assert.ok(item.type === 'function_call' || item.type === 'custom_tool_call');
      const id = item.call_id + '|' + item.id;
      content.push({ type: 'tool-call', id, name: item.name,
        arguments: item.type === 'function_call' ? item.arguments : JSON.stringify({ input: item.input }) });
      const identity = { kind: 'chatgpt-subscription-tool', version: 1, id, name: item.name,
        namespace: item.namespace, type: item.type === 'custom_tool_call' ? 'custom' : 'function' };
      blocks.push({ type: 'tool-call', namespace: item.namespace, toolIdentity: { ...identity, fingerprint: hash(identity) } });
    }
    const contentFingerprint = hash(content);
    const pi = { kind: 'pi-ai', version: 2, api: 'openai-responses', provider: plugin.PROVIDER_ID, model: MODEL, stopReason: 'toolUse' };
    const piResponse = { ...pi, subscriptionReplay: { version: 1, contentFingerprint,
      stateFingerprint: hash({ response: pi, blocks, contentFingerprint }) } };
    const native = { kind: 'chatgpt-subscription-native', version: 1, provider: plugin.PROVIDER_ID, model: MODEL,
      output: structuredClone(output), piResponse, contentFingerprint, blockCount: content.length };
    const replayState = { response: { ...native, stateFingerprint: hash({ response: native, blocks }) }, blocks };
    const message = { role: 'assistant', id: 'persisted_fixture', content,
      source: { kind: 'model', provider: plugin.PROVIDER_ID, model: MODEL, replayState } };
    assert.deepEqual(clone(message), message, 'legacy fixture is already lossless JSON, not cleaned for acceptance');
    return message;
  }
  for (const entry of ['stream', 'prepareCall']) {
    await openContext();
    const httpError = code => new Response(JSON.stringify({ error: { code, message: PRIVATE } }),
      { status: 400, headers: { 'content-type': 'application/json' } });
    const httpOverflow = await run(entry, 'HTTP 400 typed overflow', { respond: () => httpError('context_length_exceeded') });
    failure(httpOverflow, 'CONTEXT_WINDOW_EXCEEDED');
    assert.equal(httpOverflow.chunks.some(chunk => chunk.type === 'usage'), false);
    const partial = [
      { type: 'response.output_item.added', output_index: 0, item: { ...textItem(), content: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Partial answer' },
      { type: 'response.failed', response: { status: 'failed', usage: USAGE,
        error: { code: 'context_length_exceeded', message: PRIVATE } } },
    ];
    const overflow = await run(entry, 'SSE failed typed overflow with trusted partial usage', { respond: () => sse(partial) });
    failure(overflow, 'CONTEXT_WINDOW_EXCEEDED');
    assert.deepEqual(overflow.assembled.blocks(), [{ type: 'text', text: 'Partial answer' }]);
    assert.deepEqual(overflow.chunks.find(chunk => chunk.type === 'usage').usage, expectedUsage);
    failure(await run(entry, 'ordinary HTTP 400 negative control', { respond: () => httpError('invalid_request_error') }), 'PI_AI_ERROR');
    for (const [name, usage] of [['missing', undefined], ['malformed', { ...USAGE, total_tokens: 900 }]]) {
      const failed = clone(partial);
      if (usage === undefined) delete failed.at(-1).response.usage; else failed.at(-1).response.usage = usage;
      const unknown = await run(entry, 'failed overflow ' + name + ' usage omitted', { respond: () => sse(failed) });
      failure(unknown, 'CONTEXT_WINDOW_EXCEEDED');
      assert.equal(unknown.chunks.some(chunk => chunk.type === 'usage'), false);
      assert.deepEqual(unknown.assembled.blocks(), [{ type: 'text', text: 'Partial answer' }]);
      const completed = events();
      if (usage === undefined) delete completed.at(-1).response.usage; else completed.at(-1).response.usage = usage;
      const unknownSuccess = await run(entry, 'completed ' + name + ' usage omitted', { respond: () => sse(completed) }); stop(unknownSuccess);
      assert.equal(unknownSuccess.chunks.some(chunk => chunk.type === 'usage'), false);
    }
    for (const status of ['failed', 'completed']) {
      const zero = await run(entry, 'explicit valid zero usage remains exact on ' + status, { respond: () => sse([{
        type: 'response.' + status, response: { status, output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          ...(status === 'failed' ? { error: { code: 'context_length_exceeded', message: PRIVATE } } : {}) } }]) });
      // Empty completed output is a host error; the explicitly reported accounting is still known.
      failure(zero, status === 'failed' ? 'CONTEXT_WINDOW_EXCEEDED' : undefined);
      assert.deepEqual(zero.chunks.find(chunk => chunk.type === 'usage').usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    }
    const first = await run(entry, 'mixed namespace main before compaction', { inject: mixedHook }); stop(first);
    const expectedTools = [mixed.tools[1], { ...mixed.tools[2], tools: [RUN, READ, CUSTOM] }, { type: 'web_search' }];
    assert.deepEqual(first.wire.tools, expectedTools); assert.equal(first.wire.tool_choice, 'required');
    assert.deepEqual(first.wire.input[1], { type: 'additional_tools', tools: [{ type: 'namespace', name: 'dsh',
      description: 'Tools supplied by DeepSeek Harness', tools: incremental.tools }] });
    const summary = await run(entry, 'late required hook cannot override compaction none', { inject: mixedHook, purpose: 'compaction' }); stop(summary);
    assert.equal(summary.wire.tool_choice, 'none'); assert.deepEqual(summary.wire.tools, first.wire.tools);
    assert.deepEqual(summary.wire.input, first.wire.input);
    const next = await run(entry, 'main after compaction remains required and ordered', { inject: mixedHook }); stop(next);
    assert.equal(next.wire.tool_choice, 'required'); assert.deepEqual(next.wire.tools, first.wire.tools);
    assert.deepEqual(next.wire.input, first.wire.input); assert.equal(next.wire.prompt_cache_key, first.wire.prompt_cache_key);
    const conflict = await run(entry, 'conflicting qualified declaration refused before HTTP', { http: 0,
      inject: payload => ({ ...payload, tools: [{ type: 'namespace', name: 'dsh', tools: [READ] },
        { ...READ, parameters: { type: 'object', required: [PRIVATE] } }] }) });
    failure(conflict); assert.match(conflict.assembled.finish.failure.message, /conflict/i);
    const selector = await run(entry, 'unconfirmed forced selector refused before HTTP', { http: 0,
      inject: payload => ({ ...payload, tools: [READ], tool_choice: { type: 'function', namespace: 'dsh', name: 'read' } }) });
    failure(selector); assert.match(selector.assembled.finish.failure.message, /not supported/i);
    for (const kind of ['function', 'custom', 'hosted']) {
      const call = kind === 'hosted' ? { type: 'web_search_call', id: 'ws_forbidden', status: 'completed',
        action: { type: 'search', query: PRIVATE } } : { type: kind === 'function' ? 'function_call' : 'custom_tool_call',
        id: 'fc_forbidden', call_id: 'call_forbidden', namespace: 'dsh', name: 'read',
        ...(kind === 'function' ? { arguments: JSON.stringify({ path: PRIVATE }) } : { input: PRIVATE }) };
      const unexpected = await run(entry, 'compaction rejects unexpected ' + kind + ' output', {
        inject: mixedHook, purpose: 'compaction', respond: () => sse(events([textItem(), call])) });
      failure(unexpected); assert.equal(unexpected.wire.tool_choice, 'none');
      assert.match(unexpected.assembled.finish.failure.message, /compaction.*tool|tool.*compaction/i);
      assert.equal(unexpected.chunks.some(chunk => chunk.type === 'tool-call-delta' ||
        (chunk.type === 'block-start' && chunk.blockType === 'tool-call') ||
        (chunk.type === 'block-end' && chunk.block.type === 'tool-call')), false);
      assert.deepEqual(unexpected.assembled.blocks(), [{ type: 'text', text: 'Packed offline answer.' }]);
      assert.deepEqual(unexpected.chunks.find(chunk => chunk.type === 'usage').usage, expectedUsage);
      for (const [code, expected] of [['context_length_exceeded', 'CONTEXT_WINDOW_EXCEEDED'],
        ['subscription_sharing_usage_limit_exceeded', 'QUOTA'], ['unknown_error', 'PI_AI_ERROR']]) {
        const failed = events([textItem(), call]);
        failed[failed.length - 1] = { type: 'response.failed', response: { status: 'failed', usage: USAGE,
          error: { code, message: PRIVATE } } };
        const classified = await run(entry, 'forbidden ' + kind + ' then failed ' + code, {
          inject: mixedHook, purpose: 'compaction', respond: () => sse(failed) });
        failure(classified, expected);
        assert.equal(classified.chunks.some(chunk => chunk.type === 'tool-call-delta' ||
          (chunk.type === 'block-start' && chunk.blockType === 'tool-call') ||
          (chunk.type === 'block-end' && chunk.block.type === 'tool-call')), false);
        assert.deepEqual(classified.assembled.blocks(), [{ type: 'text', text: 'Packed offline answer.' }]);
        assert.deepEqual(classified.chunks.find(chunk => chunk.type === 'usage').usage, expectedUsage);
        if (code === 'context_length_exceeded') {
          const owner = new AbortController();
          const cancelled = await run(entry, 'cancellation wins forbidden ' + kind + ' then overflow', {
            inject: mixedHook, purpose: 'compaction', respond: () => sse(failed),
            signal: owner.signal, abortOnUsage: () => owner.abort() });
          assert.equal(cancelled.assembled.finish.kind, 'aborted');
          assert.equal(cancelled.assembled.finish.failure.code, 'ABORTED');
          assert.equal(cancelled.assembled.replayState, undefined);
          assert.equal(cancelled.chunks.some(chunk => chunk.type === 'tool-call-delta' ||
            (chunk.type === 'block-start' && chunk.blockType === 'tool-call') ||
            (chunk.type === 'block-end' && chunk.block.type === 'tool-call')), false);
          assert.doesNotMatch(JSON.stringify(cancelled.chunks), /SYNTHETIC_PRIVATE_DIAGNOSTIC|fc_forbidden|call_forbidden/);
        }
      }
    }
    for (const item of callOutput.slice(1)) {
      const blocked = await run(entry, 'fresh ' + item.type + ' cannot execute a same-name local tool', {
        tools: localCallTools, inject: payload => ({ ...payload, tools: callTools }),
        respond: () => sse(events([textItem(), item])) });
      failure(blocked, 'PI_AI_ERROR');
      assert.match(blocked.assembled.finish.failure.message, /declared local execution binding/i);
      assert.equal(blocked.chunks.some(chunk => chunk.type === 'tool-call-delta' ||
        (chunk.type === 'block-start' && chunk.blockType === 'tool-call') ||
        (chunk.type === 'block-end' && chunk.block.type === 'tool-call')), false);
      assert.deepEqual(blocked.assembled.blocks(), [{ type: 'text', text: 'Packed offline answer.' }]);
      assert.deepEqual(blocked.chunks.find(chunk => chunk.type === 'usage').usage, expectedUsage);
    }
    for (const phase of ['added', 'terminal']) for (const namespace of ['dsh', 'remote']) {
      const item = { type: 'function_call', id: 'fc_reassigned', call_id: 'call_original', name: 'read', namespace: 'dsh', arguments: '{}' };
      const streamed = events([textItem(), item]);
      const changed = { ...item, call_id: 'call_reassigned', namespace };
      if (phase === 'added') streamed.find(event => event.type === 'response.output_item.added' && event.item.id === item.id).item = changed;
      else streamed.at(-1).response.output = [textItem(), changed];
      const blocked = await run(entry, 'same item id rejects changed call id in ' + phase + '/' + namespace, {
        tools: [{ name: 'read', description: 'Synthetic declared local function', parameters: { type: 'object' } }],
        inject: payload => ({ ...payload, tools: [...payload.tools, { type: 'namespace', name: 'remote', tools: [READ] }] }),
        respond: () => sse(streamed),
      });
      failure(blocked, 'PI_AI_ERROR');
      assert.match(blocked.assembled.finish.failure.message, /declared local execution binding/i);
      assert.equal(blocked.chunks.some(chunk => chunk.type === 'tool-call-delta' ||
        (chunk.type === 'block-start' && chunk.blockType === 'tool-call') ||
        (chunk.type === 'block-end' && chunk.block.type === 'tool-call')), false);
      assert.deepEqual(blocked.assembled.blocks(), [{ type: 'text', text: 'Packed offline answer.' }]);
      assert.deepEqual(blocked.chunks.find(chunk => chunk.type === 'usage').usage, expectedUsage);
    }
    const seeded = await run(entry, 'real local response creates persistent qualified identity', {
      tools: localCallTools, inject: payload => ({ ...payload, tools: callTools }),
      respond: () => sse(events(callOutput.slice(0, 1))) });
    assert.equal(seeded.assembled.finish.kind, 'tool-calls');
    const localHistorical = seeded.assembled.message({ provider: plugin.PROVIDER_ID, model: MODEL,
      replayState: seeded.assembled.replayState });
    const historical = persistedToolHistory(callOutput);
    assert.deepEqual(localHistorical.content, historical.content.slice(0, 1));
    assert.deepEqual(localHistorical.source.replayState.blocks[0].toolIdentity, historical.source.replayState.blocks[0].toolIdentity);
    const results = callOutput.map(item => ({ role: 'tool', id: 'result_' + item.call_id,
      toolCallId: item.call_id + '|' + item.id, source: { kind: 'tool', callId: item.call_id + '|' + item.id },
      content: [{ type: 'text', text: 'CURRENT_' + item.call_id }] }));
    const persistedMessages = clone([...messages, historical, ...results]);
    await closeContexts(); await openContext();
    const replayOptions = { inject: payload => ({ ...payload, tools: [] }), messages: persistedMessages };
    const replay = await run(entry, 'JSON persisted identities replay after reapply', replayOptions); stop(replay);
    assert.deepEqual(replay.wire.input.slice(1, 4), callOutput);
    const expectedPairing = [['function_call_output', 'call_local'], ['function_call_output', 'call_remote'], ['custom_tool_call_output', 'call_custom']];
    assert.deepEqual(replay.wire.input.slice(4).map(item => [item.type, item.call_id]), expectedPairing);
    const repeated = await run(entry, 'same persistent input repeats deterministically', replayOptions); stop(repeated);
    assert.deepEqual(repeated.wire.input, replay.wire.input);
    const appended = await run(entry, 'ordinary append preserves historical prefix', { ...replayOptions,
      messages: [...persistedMessages, { role: 'user', content: [{ type: 'text', text: 'Ordinary append' }] }] }); stop(appended);
    assert.deepEqual(appended.wire.input.slice(0, replay.wire.input.length), replay.wire.input);
    for (const value of [replay, repeated, appended]) assert.equal(value.wire.prompt_cache_key, 'packed-identity-stable-session');
    const editedMessages = clone(persistedMessages);
    editedMessages[1].content[2].arguments = '{"input":"CURRENT_CUSTOM"}';
    const edited = await run(entry, 'edited custom arguments downgrade to current visible payload', { ...replayOptions, messages: editedMessages }); stop(edited);
    const calls = edited.wire.input.filter(item => item.type === 'function_call' || item.type === 'custom_tool_call');
    assert.deepEqual(calls.map(item => [item.type, item.namespace, item.name, item.call_id]),
      [['function_call', 'dsh', 'same', 'call_local'], ['function_call', 'remote', 'same', 'call_remote'], ['custom_tool_call', 'custom', 'same', 'call_custom']]);
    assert.equal(calls[2].input, 'CURRENT_CUSTOM'); assert.equal(Object.hasOwn(calls[2], 'arguments'), false);
    assert.deepEqual(edited.wire.input.slice(4).map(item => [item.type, item.call_id]), expectedPairing);
    assert.doesNotMatch(JSON.stringify(edited.wire), /PRIVATE_DIAGNOSTIC_OLD_CUSTOM|msg_dsh_/);
    const missing = clone(persistedMessages); delete missing[1].source.replayState;
    const unrecoverable = await run(entry, 'missing historical identity refused before HTTP', {
      ...replayOptions, messages: missing, http: 0, hook: false });
    failure(unrecoverable); assert.match(unrecoverable.assembled.finish.failure.message, /tool.*identity|identity.*tool/i);
    await closeContexts();
  }
  assert.equal(cases.length, 82, 'all 74 previous cases plus eight same-item identity conflicts ran');
  for (const entry of ['stream', 'prepareCall'])
    assert.equal(cases.filter(item => item.entry === entry).length, 41, entry + ': full acceptance coverage');
  Object.defineProperty(target, 'streamSimple', descriptor);
  assert.equal(target.streamSimple, original);
  persistence.host.status = 'passed';
  console.log(JSON.stringify({ version: manifest.version, sdkVersions, persistence, archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
    packedPublicEntry: 'passed', standaloneCli: 'passed', entries: ['stream', 'prepareCall'], hostPeerResolution: 'passed', dependencyEntries,
    archiveDependencyLinks: false,
    legalBcFixtureDelivered: true, bcBundled: false, publicSdkPrototypeRestored: true,
    fakeHttpRequests: bodies.length, publicSdkIntercepts: intercepted, callerHooks: injectedHooks, contextsApplied: openedContexts,
    realProviderCalls: 0, realNetworkRequests: 0, realCredentialsRead: false, disposedLifetime: true, skipped: [],
    caseCount: cases.length, casesByEntry: Object.fromEntries(['stream', 'prepareCall'].map(entry =>
      [entry, cases.filter(item => item.entry === entry).length])), cases }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ event: 'package-smoke-failed', version: manifest?.version,
    completedCases: cases.length, persistence }));
  throw error;
} finally {
  if (target && descriptor) { Object.defineProperty(target, 'streamSimple', descriptor); assert.equal(target.streamSimple, original); }
  for (const mount of mounts.reverse()) await mount.dispose();
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
