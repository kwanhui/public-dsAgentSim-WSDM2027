import { describe, expect, it } from "vitest";
import { isLocalHost, normalizeOrigin, resolveBaseUrl } from "@/lib/cohort/base-url";

describe("normalizeOrigin", () => {
  it("keeps an absolute origin and drops trailing slashes", () => {
    expect(normalizeOrigin("https://app.example.edu/")).toBe("https://app.example.edu");
    expect(normalizeOrigin("  http://localhost:3000  ")).toBe("http://localhost:3000");
  });

  it("rejects anything that is not an http(s) origin", () => {
    for (const bad of ["", "  ", null, undefined, "app.example.edu", "ftp://x"]) {
      expect(normalizeOrigin(bad)).toBeNull();
    }
  });
});

describe("isLocalHost", () => {
  it("covers the loopback names with and without a port", () => {
    for (const host of ["localhost", "localhost:3000", "127.0.0.1", "127.0.0.1:3000", "[::1]"]) {
      expect(isLocalHost(host)).toBe(true);
    }
    expect(isLocalHost("demo.trycloudflare.com")).toBe(false);
    expect(isLocalHost("192.168.1.20:3000")).toBe(false);
  });
});

describe("resolveBaseUrl", () => {
  it("uses a configured origin for an ordinary deployment", () => {
    expect(
      resolveBaseUrl({ configured: "https://app.example.edu", host: "app.example.edu" }),
    ).toBe("https://app.example.edu");
  });

  it("prefers a configured proxy origin over the request host", () => {
    expect(
      resolveBaseUrl({ configured: "https://class.example.edu", host: "internal-7.fly.dev" }),
    ).toBe("https://class.example.edu");
  });

  it("ignores a localhost AUTH_URL when the request came in on another host", () => {
    expect(
      resolveBaseUrl({
        configured: "http://localhost:3000",
        host: "quiet-owl.trycloudflare.com",
        forwardedProto: "https",
      }),
    ).toBe("https://quiet-owl.trycloudflare.com");
    expect(
      resolveBaseUrl({ configured: "http://localhost:3000", host: "192.168.1.20:3000" }),
    ).toBe("https://192.168.1.20:3000");
  });

  it("keeps a localhost AUTH_URL for a local request", () => {
    expect(
      resolveBaseUrl({ configured: "http://localhost:3000", host: "localhost:3000" }),
    ).toBe("http://localhost:3000");
  });

  it("derives the origin from the request when nothing is configured", () => {
    expect(resolveBaseUrl({ configured: undefined, host: "localhost:3000" })).toBe(
      "http://localhost:3000",
    );
    expect(resolveBaseUrl({ configured: "", host: "app.example.edu" })).toBe(
      "https://app.example.edu",
    );
  });

  it("returns null when there is neither a configured origin nor a usable host", () => {
    expect(resolveBaseUrl({ configured: null, host: null })).toBeNull();
    expect(resolveBaseUrl({ configured: null, host: "not a host/" })).toBeNull();
  });
});
