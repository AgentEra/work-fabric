import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  FeishuTenantAccessTokenProvider,
} from "@work-fabric/connector-feishu";
import {
  FeishuCalendarAdministrationService,
  FeishuCalendarOpenApiBackend,
  FeishuOpenApiRequestClient,
  MemoryFeishuCalendarStore,
  SqliteFeishuCalendarStore,
  type CalendarBinding,
  type FeishuCalendarStore,
} from "@work-fabric/provider-feishu";

import { loadFeishuProviderConfiguration } from "../examples/feishu-capability-provider/src/configuration.js";
import { EnvironmentFeishuAppCredentialProvider } from "../examples/feishu-capability-provider/src/credentials.js";

type ParsedArguments =
  | {
      readonly command: "bind-existing";
      readonly alias: string;
      readonly calendar_id: string;
      readonly make_default: boolean;
    }
  | {
      readonly command: "create-and-bind";
      readonly alias: string;
      readonly summary: string;
      readonly permissions: "private" | "show_only_free_busy" | "public";
      readonly make_default: boolean;
    }
  | { readonly command: "list" };

function value(
  args: readonly string[],
  index: number,
  flag: string,
): string {
  const candidate = args[index + 1];
  if (
    candidate === undefined ||
    candidate.length === 0 ||
    candidate.startsWith("--")
  ) throw new TypeError(`${flag} requires a value`);
  return candidate;
}

function fields(args: readonly string[]): ReadonlyMap<string, string | true> {
  const result = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (!flag.startsWith("--") || result.has(flag)) {
      throw new TypeError("Calendar admin arguments are invalid");
    }
    if (flag === "--default") {
      result.set(flag, true);
      continue;
    }
    result.set(flag, value(args, index, flag));
    index += 1;
  }
  return result;
}

function only(
  parsed: ReadonlyMap<string, string | true>,
  allowed: readonly string[],
): void {
  if ([...parsed.keys()].some((flag) => !allowed.includes(flag))) {
    throw new TypeError("Calendar admin contains an unsupported flag");
  }
}

function required(
  parsed: ReadonlyMap<string, string | true>,
  flag: string,
): string {
  const result = parsed.get(flag);
  if (typeof result !== "string" || result.trim() !== result) {
    throw new TypeError(`${flag} is required`);
  }
  return result;
}

export function parseFeishuCalendarAdminArguments(
  args: readonly string[],
): ParsedArguments {
  const [command, ...rest] = args;
  if (command === "list") {
    if (rest.length !== 0) {
      throw new TypeError("list does not accept flags");
    }
    return { command };
  }
  const parsed = fields(rest);
  if (command === "bind-existing") {
    only(parsed, ["--alias", "--calendar-id", "--default"]);
    return {
      command,
      alias: required(parsed, "--alias"),
      calendar_id: required(parsed, "--calendar-id"),
      make_default: parsed.get("--default") === true,
    };
  }
  if (command === "create-and-bind") {
    only(parsed, [
      "--alias",
      "--summary",
      "--permissions",
      "--default",
    ]);
    const permissions = required(parsed, "--permissions");
    if (
      permissions !== "private" &&
      permissions !== "show_only_free_busy" &&
      permissions !== "public"
    ) throw new TypeError("--permissions is invalid");
    return {
      command,
      alias: required(parsed, "--alias"),
      summary: required(parsed, "--summary"),
      permissions,
      make_default: parsed.get("--default") === true,
    };
  }
  throw new TypeError(
    "Expected bind-existing, create-and-bind or list",
  );
}

function parseEnvironment(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ")
      ? line.slice("export ".length)
      : line;
    const separator = normalized.indexOf("=");
    if (separator < 1) throw new Error("Environment file is invalid");
    const name = normalized.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error("Environment file key is invalid");
    }
    let entry = normalized.slice(separator + 1).trim();
    if (
      entry.length >= 2 &&
      (
        (entry.startsWith("\"") && entry.endsWith("\"")) ||
        (entry.startsWith("'") && entry.endsWith("'"))
      )
    ) entry = entry.slice(1, -1);
    result[name] = entry;
  }
  return result;
}

async function environment(
  source: Readonly<Record<string, string | undefined>>,
): Promise<Readonly<Record<string, string>>> {
  const path = source.WORK_FABRIC_ENV_FILE;
  if (path === undefined || path.length === 0) {
    throw new Error("WORK_FABRIC_ENV_FILE is required");
  }
  const fromFile = parseEnvironment(await readFile(resolve(path), "utf8"));
  const combined = Object.fromEntries(
    Object.entries({ ...fromFile, ...source }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  if (
    combined.WORK_FABRIC_CONFIG === undefined ||
    combined.WORK_FABRIC_ADMIN_PRINCIPAL_ID === undefined
  ) {
    throw new Error(
      "WORK_FABRIC_CONFIG and WORK_FABRIC_ADMIN_PRINCIPAL_ID are required",
    );
  }
  return Object.freeze({
    ...combined,
    WORK_FABRIC_FEISHU_PROVIDER_CONFIG: combined.WORK_FABRIC_CONFIG,
    WORK_FABRIC_FEISHU_PROVIDER_CONFIG_APPLICATION:
      combined.WORK_FABRIC_FEISHU_PROVIDER_CONFIG_APPLICATION ??
      "feishu-provider",
  });
}

function safe(binding: CalendarBinding) {
  return {
    alias: binding.alias,
    resource_uri: binding.resource_uri,
    calendar_type: binding.calendar_type,
    access_role: binding.access_role,
    is_default: binding.is_default,
    version: binding.version,
  };
}

export async function listCalendarBindings(
  store: Pick<FeishuCalendarStore, "listBindings">,
  tenantId: string,
): Promise<readonly CalendarBinding[]> {
  const items: CalendarBinding[] = [];
  let afterAlias: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await store.listBindings({
      tenant_id: tenantId,
      ...(afterAlias === undefined ? {} : { after_alias: afterAlias }),
      limit: 100,
    });
    items.push(...result.items);
    if (result.next_after_alias === null) return items;
    afterAlias = result.next_after_alias;
  }
  throw new Error("calendar_binding_list_bound_exceeded");
}

export async function runFeishuCalendarAdmin(
  args: readonly string[] = process.argv.slice(2),
  source: Readonly<Record<string, string | undefined>> = process.env,
): Promise<unknown> {
  const parsed = parseFeishuCalendarAdminArguments(args);
  const env = await environment(source);
  const loaded = await loadFeishuProviderConfiguration({ environment: env });
  const credentials = new EnvironmentFeishuAppCredentialProvider({
    credential_ref: loaded.provider.credential_ref,
    environment: env,
  });
  const tokens = new FeishuTenantAccessTokenProvider({
    credential_provider: credentials,
    fetch: globalThis.fetch,
    base_url: loaded.provider.open_api.base_url,
    clock: { nowEpochSeconds: () => Math.floor(Date.now() / 1_000) },
    expiry_skew_seconds: 60,
    request_timeout_ms: loaded.provider.open_api.request_timeout_ms,
  });
  const requests = new FeishuOpenApiRequestClient({
    credential_ref: loaded.provider.credential_ref,
    token_provider: tokens,
    fetch: globalThis.fetch,
    base_url: loaded.provider.open_api.base_url,
    request_timeout_ms: loaded.provider.open_api.request_timeout_ms,
    max_response_bytes: loaded.provider.open_api.max_response_bytes,
  });
  const backend = new FeishuCalendarOpenApiBackend({ requests });
  if (
    loaded.provider.state.type === "sqlite" &&
    loaded.provider.state.location !== ":memory:"
  ) {
    await mkdir(dirname(resolve(loaded.provider.state.location)), {
      recursive: true,
      mode: 0o700,
    });
  }
  const store: FeishuCalendarStore =
    loaded.provider.state.type === "sqlite"
      ? new SqliteFeishuCalendarStore(loaded.provider.state)
      : new MemoryFeishuCalendarStore();
  try {
    if (parsed.command === "list") {
      return (await listCalendarBindings(
        store,
        loaded.service.work_fabric.tenant_id,
      )).map(safe);
    }
    const admin = new FeishuCalendarAdministrationService({
      backend,
      store,
    });
    const common = {
      tenant_id: loaded.service.work_fabric.tenant_id,
      alias: parsed.alias,
      make_default: parsed.make_default,
      operator_principal_id: env.WORK_FABRIC_ADMIN_PRINCIPAL_ID!,
    };
    return safe(parsed.command === "bind-existing"
      ? await admin.bindExisting({
          ...common,
          external_calendar_id: parsed.calendar_id,
        })
      : await admin.createAndBind({
          ...common,
          summary: parsed.summary,
          permissions: parsed.permissions,
        }));
  } finally {
    await store.close();
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  void runFeishuCalendarAdmin().then(
    (result) => console.log(JSON.stringify(result, null, 2)),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : "Calendar admin failed");
      process.exitCode = 1;
    },
  );
}
