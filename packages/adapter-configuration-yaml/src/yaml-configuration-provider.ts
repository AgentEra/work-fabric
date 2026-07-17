import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  ConfigurationDocument,
  ConfigurationProvider,
} from "@work-fabric/configuration-spi";
import { parseAllDocuments, visit } from "yaml";

export class YamlConfigurationError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
  ) {
    super(`${code} at ${path}`);
    this.name = "YamlConfigurationError";
  }
}

export interface YamlConfigurationProviderOptions {
  readonly path: string;
  readonly max_bytes: number;
  readonly max_depth: number;
}

function positiveBound(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${field} is outside its bound`);
  }
  return value;
}

function assertJsonTree(value: unknown, depth: number, maximum: number, path: string): void {
  if (depth > maximum) throw new YamlConfigurationError("document_too_deep", path);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new YamlConfigurationError("non_json_number", path);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertJsonTree(value[index], depth + 1, maximum, `${path}[${index}]`);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assertJsonTree(child, depth + 1, maximum, `${path}.${key}`);
    }
    return;
  }
  throw new YamlConfigurationError("non_json_value", path);
}

function parserErrorCode(code: string | undefined): string {
  if (code === "DUPLICATE_KEY") return "duplicate_key";
  if (code === "TAG_RESOLVE_FAILED") return "custom_tag_forbidden";
  return "invalid_yaml";
}

export class YamlConfigurationProvider implements ConfigurationProvider {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly maxDepth: number;

  constructor(options: YamlConfigurationProviderOptions) {
    this.path = resolve(options.path);
    this.maxBytes = positiveBound(options.max_bytes, "max_bytes", 16 * 1024 * 1024);
    this.maxDepth = positiveBound(options.max_depth, "max_depth", 128);
  }

  async load(): Promise<ConfigurationDocument> {
    let bytes: Buffer;
    try {
      const metadata = await stat(this.path);
      if (!metadata.isFile()) throw new YamlConfigurationError("file_unavailable", this.path);
      if (metadata.size > this.maxBytes) {
        throw new YamlConfigurationError("file_too_large", this.path);
      }
      bytes = await readFile(this.path);
    } catch (error) {
      if (error instanceof YamlConfigurationError) throw error;
      throw new YamlConfigurationError("file_unavailable", this.path);
    }
    if (bytes.byteLength > this.maxBytes) {
      throw new YamlConfigurationError("file_too_large", this.path);
    }

    const documents = parseAllDocuments(bytes.toString("utf8"), {
      strict: true,
      uniqueKeys: true,
      customTags: [],
    });
    if (documents.length !== 1) {
      throw new YamlConfigurationError("multiple_documents", this.path);
    }
    const document = documents[0]!;
    const parseError = document.errors[0];
    if (parseError !== undefined) {
      throw new YamlConfigurationError(parserErrorCode(parseError.code), this.path);
    }
    let containsAlias = false;
    let containsCustomTag = false;
    visit(document, {
      Alias() {
        containsAlias = true;
        return visit.BREAK;
      },
      Node(_key, node) {
        if (
          "tag" in node &&
          typeof node.tag === "string" &&
          !node.tag.startsWith("tag:yaml.org,2002:")
        ) {
          containsCustomTag = true;
          return visit.BREAK;
        }
      },
    });
    if (containsAlias) throw new YamlConfigurationError("alias_forbidden", this.path);
    if (containsCustomTag) {
      throw new YamlConfigurationError("custom_tag_forbidden", this.path);
    }

    let value: unknown;
    try {
      value = document.toJS({ maxAliasCount: 0, mapAsMap: false });
    } catch {
      throw new YamlConfigurationError("invalid_yaml", this.path);
    }
    assertJsonTree(value, 0, this.maxDepth, "$");
    return {
      revision: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      value,
    };
  }
}
