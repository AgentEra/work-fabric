import { describe, expect, it } from "vitest";

import { EnvironmentFeishuAppCredentialProvider } from "../src/credentials.js";

describe("EnvironmentFeishuAppCredentialProvider", () => {
  it("maps one configured credential reference to the two exact environment keys", async () => {
    const provider = new EnvironmentFeishuAppCredentialProvider({
      credential_ref: "feishu-primary",
      environment: {
        FEISHU_APP_ID: "app-id",
        FEISHU_APP_SECRET: "app-secret",
      },
    });
    await expect(provider.loadAppCredentials("feishu-primary")).resolves.toEqual({
      app_id: "app-id",
      app_secret: "app-secret",
    });
  });

  it("does not serve another credential reference", async () => {
    const provider = new EnvironmentFeishuAppCredentialProvider({
      credential_ref: "feishu-primary",
      environment: {
        FEISHU_APP_ID: "app-id",
        FEISHU_APP_SECRET: "app-secret",
      },
    });
    await expect(provider.loadAppCredentials("other")).rejects.toThrow(
      "credential reference is unavailable",
    );
  });
});
