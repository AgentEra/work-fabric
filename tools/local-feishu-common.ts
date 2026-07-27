import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const LOCAL_FEISHU_REQUIRED_ENVIRONMENT = Object.freeze([
  "WORK_FABRIC_CURSOR_SECRET",
  "WORK_FABRIC_ADMIN_TOKEN",
  "WORK_FABRIC_ADMISSION_FINGERPRINT_KEY",
  "WORK_FABRIC_ADMISSION_GRANT_KEY",
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_SHARED_FOLDER_TOKEN",
  "FEISHU_CONNECTOR_ACCESS_TOKEN",
  "INTAKE_AGENT_ACCESS_TOKEN",
  "FEISHU_PROVIDER_ACCESS_TOKEN",
  "AGENTLY_MODEL_API_KEY",
  "FEISHU_EXTERNAL_TENANT_ID",
  "FEISHU_BOT_OPEN_ID",
] as const);

export const LOCAL_FEISHU_PID_FILE = resolve(
  "var/local-feishu-stack.json",
);

function parseLine(line: string): readonly [string, string] | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) return null;
  const normalized = trimmed.startsWith("export ")
    ? trimmed.slice("export ".length)
    : trimmed;
  const separator = normalized.indexOf("=");
  if (separator < 1) throw new Error("Environment file contains an invalid line");
  const key = normalized.slice(0, separator).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error("Environment file contains an invalid key");
  }
  let value = normalized.slice(separator + 1).trim();
  if (
    value.length >= 2 &&
    ((value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

async function loadEnvironmentFile(
  path: string,
): Promise<Record<string, string>> {
  const text = await readFile(path, "utf8");
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const entry = parseLine(line);
    if (entry !== null) result[entry[0]] = entry[1];
  }
  return result;
}

function replaceDeploymentValue(
  source: string,
  name: "FEISHU_EXTERNAL_TENANT_ID" | "FEISHU_BOT_OPEN_ID",
  value: string,
): string {
  const marker = `\${${name}}`;
  if (!source.includes(marker)) {
    throw new Error(`Configuration marker ${name} is missing`);
  }
  return source.replaceAll(marker, JSON.stringify(value));
}

export async function prepareLocalFeishuEnvironment(
  input: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Readonly<Record<string, string>>> {
  const envFile = input.WORK_FABRIC_ENV_FILE;
  if (envFile === undefined || envFile.trim() === "") {
    throw new Error("WORK_FABRIC_ENV_FILE is required");
  }
  const fileValues = await loadEnvironmentFile(resolve(envFile));
  const combined: Record<string, string | undefined> = {
    ...fileValues,
    ...input,
    WORK_FABRIC_ENV_FILE: resolve(envFile),
  };
  const missing = LOCAL_FEISHU_REQUIRED_ENVIRONMENT.filter(
    (name) => combined[name] === undefined || combined[name]!.length === 0,
  );
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  }
  const sourcePath = resolve(
    combined.WORK_FABRIC_CONFIG ??
      "examples/config/local-feishu-assistant.bundle.yaml",
  );
  const resolvedPath = resolve(
    combined.WORK_FABRIC_RESOLVED_CONFIG ??
      "var/local-feishu-assistant.bundle.resolved.yaml",
  );
  let configuration = await readFile(sourcePath, "utf8");
  if (configuration.includes("${FEISHU_EXTERNAL_TENANT_ID}")) {
    configuration = replaceDeploymentValue(
      configuration,
      "FEISHU_EXTERNAL_TENANT_ID",
      combined.FEISHU_EXTERNAL_TENANT_ID!,
    );
    configuration = replaceDeploymentValue(
      configuration,
      "FEISHU_BOT_OPEN_ID",
      combined.FEISHU_BOT_OPEN_ID!,
    );
  } else if (sourcePath !== resolvedPath) {
    throw new Error("Configuration deployment markers are missing");
  }
  await mkdir(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  await writeFile(resolvedPath, configuration, { mode: 0o600 });
  return Object.freeze(Object.fromEntries(
    Object.entries({
      ...combined,
      WORK_FABRIC_CONFIG: resolvedPath,
    }).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string"
    ),
  ));
}

export interface LocalFeishuPidState {
  readonly supervisor_pid: number;
  readonly started_at: string;
  readonly children: readonly {
    readonly name: string;
    readonly pid: number;
  }[];
}

export async function writeLocalFeishuPidState(
  state: LocalFeishuPidState,
): Promise<void> {
  await mkdir(dirname(LOCAL_FEISHU_PID_FILE), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    LOCAL_FEISHU_PID_FILE,
    `${JSON.stringify(state, null, 2)}\n`,
    { mode: 0o600 },
  );
}
