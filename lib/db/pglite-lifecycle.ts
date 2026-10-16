// Shutdown handling for the embedded PGlite database (DB_DRIVER=pglite).
//
// PGlite is a single-process database: its data directory must be opened by
// one process at a time and closed cleanly, or the next open can fail with
// "PANIC: could not locate a valid checkpoint record". This module provides
// an idempotent close and once-per-process signal handlers. It has no
// dependency on PGlite itself so the logic can be unit-tested with a stub.

export interface PgliteLike {
  readonly closed?: boolean;
  exec(query: string): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Returns a close function that is safe to call any number of times, from any
 * number of places: the first call runs CHECKPOINT (so the WAL is flushed into
 * the data files and pg_control points at a fresh checkpoint) and then
 * close(); every later call returns the same promise.
 */
export function makePgliteCloser(client: PgliteLike, log: (msg: string) => void = console.warn): () => Promise<void> {
  let closing: Promise<void> | null = null;
  return () => {
    closing ??= (async () => {
      if (client.closed) return;
      try {
        await client.exec("CHECKPOINT");
      } catch (err) {
        log(`PGlite CHECKPOINT before close failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!client.closed) await client.close();
    })();
    return closing;
  };
}

/** The subset of `process` the shutdown handlers use; a stub in tests. */
export interface ProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  exit(code?: number): never;
}

const REGISTERED = Symbol.for("dsagentsim.pglite.shutdownHandlers");

// How long exit waits for the close before giving up and exiting anyway, so a
// wedged database can never keep the process alive.
const CLOSE_TIMEOUT_MS = 5000;

/**
 * Registers, at most once per process, handlers that close PGlite before the
 * process ends:
 *  - SIGINT / SIGTERM: close, then exit with 130 / 143.
 *  - beforeExit (event loop drained): close.
 *  - process.exit(): wrapped so that it closes first. Next's own SIGINT
 *    handler in the dev server ends with process.exit() once it has stopped
 *    the HTTP server, and CLI scripts call process.exit() when done; without
 *    the wrapper either would cut the close off half way.
 * Returns true if the handlers were installed by this call.
 */
export function registerPgliteShutdown(
  close: () => Promise<void>,
  proc: ProcessLike = process as unknown as ProcessLike,
  log: (msg: string) => void = console.warn,
): boolean {
  const flagged = proc as unknown as Record<symbol, boolean>;
  if (flagged[REGISTERED]) return false;
  flagged[REGISTERED] = true;

  const realExit = proc.exit.bind(proc);
  let exiting = false;

  const closeThenExit = (code: number | undefined): void => {
    if (exiting) return;
    exiting = true;
    const timer = setTimeout(() => {
      log(`PGlite did not close within ${CLOSE_TIMEOUT_MS} ms; exiting anyway.`);
      realExit(code);
    }, CLOSE_TIMEOUT_MS);
    timer.unref?.();
    close()
      .catch((err: unknown) => log(`PGlite close failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        clearTimeout(timer);
        realExit(code);
      });
  };

  proc.exit = ((code?: number) => {
    closeThenExit(code ?? (process.exitCode as number | undefined));
    // process.exit() never returns; keep callers from running on while the
    // close is in flight.
    return undefined as never;
  }) as ProcessLike["exit"];

  proc.on("SIGINT", () => closeThenExit(130));
  proc.on("SIGTERM", () => closeThenExit(143));
  proc.once("beforeExit", () => {
    void close().catch((err: unknown) =>
      log(`PGlite close failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  });
  return true;
}

/**
 * True inside a Next.js jest-worker child (the dev server's static-paths
 * worker, or a build worker). Next forks one of these for requests to dynamic
 * routes and evaluates the route's module graph in it; opening PGlite there
 * would put a second process on the data directory.
 */
export function isNextWorkerProcess(
  env: Record<string, string | undefined> = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  return Boolean(env.JEST_WORKER_ID) && argv.some((a) => a.includes("jest-worker"));
}
