import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import type {
  Ajv2020 as Ajv2020Instance,
  AnySchema,
} from "ajv/dist/2020.js";

const require = createRequire(import.meta.url);
const { default: Ajv2020 } = require("ajv/dist/2020.js") as typeof import(
  "ajv/dist/2020.js"
);
const { default: addFormats } = require("ajv-formats") as typeof import(
  "ajv-formats"
);

export async function findJsonFiles(root: string): Promise<string[]> {
  const absoluteRoot = resolve(root);
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(path);
      }
    }
  }

  await visit(absoluteRoot);
  return files.sort((left, right) => left.localeCompare(right));
}

export async function loadSchemaRegistry(root: string): Promise<Ajv2020Instance> {
  const files = await findJsonFiles(root);
  if (files.length === 0) {
    throw new Error(`No JSON schemas found in ${resolve(root)}`);
  }

  const schemas: AnySchema[] = [];
  const identifiers = new Set<string>();

  for (const file of files) {
    const schema = JSON.parse(await readFile(file, "utf8")) as AnySchema & {
      $id?: unknown;
    };
    if (typeof schema.$id !== "string" || schema.$id.length === 0) {
      throw new Error(`Schema is missing a non-empty $id: ${file}`);
    }
    if (identifiers.has(schema.$id)) {
      throw new Error(`Duplicate schema $id: ${schema.$id}`);
    }
    identifiers.add(schema.$id);
    schemas.push(schema);
  }

  const registry = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: true,
  });
  addFormats(registry);
  for (const schema of schemas) {
    registry.addSchema(schema);
  }
  return registry;
}
