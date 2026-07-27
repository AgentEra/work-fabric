import { readFileSync } from "node:fs";

export const CLAIM_POOL_INDEX_MIGRATION = {
  id: "012_claim_pool_index",
  sql: readFileSync(
    new URL("../migrations/012_claim_pool_index.sql", import.meta.url),
    "utf8",
  ),
} as const;
