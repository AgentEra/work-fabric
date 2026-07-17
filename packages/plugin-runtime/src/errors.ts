export class PluginRuntimeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PluginRuntimeError";
  }
}
