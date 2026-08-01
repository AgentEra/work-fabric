import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";

import { invalid } from "./errors.js";

function identifier(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.trim() !== value) invalid("invalid_identifier", field);
  return value;
}

export function workspacePath(root: string, tenantId: string, handoffId: string): string {
  const normalizedRoot = resolve(root);
  identifier(tenantId, "tenant_id");
  identifier(handoffId, "handoff_id");
  const result = resolve(
    normalizedRoot,
    createHash("sha256").update(tenantId).digest("hex"),
    createHash("sha256").update(handoffId).digest("hex"),
  );
  const path = relative(normalizedRoot, result);
  if (path.length === 0 || path === ".." || path.startsWith("../") || path.startsWith("..\\")) invalid("workspace_root", "root");
  return result;
}
