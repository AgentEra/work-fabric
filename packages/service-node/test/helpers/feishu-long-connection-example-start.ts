import type {
  FeishuLongConnectionClient,
  FeishuLongConnectionHandler,
  FeishuLongConnectionStatus,
} from "@work-fabric/connector-feishu";

import {
  composeNodeService,
  loadNodeConfiguration,
  startListeningNodeService,
} from "../../src/index.js";

class NeutralLongConnectionClient implements FeishuLongConnectionClient {
  private state: FeishuLongConnectionStatus = {
    state: "connecting",
    code: "connecting",
    reconnect_attempts: 0,
    changed_at: "2026-07-18T00:00:00.000Z",
  };

  start(_handler: FeishuLongConnectionHandler): Promise<void> {
    this.state = { ...this.state, state: "connected", code: "connected" };
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.state = { ...this.state, state: "stopped", code: "stopped" };
    return Promise.resolve();
  }

  status(): FeishuLongConnectionStatus {
    return { ...this.state };
  }
}

const loaded = await loadNodeConfiguration(process.env);
const testPort = process.env.WORK_FABRIC_TEST_LISTEN_PORT;
const service = await composeNodeService({
  ...loaded.service,
  ...(testPort === undefined
    ? {}
    : {
        listen: {
          ...loaded.service.listen,
          port: Number(testPort),
        },
      }),
}, {
  configuration_revision: loaded.revision,
  plugins: loaded.plugins,
  admission: loaded.admission,
  feishu_long_connection_client_factory: {
    create: () => new NeutralLongConnectionClient(),
  },
  fetch: async () => {
    throw new Error("unexpected_network_request");
  },
});

try {
  await service.listen();
  await startListeningNodeService(service);
  const readiness = await service.http.dispatch({
    method: "GET",
    url: "/health/ready",
  });
  if (readiness.status_code !== 200) {
    throw new Error(`unexpected_readiness_${readiness.status_code}`);
  }
} finally {
  await service.close();
}

process.stdout.write('{"started":true}\n');
