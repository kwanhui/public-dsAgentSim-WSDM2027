import { describe, expect, it } from "vitest";
import { compare, hashSync } from "bcryptjs";
import {
  envLocalLine,
  MIN_PASSWORD_LENGTH,
  parsePasswordArgs,
  passwordProblem,
} from "@/scripts/password-hash";

describe("change-admin-password arguments", () => {
  it("prints locally for the instructor by default", () => {
    expect(parsePasswordArgs([])).toEqual({ target: "ADMIN_PASSWORD_HASH", vercel: false });
  });

  it("needs --vercel to push, and --reviewer to target the reviewer hash", () => {
    expect(parsePasswordArgs(["--vercel"])).toEqual({ target: "ADMIN_PASSWORD_HASH", vercel: true });
    expect(parsePasswordArgs(["--reviewer"])).toEqual({ target: "REVIEWER_PASSWORD_HASH", vercel: false });
  });

  it("refuses anything else, including a password on the command line", () => {
    expect(parsePasswordArgs(["hunter2hunter2"])).toMatchObject({ error: expect.stringMatching(/never from the command line/) });
  });
});

describe("password rules", () => {
  it("requires at least 12 characters", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    expect(passwordProblem("demo1234")).toMatch(/12 characters/);
    expect(passwordProblem("a-long-enough-pass")).toBeNull();
  });

  it("rejects surrounding spaces", () => {
    expect(passwordProblem(" twelve-chars-ok ")).toMatch(/spaces/);
  });
});

describe("envLocalLine", () => {
  it("escapes every $ so dotenv-expand leaves the hash intact", async () => {
    const h = hashSync("a-long-enough-pass", 4);
    const line = envLocalLine("ADMIN_PASSWORD_HASH", h);
    expect(line.startsWith("ADMIN_PASSWORD_HASH=\\$2")).toBe(true);
    expect(line).not.toMatch(/[^\\]\$/);
    const restored = line.slice("ADMIN_PASSWORD_HASH=".length).replace(/\\\$/g, "$");
    expect(await compare("a-long-enough-pass", restored)).toBe(true);
  });
});
