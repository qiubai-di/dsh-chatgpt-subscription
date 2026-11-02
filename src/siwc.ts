import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from 'jose';
import { startLoopback } from './loopback.js';
import { SiwcError } from './siwc-error.js';

export { SiwcError } from './siwc-error.js';

export const SIWC_ENDPOINTS = Object.freeze({
  issuer: 'https://auth.openai.com',
  authorize: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  revoke: 'https://auth.openai.com/api/accounts/oauth/revoke',
  jwks: 'https://auth.openai.com/.well-known/jwks.json',
  resource: 'https://api.openai.com/v1',
  models: 'https://api.openai.com/v1/models',
  responses: 'https://api.openai.com/v1/responses',
});

export const SIWC_SCOPES = Object.freeze([
  'openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct',
]);
const REQUIRED_SCOPES = ['openid', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
const DEFAULT_JWKS = createRemoteJWKSet(new URL(SIWC_ENDPOINTS.jwks), { timeoutDuration: 10_000 });

export interface SiwcCredential {
  type: 'oauth';
  access: string;
  refresh: string;
  /** Epoch milliseconds, matching pi-ai's OAuthCredential contract. */
  expires: number;
  clientId: string;
  idToken: string;
  scopes: string[];
  issuer: string;
  subject: string;
  email?: string;
  hostId: string;
  [key: string]: unknown;
}

export interface SiwcRegistration {
  clientId: string;
  issuer: string;
  subject?: string;
  idToken?: string;
  email?: string;
}

export interface SiwcModel {
  id: string;
  name: string;
}

/** Injection is a code-level offline-test seam, never an end-user endpoint option. */
export interface SiwcNetworkOptions {
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  jwks?: JWTVerifyGetKey;
  now?: () => number;
  requestTimeoutMs?: number;
}

export interface SiwcInteraction {
  notify(event: {
    type: 'auth_url' | 'info';
    url?: string;
    instructions?: string;
    message?: string;
  }): void | Promise<void>;
}

export interface SiwcLoginOptions extends SiwcNetworkOptions {
  getDeviceId: () => string;
  agentName: string;
  previousCredential?: SiwcCredential;
  registration?: SiwcRegistration;
  /** Persist the issued registration before attempting the one-use code exchange. */
  onRegistration?: (registration: SiwcRegistration) => void | Promise<void>;
  callbackTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validClientId(value: unknown): value is string {
  return typeof value === 'string' && value !== DYNAMIC_CLIENT_ID && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
}

function ensureScopes(value: unknown): string[] {
  const scopes = typeof value === 'string'
    ? value.trim().split(/\s+/).filter(Boolean)
    : Array.isArray(value) && value.every((scope) => nonempty(scope)) ? value as string[] : undefined;
  if (scopes === undefined || REQUIRED_SCOPES.some((scope) => !scopes.includes(scope))) {
    throw new SiwcError('MISSING_SCOPE', 'The granted permissions do not include renewable ChatGPT plan access.');
  }
  return [...new Set(scopes)];
}

function hostId(deviceId: string): string {
  const uuid = deviceId.startsWith('urn:uuid:') ? deviceId.slice(9) : deviceId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new SiwcError('INVALID_HOST_ID', 'This installation needs a persistent UUIDv4 before sign-in.');
  }
  return `urn:uuid:${uuid.toLowerCase()}`;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SiwcError('REQUEST_ABORTED', 'The account operation was cancelled.');
}

export function validateSiwcCredential(value: unknown): SiwcCredential {
  if (!isRecord(value) || value.type !== 'oauth' || !nonempty(value.access) || !nonempty(value.refresh)
    || !validClientId(value.clientId) || !nonempty(value.idToken) || value.issuer !== SIWC_ENDPOINTS.issuer
    || !nonempty(value.subject) || typeof value.expires !== 'number' || !Number.isFinite(value.expires)
    || value.expires <= 0 || typeof value.hostId !== 'string'
    || (value.email !== undefined && typeof value.email !== 'string')) {
    throw new SiwcError('INVALID_CREDENTIAL', 'The saved ChatGPT authorization is incomplete or invalid.');
  }
  hostId(value.hostId);
  if (!Array.isArray(value.scopes)) throw new SiwcError('INVALID_CREDENTIAL', 'The saved authorization has no granted scopes.');
  ensureScopes(value.scopes);
  return value as SiwcCredential;
}

export interface VerifySiwcIdTokenOptions extends Pick<SiwcNetworkOptions, 'jwks' | 'now'> {
  clientId: string;
  nonce?: string;
  expectedSubject?: string;
}

/** Verify signatures and OIDC identity before any new account becomes active. */
export async function verifySiwcIdToken(token: string, options: VerifySiwcIdTokenOptions): Promise<JWTPayload> {
  if (!validClientId(options.clientId) || !nonempty(token)) {
    throw new SiwcError('ID_TOKEN_INVALID', 'The identity token or client registration is invalid.');
  }
  const now = (options.now ?? Date.now)();
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, options.jwks ?? DEFAULT_JWKS, {
      algorithms: ['RS256'],
      issuer: SIWC_ENDPOINTS.issuer,
      audience: options.clientId,
      requiredClaims: ['sub', 'exp', 'iat'],
      clockTolerance: 5,
      currentDate: new Date(now),
    }));
  } catch {
    throw new SiwcError('ID_TOKEN_INVALID', 'OpenAI identity verification failed. Sign in again.');
  }
  if (!nonempty(payload.sub) || typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)
    || payload.iat > now / 1000 + 5 || typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)
    || payload.exp <= payload.iat
    || (payload.azp !== undefined && payload.azp !== options.clientId)
    || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== options.clientId)) {
    throw new SiwcError('ID_TOKEN_INVALID', 'The verified identity claims are not valid for this registration.');
  }
  if (options.nonce !== undefined) {
    const actual = typeof payload.nonce === 'string' ? Buffer.from(payload.nonce) : Buffer.alloc(0);
    const expected = Buffer.from(options.nonce);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new SiwcError('ID_TOKEN_NONCE_MISMATCH', 'The identity response does not match this sign-in attempt.');
    }
  }
  if (options.expectedSubject !== undefined && payload.sub !== options.expectedSubject) {
    throw new SiwcError('ACCOUNT_MISMATCH', 'The returned authorization belongs to a different account.');
  }
  return payload;
}

async function request(url: string, init: RequestInit, options: SiwcNetworkOptions): Promise<Response> {
  checkAbort(options.signal);
  const timeout = options.requestTimeoutMs ?? 15_000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120_000) {
    throw new SiwcError('INVALID_TIMEOUT', 'The account request timeout is invalid.');
  }
  const deadline = AbortSignal.timeout(timeout);
  const signal = options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]);
  try {
    return await (options.fetch ?? globalThis.fetch)(url, { ...init, signal, redirect: 'error' });
  } catch {
    if (options.signal?.aborted) throw new SiwcError('REQUEST_ABORTED', 'The account operation was cancelled.');
    throw new SiwcError('REQUEST_FAILED', 'The OpenAI account request could not be completed.');
  }
}

async function readJson(response: Response, maxBytes = 128 * 1024): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new SiwcError('INVALID_RESPONSE', 'OpenAI returned an empty account response.');
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new SiwcError('INVALID_RESPONSE', 'The account response exceeded its supported size.');
      }
      chunks.push(chunk.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!isRecord(value)) throw new SiwcError('INVALID_RESPONSE', 'OpenAI returned an invalid account response.');
    return value;
  } catch (error) {
    if (error instanceof SiwcError) throw error;
    throw new SiwcError('INVALID_RESPONSE', 'OpenAI returned an unreadable account response.');
  } finally {
    reader.releaseLock();
  }
}

async function tokenRequest(form: URLSearchParams, options: SiwcNetworkOptions): Promise<Record<string, unknown>> {
  const response = await request(SIWC_ENDPOINTS.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  }, options);
  if (!response.ok) {
    // Only a known error identifier crosses the boundary. Never reflect server text.
    let code: unknown;
    try { code = (await readJson(response)).error; } catch { /* Status still supplies the account error. */ }
    if (code === 'invalid_grant') throw new SiwcError('REAUTHORIZATION_REQUIRED', 'The authorization expired or was revoked. Sign in again.');
    if (code === 'access_denied') throw new SiwcError('LOGIN_DENIED', 'The account authorization was declined.');
    throw new SiwcError('TOKEN_REQUEST_FAILED', 'OpenAI did not complete the token request.');
  }
  return readJson(response);
}

async function credentialFromResponse(
  response: Record<string, unknown>,
  context: { mode: 'login' | 'refresh'; clientId: string; hostId: string; nonce?: string; previous?: SiwcCredential },
  options: SiwcNetworkOptions,
): Promise<SiwcCredential> {
  const refreshing = context.mode === 'refresh';
  if (!nonempty(response.access_token) || !nonempty(response.refresh_token)
    || (!refreshing && !nonempty(response.id_token))
    || (Object.hasOwn(response, 'id_token') && !nonempty(response.id_token))
    || typeof response.token_type !== 'string'
    || response.token_type.toLowerCase() !== 'bearer'
    || typeof response.expires_in !== 'number' || !Number.isFinite(response.expires_in)
    || response.expires_in <= 0) {
    throw new SiwcError('INVALID_TOKEN_RESPONSE', 'OpenAI did not return a complete renewable authorization.');
  }
  // A refresh preserves the existing grant when scope is omitted. An explicit
  // empty/reduced grant must still fail, rather than inheriting removed access.
  const scopes = refreshing && !Object.hasOwn(response, 'scope') && context.previous !== undefined
    ? [...context.previous.scopes] : ensureScopes(response.scope);
  let identity: JWTPayload;
  let idToken: string;
  if (nonempty(response.id_token)) {
    idToken = response.id_token;
    identity = await verifySiwcIdToken(idToken, {
      clientId: context.clientId,
      nonce: context.nonce,
      expectedSubject: context.previous?.subject,
      jwks: options.jwks,
      now: options.now,
    });
  } else if (refreshing && context.previous !== undefined) {
    // No new identity assertion was issued. Preserve the previously verified
    // identity; an old ID token's expiry does not expire the new access token.
    idToken = context.previous.idToken;
    identity = { sub: context.previous.subject, ...(context.previous.email === undefined ? {} : { email: context.previous.email }) };
  } else {
    throw new SiwcError('INVALID_TOKEN_RESPONSE', 'The authorization has no verified identity token.');
  }
  checkAbort(options.signal);
  const expires = (options.now ?? Date.now)() + response.expires_in * 1000;
  if (!Number.isFinite(expires)) throw new SiwcError('INVALID_TOKEN_RESPONSE', 'The account token expiry is invalid.');
  return validateSiwcCredential({
    type: 'oauth',
    access: response.access_token,
    refresh: response.refresh_token,
    expires,
    clientId: context.clientId,
    idToken,
    scopes,
    issuer: SIWC_ENDPOINTS.issuer,
    subject: identity.sub,
    ...(typeof identity.email === 'string' ? { email: identity.email } : {}),
    hostId: context.hostId,
  });
}

function registrationForLogin(options: SiwcLoginOptions): SiwcRegistration | undefined {
  const credential = options.previousCredential === undefined ? undefined : validateSiwcCredential(options.previousCredential);
  const registration = options.registration;
  if (registration !== undefined && (!validClientId(registration.clientId) || registration.issuer !== SIWC_ENDPOINTS.issuer
    || (registration.subject !== undefined && !nonempty(registration.subject))
    || (registration.idToken !== undefined && !nonempty(registration.idToken)))) {
    throw new SiwcError('INVALID_REGISTRATION', 'The saved client registration is invalid.');
  }
  if (credential !== undefined && registration !== undefined && credential.clientId !== registration.clientId) {
    throw new SiwcError('CLIENT_ID_MISMATCH', 'The selected account and registration do not match.');
  }
  return credential === undefined ? registration : {
    clientId: credential.clientId, issuer: credential.issuer, subject: credential.subject,
    idToken: credential.idToken, ...(credential.email === undefined ? {} : { email: credential.email }),
  };
}

export async function loginSiwc(interaction: SiwcInteraction, options: SiwcLoginOptions): Promise<SiwcCredential> {
  checkAbort(options.signal);
  const installation = hostId(options.getDeviceId());
  if (typeof options.agentName !== 'string' || options.agentName.trim().length === 0
    || options.agentName.length > 128 || /[\u0000-\u001f\u007f]/.test(options.agentName)) {
    throw new SiwcError('INVALID_AGENT_NAME', 'Sign-in requires this application\'s actual name.');
  }
  const registration = registrationForLogin(options);
  const callbackTimeoutMs = options.callbackTimeoutMs ?? 5 * 60_000;
  if (!Number.isFinite(callbackTimeoutMs) || callbackTimeoutMs < 1 || callbackTimeoutMs > 15 * 60_000) {
    throw new SiwcError('INVALID_TIMEOUT', 'The sign-in time limit is invalid.');
  }
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const callback = await startLoopback({ state, clientId: registration?.clientId, signal: options.signal, timeoutMs: callbackTimeoutMs });
  try {
    const authorization = new URL(SIWC_ENDPOINTS.authorize);
    authorization.search = new URLSearchParams({
      client_id: registration?.clientId ?? DYNAMIC_CLIENT_ID,
      ...(registration === undefined ? { agent_name_hint: options.agentName.trim() } : {}),
      ext_agent_host_id: installation,
      response_type: 'code',
      redirect_uri: callback.redirectUri,
      scope: SIWC_SCOPES.join(' '),
      resource: SIWC_ENDPOINTS.resource,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      // This URL is displayed to the user. Omit optional identity/email hints so
      // terminal output and authorization notices contain no ID token or email.
      // Reauthorization without hints remains supported and verifies subject.
    }).toString();
    await interaction.notify({
      type: 'auth_url', url: authorization.toString(),
      instructions: 'Open this OpenAI page to authorize DSH ChatGPT Subscription. The link is private to this sign-in attempt.',
    });
    const returned = await callback.result;
    checkAbort(options.signal);
    const pending: SiwcRegistration = {
      clientId: returned.clientId,
      issuer: SIWC_ENDPOINTS.issuer,
      ...(registration?.subject === undefined ? {} : { subject: registration.subject }),
      ...(registration?.email === undefined ? {} : { email: registration.email }),
      ...(registration?.idToken === undefined ? {} : { idToken: registration.idToken }),
    };
    await options.onRegistration?.(pending);
    checkAbort(options.signal);
    const response = await tokenRequest(new URLSearchParams({
      grant_type: 'authorization_code', client_id: returned.clientId,
      code: returned.code, code_verifier: verifier,
      redirect_uri: callback.redirectUri, resource: SIWC_ENDPOINTS.resource,
    }), options);
    const credential = await credentialFromResponse(response, {
      mode: 'login', clientId: returned.clientId, hostId: installation, nonce, previous: options.previousCredential,
    }, options);
    if (registration?.subject !== undefined && credential.subject !== registration.subject) {
      throw new SiwcError('ACCOUNT_MISMATCH', 'The returned authorization belongs to a different saved account.');
    }
    return credential;
  } finally {
    await callback.close();
  }
}

/** Caller must run this inside the credential store's cross-process mutation lock. */
export async function refreshSiwc(value: SiwcCredential, options: SiwcNetworkOptions = {}): Promise<SiwcCredential> {
  const credential = validateSiwcCredential(value);
  const response = await tokenRequest(new URLSearchParams({
    grant_type: 'refresh_token', client_id: credential.clientId,
    refresh_token: credential.refresh, resource: SIWC_ENDPOINTS.resource,
  }), options);
  return credentialFromResponse(response, {
    mode: 'refresh', clientId: credential.clientId, hostId: credential.hostId, previous: credential,
  }, options);
}

/** Remote failure is an error; the caller decides whether to retain a revocation retry. */
export async function revokeSiwc(value: SiwcCredential, options: SiwcNetworkOptions = {}): Promise<void> {
  const credential = validateSiwcCredential(value);
  const response = await request(SIWC_ENDPOINTS.revoke, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: credential.refresh, token_type_hint: 'refresh_token', client_id: credential.clientId }),
  }, options);
  if (response.status !== 200) {
    throw new SiwcError('REVOCATION_UNCONFIRMED', 'OpenAI did not confirm revocation. The saved authorization has been retained for retry.');
  }
  checkAbort(options.signal);
}

export async function fetchSiwcModels(value: SiwcCredential, options: SiwcNetworkOptions = {}): Promise<SiwcModel[]> {
  const credential = validateSiwcCredential(value);
  const response = await request(SIWC_ENDPOINTS.models, {
    method: 'GET', headers: { Authorization: `Bearer ${credential.access}`, Accept: 'application/json' },
  }, options);
  if (response.status === 401) throw new SiwcError('REAUTHORIZATION_REQUIRED', 'The account model catalog requires a valid authorization.');
  if (!response.ok) throw new SiwcError('MODEL_CATALOG_FAILED', 'OpenAI did not return the account model catalog.');
  const data = await readJson(response, 2 * 1024 * 1024);
  if (!Array.isArray(data.models)) throw new SiwcError('INVALID_MODEL_CATALOG', 'The account model catalog does not contain a models array.');
  const seen = new Set<string>();
  const models: SiwcModel[] = [];
  for (const row of data.models) {
    if (!isRecord(row) || row.visibility !== 'list') continue;
    if (!nonempty(row.slug)) throw new SiwcError('INVALID_MODEL_CATALOG', 'A visible account model has no model ID.');
    if (seen.has(row.slug)) continue;
    seen.add(row.slug);
    models.push({ id: row.slug, name: nonempty(row.display_name) ? row.display_name : row.slug });
  }
  checkAbort(options.signal);
  return models;
}
