import { describe, expect, it } from "vitest";
import { signResumeToken, verifyResumeToken } from "@/lib/cohort/resume";
import { classifyInvite, findDuplicateMint } from "@/lib/cohort/invite";
import { joinErrorCopy, SHOWCASE_HINT } from "@/app/join/error/copy";

const SECRET = "test-resume-secret";
const STUDENT = "8f0b0f4e-1a2b-4c3d-9e8f-0a1b2c3d4e5f";
const NOW = new Date("2026-08-25T10:00:00Z");
const LATER = new Date("2026-09-08T10:00:00Z");

function mint(expiresAt = LATER, studentId = STUDENT) {
  return signResumeToken(studentId, expiresAt, SECRET);
}

describe("resume tokens", () => {
  it("round-trips a signed token", () => {
    const result = verifyResumeToken(mint(), { secret: SECRET, now: NOW });
    expect(result).toEqual({ ok: true, studentId: STUDENT, expiresAt: LATER });
  });

  it("rejects a token signed with a different secret", () => {
    const token = signResumeToken(STUDENT, LATER, "some-other-secret");
    expect(verifyResumeToken(token, { secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("rejects a tampered student id", () => {
    const [payload, signature] = mint().split(".");
    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const forged = decoded.replace(STUDENT, "00000000-0000-4000-8000-000000000000");
    const token = `${Buffer.from(forged, "utf8").toString("base64url")}.${signature}`;
    expect(verifyResumeToken(token, { secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("reports expiry separately from invalidity", () => {
    const token = mint(new Date("2026-08-24T10:00:00Z"));
    expect(verifyResumeToken(token, { secret: SECRET, now: NOW })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("treats truncated, empty and malformed tokens as invalid", () => {
    const token = mint();
    for (const bad of [
      "",
      null,
      undefined,
      token.slice(0, token.length - 5),
      token.split(".")[0],
      `${token}.extra`,
      "not-a-token",
    ]) {
      expect(verifyResumeToken(bad, { secret: SECRET, now: NOW })).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
  });
});

describe("classifyInvite", () => {
  const base = {
    cohortSlug: "ba-2026",
    usedAt: null as Date | null,
    expiresAt: new Date("2026-09-20T10:00:00Z"),
  };

  it("accepts a fresh invite whose slug matches the URL", () => {
    expect(classifyInvite(base, "ba-2026", NOW)).toBeNull();
    expect(classifyInvite(base, undefined, NOW)).toBeNull();
  });

  it("reports an unknown token as invalid, not used", () => {
    expect(classifyInvite(null, "ba-2026", NOW)).toBe("invalid");
    expect(classifyInvite(undefined, "ba-2026", NOW)).toBe("invalid");
  });

  it("reports a slug that does not match the token's cohort as invalid", () => {
    expect(classifyInvite(base, "wrong-cohort", NOW)).toBe("invalid");
  });

  it("distinguishes used from expired", () => {
    expect(classifyInvite({ ...base, usedAt: new Date("2026-08-01T00:00:00Z") }, "ba-2026", NOW)).toBe(
      "used",
    );
    expect(
      classifyInvite({ ...base, expiresAt: new Date("2026-08-01T00:00:00Z") }, "ba-2026", NOW),
    ).toBe("expired");
  });

  it("expires an invite at exactly expiresAt, matching the overview's buckets", () => {
    expect(classifyInvite({ ...base, expiresAt: NOW }, "ba-2026", NOW)).toBe("expired");
    expect(
      classifyInvite({ ...base, expiresAt: new Date(NOW.getTime() + 1000) }, "ba-2026", NOW),
    ).toBeNull();
  });

  it("prefers 'used' over 'expired' for an invite that is both", () => {
    expect(
      classifyInvite(
        { ...base, usedAt: new Date("2026-07-01T00:00:00Z"), expiresAt: new Date("2026-08-01T00:00:00Z") },
        "ba-2026",
        NOW,
      ),
    ).toBe("used");
  });

  it("refuses a live invite once the cohort is archived", () => {
    expect(
      classifyInvite(
        { ...base, cohortArchivedAt: new Date("2026-08-20T00:00:00Z") },
        "ba-2026",
        NOW,
      ),
    ).toBe("cohort-closed");
  });

  it("keeps the more specific reason for a spent or expired link in a closed cohort", () => {
    const closed = { ...base, cohortArchivedAt: new Date("2026-08-20T00:00:00Z") };
    expect(classifyInvite({ ...closed, usedAt: new Date("2026-08-01T00:00:00Z") }, "ba-2026", NOW)).toBe(
      "used",
    );
    expect(
      classifyInvite({ ...closed, expiresAt: new Date("2026-08-01T00:00:00Z") }, "ba-2026", NOW),
    ).toBe("expired");
  });

  it("still accepts an invite when the cohort is not archived", () => {
    expect(classifyInvite({ ...base, cohortArchivedAt: null }, "ba-2026", NOW)).toBeNull();
  });
});

describe("findDuplicateMint", () => {
  // A fresh invite minted moments before "now": the shape createInvite reads
  // back for the cohort's newest invite.
  const fresh = {
    token: "tok-abc",
    expiresAt: new Date("2026-09-24T10:00:00Z"),
    usedAt: null as Date | null,
    revokedAt: null as Date | null,
    createdAt: new Date("2026-08-25T09:59:59.900Z"),
  };

  it("hands back an invite minted within the window instead of a new one", () => {
    expect(findDuplicateMint(fresh, NOW)).toEqual({
      token: "tok-abc",
      expiresAt: fresh.expiresAt,
    });
  });

  it("mints fresh when the cohort has no invites yet", () => {
    expect(findDuplicateMint(null, NOW)).toBeNull();
    expect(findDuplicateMint(undefined, NOW)).toBeNull();
  });

  it("mints fresh once the newest invite is older than the window", () => {
    expect(
      findDuplicateMint({ ...fresh, createdAt: new Date("2026-08-25T09:59:57Z") }, NOW),
    ).toBeNull();
  });

  it("still counts an invite whose createdAt sits ahead of now (clock skew)", () => {
    expect(
      findDuplicateMint({ ...fresh, createdAt: new Date("2026-08-25T10:00:00.150Z") }, NOW),
    ).not.toBeNull();
  });

  it("never hands back a redeemed, revoked or expired invite", () => {
    expect(
      findDuplicateMint({ ...fresh, usedAt: new Date("2026-08-25T09:59:59.950Z") }, NOW),
    ).toBeNull();
    expect(
      findDuplicateMint({ ...fresh, revokedAt: new Date("2026-08-25T09:59:59.950Z") }, NOW),
    ).toBeNull();
    expect(findDuplicateMint({ ...fresh, expiresAt: NOW }, NOW)).toBeNull();
  });
});

describe("joinErrorCopy", () => {
  it("points capacity limits at the read-only reviewer sign-in", () => {
    for (const r of ["sandbox-ip-limit", "sandbox-full", "usage-limit"]) {
      expect(joinErrorCopy(r).showcaseHint).toBe(true);
    }
    expect(joinErrorCopy("used").showcaseHint).toBeUndefined();
    expect(SHOWCASE_HINT.linkText).toBe("read-only reviewer sign-in");
    expect(SHOWCASE_HINT.href).toBe("/admin/login");
    expect(`${SHOWCASE_HINT.before}${SHOWCASE_HINT.linkText}${SHOWCASE_HINT.after}`).toBe(
      "You can still view the showcase cohort with the read-only reviewer sign-in, which needs no seat.",
    );
  });

  it("gives each reason its own message", () => {
    const titles = [
      "missing",
      "invalid",
      "used",
      "expired",
      "cohort-closed",
      "resume-expired",
      "resume-invalid",
    ].map(
      (r) => joinErrorCopy(r).title,
    );
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("says who closed the cohort when an invite lands on an archived one", () => {
    expect(joinErrorCopy("cohort-closed").description).toContain(
      "closed by the instructor",
    );
  });

  it("points a used invite at the resume link", () => {
    expect(joinErrorCopy("used").description).toContain("resume link");
  });

  it("falls back to the generic bad-link message, never to 'already used'", () => {
    for (const reason of [undefined, null, "", "banana", "USED", "__proto__", "toString"]) {
      const copy = joinErrorCopy(reason);
      expect(copy).toEqual(joinErrorCopy("invalid"));
      expect(copy.title).not.toContain("already been used");
    }
  });
});
