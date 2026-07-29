import { readFile } from "node:fs/promises";

import {
  BearerTokenProvider,
  WorkFabricClient,
} from "@work-fabric/sdk-typescript";

import {
  LOCAL_FEISHU_PID_FILE,
  prepareLocalFeishuEnvironment,
  type LocalFeishuPidState,
} from "./local-feishu-common.js";

export const LOCAL_FEISHU_CITIZEN_IDS = Object.freeze({
  message: "citizen-feishu-message",
  document: "citizen-feishu-document",
  context: "citizen-feishu-context",
});

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pidState(): Promise<LocalFeishuPidState | null> {
  try {
    return JSON.parse(
      await readFile(LOCAL_FEISHU_PID_FILE, "utf8"),
    ) as LocalFeishuPidState;
  } catch {
    return null;
  }
}

export async function localFeishuStatus(
  input: Readonly<Record<string, string | undefined>> = process.env,
) {
  const environment = await prepareLocalFeishuEnvironment(input);
  let serviceReady = false;
  try {
    serviceReady = (await fetch("http://127.0.0.1:8787/health/ready", {
      signal: AbortSignal.timeout(2_000),
    })).ok;
  } catch {
    serviceReady = false;
  }
  const processes = await pidState();
  const client = new WorkFabricClient({
    baseUrl: "http://127.0.0.1:8787",
    tenantId: "tenant-local",
    exchangeId: "exchange-local",
    representation: {
      actorId: "actor-work-fabric-admin",
      endpointId: "endpoint-work-fabric-admin",
    },
    authentication: new BearerTokenProvider(
      environment.WORK_FABRIC_ADMIN_TOKEN!,
    ),
  });
  const query = async (operation: () => Promise<unknown>) => {
    if (!serviceReady) return false;
    try {
      await operation();
      return true;
    } catch {
      return false;
    }
  };
  const [
    assistantEndpoint,
    providerEndpoint,
    messageCitizen,
    documentCitizen,
    contextCitizen,
  ] =
    await Promise.all([
      query(() => client.endpoints.get("endpoint-intake-agent")),
      query(() => client.endpoints.get("endpoint-feishu-provider")),
      query(() => client.citizens.get(LOCAL_FEISHU_CITIZEN_IDS.message)),
      query(() => client.citizens.get(LOCAL_FEISHU_CITIZEN_IDS.document)),
      query(() => client.citizens.get(LOCAL_FEISHU_CITIZEN_IDS.context)),
    ]);
  return Object.freeze({
    service_ready: serviceReady,
    processes: processes === null
      ? []
      : processes.children.map((item) => ({
          name: item.name,
          pid: item.pid,
          alive: processAlive(item.pid),
        })),
    endpoint_registration: {
      daily_assistant: assistantEndpoint,
      feishu_provider: providerEndpoint,
    },
    citizen_registration: {
      message: messageCitizen,
      document: documentCitizen,
      context: contextCitizen,
    },
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  void localFeishuStatus().then((status) => {
    console.log(JSON.stringify(status, null, 2));
    if (
      !status.service_ready ||
      !status.endpoint_registration.daily_assistant ||
      !status.endpoint_registration.feishu_provider ||
      !status.citizen_registration.message ||
      !status.citizen_registration.document ||
      !status.citizen_registration.context
    ) process.exitCode = 1;
  }).catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Status check failed",
    );
    process.exitCode = 1;
  });
}
