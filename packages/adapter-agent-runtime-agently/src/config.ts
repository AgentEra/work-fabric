import { isAbsolute, resolve } from "node:path";

export const MAX_EXECUTION_TIMEOUT_SECONDS = 86_400;
export const MAX_CANCELLATION_GRACE_SECONDS = 60;

export interface AgentlyRuntimeDriverConfig {
  readonly python: { readonly executable: string; readonly module: "work_fabric_agently_runtime" };
  readonly workspace_root: string;
  readonly execution_timeout_seconds: number;
  readonly cancellation_grace_seconds: number;
  readonly provider: { readonly type: "OpenAICompatible"; readonly base_url: string; readonly model: string; readonly api_key: string };
  readonly development_mode?: boolean;
}

export interface AgentlyConfigurationLocation { readonly config_directory: string; }

function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${path} must be a plain object`);
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== "string" || !keys.includes(key)) || keys.some((key) => !Object.hasOwn(value, key) && key !== "development_mode")) throw new TypeError(`${path} has unsupported or missing fields`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of actual as readonly string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) throw new TypeError(`${path}.${key} must be a data property`);
    result[key] = descriptor.value;
  }
  return result;
}

function text(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.trim() !== value || value.includes("\0")) throw new TypeError(`${path} is invalid`);
  return value;
}

function positive(value: unknown, path: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) throw new RangeError(`${path} is outside its bound`);
  return value as number;
}

function resolvedPath(value: unknown, path: string, location: AgentlyConfigurationLocation): string {
  const candidate = text(value, path, 4_096);
  if (!isAbsolute(candidate) && candidate.split(/[\\/]/).length === 1) throw new TypeError(`${path} must be absolute or configuration-relative`);
  return resolve(location.config_directory, candidate);
}

function modelUrl(value: unknown, path: string, developmentMode: boolean): string {
  const raw = text(value, path, 2_048);
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new TypeError(`${path} is invalid`); }
  if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" || (parsed.protocol !== "https:" && !(developmentMode && parsed.protocol === "http:"))) throw new TypeError(`${path} must be HTTPS outside development mode`);
  return raw;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function validateAgentlyRuntimeDriverConfig(value: unknown, path: string, location: AgentlyConfigurationLocation = { config_directory: process.cwd() }): AgentlyRuntimeDriverConfig {
  const root = object(value, path, ["python", "workspace_root", "execution_timeout_seconds", "cancellation_grace_seconds", "provider", "development_mode"]);
  const developmentMode = root.development_mode === undefined ? false : root.development_mode;
  if ((Object.hasOwn(root, "development_mode") && typeof root.development_mode !== "boolean") || typeof developmentMode !== "boolean") throw new TypeError(`${path}.development_mode is invalid`);
  const python = object(root.python, `${path}.python`, ["executable", "module"]);
  if (python.module !== "work_fabric_agently_runtime") throw new TypeError(`${path}.python.module is invalid`);
  const provider = object(root.provider, `${path}.provider`, ["type", "base_url", "model", "api_key"]);
  if (provider.type !== "OpenAICompatible") throw new TypeError(`${path}.provider.type is invalid`);
  const normalized: AgentlyRuntimeDriverConfig = {
    python: { executable: resolvedPath(python.executable, `${path}.python.executable`, location), module: "work_fabric_agently_runtime" },
    workspace_root: resolvedPath(root.workspace_root, `${path}.workspace_root`, location),
    execution_timeout_seconds: positive(root.execution_timeout_seconds, `${path}.execution_timeout_seconds`, MAX_EXECUTION_TIMEOUT_SECONDS),
    cancellation_grace_seconds: positive(root.cancellation_grace_seconds, `${path}.cancellation_grace_seconds`, MAX_CANCELLATION_GRACE_SECONDS),
    provider: {
      type: "OpenAICompatible", base_url: modelUrl(provider.base_url, `${path}.provider.base_url`, developmentMode),
      model: text(provider.model, `${path}.provider.model`, 256), api_key: text(provider.api_key, `${path}.provider.api_key`, 4_096),
    },
    ...(developmentMode ? { development_mode: true } : {}),
  };
  return freeze(normalized);
}

export function agentlySecretPaths(): readonly ["provider.api_key"] { return ["provider.api_key"]; }
