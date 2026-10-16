// Links to the paper and the demo video on the landing page. Each shows only
// when its NEXT_PUBLIC_* variable holds an http(s) URL, so a deployment
// without them shows neither.

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
  if (paper) links.push({ label: "Paper", href: paper });
  if (video) links.push({ label: "Demo video", href: video });
  return links;
}
