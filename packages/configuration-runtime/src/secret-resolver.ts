import { ConfigurationError } from "./errors.js";

export interface SecretReference {
  readonly environment: string;
}

export interface SecretResolver {
  resolve(reference: SecretReference, path: string): Promise<string>;
}

export class EnvironmentSecretResolver implements SecretResolver {
  constructor(private readonly environment: Readonly<Record<string, string | undefined>>) {}

  async resolve(reference: SecretReference, path: string): Promise<string> {
    const value = this.environment[reference.environment];
    if (value === undefined || value.length === 0) {
      throw new ConfigurationError("secret_not_found", path);
    }
    return value;
  }
}

export interface ResolveDeclaredSecretsOptions {
  readonly resolver: SecretResolver;
  readonly allow_literals: boolean;
}

const referencePattern = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function child(container: Record<string, unknown> | unknown[], segment: string): unknown {
  if (!Array.isArray(container)) return container[segment];
  if (!/^\d+$/.test(segment)) return undefined;
  return container[Number(segment)];
}

async function resolveAtPath(
  root: Record<string, unknown>,
  path: string,
  options: ResolveDeclaredSecretsOptions,
): Promise<void> {
  const segments = path.split(".");
  let cursor: Record<string, unknown> | unknown[] = root;
  for (const segment of segments.slice(0, -1)) {
    const next: unknown = child(cursor, segment);
    if (!object(next) && !Array.isArray(next)) throw new ConfigurationError("secret_path_missing", path);
    cursor = next;
  }
  const leaf = segments.at(-1);
  if (leaf === undefined || (Array.isArray(cursor) && !/^\d+$/.test(leaf))) {
    throw new ConfigurationError("secret_path_missing", path);
  }
  const leafKey = Array.isArray(cursor) ? Number(leaf) : leaf;
  if (!Object.hasOwn(cursor, leafKey)) throw new ConfigurationError("secret_path_missing", path);
  const value = Array.isArray(cursor) ? cursor[leafKey as number] : cursor[leafKey as string];
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigurationError("invalid_secret_reference", path);
  }
  const match = referencePattern.exec(value);
  if (match !== null) {
    const resolved = await options.resolver.resolve({ environment: match[1]! }, path);
    if (Array.isArray(cursor)) cursor[leafKey as number] = resolved;
    else cursor[leafKey as string] = resolved;
    return;
  }
  if (value.includes("${")) {
    throw new ConfigurationError("invalid_secret_reference", path);
  }
  if (!options.allow_literals) {
    throw new ConfigurationError("literal_secret_forbidden", path);
  }
}

export async function resolveDeclaredSecrets<T>(
  input: T,
  paths: readonly string[],
  options: ResolveDeclaredSecretsOptions,
): Promise<T> {
  const output = structuredClone(input);
  if (!object(output)) throw new ConfigurationError("invalid_configuration_root", "$");
  for (const path of paths) await resolveAtPath(output, path, options);
  return output as T;
}
