import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  isNextWorkerProcess,
  makePgliteCloser,
  registerPgliteShutdown,
  type PgliteLike,
  type ProcessLike,
} from "@/lib/db/pglite-lifecycle";

function stubClient() {
  const calls: string[] = [];
  const client: PgliteLike & { closed: boolean } = {
    closed: false,
    exec: vi.fn(async (q: string) => {
      if (client.closed) throw new Error("PGlite is closed");
      calls.push(q);
    }),
    close: vi.fn(async () => {
      if (client.closed) throw new Error("already closed");
      calls.push("close");
      client.closed = true;
    }),
  };
  return { client, calls };
}

function stubProcess() {
  const emitter = new EventEmitter();
  const exit = vi.fn();
  const proc = Object.assign(emitter, { exit }) as unknown as ProcessLike & EventEmitter;
  return { proc, exit };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("makePgliteCloser", () => {
  it("checkpoints then closes, once, however often it is called", async () => {
    const { client, calls } = stubClient();
    const close = makePgliteCloser(client);
    const [a, b] = [close(), close()];
    expect(a).toBe(b);
    await Promise.all([a, b, close()]);
    expect(calls).toEqual(["CHECKPOINT", "close"]);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("still closes when CHECKPOINT fails", async () => {
    const { client, calls } = stubClient();
    client.exec = vi.fn(async () => {
      throw new Error("boom");
    });
    const log = vi.fn();
    await makePgliteCloser(client, log)();
    expect(calls).toEqual(["close"]);
    expect(log).toHaveBeenCalledOnce();
  });

  it("does nothing for a client that is already closed", async () => {
    const { client } = stubClient();
    client.closed = true;
    await makePgliteCloser(client)();
    expect(client.exec).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
  });

  it("closes a real in-memory PGlite idempotently and rejects later queries", async () => {
    const pg = new PGlite();
    await pg.exec("create table t (x int); insert into t values (1)");
    const close = makePgliteCloser(pg);
    await Promise.all([close(), close()]);
    await close();
    expect(pg.closed).toBe(true);
    await expect(pg.query("select 1")).rejects.toThrow();
  });
});

describe("registerPgliteShutdown", () => {
  it("installs its handlers once per process", () => {
    const { proc } = stubProcess();
    const close = vi.fn(async () => {});
    expect(registerPgliteShutdown(close, proc)).toBe(true);
    expect(registerPgliteShutdown(close, proc)).toBe(false);
    expect(proc.listenerCount("SIGINT")).toBe(1);
    expect(proc.listenerCount("SIGTERM")).toBe(1);
    expect(proc.listenerCount("beforeExit")).toBe(1);
  });

  it("closes before exiting on SIGINT (130) and SIGTERM (143)", async () => {
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      const { proc, exit } = stubProcess();
      const order: string[] = [];
      exit.mockImplementation(() => order.push("exit"));
      const close = vi.fn(async () => {
        order.push("close");
      });
      registerPgliteShutdown(close, proc);
      proc.emit(signal);
      proc.emit(signal); // a repeated signal (shell plus parent) must not exit twice
      await flush();
      expect(order).toEqual(["close", "exit"]);
      expect(exit).toHaveBeenCalledWith(code);
    }
  });

  it("makes process.exit wait for the close", async () => {
    const { proc, exit } = stubProcess();
    let release!: () => void;
    const close = vi.fn(() => new Promise<void>((r) => (release = r)));
    registerPgliteShutdown(close, proc);
    proc.exit(0);
    await flush();
    expect(close).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    release();
    await flush();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits even when the close fails", async () => {
    const { proc, exit } = stubProcess();
    const log = vi.fn();
    registerPgliteShutdown(async () => Promise.reject(new Error("nope")), proc, log);
    proc.emit("SIGTERM");
    await flush();
    await flush();
    expect(log).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("closes on beforeExit without forcing an exit", async () => {
    const { proc, exit } = stubProcess();
    const close = vi.fn(async () => {});
    registerPgliteShutdown(close, proc);
    proc.emit("beforeExit", 0);
    await flush();
    expect(close).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("isNextWorkerProcess", () => {
  it("recognises a Next.js jest-worker child and nothing else", () => {
    const workerArgv = ["node", "/x/next/dist/compiled/jest-worker/processChild.js"];
    expect(isNextWorkerProcess({ JEST_WORKER_ID: "1" }, workerArgv)).toBe(true);
    expect(isNextWorkerProcess({}, workerArgv)).toBe(false);
    expect(isNextWorkerProcess({ JEST_WORKER_ID: "1" }, ["node", "next-server"])).toBe(false);
  });
});
