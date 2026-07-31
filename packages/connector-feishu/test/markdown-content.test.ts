import { describe, expect, it } from "vitest";

import {
  assertSafeMarkdownLinks,
  FeishuMarkdownError,
} from "../src/index.js";

describe("assertSafeMarkdownLinks", () => {
  it("accepts portable HTTPS links nested in Markdown", () => {
    expect(() => assertSafeMarkdownLinks(
      "## 结果\n\n- [需求文档](https://example.com/r/1?from=agent)",
    )).not.toThrow();
  });

  it("accepts a bare SSH username-at-host token in an Agent reply", () => {
    expect(() => assertSafeMarkdownLinks(
      "> 登录方式 ssh -p 2222 deploy@192.168.0.66，首次登录前需要添加 authorized_keys",
    )).not.toThrow();
  });

  it.each([
    "[危险](javascript:alert(1))",
    "[本地](file:///etc/passwd)",
    "[数据](data:text/html;base64,WA==)",
    "[邮件](mailto:admin@example.com)",
    "[相对](../private)",
    "[无协议](example.com/doc)",
  ])("rejects an unsafe or invalid parsed destination: %s", (markdown) => {
    expect(() => assertSafeMarkdownLinks(markdown)).toThrow(
      expect.objectContaining<Partial<FeishuMarkdownError>>({
        code: "unsafe_link",
      }),
    );
  });

  it("does not fetch or rewrite a safe link", () => {
    const markdown = "[文档](https://example.com/a_(b))";
    expect(() => assertSafeMarkdownLinks(markdown)).not.toThrow();
  });
});
