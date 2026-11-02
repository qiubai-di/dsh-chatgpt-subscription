// Offline integration against an explicitly supplied, already-built OptChat 0.2.0.
// Only synthetic credentials and an owned loopback HTTP/SSE peer are controlled.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name) + 1];
assert.ok(args.includes('--optchat'), 'Pass --optchat /absolute/path/to/the/frozen/OptChat/source');
const optchat = resolve(arg('--optchat'));
const runtimeRequire = createRequire(join(optchat, 'package.json'));
const load = name => import(pathToFileURL(runtimeRequire.resolve(name)));
const mod = name => import(pathToFileURL(join(optchat, 'dist', name + '.js')));
const [{ Context }, { default: SessionStore, SessionId }, { default: AgentRegistry },
  { default: LlmRuntime }, { default: TokenMeter }, { default: LocalCredentials },
  { default: AgentLoop }, { default: ToolRuntime }, { default: SystemPrompt }, { SessionProjectionRegistry },
  { PrefixCache }, { captureRequestPolicy }, { OptChatCapacity }, { createNodeSummarizer },
  { resolveConfig }, { SummaryBudget }, provider, { SIWC_SCOPES }] = await Promise.all([
  load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-session'), load('@deepseek-ai/dsh-agent'),
  load('@deepseek-ai/dsh-llm'), load('@deepseek-ai/dsh-token-meter'), import('@deepseek-ai/dsh-credentials-local'),
  load('@deepseek-ai/dsh-agent-loop'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-session-projection'),
  mod('cache-runtime'), mod('cache-policy'), mod('capacity'), mod('summarizer'), mod('config'), mod('summary-budget'),
  import('../dist/index.js'), import('../dist/siwc.js'),
]);
const MODEL = 'gpt-6.1-sol';
const grant = () => ({ type: 'oauth', access: 'synthetic-optchat-access', refresh: 'synthetic-optchat-refresh',
  expires: Date.now() + 3600000, issuer: 'https://auth.openai.com', clientId: 'oaiapp_offline_gate',
  subject: 'synthetic-optchat-subject', idToken: 'synthetic-optchat-id', scopes: [...SIWC_SCOPES],
  hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const until = async test => { const end = Date.now() + 6000; while (!await test()) { assert.ok(Date.now() < end, 'owned gate state did not settle'); await delay(5); } };
const emit = (res, event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
const item = { id: 'msg_owned', type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'Owned native summary.', annotations: [] }] };
const begin = res => emit(res, { type: 'response.created', response: { id: 'resp_owned' } });
const content = res => {
  emit(res, { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
  emit(res, { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Owned native summary.' });
};
const complete = res => {
  emit(res, { type: 'response.output_item.done', output_index: 0, item });
  emit(res, { type: 'response.completed', response: { id: 'resp_owned', status: 'completed', output: [item],
    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 0 } } } });
  res.end();
};

const receipt = { version: 1, realProviderCalls: 0, realCredentialsRead: false, externalNetworkRequests: 0,
  cases: [], ownedResourcesClosed: false, supplierCacheHit: 'unverified', subscriptionDebit: 'unobserved' };
const originalFetch = globalThis.fetch;
const root = await mkdtemp(join(tmpdir(), 'dsh-provider-optchat-owned-'));
const ctx = new Context(), mounts = [], agents = [], pending = new Set(), responses = new Set();
let subscription, cache, server, base, shuttingDown = false;
const lifetime = new AbortController();
const requests = [];
let respond = (_request, res) => { begin(res); content(res); complete(res); };
const config = resolveConfig({ mode: 'full', dataDir: join(root, 'budget'), auto: false, summaryRequestBudget: 50 });
const bounded = setTimeout(() => lifetime.abort(new Error('owned offline integration deadline')), 25000);
const track = work => { pending.add(work); work.then(() => pending.delete(work), () => pending.delete(work)); return work; };
try {
  server = createServer(async (req, res) => {
    responses.add(res); res.once('close', () => responses.delete(res));
    try {
      let raw = ''; for await (const data of req) raw += data;
      const request = { body: JSON.parse(raw), authorizationIsSynthetic: req.headers.authorization === 'Bearer synthetic-optchat-access' };
      assert.equal(request.authorizationIsSynthetic, true);
      requests.push(request);
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
      await respond(request, res);
    } catch (error) { if (!shuttingDown) console.error(error); res.destroy(); }
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.href, 'https://api.openai.com/v1/responses', 'No OAuth, model catalog or other external request is admitted');
    return originalFetch(base + '/responses', init);
  };
  for (const service of [SessionStore, AgentRegistry, LlmRuntime, TokenMeter]) mounts.push(await ctx.plugin(service));
  mounts.push(await ctx.plugin(LocalCredentials, { dshHome: join(root, 'synthetic-credentials'), watch: false }));
  await ctx.credentials.modifyRecord(provider.SUBSCRIPTION_KEY, async () => ({ kind: 'grant', payload: { version: 1, credential: grant(),
    models: [{ id: MODEL, name: 'Synthetic GPT' }, { id: 'gpt-5.4', name: 'Synthetic unknown capacity' }] } }));
  subscription = await ctx.plugin(provider);
  mounts.push(await ctx.plugin(SessionProjectionRegistry));
  mounts.push(await ctx.plugin(ToolRuntime)); mounts.push(await ctx.plugin(SystemPrompt, {}));
  mounts.push(await ctx.plugin(AgentLoop, { agents: [] }));
  cache = new PrefixCache(ctx, lifetime.signal, () => { throw new Error('These are actual summary workers, not a synthetic main memory view'); }, 5000);
  const capacity = new OptChatCapacity(ctx);
  const create = async id => {
    const handle = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: root }, agentOptions: { provider: provider.PROVIDER_ID, model: MODEL } });
    agents.push(handle); return handle.agent;
  };
  const fixed = { system: 'OWN_STABLE_RULE', tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } }] };
  const summarizer = agent => createNodeSummarizer(ctx, agent, config, fixed, { cache, validatePrepared: request => capacity.validatePrepared(request) });
  const task = { start: 0, count: 8, historicalContext: 'OWN_HISTORICAL_CONTEXT', viewGeneration: 0 };
  const budget = agent => new SummaryBudget(config.dataDir, agent.session.id, config.summaryRequestBudget);
  const agent = await create('actual-subscription-content-gate');
  const summarize = summarizer(agent);
  const received = deferred(), sendCreated = deferred(), sendContent = deferred(), sendTerminal = deferred();
  let number = 0;
  respond = async (_request, res) => {
    if (++number === 1) {
      received.resolve(); await sendCreated.promise; begin(res); await sendContent.promise; content(res); await sendTerminal.promise; complete(res);
    } else { begin(res); content(res); complete(res); }
  };
  const writer = track(summarize('OWN_SOURCE_A ' + 'x'.repeat(1200), 512, lifetime.signal, task));
  await Promise.race([received.promise, writer.then(() => { throw new Error('writer finished without HTTP'); })]);
  const follower = track(summarize('OWN_SOURCE_B ' + 'x'.repeat(1200), 512, lifetime.signal, task));
  await until(() => cache.status(agent.session.id).waiting === 1);
  await delay(60);
  assert.equal(requests.length, 1, 'native HTTP headers did not release the follower');
  assert.equal((await budget(agent).status()).requestsStarted, 1);
  receipt.cases.push({ name: 'headers', controlledHttpRequests: requests.length, softwareReservations: 1, waiting: 1 });
  sendCreated.resolve(); await delay(60);
  assert.equal(requests.length, 1, 'response.created and local SDK start did not release the follower');
  assert.equal(cache.status(agent.session.id).writerResponseStarts, 0);
  receipt.cases.push({ name: 'response.created', controlledHttpRequests: requests.length, writerResponseStarts: 0 });
  sendContent.resolve(); await until(() => requests.length === 2);
  assert.equal(await follower, 'Owned native summary.');
  assert.equal(requests[0].body.tool_choice, 'none'); assert.equal(requests[1].body.tool_choice, 'none');
  assert.deepEqual(requests[0].body.tools, requests[1].body.tools);
  assert.equal(requests[0].body.max_output_tokens, undefined);
  sendTerminal.resolve(); assert.equal(await writer, 'Owned native summary.');
  const accounting = await budget(agent).accounting();
  assert.equal(accounting.activeRequests, 0); assert.equal(accounting.outcomes.accepted, 2);
  const status = cache.status(agent.session.id);
  assert.equal(status.mechanism, 'automatic'); assert.equal(status.supplierCacheHit, 'unverified'); assert.equal(status.cost, null);
  receipt.cases.push({ name: 'forwarded-content', controlledHttpRequests: 2, softwareReservations: accounting.requestsStarted,
    accepted: accounting.outcomes.accepted, activeReservations: accounting.activeRequests, writerResponseStarts: status.writerResponseStarts });

  // No account/model-name fallback: a real unknown-capacity profile reaches the
  // real OptChat validator, then stops before a budget reservation or HTTP.
  const unknown = await create('unknown-capacity');
  const unknownConfig = { ...config, summarizationModel: 'gpt-5.4', summarizationProvider: provider.PROVIDER_ID };
  const unknownSummary = createNodeSummarizer(ctx, unknown, unknownConfig, fixed, { cache, validatePrepared: request => capacity.validatePrepared(request) });
  const beforeUnknown = requests.length;
  await assert.rejects(unknownSummary('OWN_UNKNOWN_CAPACITY ' + 'x'.repeat(1200), 512, lifetime.signal, task), /proven total-output ceiling/);
  assert.equal(requests.length, beforeUnknown); assert.equal((await budget(unknown).status()).requestsStarted, 0);
  receipt.cases.push({ name: 'unknown-capacity', controlledHttpRequests: 0, softwareReservations: 0 });

  const pendingAgent = await create('actual-missing-policy');
  const pendingSummary = summarizer(pendingAgent);
  const beforeMissing = requests.length;
  await ctx.credentials.deleteRecord(provider.SUBSCRIPTION_KEY);
  await assert.rejects(pendingSummary('OWN_MISSING ' + 'x'.repeat(1200), 512, lifetime.signal, task), /waiting for this route/);
  assert.equal((await budget(pendingAgent).status()).requestsStarted, 0);
  assert.equal(requests.length, beforeMissing);
  await ctx.credentials.modifyRecord(provider.SUBSCRIPTION_KEY, async () => ({ kind: 'grant', payload: { version: 1, credential: grant(),
    models: [{ id: MODEL, name: 'Synthetic GPT' }, { id: 'gpt-5.4', name: 'Synthetic unknown capacity' }] } }));
  await until(() => captureRequestPolicy(ctx, provider.PROVIDER_ID, MODEL, 'compaction').facts !== undefined);
  respond = (_request, res) => { begin(res); content(res); complete(res); };
  assert.equal(await pendingSummary('OWN_RECOVERED ' + 'x'.repeat(1200), 512, lifetime.signal, task), 'Owned native summary.');
  assert.equal((await budget(pendingAgent).status()).requestsStarted, 1);
  receipt.cases.push({ name: 'missing-policy-then-recovery', missingSoftwareReservations: 0, missingControlledHttpRequests: 0,
    recoveredSoftwareReservations: 1, recoveredControlledHttpRequests: requests.length - beforeMissing });

  const closedAgent = await create('actual-peer-close');
  const closeEntered = deferred(), closePeer = deferred();
  respond = async (_request, res) => { closeEntered.resolve(); await closePeer.promise; res.destroy(); };
  const closeSummary = summarizer(closedAgent);
  const closedWriter = track(closeSummary('OWN_CLOSE_A ' + 'x'.repeat(1200), 512, lifetime.signal, task));
  const closedWriterCheck = assert.rejects(closedWriter);
  await Promise.race([closeEntered.promise, closedWriter]);
  assert.equal(cache.status(closedAgent.session.id).writerResponseStarts, 0);
  closePeer.resolve(); await closedWriterCheck; await budget(closedAgent).drain();
  const closedAccounting = await budget(closedAgent).accounting();
  assert.equal(closedAccounting.activeRequests, 0); assert.equal(closedAccounting.outcomes.failed, 1);
  assert.equal(closedAccounting.requestsStarted, 1); assert.equal(cache.status(closedAgent.session.id).writerResponseStarts, 0);
  receipt.cases.push({ name: 'peer-close-before-content', softwareReservations: 1, failed: 1, activeReservations: 0, writerResponseStarts: 0 });

  const emptyAgent = await create('actual-usage-finish-only');
  respond = (_request, res) => {
    begin(res); emit(res, { type: 'response.completed', response: { id: 'resp_empty_owned', status: 'completed', output: [],
      usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 } } }); res.end();
  };
  const beforeEmpty = requests.length;
  await assert.rejects(summarizer(emptyAgent)('OWN_EMPTY ' + 'x'.repeat(1200), 512, lifetime.signal, task), /no content/);
  await budget(emptyAgent).drain();
  const emptyAccounting = await budget(emptyAgent).accounting();
  assert.equal(emptyAccounting.activeRequests, 0); assert.equal(emptyAccounting.requestsStarted, 1);
  assert.equal(cache.status(emptyAgent.session.id).writerResponseStarts, 0);
  receipt.cases.push({ name: 'usage-finish-only', controlledHttpRequests: requests.length - beforeEmpty,
    softwareReservations: emptyAccounting.requestsStarted, activeReservations: 0, writerResponseStarts: 0 });

  // Cancelling an actual worker and closing its peer must settle its real ledger.
  const cancelledAgent = await create('actual-caller-cancel');
  const cancelledEntered = deferred();
  respond = (_request, _res) => { cancelledEntered.resolve(); };
  const cancellation = new AbortController();
  const cancelled = track(summarizer(cancelledAgent)('OWN_CANCEL ' + 'x'.repeat(1200), 512, cancellation.signal, task));
  const cancelledCheck = assert.rejects(cancelled);
  await cancelledEntered.promise; cancellation.abort(new Error('owned caller cancellation')); await cancelledCheck;
  await budget(cancelledAgent).drain();
  const cancelledAccounting = await budget(cancelledAgent).accounting();
  assert.equal(cancelledAccounting.activeRequests, 0); assert.equal(cancelledAccounting.outcomes.cancelled, 1);
  receipt.cases.push({ name: 'caller-cancel', softwareReservations: cancelledAccounting.requestsStarted, activeReservations: 0,
    cancelled: cancelledAccounting.outcomes.cancelled });

  // Producer lifetime (not a credential feed) cancels both a writer at native
  // headers and its still-unreserved same-prefix follower.
  const disposedAgent = await create('actual-producer-dispose');
  const disposedEntered = deferred(); respond = () => { disposedEntered.resolve(); };
  const disposeSummary = summarizer(disposedAgent);
  const disposedWriter = track(disposeSummary('OWN_DISPOSE_A ' + 'x'.repeat(1200), 512, lifetime.signal, task));
  const writerCheck = assert.rejects(disposedWriter);
  await disposedEntered.promise;
  const disposedFollower = track(disposeSummary('OWN_DISPOSE_B ' + 'x'.repeat(1200), 512, lifetime.signal, task));
  const followerCheck = assert.rejects(disposedFollower);
  await until(() => cache.status(disposedAgent.session.id).waiting === 1);
  const captured = captureRequestPolicy(ctx, provider.PROVIDER_ID, MODEL, 'compaction');
  assert.ok(captured.routeSignal && !('lifetime' in captured.facts));
  await subscription.dispose(); subscription = undefined;
  await Promise.all([writerCheck, followerCheck]); await budget(disposedAgent).drain();
  const disposedAccounting = await budget(disposedAgent).accounting();
  assert.equal(disposedAccounting.requestsStarted, 1); assert.equal(disposedAccounting.activeRequests, 0);
  assert.equal(captured.routeSignal.aborted, true);
  assert.equal(captureRequestPolicy(ctx, provider.PROVIDER_ID, MODEL, 'compaction').facts, undefined);
  receipt.cases.push({ name: 'producer-dispose', softwareReservations: 1, cancelled: disposedAccounting.outcomes.cancelled,
    followerReserved: false, activeReservations: 0 });
} finally {
  shuttingDown = true; lifetime.abort(); cache?.close();
  for (const response of responses) response.destroy();
  await Promise.allSettled([...pending]);
  await subscription?.dispose();
  for (const agent of agents.reverse()) await agent.dispose();
  for (const mount of mounts.reverse()) await mount.dispose();
  clearTimeout(bounded); server?.closeAllConnections();
  if (server) await new Promise(done => server.close(done));
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
  receipt.ownedResourcesClosed = true;
}
receipt.controlledHttpRequests = requests.length;
receipt.optchatPackageVersion = JSON.parse(await readFile(join(optchat, 'package.json'))).version;
receipt.optchatCapacitySHA256 = createHash('sha256').update(await readFile(join(optchat, 'dist/capacity.js'))).digest('hex');
if (args.includes('--output')) await writeFile(resolve(arg('--output')), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
