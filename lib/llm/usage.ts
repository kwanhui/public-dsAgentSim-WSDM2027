// Token usage of a model call that failed. The AI SDK attaches the usage of
// the response it could not use to NoObjectGeneratedError (a structured call
// whose output did not parse or validate), and wraps retried failures in a
// RetryError that lists every attempt's error. These calls were once
// not metered, so the spend guard and the cost figures missed them.
// Dependency-free and pure.

export interface CallUsage {
  promptTokens: number;
  completionTokens: number;
}

// Set on an error whose usage has already been written to an event, so a
// caller further up that logs the same error does not count it twice.
const METERED = Symbol.for("dsagentsim.usage.metered");

export function markMetered(err: unknown): void {
  if (err && typeof err === "object") (err as Record<symbol, unknown>)[METERED] = true;
}

export function isMetered(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as Record<symbol, unknown>)[METERED]);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * The usage carried by an error from a model call, summed over nested
 * attempts (RetryError.errors) and causes; zero when none is attached or
 * when the error was already metered.
 */
export function usageFromError(err: unknown, depth = 0): CallUsage {
  const zero = { promptTokens: 0, completionTokens: 0 };
  if (!err || typeof err !== "object" || depth > 4 || isMetered(err)) return zero;
  const e = err as { usage?: unknown; errors?: unknown; cause?: unknown };
  if (e.usage && typeof e.usage === "object") {
    const u = e.usage as { promptTokens?: unknown; completionTokens?: unknown };
    return { promptTokens: num(u.promptTokens), completionTokens: num(u.completionTokens) };
  }
  if (Array.isArray(e.errors)) {
    return e.errors.reduce<CallUsage>((acc, inner) => addUsage(acc, usageFromError(inner, depth + 1)), zero);
  }
  if (e.cause) return usageFromError(e.cause, depth + 1);
  return zero;
}

export function addUsage(a: CallUsage | undefined, b: CallUsage | undefined): CallUsage {
  return {
    promptTokens: (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0),
    completionTokens: (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0),
  };
}

/** The error's class name and a trimmed message, for a failure event. */
export function describeCallError(err: unknown, maxChars = 300): { errorClass: string; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  return { errorClass: err instanceof Error ? err.name : typeof err, message: message.slice(0, maxChars) };
}
