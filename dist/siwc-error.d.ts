/** Errors at the account boundary never include token responses or callback URLs. */
export declare class SiwcError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
