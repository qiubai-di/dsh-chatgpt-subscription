/** Errors at the account boundary never include token responses or callback URLs. */
export class SiwcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SiwcError';
    this.code = code;
  }
}
