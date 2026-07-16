import { describe, expect, it, vi } from "vitest";

import {
  LOCALE_STORAGE_KEY,
  createPresentation,
  readBrowserLocale,
  readLocale,
  resolveLocale,
  saveBrowserLocale,
  saveLocale,
} from "../src/i18n.js";

describe("Console i18n", () => {
  it("resolves stored preference before browser language and falls back to English", () => {
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveLocale(null, ["zh-Hans-CN", "en"])).toBe("zh-CN");
    expect(resolveLocale("invalid", ["fr-FR"])).toBe("en");
  });

  it("persists only the dedicated supported locale preference", () => {
    const storage = { getItem: vi.fn(() => "zh-CN"), setItem: vi.fn() };
    expect(readLocale(storage, ["en-US"])).toBe("zh-CN");
    saveLocale(storage, "en");
    expect(storage.setItem).toHaveBeenCalledWith(LOCALE_STORAGE_KEY, "en");
  });

  it("survives disabled browser storage", () => {
    const storage = {
      getItem: () => { throw new Error("disabled"); },
      setItem: () => { throw new Error("disabled"); },
    };
    expect(readLocale(storage, ["zh-CN"])).toBe("zh-CN");
    expect(() => saveLocale(storage, "zh-CN")).not.toThrow();
  });

  it("uses the dedicated browser preference adapter without exposing other state", () => {
    const storage = { getItem: vi.fn(() => "zh-CN"), setItem: vi.fn() };
    vi.stubGlobal("localStorage", storage);
    try {
      expect(readBrowserLocale(["en-US"])).toBe("zh-CN");
      saveBrowserLocale("en");
      expect(storage.getItem).toHaveBeenCalledWith(LOCALE_STORAGE_KEY);
      expect(storage.setItem).toHaveBeenCalledWith(LOCALE_STORAGE_KEY, "en");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("provides complete Chinese presentation without rewriting unknown facts", () => {
    const zh = createPresentation("zh-CN");
    expect(zh.text.navigationHandoffs).toBe("交接");
    expect(zh.text.operationsTitle).toBe("连接健康状态");
    expect(zh.display("lifecycle", "verified")).toBe("已验收");
    expect(zh.display("lifecycle", "customer_specific")).toBe("customer_specific");
    expect(zh.formatDate("2026-07-16T00:00:00.000Z")).not.toBe("");
  });
});
