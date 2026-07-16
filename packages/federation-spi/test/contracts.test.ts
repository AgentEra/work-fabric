import { describe, expect, it } from "vitest";

import {
  FEDERATION_MAX_ENVELOPE_BYTES,
  FEDERATION_MESSAGE_TYPES,
  FEDERATION_PROFILE,
} from "../src/index.js";

describe("Federation SPI contracts", () => {
  it("keeps the v1 profile small and explicit", () => {
    expect(FEDERATION_PROFILE).toBe("workfabric.federation.v1");
    expect(FEDERATION_MESSAGE_TYPES).toEqual([
      "transfer_offer",
      "transfer_receipt",
    ]);
    expect(FEDERATION_MAX_ENVELOPE_BYTES).toBe(65_536);
  });
});
