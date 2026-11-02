import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials';
import type { CredentialStore, Credential, AuthOperationOptions } from '@earendil-works/pi-ai';
import { loginSiwc, refreshSiwc, revokeSiwc, fetchSiwcModels } from './siwc.js';
import type { SiwcCredential, SiwcRegistration, SiwcModel } from './siwc.js';
export declare const CREDENTIAL_SCOPE = "chatgpt-subscription";
export declare const SUBSCRIPTION_KEY: CredentialKey;
export declare const INSTALLATION_KEY: CredentialKey;
/** A local state failure whose fixed message is safe for a command-line surface. */
export declare class SubscriptionStateError extends Error {
    constructor(message: string);
}
/** Fixed diagnostics for a call whose selected account can no longer be honored. */
export declare class SubscriptionBindingError extends SubscriptionStateError {
    constructor(unbound?: boolean);
}
export interface SubscriptionStatus {
    signedIn: boolean;
    needsLogin: boolean;
    expiresAt?: number;
    email?: string;
    clientId?: string;
    modelCount: number;
    models: SiwcModel[];
    unsupportedModels: string[];
}
export interface SubscriptionOperations {
    login: typeof loginSiwc;
    refresh: typeof refreshSiwc;
    revoke: typeof revokeSiwc;
    fetchModels: typeof fetchSiwcModels;
}
/** Private validated account/authorization conditions; never included in public facts. */
export interface SubscriptionIdentity {
    readonly issuer: string;
    readonly clientId: string;
    readonly subject: string;
    readonly hostId: string;
    readonly scopes: readonly string[];
}
export interface SubscriptionSnapshot {
    readonly models: readonly SiwcModel[];
    readonly identity?: SubscriptionIdentity;
}
export declare function assertSubscriptionIdentity(expected: SubscriptionIdentity, credential: SiwcCredential): void;
/** Owns only the plugin's records; all writes retain the native cross-process DSH lock. */
export declare class SubscriptionManager {
    readonly credentials: CredentialProvider;
    private readonly operations;
    readonly credentialStore: CredentialStore;
    constructor(credentials: CredentialProvider, operations?: SubscriptionOperations);
    private assertProvider;
    hostId(): Promise<string>;
    credential(): Promise<SiwcCredential | undefined>;
    registration(): Promise<SiwcRegistration | undefined>;
    /** One record read owns both model selection and the corresponding validated identity. */
    snapshot(): Promise<SubscriptionSnapshot>;
    models(): Promise<SiwcModel[]>;
    status(): Promise<SubscriptionStatus>;
    login(interaction: Parameters<typeof loginSiwc>[0], options?: AuthOperationOptions): Promise<SiwcCredential>;
    validCredential(options?: AuthOperationOptions): Promise<SiwcCredential>;
    refreshModels(options?: AuthOperationOptions): Promise<SiwcModel[]>;
    refreshCredential(credential: Credential, signal: AbortSignal): Promise<SiwcCredential>;
    logout(options?: AuthOperationOptions): Promise<void>;
}
/** A private credential context; a long-lived host can watch the same grant as the CLI. */
export declare function openSubscriptionStore(dshHome: string, options?: {
    watch?: boolean;
}): Promise<{
    manager: SubscriptionManager;
    onRecordUpdated(listener: (key: CredentialKey) => void | Promise<void>): () => void;
    dispose(): Promise<void>;
}>;
