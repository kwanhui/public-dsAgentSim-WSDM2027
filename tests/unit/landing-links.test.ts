import { describe, expect, it } from "vitest";
import { externalLinks } from "@/lib/landing-links";

describe("landing page paper and video links", () => {
  it("shows nothing when the variables are unset", () => {
    expect(externalLinks({})).toEqual([]);
  });

  it("shows each link that is configured", () => {
    expect(
      externalLinks({
        NEXT_PUBLIC_PAPER_URL: "https://example.org/paper.pdf",
        NEXT_PUBLIC_VIDEO_URL: " https://youtu.be/abc ",
      }),
    ).toEqual([
      { label: "Paper", href: "https://example.org/paper.pdf" },
      { label: "Demo video", href: "https://youtu.be/abc" },
    ]);
  });

  it("ignores values that are not http(s) URLs", () => {
    expect(externalLinks({ NEXT_PUBLIC_VIDEO_URL: "javascript:alert(1)" })).toEqual([]);
    expect(externalLinks({ NEXT_PUBLIC_PAPER_URL: "not a url" })).toEqual([]);
  });
});
