export class ConfigurationError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
  ) {
    super(`${code} at ${path}`);
    this.name = "ConfigurationError";
  }
}
