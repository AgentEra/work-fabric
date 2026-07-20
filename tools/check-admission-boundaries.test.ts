import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkAdmissionBoundaries } from "./check-admission-boundaries.js";

const temporary: string[] = [];

async function fixture(sources: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "work-fabric-admission-boundary-"));
  temporary.push(root);
  for (const [repositoryPath, source] of Object.entries(sources)) {
    const target = join(root, repositoryPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source, "utf8");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("Collaboration Admission architecture boundaries", () => {
  it("accepts the real repository", async () => {
    await expect(checkAdmissionBoundaries()).resolves.toMatchObject({
      source_files: expect.any(Number),
      admission_imports: expect.any(Number),
      responsibility_violations: 0,
      sensitive_sink_violations: 0,
    });
  });

  it.each([
    ["channel SDK", 'import lark from "@larksuiteoapi/node-sdk";'],
    ["YAML", 'import YAML from "yaml";'],
    ["SQLite", 'import Database from "better-sqlite3";'],
    ["PostgreSQL", 'import pg from "pg";'],
    ["WFPP", 'import { parseEnvelope } from "@work-fabric/wfpp";'],
    ["Exchange SPI", 'import type { IdentityProvider } from "@work-fabric/exchange-spi";'],
    ["Exchange Core", 'import { ExchangeApplication } from "@work-fabric/exchange-core";'],
    ["Exchange runtime", 'import { ExchangeRuntime } from "@work-fabric/exchange-runtime";'],
    ["WFPP runtime", 'import { validateCommand } from "@work-fabric/protocol-runtime";'],
    ["SQLite adapter", 'import { SqliteAdmissionDecisionStore } from "@work-fabric/adapter-admission-sqlite";'],
  ])("rejects a %s import from Admission SPI/runtime", async (_name, source) => {
    await expect(checkAdmissionBoundaries(await fixture({
      "packages/admission-runtime/src/leak.ts": `${source}\n`,
    }))).rejects.toThrow(/admission-runtime\/src\/leak\.ts/);
  });

  it.each([
    ['import { ExchangeApplication } from "@work-fabric/exchange-core";\nvoid ExchangeApplication;'],
    ['const core = require("@work-fabric/exchange-core");\nvoid core.ExchangeApplication;'],
  ])("rejects direct ExchangeApplication use from a channel plugin", async (source) => {
    await expect(checkAdmissionBoundaries(await fixture({
      "packages/plugin-channel-feishu/src/exchange-bypass.ts": `${source}\n`,
    }))).rejects.toThrow(/directly uses ExchangeApplication/);
  });

  it.each([
    ["deny precedence", "if (exactDeny.has(subject)) return deny();"],
    ["allow precedence", "if (exactAllow.has(subject)) return allow();"],
    ["internal wildcard", "if (allInternalMembers && evidence.membership === 'internal') return allow();"],
  ])("rejects channel-owned policy precedence: %s", async (_name, body) => {
    await expect(checkAdmissionBoundaries(await fixture({
      "packages/plugin-channel-feishu/src/policy.ts": `export function decide(): unknown { ${body} }\n`,
    }))).rejects.toThrow(/policy precedence/);
  });

  it.each([
    ["logger raw subject", "packages/admission-runtime/src/log.ts", "logger.info({ external_subject_id: request.external_subject_id });"],
    ["metric raw subject", "packages/admission-runtime/src/metric.ts", "metrics.observe({ subject_id: request.external_subject_id });"],
    ["decision raw subject", "packages/admission-runtime/src/decision.ts", "const decision = { raw_subject: request.external_subject_id }; export { decision };"],
    ["nested decision raw subject", "packages/admission-runtime/src/result.ts", "export const result = { decision: { sender_open_id: request.external_subject_id } };"],
    ["Console raw subject", "packages/console-web/src/admission.ts", "export const external_subject_id = value;"],
    ["logger grant", "packages/plugin-channel-feishu/src/log.ts", "logger.info({ representation_grant: grant });"],
    ["logger opaque credential", "packages/plugin-channel-feishu/src/credential-log.ts", "logger.info({ credential: grant });"],
    ["Console grant key", "packages/console-web/src/admission.ts", "export const grant_signing_key = value;"],
  ])("rejects %s", async (_name, repositoryPath, source) => {
    await expect(checkAdmissionBoundaries(await fixture({
      [repositoryPath]: `${source}\n`,
    }))).rejects.toThrow(repositoryPath);
  });

  it("allows source-neutral contracts, fingerprints and inert documentation", async () => {
    await expect(checkAdmissionBoundaries(await fixture({
      "packages/admission-spi/src/contracts.ts": [
        "export interface AdmissionRequest { readonly external_subject_id: string; }",
        "export interface DecisionRecord { readonly external_subject_fingerprint: string; }",
      ].join("\n"),
      "packages/admission-runtime/src/service.ts": [
        "// Admission must never log an external_subject_id or representation_grant.",
        "export const guidance = 'deny overrides allow; all_internal_members requires evidence';",
        "export function evaluate(request: { external_subject_id: string }) { return request.external_subject_id; }",
      ].join("\n"),
      "packages/plugin-channel-feishu/src/translation.ts": [
        "export const request = { external_subject_id: sender.open_id };",
        "export const label = 'policy precedence belongs to Admission';",
      ].join("\n"),
      "packages/console-web/src/view.tsx": [
        "export const View = () => <div>Raw subjects and grant keys are never displayed.</div>;",
      ].join("\n"),
    }))).resolves.toMatchObject({
      responsibility_violations: 0,
      sensitive_sink_violations: 0,
    });
  });

  it("ignores tests and generated output so security fixtures do not self-trigger", async () => {
    await expect(checkAdmissionBoundaries(await fixture({
      "packages/admission-runtime/test/fixture.ts": 'logger.info({ external_subject_id: "raw" });',
      "packages/console-web/src/admission.test.ts": 'export const grant_signing_key = "fixture";',
      "packages/admission-runtime/dist/leak.ts": 'import pg from "pg";',
    }))).resolves.toMatchObject({ sensitive_sink_violations: 0 });
  });
});
