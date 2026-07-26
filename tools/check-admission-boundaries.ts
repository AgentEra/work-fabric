import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type Expression,
  isAsExpression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
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
  isPropertyAssignment,
  isSatisfiesExpression,
  isStringLiteral,
  isTypeAssertion,
  isVariableDeclaration,
  type Node,
  ScriptKind,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";

export interface AdmissionBoundaryReport {
  readonly source_files: number;
  readonly admission_imports: number;
  readonly responsibility_violations: number;
  readonly sensitive_sink_violations: number;
}

interface SourceDiscovery {
  readonly files: readonly string[];
  readonly violations: readonly string[];
}

interface SourceAnalysis {
  readonly moduleSpecifiers: readonly string[];
  readonly dynamicLoader: boolean;
  readonly createRequireUse: boolean;
  readonly policyPrecedence: boolean;
  readonly exchangeApplicationUse: boolean;
  readonly sensitiveSink: boolean;
}

const sourceExtension = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const excludedDirectories = new Set([
  ".cache", ".git", ".hg", ".parcel-cache", ".scratch", ".superpowers", ".venv",
  ".svn", ".temp", ".tmp", ".turbo", ".worktrees", "node_modules",
  "scratch", "temp", "tmp",
]);
const outputDirectories = new Set([".next", ".nuxt", "build", "coverage", "dist", "out"]);

function normalizeRepositoryPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isProductionSourcePath(path: string): boolean {
  const repositoryPath = normalizeRepositoryPath(path);
  if (!sourceExtension.test(repositoryPath)) return false;
  const segments = repositoryPath.split("/");
  if (segments.some((segment) => segment === "test" || segment === "tests" || segment === "__tests__")) {
    return false;
  }
  return !/\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/i.test(segments.at(-1)!);
}

function isOutputDirectory(repositoryPath: string): boolean {
  const segments = repositoryPath.split("/");
  const name = segments.at(-1)!;
  if (!outputDirectories.has(name) || segments.includes("src")) return false;
  return segments.length === 1 ||
    (segments.length === 3 && (segments[0] === "packages" || segments[0] === "examples"));
}

async function discoverSources(root: string): Promise<SourceDiscovery> {
  const files: string[] = [];
  const violations: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const repositoryPath = normalizeRepositoryPath(relative(root, path));
      if (excludedDirectories.has(entry.name) || isOutputDirectory(repositoryPath)) continue;
      if (entry.isSymbolicLink()) {
        violations.push(`${repositoryPath} is a symbolic link and cannot be boundary-scanned`);
      } else if (entry.isDirectory()) {
        await visit(path);
      } else if (isProductionSourcePath(repositoryPath)) {
        files.push(path);
      }
    }
  };
  await visit(root);
  return { files, violations };
}

function expectedScriptKind(repositoryPath: string): ScriptKind {
  if (/\.tsx$/i.test(repositoryPath)) return ScriptKind.TSX;
  if (/\.jsx$/i.test(repositoryPath)) return ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/i.test(repositoryPath)) return ScriptKind.JS;
  return ScriptKind.TS;
}

function unwrapExpression(expression: Expression): Expression {
  let current = expression;
  while (
    isAsExpression(current) || isNonNullExpression(current) ||
    isParenthesizedExpression(current) || isPartiallyEmittedExpression(current) ||
    isSatisfiesExpression(current) || isTypeAssertion(current)
  ) current = current.expression;
  return current;
}

function stringLiteralText(expression: Expression | undefined): string | undefined {
  if (expression === undefined) return undefined;
  const unwrapped = unwrapExpression(expression);
  return isStringLiteral(unwrapped) || isNoSubstitutionTemplateLiteral(unwrapped)
    ? unwrapped.text
    : undefined;
}

function isRequire(expression: Expression): boolean {
  const value = unwrapExpression(expression);
  if (isIdentifier(value)) return value.text === "require";
  if (!isPropertyAccessExpression(value) && !isElementAccessExpression(value)) return false;
  const receiver = unwrapExpression(value.expression);
  if (!isIdentifier(receiver) || receiver.text !== "module") return false;
  return isPropertyAccessExpression(value)
    ? value.name.text === "require"
    : stringLiteralText(value.argumentExpression) === "require";
}

function normalizedIdentifier(value: string): string {
  return value
    .replace(/^#/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_$-]+/g, " ")
    .trim()
    .toLowerCase();
}

const precedenceIdentifiers = new Set([
  "exact allow", "exact deny", "all internal members", "internal member allowance",
  "policy precedence", "evaluate admission policy", "compile admission policy",
]);
const sensitiveIdentifiers = new Set([
  "external subject id", "external open id", "sender open id", "open id", "subject id", "raw subject", "raw subject id",
  "grant", "credential", "representation grant", "grant key", "grant keys", "grant signing key", "subject fingerprint key",
]);

function nodeName(node: Node): string | undefined {
  if (isIdentifier(node) || isPrivateIdentifier(node) || isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function subtreeContainsExecutableIdentifier(node: Node, vocabulary: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (child: Node): void => {
    if (found || isJSDoc(child)) return;
    if (isIdentifier(child) || isPrivateIdentifier(child)) {
      if (vocabulary.has(normalizedIdentifier(child.text))) found = true;
      return;
    }
    if (isPropertyAccessExpression(child)) {
      if (vocabulary.has(normalizedIdentifier(child.name.text))) {
        found = true;
        return;
      }
    } else if (isElementAccessExpression(child)) {
      const key = stringLiteralText(child.argumentExpression);
      if (key !== undefined && vocabulary.has(normalizedIdentifier(key))) {
        found = true;
        return;
      }
    } else if (isPropertyAssignment(child)) {
      const name = nodeName(child.name);
      if (name !== undefined && vocabulary.has(normalizedIdentifier(name))) {
        found = true;
        return;
      }
    }
    child.forEachChild(visit);
  };
  visit(node);
  return found;
}

function callName(expression: Expression): string {
  const value = unwrapExpression(expression);
  if (isIdentifier(value)) return normalizedIdentifier(value.text);
  if (isPropertyAccessExpression(value)) {
    const receiver = callName(value.expression);
    return `${receiver} ${normalizedIdentifier(value.name.text)}`.trim();
  }
  if (isElementAccessExpression(value)) {
    const receiver = callName(value.expression);
    return `${receiver} ${normalizedIdentifier(stringLiteralText(value.argumentExpression) ?? "")}`.trim();
  }
  return "";
}

function isObservationCall(expression: Expression): boolean {
  const name = callName(expression);
  return /(?:^| )(?:log|logger|info|warn|error|debug|metric|metrics|observe|telemetry|console)(?: |$)/.test(name);
}

function isDecisionPersistenceCall(expression: Expression): boolean {
  const name = callName(expression);
  return /(?:^| )decisions?(?: store)? (?:record|persist|save|put|append)$/.test(name);
}

function targetIdentifiers(node: Node): readonly string[] {
  const names: string[] = [];
  const visit = (child: Node): void => {
    if (isIdentifier(child)) {
      names.push(child.text);
      return;
    }
    child.forEachChild(visit);
  };
  visit(node);
  return names;
}

function subtreeUsesTaint(node: Node, tainted: ReadonlySet<string>): boolean {
  let found = subtreeContainsExecutableIdentifier(node, sensitiveIdentifiers);
  const visit = (child: Node): void => {
    if (found || isJSDoc(child)) return;
    if (isIdentifier(child) && tainted.has(child.text)) {
      found = true;
      return;
    }
    child.forEachChild(visit);
  };
  if (!found) visit(node);
  return found;
}

function sensitiveSinkIn(sourceFile: SourceFile, consoleSource: boolean): boolean {
  const tainted = new Set<string>();
  const propagation: Array<{ readonly targets: readonly string[]; readonly source: Node }> = [];

  const collect = (node: Node): void => {
    if (isJSDoc(node)) return;
    if (isVariableDeclaration(node) && node.initializer !== undefined) {
      propagation.push({ targets: targetIdentifiers(node.name), source: node.initializer });
    } else if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
      propagation.push({ targets: targetIdentifiers(node.left), source: node.right });
    }
    if (isBindingElement(node) && node.name !== undefined) {
      const property = node.propertyName === undefined ? node.name : node.propertyName;
      const name = nodeName(property);
      if (name !== undefined && sensitiveIdentifiers.has(normalizedIdentifier(name))) {
        for (const target of targetIdentifiers(node.name)) tainted.add(target);
      }
    }
    node.forEachChild(collect);
  };
  collect(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of propagation) {
      if (!subtreeUsesTaint(edge.source, tainted)) continue;
      for (const target of edge.targets) {
        if (!tainted.has(target)) {
          tainted.add(target);
          changed = true;
        }
      }
    }
  }

  let sensitive = false;
  const inspect = (node: Node): void => {
    if (sensitive || isJSDoc(node)) return;
    if (consoleSource && subtreeUsesTaint(node, tainted)) {
      sensitive = true;
      return;
    }
    if (isCallExpression(node) &&
      (isObservationCall(node.expression) || isDecisionPersistenceCall(node.expression)) &&
      node.arguments.some((argument) => subtreeUsesTaint(argument, tainted))) {
      sensitive = true;
      return;
    }
    node.forEachChild(inspect);
  };
  inspect(sourceFile);
  return sensitive;
}

function analyzeSourceFile(sourceFile: SourceFile, repositoryPath: string): SourceAnalysis {
  const moduleSpecifiers: string[] = [];
  let dynamicLoader = false;
  let createRequireUse = false;
  let policyPrecedence = false;
  let exchangeApplicationUse = false;
  const consoleSource = repositoryPath.startsWith("packages/console-web/src/");

  const visit = (node: Node): void => {
    if (isJSDoc(node)) return;
    if (isImportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier !== undefined) moduleSpecifiers.push(specifier);
    } else if (isExportDeclaration(node)) {
      const specifier = stringLiteralText(node.moduleSpecifier);
      if (specifier !== undefined) moduleSpecifiers.push(specifier);
    } else if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
      const specifier = stringLiteralText(node.moduleReference.expression);
      if (specifier !== undefined) moduleSpecifiers.push(specifier);
    } else if (isCallExpression(node)) {
      const first = node.arguments[0];
      if (node.expression.kind === SyntaxKind.ImportKeyword) {
        const specifier = stringLiteralText(first);
        if (specifier === undefined) dynamicLoader = true;
        else moduleSpecifiers.push(specifier);
      } else if (isRequire(node.expression)) {
        const specifier = stringLiteralText(first);
        if (specifier === undefined) dynamicLoader = true;
        else moduleSpecifiers.push(specifier);
      }
    }

    if ((isIdentifier(node) || isPrivateIdentifier(node)) && node.text === "ExchangeApplication") {
      exchangeApplicationUse = true;
    }
    if (isIdentifier(node) && node.text === "createRequire") createRequireUse = true;
    if (subtreeContainsExecutableIdentifier(node, precedenceIdentifiers)) policyPrecedence = true;
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return {
    moduleSpecifiers,
    dynamicLoader,
    createRequireUse,
    policyPrecedence,
    exchangeApplicationUse,
    sensitiveSink: sensitiveSinkIn(sourceFile, consoleSource),
  };
}

const admissionCorePrefixes = ["packages/admission-spi/", "packages/admission-runtime/"];
const channelPluginPath = /^packages\/plugin-channel-[^/]+\//;
const forbiddenAdmissionImport = /^(?:node:module$|@larksuiteoapi\/node-sdk(?:\/|$)|@slack\/|@wecom\/|yaml$|better-sqlite3$|sqlite3$|node:sqlite$|pg$|postgres$|@work-fabric\/(?:wfpp|protocol-runtime|exchange-spi|exchange-core|exchange-runtime|adapter-(?:configuration-yaml|admission-sqlite|admission-postgres|storage-sqlite|storage-postgres))(?:\/|$))/;

interface AnalyzedRepository {
  readonly discovery: SourceDiscovery;
  readonly sources: readonly {
    readonly repositoryPath: string;
    readonly analysis: SourceAnalysis;
  }[];
}

async function analyzeRepository(root: string): Promise<AnalyzedRepository> {
  const discovery = await discoverSources(root);
  const sources: Array<{ repositoryPath: string; analysis: SourceAnalysis }> = [];
  const violations = [...discovery.violations];
  const api = new API({ cwd: root });
  let snapshot: ReturnType<API["updateSnapshot"]> | undefined;
  try {
    snapshot = api.updateSnapshot({ openFiles: [...discovery.files] });
    for (const path of discovery.files) {
      const repositoryPath = normalizeRepositoryPath(relative(root, path));
      const sourceFile = snapshot.getDefaultProjectForFile(path)?.program.getSourceFile(path);
      if (sourceFile === undefined) {
        violations.push(`${repositoryPath} could not be parsed as repository source`);
        continue;
      }
      if (sourceFile.scriptKind !== expectedScriptKind(repositoryPath)) {
        violations.push(`${repositoryPath} was parsed with the wrong ScriptKind`);
        continue;
      }
      sources.push({ repositoryPath, analysis: analyzeSourceFile(sourceFile, repositoryPath) });
    }
  } finally {
    snapshot?.dispose();
    api.close();
  }
  return { discovery: { ...discovery, violations }, sources };
}

function resolvedModulePath(repositoryPath: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  return normalizeRepositoryPath(join(dirname(repositoryPath), specifier));
}

function forbiddenImport(repositoryPath: string, specifier: string): boolean {
  const target = resolvedModulePath(repositoryPath, specifier);
  return forbiddenAdmissionImport.test(target) ||
    /^(?:packages\/(?:exchange-(?:spi|core|runtime)|protocol-runtime|adapter-(?:configuration-yaml|admission-sqlite|admission-postgres|storage-sqlite|storage-postgres)))(?:\/|$)/.test(target);
}

export interface AdmissionSensitiveSinkReport {
  readonly source_files: number;
  readonly sensitive_sink_violations: number;
}

export async function checkAdmissionSensitiveSinks(
  root = resolve("."),
): Promise<AdmissionSensitiveSinkReport> {
  const repository = await analyzeRepository(root);
  const violations = [...repository.discovery.violations];
  let sensitiveSinkViolations = 0;
  for (const source of repository.sources) {
    if (!source.analysis.sensitiveSink) continue;
    sensitiveSinkViolations += 1;
    violations.push(`${source.repositoryPath} exposes a raw subject or representation-grant secret in an output sink`);
  }
  if (violations.length > 0) {
    throw new Error(`Admission sensitive sink violations:\n${violations.join("\n")}`);
  }
  return {
    source_files: repository.discovery.files.length,
    sensitive_sink_violations: sensitiveSinkViolations,
  };
}

export async function checkAdmissionBoundaries(root = resolve(".")): Promise<AdmissionBoundaryReport> {
  const repository = await analyzeRepository(root);
  const violations = [...repository.discovery.violations];
  let admissionImports = 0;
  let responsibilityViolations = 0;
  let sensitiveSinkViolations = 0;
  for (const source of repository.sources) {
      const { repositoryPath, analysis } = source;
      const admissionCore = admissionCorePrefixes.some((prefix) => repositoryPath.startsWith(prefix));
      if (admissionCore) {
        for (const specifier of analysis.moduleSpecifiers) {
          if (!specifier.startsWith("@work-fabric/admission-")) admissionImports += 1;
          if (forbiddenImport(repositoryPath, specifier)) {
            violations.push(`${repositoryPath} imports forbidden technology or Exchange responsibility: ${specifier}`);
          }
        }
        if (analysis.dynamicLoader) {
          violations.push(`${repositoryPath} uses a non-literal dynamic module loader inside Admission core`);
        }
        if (analysis.createRequireUse) {
          violations.push(`${repositoryPath} uses createRequire inside Admission core`);
        }
      }
      const channelPlugin = channelPluginPath.test(repositoryPath);
      if (channelPlugin && analysis.policyPrecedence) {
        responsibilityViolations += 1;
        violations.push(`${repositoryPath} contains channel-owned Admission policy precedence`);
      }
      if (channelPlugin && analysis.exchangeApplicationUse) {
        responsibilityViolations += 1;
        violations.push(`${repositoryPath} directly uses ExchangeApplication`);
      }
      if (analysis.sensitiveSink) {
        sensitiveSinkViolations += 1;
        violations.push(`${repositoryPath} exposes a raw subject or representation-grant secret in an output sink`);
      }
  }
  if (violations.length > 0) {
    throw new Error(`Admission boundary violations:\n${violations.join("\n")}`);
  }
  return {
    source_files: repository.discovery.files.length,
    admission_imports: admissionImports,
    responsibility_violations: responsibilityViolations,
    sensitive_sink_violations: sensitiveSinkViolations,
  };
}

const invoked = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) {
  process.stdout.write(`${JSON.stringify(await checkAdmissionBoundaries())}\n`);
}
