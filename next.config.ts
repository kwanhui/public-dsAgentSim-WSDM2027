import type { NextConfig } from "next";
import { assertStartupEnv } from "./lib/env-guard";

// Refuse an unsafe environment (lib/env-guard.ts: DEMO_MODE on Vercel or
// beside a paid provider, an unparsable daily budget) before anything builds
// or serves. The same check runs again in instrumentation.ts at server start,
// for a variable added after the build.
assertStartupEnv();

const nextConfig: NextConfig = {
  experimental: {
    // Lets server actions answer a read-only reviewer with forbidden() (403);
    // see lib/auth/guard.ts.
    authInterrupts: true,
    serverActions: {
      bodySizeLimit: "1mb",
    },
  },
  // @electric-sql/pglite must load its WASM assets from node_modules at
  // runtime; bundling it breaks the demo-mode database.
  serverExternalPackages: ["js-yaml", "@electric-sql/pglite"],
};

export default nextConfig;
