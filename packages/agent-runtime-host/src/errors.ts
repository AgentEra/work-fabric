export class AgentRuntimeHostError extends Error {
  constructor(readonly code: string, readonly path: string) {
    super(`${code} at ${path}`);
    this.name = "AgentRuntimeHostError";
  }
}

export function invalid(code: string, path: string): never {
  throw new AgentRuntimeHostError(code, path);
}
