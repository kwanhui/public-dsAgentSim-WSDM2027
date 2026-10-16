/**
 * Absolute origins for links handed to learners (invite URLs, resume URLs).
 *
 * These links leave the app, so a wrong origin is a dead link rather than a
 * visible error. AUTH_URL is the override for setups behind a rewriting proxy,
 * but a value left at http://localhost:3000 from local setup made tunnel and
 * LAN demos hand out links pointing at the instructor's own machine. When the
 * request arrived on a non-local host, the request's own origin is the one the
 * instructor is actually using, so it wins over a local AUTH_URL.
 */

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function isLocalHost(host: string): boolean {
  return LOCAL_HOST.test(host.trim().toLowerCase());
}

/** An absolute http(s) origin with any trailing slashes removed, or null. */
export function normalizeOrigin(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !/^https?:\/\/[^/\s]+/.test(trimmed)) return null;
  return trimmed.replace(/\/+$/, "");
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

export interface BaseUrlInput {
  /** AUTH_URL, or whatever the deployment configured. */
  configured?: string | null;
  /** The request's Host (or X-Forwarded-Host) header. */
  host?: string | null;
  /** X-Forwarded-Proto, when a proxy set one. */
  forwardedProto?: string | null;
}

export function resolveBaseUrl({ configured, host, forwardedProto }: BaseUrlInput): string | null {
  const rawHost = host?.trim() ?? "";
  const requestHost = rawHost && /^[^/\s]+$/.test(rawHost) ? rawHost : null;
  const requestOrigin = requestHost
    ? `${forwardedProto ?? (isLocalHost(requestHost) ? "http" : "https")}://${requestHost}`
    : null;

  const configuredOrigin = normalizeOrigin(configured);
  if (!configuredOrigin) return requestOrigin;

  const configuredHost = hostOf(configuredOrigin);
  if (requestHost && requestOrigin && configuredHost && isLocalHost(configuredHost) && !isLocalHost(requestHost)) {
    return requestOrigin;
  }
  return configuredOrigin;
}
