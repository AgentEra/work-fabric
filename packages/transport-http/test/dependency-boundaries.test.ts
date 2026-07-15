import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { glob } from "node:fs/promises";

describe("HTTP dependency boundaries", () => {
  it("keeps HTTP and Fastify out of Core and SPI", async () => {
    for (const root of ["packages/exchange-core/src", "packages/exchange-spi/src"]) {
      for await (const file of glob(`${root}/**/*.ts`)) {
        const source = await readFile(file, "utf8");
        expect(source).not.toMatch(/from ["'](?:fastify|node:http|@work-fabric\/transport-http)/);
      }
    }
  });
});
