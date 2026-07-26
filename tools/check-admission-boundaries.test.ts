import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkAdmissionBoundaries,
  checkAdmissionSensitiveSinks,
} from "./check-admission-boundaries.js";

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

  it("ignores an ignored Python virtual environment without relaxing source symlink checks", async () => {
    const root = await fixture({
      "packages/admission-runtime/src/safe.ts": "export const safe = true;\n",
    });
    await mkdir(join(root, "runtimes/agently-worker/.venv/bin"), { recursive: true });
    await symlink(process.execPath, join(root, "runtimes/agently-worker/.venv/bin/python"));
    await expect(checkAdmissionBoundaries(root)).resolves.toMatchObject({
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
    ["relative Exchange import", 'import { ExchangeApplication } from "../../exchange-core/src/index.js";'],
    ["relative SQLite require", 'const sqlite = require("../../adapter-admission-sqlite/src/index.js");'],
  ])("resolves and rejects %s", async (_name, source) => {
    await expect(checkAdmissionBoundaries(await fixture({
      "packages/admission-runtime/src/leak.ts": `${source}\n`,
    }))).rejects.toThrow(/admission-runtime\/src\/leak\.ts/);
  });

  it.each([
    ["dynamic import", "declare const moduleName: string; void import(moduleName);"],
    ["dynamic require", "declare const moduleName: string; require(moduleName);"],
    ["dynamic module.require", "declare const moduleName: string; module.require(moduleName);"],
    [
      "createRequire",
      'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); load("pg");',
    ],
    [
      "ambient createRequire use",
      'declare function createRequire(url: string): (name: string) => unknown; const load = createRequire(import.meta.url); load("pg");',
    ],
  ])("fails closed on Admission-core %s", async (_name, source) => {
    await expect(checkAdmissionBoundaries(await fixture({
      "packages/admission-runtime/src/dynamic-loader.ts": `${source}\n`,
    }))).rejects.toThrow(/dynamic-loader\.ts/);
  });

  it("allows literal relative imports that remain inside Admission", async () => {
    await expect(checkAdmissionBoundaries(await fixture({
      "packages/admission-runtime/src/index.ts": 'export { evaluate } from "./evaluate.js";',
      "packages/admission-runtime/src/evaluate.ts": "export const evaluate = (): boolean => true;",
    }))).resolves.toMatchObject({ responsibility_violations: 0 });
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
    ["decision raw subject", "packages/admission-runtime/src/decision.ts", "const decision = { raw_subject: request.external_subject_id }; decisionStore.record(decision);"],
    ["nested decision raw subject", "packages/admission-runtime/src/result.ts", "const result = { decision: { sender_open_id: request.external_subject_id } }; decisions.persist(result);"],
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

  it.each([
    [
      "renamed and second-order grant aliases",
      "packages/admission-runtime/src/log-alias.ts",
      [
        "const first = result.representation_grant;",
        "const second = first;",
        "logger.info({ value: second });",
      ].join("\n"),
    ],
    [
      "destructured grant alias",
      "packages/admission-runtime/src/log-destructure.ts",
      [
        "const { representation_grant: opaque } = result;",
        "metrics.observe({ value: opaque });",
      ].join("\n"),
    ],
    [
      "raw subject through an object alias",
      "packages/admission-runtime/src/decision-alias.ts",
      [
        "const { external_subject_id: raw } = request;",
        "const renamed = raw;",
        "const stored = { value: renamed };",
        "decisionStore.record(stored);",
      ].join("\n"),
    ],
    [
      "grant keys assigned after declaration",
      "packages/admission-runtime/src/key-alias.ts",
      [
        "let renamed;",
        "renamed = config.grant_keys;",
        "const wrapped = { value: renamed };",
        "logger.warn(wrapped);",
      ].join("\n"),
    ],
  ])("rejects sensitive taint through %s", async (_name, repositoryPath, source) => {
    const root = await fixture({ [repositoryPath]: `${source}\n` });
    await expect(checkAdmissionBoundaries(root)).rejects.toThrow(repositoryPath);
    await expect(checkAdmissionSensitiveSinks(root)).rejects.toThrow(repositoryPath);
  });

  it("does not taint fingerprints, reason codes or bounded decision metadata", async () => {
    const root = await fixture({
      "packages/admission-runtime/src/safe-observation.ts": [
        "const first = record.external_subject_fingerprint;",
        "const second = first;",
        "logger.info({ reason_code: decision.reason_code, fingerprint: second });",
      ].join("\n"),
    });
    await expect(checkAdmissionSensitiveSinks(root)).resolves.toMatchObject({
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
