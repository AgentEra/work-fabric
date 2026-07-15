export interface AuthenticationRequest {
  readonly method: string;
  readonly url: string;
  readonly signal: AbortSignal;
}

export interface AuthenticationProvider {
  getAuthorization(input: AuthenticationRequest): Promise<string | null>;
}

type TokenSource = string | (() => string | Promise<string>);

function token(value: string): string {
  if (
    value.length === 0 ||
    value.length > 4096 ||
    value.trim() !== value ||
    /\s/.test(value)
  ) {
    throw new TypeError("Bearer token is invalid");
  }
  return value;
}

export class BearerTokenProvider implements AuthenticationProvider {
  constructor(private readonly source: TokenSource) {}

  async getAuthorization(_input: AuthenticationRequest): Promise<string> {
    const value =
      typeof this.source === "function" ? await this.source() : this.source;
    return `Bearer ${token(value)}`;
  }
}

