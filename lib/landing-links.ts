// Links to the paper, the source code and the demo video on the landing
// page. The paper and video links show only when their NEXT_PUBLIC_*
// variable holds an http(s) URL, so a deployment without them shows neither.
// The source-code link always shows: it points to the public repository
// unless NEXT_PUBLIC_SOURCE_URL holds another http(s) URL (a fork's own).

export const PUBLIC_SOURCE_URL = "https://github.com/kwanhui/public-dsAgentSim-WSDM2027";

export interface ExternalLink {
  label: string;
  href: string;
}

function validUrl(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? trimmed : null;
  } catch {
    return null;
  }
}

export function externalLinks(env: Record<string, string | undefined>): ExternalLink[] {
  const links: ExternalLink[] = [];
  const paper = validUrl(env.NEXT_PUBLIC_PAPER_URL);
  const video = validUrl(env.NEXT_PUBLIC_VIDEO_URL);
  const source = validUrl(env.NEXT_PUBLIC_SOURCE_URL) ?? PUBLIC_SOURCE_URL;
  if (paper) links.push({ label: "Paper", href: paper });
  links.push({ label: "Source code", href: source });
  if (video) links.push({ label: "Demo video", href: video });
  return links;
}
