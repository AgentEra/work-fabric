import { expect, it } from "vitest";

import {
  defineAgentRoleProfile,
  validateDriverManifest,
  type AgentRuntimeDriver,
  type RuntimeTaskPackage,
} from "../src/index.js";

it("defines an immutable versioned role without authority fields", () => {
  const profile = defineAgentRoleProfile({
    role_id: "daily-assistant",
    version: 1,
    display_name: "日常助理 Agent",
    description: "团队共享的协作入口与日常事务助理",
    capability_ids: [
      "collaboration.request.intake",
      "information.synthesis",
      "collaboration.handoff.draft",
    ],
  });
  expect(Object.isFrozen(profile)).toBe(true);
  expect(profile).not.toHaveProperty("authority");
});

it("rejects a Driver manifest with duplicate capabilities", () => {
  expect(() => validateDriverManifest({
    driver_type: "test",
    protocol_version: "1",
    capability_ids: ["information.synthesis", "information.synthesis"],
  })).toThrow(/duplicate/i);
});

it("requires execution to receive cancellation and a progress sink", () => {
  const driver: AgentRuntimeDriver = {
    manifest: validateDriverManifest({
      driver_type: "test",
      protocol_version: "1",
      capability_ids: ["information.synthesis"],
    }),
    execute: async (_task: RuntimeTaskPackage, _progress, _signal) => ({
      summary: [{ kind: "text", media_type: "text/plain", text: "done" }],
      artifacts: [],
      evidence: [],
      extensions: {},
    }),
  };
  expect(driver.manifest.driver_type).toBe("test");
});
