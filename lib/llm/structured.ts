// One structured model call with two recoveries for a schema failure.
//
// Anthropic models in tool mode sometimes return the right object wrapped in
// an extra key, e.g. {"jsonData": {"scores": [...]}}. The AI SDK then throws
// NoObjectGeneratedError (TypeValidationError underneath) although the object
// inside is valid. generateObjectRobust first tries to unwrap such a response
// from the error; failing that, it retries the call once with a short note in
// the system prompt. When the retry also fails, it rethrows the first error
// so the caller's error handling applies, with the usage of both attempts on
// it so the failure metering counts every call.
//
// Every structured call site goes through this helper. The "ai" module is
// imported only for generateObject, and the error is recognised by name, so
// tests that mock "ai" with a bare generateObject still exercise this path.

import { generateObject, type CoreMessage, type LanguageModel } from "ai";
import type { z } from "zod";
import { addUsage, usageFromError, type CallUsage } from "./usage";

export const STRUCTURED_UNWRAPPED_EVENT = "structured_unwrapped";
export const STRUCTURED_RETRY_EVENT = "structured_retry";

export const STRUCTURED_RETRY_NOTE =
  "Return the object with the exact top-level fields of the schema; do not wrap it in another key.";

export interface RobustObjectOptions<S extends z.ZodTypeAny> {
  model: LanguageModel;
  schema: S;
  system?: string;
  prompt?: string;
  messages?: CoreMessage[];
  maxTokens?: number;
  temperature?: number;
  experimental_repairText?: (input: {
    text: string;
    error: unknown;
  }) => Promise<string | null>;
}

export interface RobustObjectMeta {
  // Names the call in the warning log, e.g. "rubric.judge".
  callSite: string;
  // Retry once with the unwrap note after a schema failure. Off where the
  // caller already retries the whole call (the persona paths).
  retry?: boolean;
  // Where warnings go; console.warn by default.
  warn?: (line: string) => void;
}

export interface RobustObjectResult<T> {
  object: T;
  // Summed over every attempt this helper made, failed ones included.
  usage: CallUsage & { totalTokens?: number };
  response?: { modelId?: string; [k: string]: unknown };
  finishReason?: string;
  // How the object was obtained.
  recovery: "none" | "unwrapped" | "retried";
}

export function isNoObjectGeneratedError(err: unknown): boolean {
  return err instanceof Error && err.name === "AI_NoObjectGeneratedError";
}

function parseJson(text: unknown): unknown {
  if (typeof text !== "string" || !text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The schema-valid object inside a single-key wrapper, found in the text or
 * value a NoObjectGeneratedError carries; null when there is none.
 */
export function unwrapFromError<S extends z.ZodTypeAny>(
  err: unknown,
  schema: S,
): { object: z.infer<S>; key: string } | null {
  if (!err || typeof err !== "object") return null;
  const e = err as {
    text?: unknown;
    value?: unknown;
    cause?: { value?: unknown };
  };
  const candidates = [parseJson(e.text), e.value, e.cause?.value];
  for (const c of candidates) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    const keys = Object.keys(c);
    if (keys.length !== 1) continue;
    const parsed = schema.safeParse((c as Record<string, unknown>)[keys[0]]);
    if (parsed.success) return { object: parsed.data, key: keys[0] };
  }
  return null;
}

function withUsage(err: unknown, usage: CallUsage): void {
  if (!err || typeof err !== "object") return;
  try {
    Object.defineProperty(err, "usage", {
      value: {
        ...usage,
        totalTokens: usage.promptTokens + usage.completionTokens,
      },
      configurable: true,
      enumerable: true,
      writable: true,
    });
  } catch {
    // A frozen error keeps its own usage.
  }
}

function logLine(
  meta: RobustObjectMeta,
  event: string,
  detail: Record<string, unknown>,
): void {
  (meta.warn ?? console.warn)(
    JSON.stringify({
      level: "warn",
      event,
      callSite: meta.callSite,
      ...detail,
    }),
  );
}

function totals(u: CallUsage): CallUsage & { totalTokens: number } {
  return { ...u, totalTokens: u.promptTokens + u.completionTokens };
}

export async function generateObjectRobust<S extends z.ZodTypeAny>(
  options: RobustObjectOptions<S>,
  meta: RobustObjectMeta,
): Promise<RobustObjectResult<z.infer<S>>> {
  const call = (opts: RobustObjectOptions<S>) =>
    (
      generateObject as unknown as (o: RobustObjectOptions<S>) => Promise<{
        object: z.infer<S>;
        usage?: CallUsage;
        response?: { modelId?: string };
        finishReason?: string;
      }>
    )(opts);

  let first: unknown;
  try {
    const r = await call(options);
    return {
      object: r.object,
      usage: totals(addUsage(r.usage, undefined)),
      response: r.response,
      finishReason: r.finishReason,
      recovery: "none",
    };
  } catch (err) {
    if (!isNoObjectGeneratedError(err)) throw err;
    first = err;
  }

  const firstUsage = usageFromError(first);
  const unwrapped = unwrapFromError(first, options.schema);
  if (unwrapped) {
    logLine(meta, STRUCTURED_UNWRAPPED_EVENT, { wrapperKey: unwrapped.key });
    const e = first as {
      response?: { modelId?: string };
      finishReason?: string;
    };
    return {
      object: unwrapped.object,
      usage: totals(firstUsage),
      response: e.response,
      finishReason: e.finishReason,
      recovery: "unwrapped",
    };
  }

  if (meta.retry === false) throw first;

  logLine(meta, STRUCTURED_RETRY_EVENT, {
    message: (first as Error).message.slice(0, 200),
  });
  const system = options.system
    ? `${options.system}\n\n${STRUCTURED_RETRY_NOTE}`
    : STRUCTURED_RETRY_NOTE;
  try {
    const r = await call({ ...options, system });
    return {
      object: r.object,
      usage: totals(addUsage(firstUsage, r.usage)),
      response: r.response,
      finishReason: r.finishReason,
      recovery: "retried",
    };
  } catch (second) {
    const secondUsage = usageFromError(second);
    const again = isNoObjectGeneratedError(second)
      ? unwrapFromError(second, options.schema)
      : null;
    if (again) {
      logLine(meta, STRUCTURED_UNWRAPPED_EVENT, {
        wrapperKey: again.key,
        attempt: 2,
      });
      const e = second as {
        response?: { modelId?: string };
        finishReason?: string;
      };
      return {
        object: again.object,
        usage: totals(addUsage(firstUsage, secondUsage)),
        response: e.response,
        finishReason: e.finishReason,
        recovery: "unwrapped",
      };
    }
    withUsage(first, addUsage(firstUsage, secondUsage));
    throw first;
  }
}
