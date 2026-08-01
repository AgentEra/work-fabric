import { lexer, walkTokens, type Token } from "marked";

export class FeishuMarkdownError extends Error {
  readonly code = "unsafe_link" as const;

  constructor() {
    super("unsafe_link");
    this.name = "FeishuMarkdownError";
  }
}

function assertSafeHref(href: string): void {
  if (/[\u0000-\u001f\u007f]/u.test(href)) {
    throw new FeishuMarkdownError();
  }
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    throw new FeishuMarkdownError();
  }
  if (parsed.protocol !== "https:") {
    throw new FeishuMarkdownError();
  }
}

export function assertSafeMarkdownLinks(markdown: string): void {
  const tokens = lexer(markdown, { gfm: true });
  walkTokens(tokens, (token: Token) => {
    if (token.type === "link") {
      assertSafeHref(token.href);
    }
  });
}
