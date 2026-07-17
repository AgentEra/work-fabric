import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  EnvironmentSecretResolver,
  resolveDeclaredSecrets,
} from "../src/index.js";

describe("declared secret resolution", () => {
  it("resolves only exact environment references at declared paths", async () => {
    const input = {
      service: { cursor_secret: "${CURSOR_SECRET}", label: "${NOT_A_SECRET}" },
    };
    const output = await resolveDeclaredSecrets(input, ["service.cursor_secret"], {
      resolver: new EnvironmentSecretResolver({ CURSOR_SECRET: "resolved-secret" }),
      allow_literals: false,
    });

    expect(output).toEqual({
      service: { cursor_secret: "resolved-secret", label: "${NOT_A_SECRET}" },
    });
    expect(input.service.cursor_secret).toBe("${CURSOR_SECRET}");
  });

  it("rejects mixed interpolation and missing variables without exposing values", async () => {
    const resolver = new EnvironmentSecretResolver({ PRESENT: "private-value" });
    await expect(resolveDeclaredSecrets({ secret: "prefix-${PRESENT}" }, ["secret"], {
      resolver, allow_literals: false,
    })).rejects.toMatchObject({ code: "invalid_secret_reference", path: "secret" });

    let error: unknown;
    try {
      await resolveDeclaredSecrets({ secret: "${MISSING}" }, ["secret"], {
        resolver, allow_literals: false,
      });
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(String(error)).not.toContain("private-value");
    expect(error).toMatchObject({ code: "secret_not_found", path: "secret" });
  });

  it("allows literal secrets only in development mode", async () => {
    const resolver = new EnvironmentSecretResolver({});
    await expect(resolveDeclaredSecrets({ secret: "literal-secret" }, ["secret"], {
      resolver, allow_literals: false,
    })).rejects.toMatchObject({ code: "literal_secret_forbidden" });
    await expect(resolveDeclaredSecrets({ secret: "literal-secret" }, ["secret"], {
      resolver, allow_literals: true,
    })).resolves.toEqual({ secret: "literal-secret" });
  });

  it("fails safely when a declared path is absent", async () => {
    await expect(resolveDeclaredSecrets({}, ["plugin.credentials.secret"], {
      resolver: new EnvironmentSecretResolver({}), allow_literals: false,
    })).rejects.toMatchObject({
      code: "secret_path_missing",
      path: "plugin.credentials.secret",
    });
  });
});
