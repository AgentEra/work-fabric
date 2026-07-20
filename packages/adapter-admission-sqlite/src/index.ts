import { readFileSync } from "node:fs";

import type { SqliteMigration } from "@work-fabric/adapter-storage-sqlite";

export const SQLITE_ADMISSION_MIGRATION: SqliteMigration = {
  id: "005_admission",
  sql: readFileSync(new URL("../migrations/005_admission.sql", import.meta.url), "utf8"),
};

export * from "./sqlite-admission-stores.js";
