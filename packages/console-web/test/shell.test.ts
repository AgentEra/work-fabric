import { describe, expect, it } from "vitest";

import { createPresentation } from "../src/i18n.js";
import { renderShell } from "../src/shell.js";

describe("Console shell", () => {
  it("renders the Chinese shell and a two-language selector", () => {
    const html = renderShell("<p>content</p>", "north", createPresentation("zh-CN"));
    expect(html).toContain("协作连接控制台");
    expect(html).toContain("交接");
    expect(html).toContain('id="locale-select"');
    expect(html).toContain('<option value="zh-CN" selected>中文</option>');
    expect(html).toContain('<option value="en">English</option>');
    expect(html).toContain('value="north"');
  });
});
