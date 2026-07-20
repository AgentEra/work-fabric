import { readFileSync } from "node:fs";

import type { MigrationSource } from "@work-fabric/adapter-postgres-common";

export const POSTGRES_ADMISSION_MIGRATION: MigrationSource = {
  id: "010_admission",
  sql: readFileSync(new URL("../migrations/010_admission.sql", import.meta.url), "utf8"),
};

export * from "./postgres-admission-stores.js";
