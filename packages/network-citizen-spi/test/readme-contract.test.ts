import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NETWORK_CITIZEN_KINDS } from "../src/contracts.js";

const readme = readFileSync(
  fileURLToPath(new URL("../../../README.md", import.meta.url)),
  "utf8",
);
const architecture = readFileSync(
  fileURLToPath(new URL("../../../docs/architecture.md", import.meta.url)),
  "utf8",
);

describe("README Network Citizen contract", () => {
  it("keeps Actor types separate from Network Citizen kinds", () => {
    expect(readme).toContain("## 参与主体与 Network Citizen");
    expect(readme).not.toContain("## 协作网络中的三类公民");
    expect(readme).not.toContain("不能都叫");
    expect(readme).toContain("`human`、`agent`、`system`");

    for (const kind of NETWORK_CITIZEN_KINDS) {
      expect(readme).toContain(`\`${kind}\``);
    }
  });

  it("documents Capability Provider as a first-class pluggable citizen", () => {
    expect(readme).toContain("Capability Provider 是一等 Network Citizen");
    expect(readme).toContain("GitHub 只读 Capability Provider");
    expect(readme).toContain("Provider Facet 不依赖 Channel Facet");
  });

  it("keeps development history out of the adopter-facing README", () => {
    expect(readme).toContain("## 快速开始");
    expect(readme).toContain("## 当前可用能力");
    expect(readme).toContain("[Roadmap](docs/roadmap.md)");
    expect(readme).not.toMatch(/阶段\s*[0-9]/);
    expect(readme).not.toContain("docs/superpowers/");
    expect(readme).not.toContain("WORK_FABRIC_ALLOW_UNSAFE_DOCUMENT_ACCESS");
  });

  it("keeps the canonical architecture terminology aligned", () => {
    expect(architecture).toContain("### 1.1 Actor type 与 Network Citizen kind");
    expect(architecture).not.toContain("三类公民");
    expect(architecture).not.toContain("不能把它们合并");

    for (const kind of NETWORK_CITIZEN_KINDS) {
      expect(architecture).toContain(`\`${kind}\``);
    }
  });
});
