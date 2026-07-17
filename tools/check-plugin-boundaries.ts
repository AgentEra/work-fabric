import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createScanner,
  LanguageVariant,
  SyntaxKind,
} from "typescript/unstable/ast";

export interface PluginBoundaryReport {
  readonly source_files: number;
  readonly isolated_imports: number;
  readonly sdk_imports: number;
  readonly responsibility_violations: number;
}

interface SourceToken {
  readonly kind: SyntaxKind;
  readonly value: string;
}

interface SourceDiscovery {
  readonly files: readonly string[];
  readonly violations: readonly string[];
}

const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const excludedDirectories = new Set([
  ".cache",
  ".git",
  ".hg",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".scratch",
  ".superpowers",
  ".svn",
  ".temp",
  ".tmp",
  ".turbo",
  ".worktrees",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "scratch",
  "temp",
  "tmp",
  "vendor",
]);

export function normalizeRepositoryPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function isProductionSourcePath(path: string): boolean {
  const repositoryPath = normalizeRepositoryPath(path);
  if (!sourceExtension.test(repositoryPath)) return false;
  const segments = repositoryPath.split("/");
  if (segments.some((segment) =>
    segment === "test" || segment === "tests" || segment === "__tests__"
  )) return false;
  const fileName = segments.at(-1)!;
  return !/\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/i.test(fileName);
}

async function discoverSources(root: string): Promise<SourceDiscovery> {
  const sourceFiles: string[] = [];
  const violations: string[] = [];

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (excludedDirectories.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const repositoryPath = normalizeRepositoryPath(relative(root, path));
      if (entry.isSymbolicLink()) {
        violations.push(`${repositoryPath} is a symbolic link and cannot be boundary-scanned`);
      } else if (entry.isDirectory()) {
        await visit(path);
      } else if (isProductionSourcePath(repositoryPath)) {
        sourceFiles.push(path);
      }
    }
  }

  await visit(root);
  return { files: sourceFiles, violations };
}

function tokenize(source: string, repositoryPath: string): SourceToken[] {
  const jsx = /\.[jt]sx$/i.test(repositoryPath);
  const scanner = createScanner(
    true,
    jsx ? LanguageVariant.JSX : LanguageVariant.Standard,
    source,
  );
  const tokens: SourceToken[] = [];
  const templateExpressionDepths: number[] = [];
  let previousKind: SyntaxKind | undefined;
  let previousEnd = -1;
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.SlashToken && regularExpressionCanStartAfter(previousKind)) {
      kind = scanner.reScanSlashToken();
    } else if (kind === SyntaxKind.TemplateHead) {
      templateExpressionDepths.push(0);
    } else if (kind === SyntaxKind.OpenBraceToken && templateExpressionDepths.length > 0) {
      const last = templateExpressionDepths.length - 1;
      templateExpressionDepths[last] = templateExpressionDepths[last]! + 1;
    } else if (kind === SyntaxKind.CloseBraceToken && templateExpressionDepths.length > 0) {
      const last = templateExpressionDepths.length - 1;
      if (templateExpressionDepths[last]! > 0) {
        templateExpressionDepths[last] = templateExpressionDepths[last]! - 1;
      } else {
        kind = scanner.reScanTemplateToken(false);
        if (kind === SyntaxKind.TemplateTail) templateExpressionDepths.pop();
      }
    }
    const end = scanner.getTokenEnd();
    if (end <= previousEnd) {
      throw new Error(`${repositoryPath} cannot be tokenized safely at offset ${end}`);
    }
    tokens.push({
      kind,
      value: scanner.getTokenValue(),
    });
    previousKind = kind;
    previousEnd = end;
  }
  return tokens;
}

const expressionPrefixTokens = new Set<SyntaxKind>([
  SyntaxKind.AmpersandAmpersandToken,
  SyntaxKind.AmpersandEqualsToken,
  SyntaxKind.AmpersandToken,
  SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.AsteriskAsteriskToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.AsteriskToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.BarBarToken,
  SyntaxKind.BarEqualsToken,
  SyntaxKind.BarToken,
  SyntaxKind.CaretEqualsToken,
  SyntaxKind.CaretToken,
  SyntaxKind.CaseKeyword,
  SyntaxKind.ColonToken,
  SyntaxKind.CommaToken,
  SyntaxKind.DeleteKeyword,
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.EqualsGreaterThanToken,
  SyntaxKind.EqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
  SyntaxKind.ExclamationToken,
  SyntaxKind.GreaterThanEqualsToken,
  SyntaxKind.GreaterThanToken,
  SyntaxKind.LessThanEqualsToken,
  SyntaxKind.LessThanToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.MinusToken,
  SyntaxKind.OpenBraceToken,
  SyntaxKind.OpenBracketToken,
  SyntaxKind.OpenParenToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.PercentToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.PlusToken,
  SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.QuestionQuestionToken,
  SyntaxKind.QuestionToken,
  SyntaxKind.ReturnKeyword,
  SyntaxKind.SemicolonToken,
  SyntaxKind.SlashEqualsToken,
  SyntaxKind.ThrowKeyword,
  SyntaxKind.TildeToken,
  SyntaxKind.TypeOfKeyword,
  SyntaxKind.VoidKeyword,
  SyntaxKind.YieldKeyword,
]);

function regularExpressionCanStartAfter(previous: SyntaxKind | undefined): boolean {
  return previous === undefined || expressionPrefixTokens.has(previous);
}

function stringValue(token: SourceToken | undefined): string | undefined {
  return token?.kind === SyntaxKind.StringLiteral ||
      token?.kind === SyntaxKind.NoSubstitutionTemplateLiteral
    ? token.value
    : undefined;
}

function moduleSpecifiers(tokens: readonly SourceToken[]): string[] {
  const specifiers: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind === SyntaxKind.ImportKeyword) {
      const direct = stringValue(tokens[index + 1]);
      if (direct !== undefined) {
        specifiers.push(direct);
        continue;
      }
      if (tokens[index + 1]?.kind === SyntaxKind.OpenParenToken) {
        const dynamic = stringValue(tokens[index + 2]);
        if (dynamic !== undefined) specifiers.push(dynamic);
        continue;
      }
      for (let cursor = index + 1; cursor < Math.min(tokens.length, index + 128); cursor += 1) {
        const candidate = tokens[cursor]!;
        if (candidate.kind === SyntaxKind.SemicolonToken) break;
        if (candidate.kind === SyntaxKind.FromKeyword) {
          const from = stringValue(tokens[cursor + 1]);
          if (from !== undefined) specifiers.push(from);
          break;
        }
      }
    } else if (token.kind === SyntaxKind.ExportKeyword) {
      for (let cursor = index + 1; cursor < Math.min(tokens.length, index + 128); cursor += 1) {
        const candidate = tokens[cursor]!;
        if (candidate.kind === SyntaxKind.SemicolonToken) break;
        if (candidate.kind === SyntaxKind.FromKeyword) {
          const from = stringValue(tokens[cursor + 1]);
          if (from !== undefined) specifiers.push(from);
          break;
        }
      }
    } else if (
      (token.kind === SyntaxKind.Identifier || token.kind === SyntaxKind.RequireKeyword) &&
      token.value === "require" &&
      tokens[index + 1]?.kind === SyntaxKind.OpenParenToken
    ) {
      const required = stringValue(tokens[index + 2]);
      if (required !== undefined) specifiers.push(required);
    }
  }
  return specifiers;
}

function normalizedIdentifier(value: string): string {
  return value
    .replace(/^#/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_$]+/g, " ")
    .trim()
    .toLowerCase();
}

const forbiddenResponsibilities = new Set([
  "agent brain",
  "auto accept",
  "execute task",
  "model inference",
  "prompt execution",
  "requirement creation",
  "run task",
  "target ranking",
  "target selection",
  "tool invocation",
  "workflow automation",
  "workflow planning",
]);

function containsForbiddenResponsibility(tokens: readonly SourceToken[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== SyntaxKind.Identifier && token.kind !== SyntaxKind.PrivateIdentifier) continue;
    let phrase = normalizedIdentifier(token.value);
    if (forbiddenResponsibilities.has(phrase)) return true;
    let cursor = index;
    while (
      tokens[cursor + 1]?.kind === SyntaxKind.DotToken &&
      (tokens[cursor + 2]?.kind === SyntaxKind.Identifier ||
        tokens[cursor + 2]?.kind === SyntaxKind.PrivateIdentifier)
    ) {
      phrase += ` ${normalizedIdentifier(tokens[cursor + 2]!.value)}`;
      if (forbiddenResponsibilities.has(phrase)) return true;
      cursor += 2;
    }
  }
  return false;
}

type TransportLiteral = "webhook" | "long_connection" | "websocket";

function transportLiteral(token: SourceToken | undefined): TransportLiteral | undefined {
  const value = stringValue(token)?.toLowerCase().replace(/[\s_-]/g, "");
  if (value === "webhook") return "webhook";
  if (value === "longconnection") return "long_connection";
  if (value === "websocket") return "websocket";
  return undefined;
}

const selectorTokenKinds = new Set<SyntaxKind>([
  SyntaxKind.CloseBracketToken,
  SyntaxKind.DotToken,
  SyntaxKind.Identifier,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.NumericLiteral,
  SyntaxKind.OpenBracketToken,
  SyntaxKind.PrivateIdentifier,
  SyntaxKind.QuestionDotToken,
  SyntaxKind.StringLiteral,
  SyntaxKind.ThisKeyword,
]);

function selectorBefore(tokens: readonly SourceToken[], operator: number): readonly SourceToken[] {
  if (tokens[operator - 1]?.kind === SyntaxKind.CloseParenToken) {
    let depth = 0;
    for (let index = operator - 1; index >= 0; index -= 1) {
      if (tokens[index]!.kind === SyntaxKind.CloseParenToken) depth += 1;
      else if (tokens[index]!.kind === SyntaxKind.OpenParenToken) {
        depth -= 1;
        if (depth === 0) return tokens.slice(index + 1, operator - 1);
      }
    }
  }
  let start = operator;
  while (start > 0 && selectorTokenKinds.has(tokens[start - 1]!.kind)) start -= 1;
  return tokens.slice(start, operator);
}

function selectorAfter(tokens: readonly SourceToken[], operator: number): readonly SourceToken[] {
  if (tokens[operator + 1]?.kind === SyntaxKind.OpenParenToken) {
    const close = matchingToken(
      tokens,
      operator + 1,
      SyntaxKind.OpenParenToken,
      SyntaxKind.CloseParenToken,
    );
    if (close !== undefined) return tokens.slice(operator + 2, close);
  }
  let end = operator + 1;
  while (end < tokens.length && selectorTokenKinds.has(tokens[end]!.kind)) end += 1;
  return tokens.slice(operator + 1, end);
}

function selectorIsFeishuSpecific(tokens: readonly SourceToken[]): boolean {
  return tokens.some((token) => {
    if (
      token.kind !== SyntaxKind.Identifier && token.kind !== SyntaxKind.PrivateIdentifier &&
      token.kind !== SyntaxKind.StringLiteral &&
      token.kind !== SyntaxKind.NoSubstitutionTemplateLiteral
    ) return false;
    return normalizedIdentifier(token.value).split(" ").includes("feishu");
  });
}

function forbiddenTransportSelection(
  literal: TransportLiteral,
  selector: readonly SourceToken[],
): boolean {
  return literal !== "webhook" || selectorIsFeishuSpecific(selector);
}

const equalityOperators = new Set<SyntaxKind>([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

function matchingToken(
  tokens: readonly SourceToken[],
  start: number,
  open: SyntaxKind,
  close: SyntaxKind,
): number | undefined {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index]!.kind === open) depth += 1;
    else if (tokens[index]!.kind === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function containsFeishuTransportConditional(tokens: readonly SourceToken[]): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    if (equalityOperators.has(tokens[index]!.kind)) {
      const rightLiteral = transportLiteral(tokens[index + 1]);
      if (
        rightLiteral !== undefined &&
        forbiddenTransportSelection(rightLiteral, selectorBefore(tokens, index))
      ) return true;
      const leftLiteral = transportLiteral(tokens[index - 1]);
      if (
        leftLiteral !== undefined &&
        forbiddenTransportSelection(leftLiteral, selectorAfter(tokens, index))
      ) return true;
    }
    if (
      tokens[index]!.kind !== SyntaxKind.SwitchKeyword ||
      tokens[index + 1]?.kind !== SyntaxKind.OpenParenToken
    ) continue;
    const selectorEnd = matchingToken(
      tokens,
      index + 1,
      SyntaxKind.OpenParenToken,
      SyntaxKind.CloseParenToken,
    );
    if (selectorEnd === undefined || tokens[selectorEnd + 1]?.kind !== SyntaxKind.OpenBraceToken) continue;
    const switchEnd = matchingToken(
      tokens,
      selectorEnd + 1,
      SyntaxKind.OpenBraceToken,
      SyntaxKind.CloseBraceToken,
    );
    if (switchEnd === undefined) continue;
    const selector = tokens.slice(index + 2, selectorEnd);
    let braceDepth = 1;
    for (let cursor = selectorEnd + 2; cursor < switchEnd; cursor += 1) {
      if (tokens[cursor]!.kind === SyntaxKind.OpenBraceToken) braceDepth += 1;
      else if (tokens[cursor]!.kind === SyntaxKind.CloseBraceToken) braceDepth -= 1;
      else if (braceDepth === 1 && tokens[cursor]!.kind === SyntaxKind.CaseKeyword) {
        const literal = transportLiteral(tokens[cursor + 1]);
        if (literal !== undefined && forbiddenTransportSelection(literal, selector)) return true;
      }
    }
    index = switchEnd;
  }
  return false;
}

const isolatedPrefixes = [
  "packages/exchange-core/",
  "packages/exchange-spi/",
  "packages/protocol-runtime/",
];
const edgePackages = [
  "packages/plugin-spi/",
  "packages/plugin-runtime/",
  "packages/channel-spi/",
  "packages/plugin-channel-feishu/",
  "packages/adapter-feishu-long-connection-node/",
];
const feishuSdk = /^@larksuiteoapi\/node-sdk(?:$|\/)/;
const feishuSdkAdapter = "packages/adapter-feishu-long-connection-node/";
const transportIsolatedPrefixes = [
  "packages/protocol-runtime/",
  "packages/exchange-core/",
  "packages/exchange-spi/",
  "packages/adapter-storage-",
  "packages/connector-runtime/",
  "packages/transport-http/",
  "packages/sdk-typescript/",
];

export async function checkPluginBoundaries(root = resolve(".")): Promise<PluginBoundaryReport> {
  const discovery = await discoverSources(root);
  const violations = [...discovery.violations];
  let isolatedImports = 0;
  let sdkImports = 0;
  let responsibilityViolations = 0;
  for (const path of discovery.files) {
    const repositoryPath = normalizeRepositoryPath(relative(root, path));
    const source = await readFile(path, "utf8");
    const tokens = tokenize(source, repositoryPath);
    const specifiers = moduleSpecifiers(tokens);
    for (const specifier of specifiers) {
      if (!feishuSdk.test(specifier)) continue;
      sdkImports += 1;
      if (!repositoryPath.startsWith(feishuSdkAdapter)) {
        violations.push(`${repositoryPath} imports the Feishu Node SDK outside ${feishuSdkAdapter}`);
      }
    }
    if (isolatedPrefixes.some((prefix) => repositoryPath.startsWith(prefix))) {
      for (const specifier of specifiers) {
        if (/^@work-fabric\/(?:configuration-|plugin-|channel-|adapter-configuration-yaml|plugin-channel-feishu)/.test(specifier) || specifier === "yaml") {
          isolatedImports += 1;
          violations.push(`${repositoryPath} imports configuration or plugin infrastructure across the Core boundary`);
        }
      }
    }
    if (
      edgePackages.some((prefix) => repositoryPath.startsWith(prefix)) &&
      containsForbiddenResponsibility(tokens)
    ) {
      responsibilityViolations += 1;
      violations.push(`${repositoryPath} contains Agent-brain, workflow or participant-execution responsibility`);
    }
    if (
      transportIsolatedPrefixes.some((prefix) => repositoryPath.startsWith(prefix)) &&
      containsFeishuTransportConditional(tokens)
    ) {
      violations.push(`${repositoryPath} contains Feishu-specific transport selection across an isolated boundary`);
    }
  }
  if (sdkImports !== 1) {
    violations.push(`expected exactly one production Feishu SDK import, found ${sdkImports}`);
  }
  if (violations.length > 0) throw new Error(`Plugin boundary violations:\n${violations.join("\n")}`);
  return {
    source_files: discovery.files.length,
    isolated_imports: isolatedImports,
    sdk_imports: sdkImports,
    responsibility_violations: responsibilityViolations,
  };
}

const invoked = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) process.stdout.write(`${JSON.stringify(await checkPluginBoundaries())}\n`);
