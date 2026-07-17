import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type Expression,
  isAsExpression,
  isBinaryExpression,
  isCallExpression,
  isCaseClause,
  isElementAccessExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isJSDoc,
  isNoSubstitutionTemplateLiteral,
  isNonNullExpression,
  isParenthesizedExpression,
  isPartiallyEmittedExpression,
  isPrivateIdentifier,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isStringLiteral,
  isSwitchStatement,
  isTypeAssertion,
  type Node,
  ScriptKind,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";

export interface PluginBoundaryReport {
  readonly source_files: number;
  readonly isolated_imports: number;
  readonly sdk_imports: number;
  readonly responsibility_violations: number;
}

interface SourceDiscovery {
  readonly files: readonly string[];
  readonly violations: readonly string[];
}

interface SourceAnalysis {
  readonly moduleSpecifiers: readonly string[];
  readonly forbiddenResponsibility: boolean;
  readonly forbiddenTransportSelection: boolean;
}

const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const globallyExcludedDirectories = new Set([
  ".cache",
  ".git",
  ".hg",
  ".parcel-cache",
  ".scratch",
  ".superpowers",
  ".svn",
  ".temp",
  ".tmp",
  ".turbo",
  ".worktrees",
  "node_modules",
  "scratch",
  "temp",
  "tmp",
]);
const outputDirectories = new Set([
  ".next",
  ".nuxt",
  "build",
  "coverage",
  "dist",
  "out",
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

function isConventionalOutputDirectory(repositoryPath: string): boolean {
  const segments = repositoryPath.split("/");
  const directoryName = segments.at(-1)!;
  if (!outputDirectories.has(directoryName)) return false;
  if (segments.includes("src")) return false;
  return segments.length === 1 ||
    (segments.length === 3 && segments[0] === "packages");
}

async function discoverSources(root: string): Promise<SourceDiscovery> {
  const sourceFiles: string[] = [];
  const violations: string[] = [];

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const repositoryPath = normalizeRepositoryPath(relative(root, path));
      if (
        globallyExcludedDirectories.has(entry.name) ||
        isConventionalOutputDirectory(repositoryPath)
      ) continue;
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

function expectedScriptKind(repositoryPath: string): ScriptKind {
  if (/\.tsx$/i.test(repositoryPath)) return ScriptKind.TSX;
  if (/\.jsx$/i.test(repositoryPath)) return ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/i.test(repositoryPath)) return ScriptKind.JS;
  return ScriptKind.TS;
}

function unwrapExpression(expression: Expression): Expression {
  let current = expression;
  while (true) {
    if (
      isAsExpression(current) || isNonNullExpression(current) ||
      isParenthesizedExpression(current) || isPartiallyEmittedExpression(current) ||
      isSatisfiesExpression(current) || isTypeAssertion(current)
    ) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

function stringLiteralText(expression: Expression | undefined): string | undefined {
  if (expression === undefined) return undefined;
  const unwrapped = unwrapExpression(expression);
  return isStringLiteral(unwrapped) || isNoSubstitutionTemplateLiteral(unwrapped)
    ? unwrapped.text
    : undefined;
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

function responsibilityIdentifier(value: string): boolean {
  return forbiddenResponsibilities.has(normalizedIdentifier(value));
}

function propertyAccessParts(expression: Expression): string[] {
  const unwrapped = unwrapExpression(expression);
  if (isIdentifier(unwrapped) || isPrivateIdentifier(unwrapped)) {
    return [normalizedIdentifier(unwrapped.text)];
  }
  if (isPropertyAccessExpression(unwrapped)) {
    return [
      ...propertyAccessParts(unwrapped.expression),
      normalizedIdentifier(unwrapped.name.text),
    ];
  }
  return [];
}

function propertyAccessContainsResponsibility(expression: Expression): boolean {
  const phrase = propertyAccessParts(expression).join(" ");
  return [...forbiddenResponsibilities].some((responsibility) =>
    phrase === responsibility || phrase.endsWith(` ${responsibility}`)
  );
}

type TransportLiteral = "webhook" | "long_connection" | "websocket";

function transportLiteral(expression: Expression | undefined): TransportLiteral | undefined {
  const value = stringLiteralText(expression)?.toLowerCase().replace(/[\s_-]/g, "");
  if (value === "webhook") return "webhook";
  if (value === "longconnection") return "long_connection";
  if (value === "websocket") return "websocket";
  return undefined;
}

function selectorIsFeishuSpecific(expression: Expression): boolean {
  let feishuSpecific = false;
  const visit = (node: Node): void => {
    if (feishuSpecific || isJSDoc(node)) return;
    if (isIdentifier(node) || isPrivateIdentifier(node)) {
      if (normalizedIdentifier(node.text).split(" ").includes("feishu")) {
        feishuSpecific = true;
      }
      return;
    }
    if (isElementAccessExpression(node)) {
      const key = stringLiteralText(node.argumentExpression);
      if (key !== undefined && normalizedIdentifier(key).split(" ").includes("feishu")) {
        feishuSpecific = true;
        return;
      }
    }
    node.forEachChild(visit);
  };
  visit(unwrapExpression(expression));
  return feishuSpecific;
}

function isForbiddenTransportSelection(
  literal: TransportLiteral,
  selector: Expression,
): boolean {
  return literal !== "webhook" || selectorIsFeishuSpecific(selector);
}

const equalityOperators = new Set<SyntaxKind>([
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

function analyzeSourceFile(sourceFile: SourceFile): SourceAnalysis {
  const moduleSpecifiers: string[] = [];
  let forbiddenResponsibility = false;
  let forbiddenTransportSelection = false;

  const visit = (node: Node): void => {
    if (isJSDoc(node)) return;

    if (isImportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier !== undefined) moduleSpecifiers.push(specifier);
    } else if (isExportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier !== undefined) moduleSpecifiers.push(specifier);
    } else if (
      isImportEqualsDeclaration(node) &&
      isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = stringLiteralText(node.moduleReference.expression);
      if (specifier !== undefined) moduleSpecifiers.push(specifier);
    } else if (isCallExpression(node)) {
      const firstArgument = node.arguments[0];
      if (node.expression.kind === SyntaxKind.ImportKeyword) {
        const specifier = stringLiteralText(firstArgument);
        if (specifier !== undefined) moduleSpecifiers.push(specifier);
      } else if (isIdentifier(node.expression) && node.expression.text === "require") {
        const specifier = stringLiteralText(firstArgument);
        if (specifier !== undefined) moduleSpecifiers.push(specifier);
      }
    }

    if (
      (isIdentifier(node) || isPrivateIdentifier(node)) &&
      responsibilityIdentifier(node.text)
    ) forbiddenResponsibility = true;
    if (
      isPropertyAccessExpression(node) &&
      propertyAccessContainsResponsibility(node)
    ) forbiddenResponsibility = true;

    if (isBinaryExpression(node) && equalityOperators.has(node.operatorToken.kind)) {
      const rightLiteral = transportLiteral(node.right);
      if (
        rightLiteral !== undefined &&
        isForbiddenTransportSelection(rightLiteral, node.left)
      ) forbiddenTransportSelection = true;
      const leftLiteral = transportLiteral(node.left);
      if (
        leftLiteral !== undefined &&
        isForbiddenTransportSelection(leftLiteral, node.right)
      ) forbiddenTransportSelection = true;
    }
    if (isSwitchStatement(node)) {
      for (const clause of node.caseBlock.clauses) {
        if (!isCaseClause(clause)) continue;
        const literal = transportLiteral(clause.expression);
        if (
          literal !== undefined &&
          isForbiddenTransportSelection(literal, node.expression)
        ) forbiddenTransportSelection = true;
      }
    }

    node.forEachChild(visit);
  };
  visit(sourceFile);
  return { moduleSpecifiers, forbiddenResponsibility, forbiddenTransportSelection };
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
  const api = new API({ cwd: root });
  let snapshot: ReturnType<API["updateSnapshot"]> | undefined;
  try {
    snapshot = api.updateSnapshot({ openFiles: [...discovery.files] });
    for (const path of discovery.files) {
      const repositoryPath = normalizeRepositoryPath(relative(root, path));
      const project = snapshot.getDefaultProjectForFile(path);
      const sourceFile = project?.program.getSourceFile(path);
      if (sourceFile === undefined) {
        violations.push(`${repositoryPath} could not be parsed as repository source`);
        continue;
      }
      const scriptKind = expectedScriptKind(repositoryPath);
      if (sourceFile.scriptKind !== scriptKind) {
        violations.push(`${repositoryPath} parsed with ScriptKind ${sourceFile.scriptKind}, expected ${scriptKind}`);
        continue;
      }
      const analysis = analyzeSourceFile(sourceFile);
      for (const specifier of analysis.moduleSpecifiers) {
        if (!feishuSdk.test(specifier)) continue;
        sdkImports += 1;
        if (!repositoryPath.startsWith(feishuSdkAdapter)) {
          violations.push(`${repositoryPath} imports the Feishu Node SDK outside ${feishuSdkAdapter}`);
        }
      }
      if (isolatedPrefixes.some((prefix) => repositoryPath.startsWith(prefix))) {
        for (const specifier of analysis.moduleSpecifiers) {
          if (/^@work-fabric\/(?:configuration-|plugin-|channel-|adapter-configuration-yaml|plugin-channel-feishu)/.test(specifier) || specifier === "yaml") {
            isolatedImports += 1;
            violations.push(`${repositoryPath} imports configuration or plugin infrastructure across the Core boundary`);
          }
        }
      }
      if (
        edgePackages.some((prefix) => repositoryPath.startsWith(prefix)) &&
        analysis.forbiddenResponsibility
      ) {
        responsibilityViolations += 1;
        violations.push(`${repositoryPath} contains Agent-brain, workflow or participant-execution responsibility`);
      }
      if (
        transportIsolatedPrefixes.some((prefix) => repositoryPath.startsWith(prefix)) &&
        analysis.forbiddenTransportSelection
      ) {
        violations.push(`${repositoryPath} contains Feishu-specific transport selection across an isolated boundary`);
      }
    }
  } finally {
    snapshot?.dispose();
    api.close();
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
