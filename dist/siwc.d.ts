import { type JWTVerifyGetKey, type JWTPayload } from 'jose';
export { SiwcError } from './siwc-error.js';
export declare const SIWC_ENDPOINTS: Readonly<{
    issuer: "https://auth.openai.com";
    authorize: "https://auth.openai.com/api/accounts/authorize";
    token: "https://auth.openai.com/api/accounts/oauth/token";
    revoke: "https://auth.openai.com/api/accounts/oauth/revoke";
    jwks: "https://auth.openai.com/.well-known/jwks.json";
    resource: "https://api.openai.com/v1";
    models: "https://api.openai.com/v1/models";
    responses: "https://api.openai.com/v1/responses";
}>;
export declare const SIWC_SCOPES: readonly string[];
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
export declare function validateSiwcCredential(value: unknown): SiwcCredential;
export interface VerifySiwcIdTokenOptions extends Pick<SiwcNetworkOptions, 'jwks' | 'now'> {
    clientId: string;
    nonce?: string;
    expectedSubject?: string;
}
/** Verify signatures and OIDC identity before any new account becomes active. */
export declare function verifySiwcIdToken(token: string, options: VerifySiwcIdTokenOptions): Promise<JWTPayload>;
export declare function loginSiwc(interaction: SiwcInteraction, options: SiwcLoginOptions): Promise<SiwcCredential>;
/** Caller must run this inside the credential store's cross-process mutation lock. */
export declare function refreshSiwc(value: SiwcCredential, options?: SiwcNetworkOptions): Promise<SiwcCredential>;
/** Remote failure is an error; the caller decides whether to retain a revocation retry. */
export declare function revokeSiwc(value: SiwcCredential, options?: SiwcNetworkOptions): Promise<void>;
export declare function fetchSiwcModels(value: SiwcCredential, options?: SiwcNetworkOptions): Promise<SiwcModel[]>;
