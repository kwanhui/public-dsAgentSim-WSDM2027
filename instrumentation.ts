// Runs once when a server instance starts. Refuses an environment that must
// not serve (lib/env-guard.ts), such as DEMO_MODE=1 on Vercel. The same
// check runs in next.config.ts at build time; this one catches a variable
// added to the project after the build.
export async function register(): Promise<void> {
  const { assertStartupEnv } = await import("./lib/env-guard");
  assertStartupEnv();
}
