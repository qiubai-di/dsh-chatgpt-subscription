import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWTPayload,
} from 'jose';
import {
  fetchSiwcModels,
  loginSiwc,
  refreshSiwc,
  revokeSiwc,
  SiwcError,
  validateSiwcCredential,
  verifySiwcIdToken,
  type SiwcCredential,
} from '../src/siwc.js';

// Every official request is intercepted. Only the loopback callback uses real HTTP.
const ISSUER = 'https://auth.openai.com';
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`;
const MODELS_URL = 'https://api.openai.com/v1/models';
const RESOURCE = 'https://api.openai.com/v1';
const CLIENT_ID = 'oaiapp_fixture_client';
const HOST_ID = 'urn:uuid:11111111-1111-4111-8111-111111111111';
const SUBJECT = 'fixture-subject';
const NOW = Date.UTC(2026, 9, 22, 12);
const SCOPES = [
  'openid', 'profile', 'email', 'offline_access',
  'resource.invoke', 'chatgpt.tokens.use.direct',
];
const trustedKey = await generateKeyPair('RS256');
const wrongKey = await generateKeyPair('RS256');
const jwks = createLocalJWKSet({
  keys: [{ ...await exportJWK(trustedKey.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }],
});

async function idToken(overrides: JWTPayload = {}, wrongSignature = false): Promise<string> {
  return new SignJWT({
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: SUBJECT,
    iat: Math.floor(NOW / 1000),
    exp: Math.floor(NOW / 1000) + 3600,
    email: 'fixture@example.test',
    nonce: 'fixture-nonce',
    ...overrides,
  }).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' })
    .sign(wrongSignature ? wrongKey.privateKey : trustedKey.privateKey);
}

async function credential(): Promise<SiwcCredential> {
  return {
    type: 'oauth',
    access: 'fixture-access-secret',
    refresh: 'fixture-refresh-secret',
    expires: NOW + 3_600_000,
    clientId: CLIENT_ID,
    idToken: await idToken(),
    scopes: [...SCOPES],
    issuer: ISSUER,
    subject: SUBJECT,
    email: 'fixture@example.test',
    hostId: HOST_ID,
  };
}

function assertSafeError(error: unknown, secrets: string[] = []): error is SiwcError {
  assert.ok(error instanceof SiwcError);
  assert.match(error.code, /^[a-z][a-z0-9_-]*$/i);
  for (const secret of secrets) {
    assert.equal(error.message.includes(secret), false, 'error must not expose fixture secrets');
    assert.equal(String(error).includes(secret), false, 'stringified error must not expose fixture secrets');
  }
  return true;
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: URLSearchParams;
}

function offlineFetch(
  handler: (request: RecordedRequest) => Response | Promise<Response>,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    return handler({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: new URLSearchParams(await request.text()),
    });
  };
}

function tokenResponse(token: string, overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    access_token: 'fixture-new-access-secret',
    refresh_token: 'fixture-new-refresh-secret',
    id_token: token,
    token_type: 'Bearer',
    expires_in: 1800,
    scope: SCOPES.join(' '),
    ...overrides,
  });
}

interface LoginFixtureOptions {
  previousCredential?: SiwcCredential;
  registration?: { clientId: string; issuer: string; subject?: string; idToken?: string; email?: string };
  onRegistration?: () => void | Promise<void>;
  response?: (authorization: URL) => Response | Promise<Response>;
}

function startLogin(t: TestContext, options: LoginFixtureOptions = {}) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  let resolveAuthorization!: (url: URL) => void;
  const authorization = new Promise<URL>((resolve) => { resolveAuthorization = resolve; });
  let currentAuthorization: URL | undefined;
  const requests: RecordedRequest[] = [];
  const order: string[] = [];
  const registrations: Array<{ clientId: string; issuer: string }> = [];
  const completion = loginSiwc({
    notify(event) {
      if (event.type === 'auth_url') {
        assert.ok(event.url);
        currentAuthorization = new URL(event.url);
        resolveAuthorization(currentAuthorization);
      }
    },
  }, {
    getDeviceId: () => HOST_ID,
    agentName: 'DeepSeek Harness',
    previousCredential: options.previousCredential,
    registration: options.registration,
    async onRegistration(registration) {
      registrations.push(registration);
      order.push('registration');
      await options.onRegistration?.();
    },
    fetch: offlineFetch(async (request) => {
      assert.equal(request.url, TOKEN_URL, 'fixture forbids any other official or external request');
      assert.ok(currentAuthorization);
      order.push('token');
      requests.push(request);
      return options.response
        ? options.response(currentAuthorization)
        : tokenResponse(await idToken({ nonce: currentAuthorization.searchParams.get('nonce') }));
    }),
    jwks,
    now: () => NOW,
    signal: controller.signal,
    callbackTimeoutMs: 5000,
  });
  // A rejected login must not become an unhandled rejection while a callback is being asserted.
  void completion.catch(() => undefined);
  return {
    authorization: Promise.race([
      authorization,
      completion.then(() => { throw new Error('login completed without an authorization URL'); }),
    ]),
    completion, controller, requests, order, registrations,
  };
}

function callbackUrl(authorization: URL, overrides: Record<string, string | null> = {}): URL {
  const redirectUri = authorization.searchParams.get('redirect_uri');
  assert.ok(redirectUri);
  const callback = new URL(redirectUri);
  assert.equal(callback.protocol, 'http:');
  assert.equal(callback.hostname, '127.0.0.1', 'offline callbacks must stay on IPv4 loopback');
  assert.ok(Number(callback.port) > 0);
  callback.searchParams.set('code', 'fixture-authorization-code-secret');
  callback.searchParams.set('state', authorization.searchParams.get('state') ?? '');
  callback.searchParams.set('client_id', CLIENT_ID);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) callback.searchParams.delete(key);
    else callback.searchParams.set(key, value);
  }
  return callback;
}

async function sendCallback(url: URL): Promise<Response> {
  const response = await fetch(url, { redirect: 'error' });
  const body = await response.text();
  if (response.status >= 400) {
    assert.equal(body.includes('fixture-authorization-code-secret'), false);
    assert.equal(body.includes(url.search), false, 'callback error page must not expose the query');
  }
  return response;
}

test('credential validation preserves issued identity and rejects incomplete subscription grants', async () => {
  const saved = await credential();
  assert.deepEqual(validateSiwcCredential(saved), saved);
  for (const invalid of [
    { ...saved, clientId: 'dynamic_agent_client' },
    { ...saved, issuer: 'https://untrusted.example.test' },
    { ...saved, subject: '' },
    { ...saved, refresh: '' },
    { ...saved, scopes: saved.scopes.filter((scope) => scope !== 'chatgpt.tokens.use.direct') },
    { ...saved, scopes: saved.scopes.filter((scope) => scope !== 'offline_access') },
  ]) {
    assert.throws(() => validateSiwcCredential(invalid), (error) => assertSafeError(error));
  }
});

test('OIDC verifies a locally signed RS256 token and issued-client audience', async () => {
  const payload = await verifySiwcIdToken(await idToken({ aud: ['other-client', CLIENT_ID], azp: CLIENT_ID }), {
    clientId: CLIENT_ID, nonce: 'fixture-nonce', expectedSubject: SUBJECT, jwks, now: () => NOW,
  });
  assert.equal(payload.sub, SUBJECT);
  assert.equal(payload.iss, ISSUER);
});

test('OIDC independently rejects issuer, audience, nonce, signature, expiry and required-claim failures', async (t) => {
  const cases: Array<{ name: string; claims: JWTPayload; wrongSignature?: boolean }> = [
    { name: 'wrong issuer', claims: { iss: 'https://untrusted.example.test' } },
    { name: 'resource audience is not the client audience', claims: { aud: RESOURCE } },
    { name: 'dynamic client audience is not an issued identity', claims: { aud: 'dynamic_agent_client' } },
    { name: 'wrong nonce', claims: { nonce: 'unrelated-attempt' } },
    { name: 'wrong signature', claims: {}, wrongSignature: true },
    { name: 'expired beyond clock tolerance', claims: { exp: Math.floor(NOW / 1000) - 60 } },
    { name: 'missing expiry', claims: { exp: undefined } },
    { name: 'missing issued-at', claims: { iat: undefined } },
    { name: 'empty subject', claims: { sub: '' } },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const token = await idToken(fixture.claims, fixture.wrongSignature);
      await assert.rejects(verifySiwcIdToken(token, {
        clientId: CLIENT_ID, nonce: 'fixture-nonce', jwks, now: () => NOW,
      }), (error) => assertSafeError(error, [token]));
    });
  }
});

test('first login binds loopback first, uses PKCE, and saves issued client before token exchange', { timeout: 10_000 }, async (t) => {
  let releaseRegistration!: () => void;
  let registrationStarted!: () => void;
  const stored = new Promise<void>((resolve) => { releaseRegistration = resolve; });
  const started = new Promise<void>((resolve) => { registrationStarted = resolve; });
  t.after(() => releaseRegistration());
  const fixture = startLogin(t, {
    onRegistration: async () => {
      registrationStarted();
      await stored;
    },
  });
  const authorization = await fixture.authorization;
  assert.equal(authorization.origin + authorization.pathname, `${ISSUER}/api/accounts/authorize`);
  assert.equal(authorization.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(authorization.searchParams.get('agent_name_hint'), 'DeepSeek Harness');
  assert.equal(authorization.searchParams.get('ext_agent_host_id'), HOST_ID);
  assert.equal(authorization.searchParams.get('response_type'), 'code');
  assert.equal(authorization.searchParams.get('resource'), RESOURCE);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.has('code_verifier'), false);
  assert.deepEqual(new Set(authorization.searchParams.get('scope')?.split(' ')), new Set(SCOPES));
  assert.ok(authorization.searchParams.get('nonce'));
  assert.ok(authorization.searchParams.get('state'));
  const callback = callbackUrl(authorization);
  assert.equal(callback.hostname, '127.0.0.1');
  assert.equal(callback.protocol, 'http:');
  assert.equal(callback.pathname, '/auth/callback');
  assert.ok(Number(callback.port) > 0);
  const callbackResponse = sendCallback(callback);
  await started;
  assert.equal(fixture.requests.length, 0, 'registration persistence must finish before token exchange');
  releaseRegistration();
  assert.equal((await callbackResponse).status, 200);
  const result = await fixture.completion;
  assert.equal(result.clientId, CLIENT_ID);
  assert.equal(result.subject, SUBJECT);
  assert.equal(result.hostId, HOST_ID);
  assert.deepEqual(fixture.order, ['registration', 'token']);
  assert.equal(fixture.registrations[0]?.clientId, CLIENT_ID);
  assert.equal(fixture.registrations[0]?.issuer, ISSUER);
  assert.equal(fixture.requests.length, 1);
  const request = fixture.requests[0]!;
  assert.equal(request.method, 'POST');
  assert.match(request.headers.get('content-type') ?? '', /^application\/x-www-form-urlencoded(?:;|$)/);
  assert.equal(request.headers.has('authorization'), false);
  assert.equal(request.body.get('grant_type'), 'authorization_code');
  assert.equal(request.body.get('client_id'), CLIENT_ID);
  assert.equal(request.body.get('code'), 'fixture-authorization-code-secret');
  assert.equal(request.body.get('resource'), RESOURCE);
  assert.equal(request.body.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
  assert.equal(request.body.has('client_secret'), false);
  const verifier = request.body.get('code_verifier');
  assert.ok(verifier);
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), authorization.searchParams.get('code_challenge'));
});

test('wrong state and malformed callbacks return 400 without consuming the pending attempt', { timeout: 10_000 }, async (t) => {
  const fixture = startLogin(t);
  const authorization = await fixture.authorization;
  const malformed = [
    callbackUrl(authorization, { state: 'wrong-state' }),
    callbackUrl(authorization, { code: null }),
    callbackUrl(authorization, { client_id: null }),
  ];
  const duplicateState = callbackUrl(authorization);
  duplicateState.searchParams.append('state', authorization.searchParams.get('state')!);
  malformed.push(duplicateState);
  for (const callback of malformed) {
    assert.equal((await sendCallback(callback)).status, 400);
    assert.equal(fixture.requests.length, 0);
  }
  assert.equal((await sendCallback(callbackUrl(authorization))).status, 200);
  await fixture.completion;
  assert.equal(fixture.requests.length, 1);
});

test('login uses actual token scopes rather than requested, callback or ID-token scopes', { timeout: 10_000 }, async (t) => {
  const fixture = startLogin(t, {
    response: async (authorization) => tokenResponse(await idToken({
      nonce: authorization.searchParams.get('nonce'), scope: SCOPES.join(' '),
    }), { scope: 'openid profile email offline_access resource.invoke' }),
  });
  const authorization = await fixture.authorization;
  await sendCallback(callbackUrl(authorization, { scope: SCOPES.join(' ') }));
  await assert.rejects(fixture.completion, (error) => assertSafeError(error));
});

test('issued registration survives invalid_grant and can be reused without agent registration hints', { timeout: 10_000 }, async (t) => {
  const first = startLogin(t, {
    response: () => Response.json({ error: 'invalid_grant', error_description: 'fixture-raw-response-secret' }, { status: 400 }),
  });
  const initialAuthorization = await first.authorization;
  await sendCallback(callbackUrl(initialAuthorization));
  await assert.rejects(first.completion, (error) => assertSafeError(error, ['fixture-raw-response-secret']));
  assert.deepEqual(first.order, ['registration', 'token']);
  assert.equal(first.registrations[0]?.clientId, CLIENT_ID);
  const second = startLogin(t, { registration: first.registrations[0]! });
  const authorization = await second.authorization;
  assert.equal(authorization.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(authorization.searchParams.has('agent_name_hint'), false);
  assert.equal(authorization.searchParams.get('ext_agent_host_id'), HOST_ID);
  assert.notEqual(authorization.searchParams.get('state'), initialAuthorization.searchParams.get('state'));
  assert.notEqual(authorization.searchParams.get('nonce'), initialAuthorization.searchParams.get('nonce'));
  assert.notEqual(authorization.searchParams.get('code_challenge'), initialAuthorization.searchParams.get('code_challenge'));
  await sendCallback(callbackUrl(authorization, { client_id: null }));
  assert.equal((await second.completion).clientId, CLIENT_ID);
});

test('relogin reuses issued identity and cannot replace it with another subject', { timeout: 10_000 }, async (t) => {
  const saved = await credential();
  const fixture = startLogin(t, {
    previousCredential: saved,
    response: async (authorization) => tokenResponse(await idToken({
      nonce: authorization.searchParams.get('nonce'), sub: 'different-subject',
    })),
  });
  const authorization = await fixture.authorization;
  assert.equal(authorization.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(authorization.searchParams.get('ext_agent_host_id'), HOST_ID);
  assert.equal(authorization.searchParams.has('id_token_hint'), false);
  assert.equal(authorization.href.includes(saved.idToken), false);
  assert.equal(authorization.searchParams.has('login_hint'), false);
  assert.equal(authorization.href.includes(saved.email!), false);
  assert.equal(authorization.searchParams.has('agent_name_hint'), false);
  await sendCallback(callbackUrl(authorization, { client_id: null }));
  await assert.rejects(fixture.completion, (error) => assertSafeError(error));
  assert.equal(saved.subject, SUBJECT);
  assert.equal(saved.access, 'fixture-access-secret');
});

test('abort cancels callback wait and releases its listener without a token request', { timeout: 10_000 }, async (t) => {
  const fixture = startLogin(t);
  const authorization = await fixture.authorization;
  const callback = callbackUrl(authorization);
  fixture.controller.abort();
  await assert.rejects(fixture.completion, (error) => assertSafeError(error));
  assert.equal(fixture.requests.length, 0);
  await assert.rejects(fetch(callback, { redirect: 'error' }));
});

test('refresh rotates both tokens with issued client and never requests a new scope', async () => {
  const saved = await credential();
  let request: RecordedRequest | undefined;
  const result = await refreshSiwc(saved, {
    jwks, now: () => NOW,
    fetch: offlineFetch(async (captured) => {
      request = captured;
      return tokenResponse(await idToken());
    }),
  });
  assert.ok(request);
  assert.equal(request.url, TOKEN_URL);
  assert.equal(request.method, 'POST');
  assert.equal(request.body.get('grant_type'), 'refresh_token');
  assert.equal(request.body.get('client_id'), CLIENT_ID);
  assert.equal(request.body.get('refresh_token'), saved.refresh);
  assert.equal(request.body.get('resource'), RESOURCE);
  assert.equal(request.body.has('scope'), false);
  assert.equal(request.body.has('client_secret'), false);
  assert.equal(result.access, 'fixture-new-access-secret');
  assert.equal(result.refresh, 'fixture-new-refresh-secret');
  assert.equal(result.expires, NOW + 1_800_000);
  assert.equal(result.subject, saved.subject);
  assert.deepEqual(new Set(result.scopes), new Set(SCOPES));
  assert.equal(saved.refresh, 'fixture-refresh-secret');
});

test('refresh rejects subject drift instead of overwriting the selected identity', async () => {
  const saved = await credential();
  await assert.rejects(refreshSiwc(saved, {
    jwks, now: () => NOW,
    fetch: offlineFetch(async () => tokenResponse(await idToken({ sub: 'different-subject' }))),
  }), (error) => assertSafeError(error));
  assert.equal(saved.subject, SUBJECT);
  assert.equal(saved.refresh, 'fixture-refresh-secret');
});

test('refresh may omit identity token and scope while preserving the verified grant after ID-token expiry', async () => {
  const saved = await credential();
  saved.idToken = await idToken({
    iat: Math.floor(NOW / 1000) - 7200,
    exp: Math.floor(NOW / 1000) - 3600,
  });
  const result = await refreshSiwc(saved, {
    jwks, now: () => NOW,
    fetch: offlineFetch((request) => {
      assert.equal(request.url, TOKEN_URL);
      assert.equal(request.body.has('scope'), false);
      return Response.json({
        access_token: 'fixture-new-access-secret',
        refresh_token: 'fixture-new-refresh-secret',
        token_type: 'Bearer',
        expires_in: 1800,
      });
    }),
  });
  assert.equal(result.access, 'fixture-new-access-secret');
  assert.equal(result.refresh, 'fixture-new-refresh-secret');
  assert.equal(result.expires, NOW + 1_800_000);
  assert.equal(result.idToken, saved.idToken);
  assert.equal(result.issuer, saved.issuer);
  assert.equal(result.clientId, saved.clientId);
  assert.equal(result.subject, saved.subject);
  assert.equal(result.email, saved.email);
  assert.deepEqual(result.scopes, saved.scopes);
});

test('refresh cannot inherit an explicitly removed scope or reuse an absent replacement refresh token', async (t) => {
  const cases = [
    { name: 'explicit empty scope', response: { scope: '' } },
    { name: 'explicit scope without subscription access', response: { scope: 'openid offline_access resource.invoke' } },
    { name: 'missing replacement refresh token', response: { refresh_token: undefined } },
    { name: 'empty replacement refresh token', response: { refresh_token: '' } },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const saved = await credential();
      await assert.rejects(refreshSiwc(saved, {
        jwks, now: () => NOW,
        fetch: offlineFetch(() => Response.json({
          access_token: 'fixture-new-access-secret',
          refresh_token: 'fixture-new-refresh-secret',
          token_type: 'Bearer',
          expires_in: 1800,
          ...fixture.response,
        })),
      }), (error) => assertSafeError(error, [saved.refresh, 'fixture-new-access-secret']));
      assert.equal(saved.refresh, 'fixture-refresh-secret');
    });
  }
});

test('model catalog reads models, filters list visibility and preserves server order', async () => {
  const saved = await credential();
  const models = await fetchSiwcModels(saved, {
    fetch: offlineFetch((request) => {
      assert.equal(request.url, MODELS_URL);
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.get('authorization'), `Bearer ${saved.access}`);
      return Response.json({
        models: [
          { slug: 'model-z', display_name: 'First visible', visibility: 'list' },
          { slug: 'model-hidden', display_name: 'Hidden', visibility: 'hidden' },
          { slug: 'model-unlisted', display_name: 'Unlisted' },
          { slug: 'model-a', display_name: 'Second visible', visibility: 'list' },
        ],
        data: [{ id: 'wrong-api-key-shape' }],
      });
    }),
  });
  assert.deepEqual(models, [
    { id: 'model-z', name: 'First visible' },
    { id: 'model-a', name: 'Second visible' },
  ]);
});

test('revocation posts refresh token and accepts an empty HTTP 200', async () => {
  const saved = await credential();
  await revokeSiwc(saved, {
    fetch: offlineFetch((request) => {
      assert.equal(request.url, REVOKE_URL);
      assert.equal(request.method, 'POST');
      assert.equal(request.body.get('client_id'), CLIENT_ID);
      assert.equal(request.body.get('token'), saved.refresh);
      assert.equal(request.body.get('token_type_hint'), 'refresh_token');
      return new Response(null, { status: 200 });
    }),
  });
});

test('revocation HTTP 5xx is not reported as successful and does not expose raw response', async () => {
  const saved = await credential();
  await assert.rejects(revokeSiwc(saved, {
    fetch: offlineFetch(() => new Response('fixture-raw-response-secret', { status: 503 })),
  }), (error) => assertSafeError(error, ['fixture-raw-response-secret', saved.refresh, saved.access]));
});
