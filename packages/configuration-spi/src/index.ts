export interface ConfigurationDocument {
  readonly revision: string;
  readonly value: unknown;
}

export interface ConfigurationProvider {
  load(): Promise<ConfigurationDocument>;
}
