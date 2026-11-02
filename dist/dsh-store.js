import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local';
import { loginSiwc, refreshSiwc, revokeSiwc, fetchSiwcModels, validateSiwcCredential, } from './siwc.js';
import { AGENT_NAME, PROVIDER_ID, supportedSubscriptionModels } from './catalog.js';
export const CREDENTIAL_SCOPE = 'chatgpt-subscription';
export const SUBSCRIPTION_KEY = credentialKey(CREDENTIAL_SCOPE, PROVIDER_ID);
export const INSTALLATION_KEY = credentialKey(CREDENTIAL_SCOPE, 'installation');
/** A local state failure whose fixed message is safe for a command-line surface. */
export class SubscriptionStateError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SubscriptionStateError';
    }
}
/** Fixed diagnostics for a call whose selected account can no longer be honored. */
export class SubscriptionBindingError extends SubscriptionStateError {
    constructor(unbound = false) {
        super(unbound ? 'ChatGPT request has no bound account; prepare a subscription snapshot first.' :
            'ChatGPT account or authorization changed; prepare the request again.');
        this.name = 'SubscriptionBindingError';
    }
}
const productionOperations = {
    login: loginSiwc,
    refresh: refreshSiwc,
    revoke: revokeSiwc,
    fetchModels: fetchSiwcModels,
};
function object(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function readState(record) {
    if (record === undefined)
        return { version: 1, models: [] };
    if (record.kind !== 'grant' || !object(record.payload) || record.payload.version !== 1) {
        throw new SubscriptionStateError('ChatGPT subscription credential record has an unsupported format.');
    }
    const payload = record.payload;
    const models = [];
    if (!Array.isArray(payload.models))
        throw new SubscriptionStateError('ChatGPT subscription model catalog is invalid.');
    for (const item of payload.models) {
        if (!object(item) || typeof item.id !== 'string' || typeof item.name !== 'string') {
            throw new SubscriptionStateError('ChatGPT subscription model catalog is invalid.');
        }
        models.push({ id: item.id, name: item.name });
    }
    let registration;
    if (payload.registration !== undefined) {
        const row = payload.registration;
        if (!object(row) || typeof row.clientId !== 'string' || row.clientId.length === 0 ||
            row.issuer !== 'https://auth.openai.com' ||
            ['subject', 'email', 'idToken'].some(key => row[key] !== undefined && typeof row[key] !== 'string')) {
            throw new SubscriptionStateError('ChatGPT subscription registration is invalid.');
        }
        registration = {
            clientId: row.clientId,
            issuer: row.issuer,
            ...(typeof row.subject === 'string' ? { subject: row.subject } : {}),
            ...(typeof row.email === 'string' ? { email: row.email } : {}),
            ...(typeof row.idToken === 'string' ? { idToken: row.idToken } : {}),
        };
    }
    return {
        version: 1,
        models,
        ...(payload.credential === undefined ? {} : { credential: validateSiwcCredential(payload.credential) }),
        ...(registration === undefined ? {} : { registration }),
    };
}
function stored(state) {
    // CredentialProvider requires JSON-representable grant payloads, excluding undefined members.
    return { kind: 'grant', payload: JSON.parse(JSON.stringify(state)) };
}
function registrationFor(credential, keepHint = true) {
    return {
        clientId: credential.clientId,
        issuer: credential.issuer,
        subject: credential.subject,
        ...(credential.email === undefined ? {} : { email: credential.email }),
        ...(keepHint ? { idToken: credential.idToken } : {}),
    };
}
function sameAccount(a, b) {
    return a.clientId === b.clientId && a.issuer === b.issuer && a.subject === b.subject;
}
function subscriptionIdentity(credential) {
    return Object.freeze({ issuer: credential.issuer, clientId: credential.clientId,
        subject: credential.subject, hostId: credential.hostId,
        scopes: Object.freeze([...new Set(credential.scopes)].sort()) });
}
export function assertSubscriptionIdentity(expected, credential) {
    const actual = subscriptionIdentity(credential);
    if (actual.issuer !== expected.issuer || actual.clientId !== expected.clientId || actual.subject !== expected.subject ||
        actual.hostId !== expected.hostId || JSON.stringify(actual.scopes) !== JSON.stringify(expected.scopes)) {
        throw new SubscriptionBindingError();
    }
}
/** Owns only the plugin's records; all writes retain the native cross-process DSH lock. */
export class SubscriptionManager {
    credentials;
    operations;
    credentialStore;
    constructor(credentials, operations = productionOperations) {
        this.credentials = credentials;
        this.operations = operations;
        this.credentialStore = {
            read: async (id, options) => {
                options?.signal?.throwIfAborted();
                return id === PROVIDER_ID ? this.credential() : undefined;
            },
            list: async (options) => {
                options?.signal?.throwIfAborted();
                return await this.credential() === undefined ? [] : [{ providerId: PROVIDER_ID, type: 'oauth' }];
            },
            modify: async (id, mutate, options) => {
                this.assertProvider(id);
                options?.signal?.throwIfAborted();
                const result = await this.credentials.modifyRecord(SUBSCRIPTION_KEY, async (current) => {
                    options?.signal?.throwIfAborted();
                    const state = readState(current);
                    const next = await mutate(state.credential);
                    if (next === undefined)
                        return undefined;
                    const credential = validateSiwcCredential(next);
                    return stored({ ...state, credential, registration: registrationFor(credential) });
                });
                return readState(result).credential;
            },
            delete: async (id, options) => {
                this.assertProvider(id);
                options?.signal?.throwIfAborted();
                await this.logout(options);
            },
        };
    }
    assertProvider(id) {
        if (id !== PROVIDER_ID)
            throw new SubscriptionStateError('This credential store is only for the ChatGPT subscription provider.');
    }
    async hostId() {
        const result = await this.credentials.modifyRecord(INSTALLATION_KEY, async (current) => {
            if (current !== undefined) {
                const value = current.kind === 'grant' && object(current.payload) ? current.payload.hostId : undefined;
                if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
                    throw new SubscriptionStateError('The stored ChatGPT installation identity is invalid.');
                }
                return undefined;
            }
            return { kind: 'grant', payload: { version: 1, hostId: randomUUID() } };
        });
        if (result?.kind !== 'grant' || !object(result.payload) || typeof result.payload.hostId !== 'string') {
            throw new SubscriptionStateError('ChatGPT installation identity could not be saved.');
        }
        return result.payload.hostId;
    }
    async credential() {
        return readState(await this.credentials.readRecord(SUBSCRIPTION_KEY)).credential;
    }
    async registration() {
        return readState(await this.credentials.readRecord(SUBSCRIPTION_KEY)).registration;
    }
    /** One record read owns both model selection and the corresponding validated identity. */
    async snapshot() {
        const state = readState(await this.credentials.readRecord(SUBSCRIPTION_KEY));
        return Object.freeze({ models: Object.freeze((state.credential === undefined ? [] :
                supportedSubscriptionModels(state.models)).map(model => Object.freeze({ ...model }))),
            ...(state.credential === undefined ? {} : { identity: subscriptionIdentity(state.credential) }) });
    }
    async models() {
        const state = readState(await this.credentials.readRecord(SUBSCRIPTION_KEY));
        return state.credential === undefined ? [] : supportedSubscriptionModels(state.models);
    }
    async status() {
        const state = readState(await this.credentials.readRecord(SUBSCRIPTION_KEY));
        const models = state.credential === undefined ? [] : supportedSubscriptionModels(state.models);
        const supported = new Set(models.map(model => model.id));
        return {
            signedIn: state.credential !== undefined,
            needsLogin: state.credential === undefined,
            ...(state.credential === undefined ? {} : {
                expiresAt: state.credential.expires,
                clientId: state.credential.clientId,
                ...(state.credential.email === undefined ? {} : { email: state.credential.email }),
            }),
            modelCount: models.length,
            models,
            unsupportedModels: state.models.filter(model => !supported.has(model.id)).map(model => model.id),
        };
    }
    async login(interaction, options = {}) {
        const state = readState(await this.credentials.readRecord(SUBSCRIPTION_KEY));
        const deviceId = await this.hostId();
        const credential = await this.operations.login(interaction, {
            getDeviceId: () => deviceId,
            agentName: AGENT_NAME,
            previousCredential: state.credential,
            registration: state.registration,
            signal: options.signal,
            onRegistration: async (registration) => {
                await this.credentials.modifyRecord(SUBSCRIPTION_KEY, async (current) => stored({ ...readState(current), registration }));
            },
        });
        await this.credentials.modifyRecord(SUBSCRIPTION_KEY, async (current) => {
            const latest = readState(current);
            // Do not overwrite a separately completed login while the browser was open.
            if (latest.credential !== undefined &&
                (state.credential === undefined || !sameAccount(latest.credential, state.credential))) {
                throw new SubscriptionStateError('ChatGPT account changed during sign-in; retry with the selected account.');
            }
            return stored({ version: 1, credential, registration: registrationFor(credential), models: [] });
        });
        return credential;
    }
    async validCredential(options = {}) {
        const result = await this.credentialStore.modify(PROVIDER_ID, async (current) => {
            if (current === undefined)
                throw new SubscriptionStateError('ChatGPT subscription is not signed in. Run dsh-chatgpt login first.');
            const credential = validateSiwcCredential(current);
            if (credential.expires > Date.now() + 30_000)
                return undefined;
            // Once admitted, finish rotation and persistence even if the waiting caller cancels.
            return this.operations.refresh(credential, { signal: AbortSignal.timeout(15_000) });
        }, options);
        if (result === undefined)
            throw new SubscriptionStateError('ChatGPT subscription is not signed in. Run dsh-chatgpt login first.');
        return validateSiwcCredential(result);
    }
    async refreshModels(options = {}) {
        const credential = await this.validCredential(options);
        const models = await this.operations.fetchModels(credential, { signal: options.signal });
        await this.credentials.modifyRecord(SUBSCRIPTION_KEY, async (current) => {
            const state = readState(current);
            if (state.credential === undefined || !sameAccount(state.credential, credential)) {
                throw new SubscriptionStateError('ChatGPT account changed while refreshing the model catalog.');
            }
            return stored({ ...state, models });
        });
        return supportedSubscriptionModels(models);
    }
    async refreshCredential(credential, signal) {
        return this.operations.refresh(validateSiwcCredential(credential), { signal });
    }
    async logout(options = {}) {
        await this.credentials.modifyRecord(SUBSCRIPTION_KEY, async (current) => {
            options.signal?.throwIfAborted();
            const state = readState(current);
            if (state.credential === undefined)
                return undefined;
            // On uncertain remote revocation, preserve the record so the user can retry.
            await this.operations.revoke(state.credential, { signal: options.signal });
            return stored({ version: 1, models: [], registration: registrationFor(state.credential, false) });
        });
    }
}
/** A private credential context; a long-lived host can watch the same grant as the CLI. */
export async function openSubscriptionStore(dshHome, options = {}) {
    const context = new Context();
    const fiber = await context.plugin(LocalCredentialProvider, { dshHome, watch: options.watch ?? false });
    const manager = new SubscriptionManager(context.credentials);
    let disposal;
    return {
        manager,
        // The credential provider owns these events in its own context. A host's
        // separate credentials service must never stand in for this event source.
        onRecordUpdated: listener => fiber.ctx.on('credentials/record-updated', listener),
        dispose: () => disposal ??= fiber.dispose(),
    };
}
//# sourceMappingURL=dsh-store.js.map