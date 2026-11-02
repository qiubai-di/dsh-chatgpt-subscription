/** Errors at the account boundary never include token responses or callback URLs. */
export class SiwcError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'SiwcError';
        this.code = code;
    }
}
//# sourceMappingURL=siwc-error.js.map