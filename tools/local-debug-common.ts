import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const LOCAL_DEBUG_REQUIRED_ENVIRONMENT = Object.freeze([
  "WORK_FABRIC_CURSOR_SECRET",
  "WORK_FABRIC_ADMIN_TOKEN",
  "WORK_FABRIC_DEBUG_TOKEN",
  "INTAKE_AGENT_ACCESS_TOKEN",
  "AGENTLY_MODEL_API_KEY",
] as const);

export const LOCAL_DEBUG_STATE_FILE = resolve("var/local-debug-stack.json");

function parseLine(line: string): readonly [string, string] | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return null;
  const normalized = trimmed.startsWith("export ")
    ? trimmed.slice("export ".length)
    : trimmed;
  const separator = normalized.indexOf("=");
  if (separator < 1) throw new Error("Environment file contains an invalid line");
  const key = normalized.slice(0, separator).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
    throw new Error("Environment file contains an invalid key");
  }
  let value = normalized.slice(separator + 1).trim();
  if (
    value.length >= 2
    && (
      (value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))
    )
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

async function loadEnvironmentFile(path: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const line of (await readFile(path, "utf8")).split(/\r?\n/u)) {
    const entry = parseLine(line);
    if (entry !== null) result[entry[0]] = entry[1];
  }
  return result;
}

export async function prepareLocalDebugEnvironment(
  input: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Readonly<Record<string, string>>> {
  const envFile = input.WORK_FABRIC_ENV_FILE;
  if (envFile === undefined || envFile.trim() === "") {
    throw new Error("WORK_FABRIC_ENV_FILE is required");
  }
  const resolvedEnvFile = resolve(envFile);
  const combined: Record<string, string> = {
    ...await loadEnvironmentFile(resolvedEnvFile),
    ...Object.fromEntries(
      Object.entries(input).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    WORK_FABRIC_ENV_FILE: resolvedEnvFile,
  };
  const missing = LOCAL_DEBUG_REQUIRED_ENVIRONMENT.filter(
    (name) => combined[name] === undefined || combined[name].length === 0,
  );
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
  const configuration = resolve(
    combined.WORK_FABRIC_CONFIG
      ?? "examples/config/local-debug-assistant.bundle.yaml",
  );
  await readFile(configuration, "utf8");
  return Object.freeze({
    ...combined,
    WORK_FABRIC_CONFIG: configuration,
    WORK_FABRIC_CONFIG_APPLICATION: "work-fabric",
    WORK_FABRIC_AGENT_RUNTIME_CONFIG: configuration,
    WORK_FABRIC_AGENT_RUNTIME_CONFIG_APPLICATION: "daily-assistant",
  });
}

export interface LocalDebugProcessState {
  readonly supervisor_pid: number;
  readonly started_at: string;
  readonly children: readonly {
    readonly name: "service" | "daily-assistant";
    readonly pid: number;
  }[];
}

export async function writeLocalDebugState(
  state: LocalDebugProcessState,
  path = LOCAL_DEBUG_STATE_FILE,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export async function readLocalDebugState(
  path = LOCAL_DEBUG_STATE_FILE,
): Promise<LocalDebugProcessState | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LocalDebugProcessState;
  } catch {
    return null;
  }
}
