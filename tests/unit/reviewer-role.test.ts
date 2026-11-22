import { describe, expect, it } from "vitest";
import { hashSync, compare } from "bcryptjs";
import { matchCredentials } from "@/lib/auth/credentials";
import { canWrite, isReviewer, roleOf } from "@/lib/auth/roles";

const base: NodeJS.ProcessEnv = { NODE_ENV: "test" };
// Cost 4 keeps the test fast; the scheme is the same bcrypt the scripts use.
const adminHash = hashSync("instructor-password", 4);
const reviewerHash = hashSync("reviewer-password", 4);

describe("matchCredentials", () => {
  const env = { ...base, ADMIN_PASSWORD_HASH: adminHash, REVIEWER_PASSWORD_HASH: reviewerHash };

  it("signs the instructor in with the instructor role", async () => {
    expect(await matchCredentials("admin", "instructor-password", compare, env)).toEqual({
      role: "instructor",
      email: "admin",
    });
  });

  it("signs the reviewer in with the reviewer role", async () => {
    expect(await matchCredentials("Reviewer ", "reviewer-password", compare, env)).toEqual({
      role: "reviewer",
      email: "reviewer",
    });
  });

  it("does not let one account's password open the other", async () => {
    expect(await matchCredentials("reviewer", "instructor-password", compare, env)).toBeNull();
    expect(await matchCredentials("admin", "reviewer-password", compare, env)).toBeNull();
  });

  it("honours a custom reviewer username", async () => {
    const custom = { ...env, REVIEWER_USERNAME: "wsdm" };
    expect(await matchCredentials("wsdm", "reviewer-password", compare, custom)).toMatchObject({
      role: "reviewer",
    });
    expect(await matchCredentials("reviewer", "reviewer-password", compare, custom)).toBeNull();
  });

  it("disables the reviewer while its hash is unset", async () => {
    const noReviewer = { ...base, ADMIN_PASSWORD_HASH: adminHash };
    expect(await matchCredentials("reviewer", "reviewer", compare, noReviewer)).toBeNull();
  });

  it("accepts the fixed demo passwords only under DEMO_MODE without hashes", async () => {
    const demo = { ...base, DEMO_MODE: "1", LLM_PROVIDER: "mock" };
    expect(await matchCredentials("admin", "demo", compare, demo)).toMatchObject({ role: "instructor" });
    expect(await matchCredentials("reviewer", "reviewer", compare, demo)).toMatchObject({
      role: "reviewer",
    });
    expect(await matchCredentials("reviewer", "reviewer", compare, base)).toBeNull();
    // A configured hash wins over the demo password even in demo mode.
    expect(
      await matchCredentials("reviewer", "reviewer", compare, { ...demo, REVIEWER_PASSWORD_HASH: reviewerHash }),
    ).toBeNull();
  });

  it("never lets a reviewer username shadow the instructor account", async () => {
    const clash = { ...env, REVIEWER_USERNAME: "admin" };
    expect(await matchCredentials("admin", "instructor-password", compare, clash)).toMatchObject({
      role: "instructor",
    });
    expect(await matchCredentials("admin", "reviewer-password", compare, clash)).toBeNull();
  });

  it("rejects empty input", async () => {
    expect(await matchCredentials("", "x", compare, env)).toBeNull();
    expect(await matchCredentials("admin", undefined, compare, env)).toBeNull();
  });
});

describe("roles", () => {
  it("reads the role from the session", () => {
    expect(roleOf(null)).toBeNull();
    expect(roleOf({ user: { role: "reviewer" } })).toBe("reviewer");
    expect(roleOf({ user: { role: "instructor" } })).toBe("instructor");
    // Sessions minted before roles existed carry none; they belong to the
    // instructor, the only account there was.
    expect(roleOf({ user: {} })).toBe("instructor");
  });

  it("lets only the instructor write", () => {
    expect(canWrite({ user: { role: "instructor" } })).toBe(true);
    expect(canWrite({ user: { role: "reviewer" } })).toBe(false);
    expect(canWrite(null)).toBe(false);
    expect(isReviewer({ user: { role: "reviewer" } })).toBe(true);
  });
});
