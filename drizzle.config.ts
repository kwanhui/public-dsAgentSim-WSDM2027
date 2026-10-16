import { config as loadEnv } from "dotenv";

// drizzle-kit runs outside Next.js, so it doesn't auto-load .env.local.
// Load it explicitly here, falling back to .env if .env.local is absent
// (e.g. in CI where the URL comes from the shell env directly).
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

import type { Config } from "drizzle-kit";

export default {
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.POSTGRES_URL ?? "",
  },
} satisfies Config;
