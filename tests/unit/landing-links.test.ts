import { describe, expect, it } from "vitest";
import { externalLinks, PUBLIC_SOURCE_URL } from "@/lib/landing-links";

const SOURCE = { label: "Source code", href: PUBLIC_SOURCE_URL };

describe("landing page paper, source and video links", () => {
  it("shows only the source-code link when the variables are unset", () => {
    expect(PUBLIC_SOURCE_URL).toBe("https://github.com/kwanhui/public-dsAgentSim-WSDM2027");
    expect(externalLinks({})).toEqual([SOURCE]);
  });

  it("shows each link that is configured", () => {
    expect(
      externalLinks({
        NEXT_PUBLIC_PAPER_URL: "https://example.org/paper.pdf",
        NEXT_PUBLIC_VIDEO_URL: " https://youtu.be/abc ",
      }),
    ).toEqual([
      { label: "Paper", href: "https://example.org/paper.pdf" },
      SOURCE,
      { label: "Demo video", href: "https://youtu.be/abc" },
    ]);
  });

  it("takes another source URL from NEXT_PUBLIC_SOURCE_URL", () => {
    expect(externalLinks({ NEXT_PUBLIC_SOURCE_URL: "https://example.org/fork" })).toEqual([
      { label: "Source code", href: "https://example.org/fork" },
    ]);
  });

  it("ignores values that are not http(s) URLs", () => {
    expect(externalLinks({ NEXT_PUBLIC_VIDEO_URL: "javascript:alert(1)" })).toEqual([SOURCE]);
    expect(externalLinks({ NEXT_PUBLIC_PAPER_URL: "not a url" })).toEqual([SOURCE]);
    expect(externalLinks({ NEXT_PUBLIC_SOURCE_URL: "javascript:alert(1)" })).toEqual([SOURCE]);
  });
});
