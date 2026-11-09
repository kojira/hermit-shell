import { APIError, ClientOptions } from "@anthropic-ai/sdk";

/** Chat-only transport policy; leave SDK retries for every non-429 response intact. */
export const fetchWithoutRateLimitRetries: NonNullable<ClientOptions["fetch"]> = async (input, init) => {
  const response = await fetch(input, init);
  if (response.status !== 429) return response;

  const headers = new Headers(response.headers);
  // SDK 0.80 honors this response hint before its status-based retry policy.
  headers.set("x-should-retry", "false");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

export function isRateLimitError(error: unknown): error is APIError {
  if (!(error instanceof APIError)) return false;
  const envelope = error.error as { error?: { type?: unknown } } | undefined;
  return error.status === 429 || envelope?.error?.type === "rate_limit_error";
}

export function rateLimitErrorBody() {
  return {
    message: "Upstream rate limit exceeded",
    type: "rate_limit_error",
    code: "rate_limit_exceeded",
    param: null,
  };
}

/** Accept delta-seconds or the three HTTP-date formats, not Date.parse's loose date syntax. */
export function rateLimitRetryAfter(error: APIError, now = Date.now()): string | undefined {
  const value = error.headers?.get("retry-after");
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value), time = now + seconds * 1000;
    return Number.isSafeInteger(seconds) && Number.isSafeInteger(time) && time <= 8640000000000000 ? value : undefined;
  }
  // asctime has no zone suffix but HTTP dates are always UTC.
  const asctimeFormat = /^\w{3} \w{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;
  const date = new Date(asctimeFormat.test(value) ? `${value} GMT` : value);
  if (!Number.isFinite(date.getTime())) return undefined;
  const canonical = date.toUTCString();
  const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getUTCDay()];
  const obsolete = canonical.replace(/^\w+, (\d+) (\w+) \d{2}(\d{2})/, `${weekday}, $1-$2-$3`);
  const asctime = `${canonical.slice(0, 3)} ${canonical.slice(8, 11)} ${String(date.getUTCDate()).padStart(2, " ")} ${canonical.slice(17, 25)} ${date.getUTCFullYear()}`;
  return [canonical, obsolete, asctime].includes(value) ? value : undefined;
}

/** Only documented, exact subscription quota signals authorize account switching. */
export function classifyExhaustion(error: unknown): "session" | "weekly" | undefined {
  if (!isRateLimitError(error)) return;
  const h = error.headers;
  if (h?.get("anthropic-ratelimit-unified-7d-status") === "rejected") return "weekly";
  if (h?.get("anthropic-ratelimit-unified-status") !== "rejected") return;
  switch (h.get("anthropic-ratelimit-unified-representative-claim")) {
    case "seven_day": return "weekly";
    case "five_hour": return "session";
  }
}

const MAX_TIME = 8640000000000000;
export function retryAfterTime(error: APIError, now = Date.now()): number | undefined {
  const value = rateLimitRetryAfter(error, now);
  if (value === undefined) return;
  let time: number;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) return;
    time = now + seconds * 1000;
  } else {
    const asctime = /^\w{3} \w{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$/;
    time = Date.parse(asctime.test(value) ? `${value} GMT` : value);
  }
  if (!Number.isSafeInteger(time) || Math.abs(time) > MAX_TIME) return;
  return Math.max(now, time);
}
export function providerRetryTime(error: APIError, now = Date.now()): number | undefined {
  const reset = error.headers?.get("anthropic-ratelimit-unified-reset");
  let resetAt: number | undefined;
  if (reset && /^\d+$/.test(reset)) {
    const seconds = Number(reset), ms = seconds * 1000;
    if (Number.isSafeInteger(seconds) && Number.isSafeInteger(ms) && ms <= MAX_TIME && ms > now && ms <= now + 8 * 86400000) resetAt = ms;
  }
  const retryAt = retryAfterTime(error, now);
  if (resetAt === undefined) return retryAt;
  return retryAt === undefined ? resetAt : Math.max(resetAt, retryAt);
}
import type { Observed } from "./accounts";
export function retryObservation(previous: Observed, now = Date.now()): Observed {
  const failureCount = previous.failureCount + 1;
  const minutes = failureCount === 1 ? 15 : failureCount === 2 ? 30 : 60;
  return { ...previous, state: "exhausted", failureCount, retryAt: now + minutes * 60000, retryBasis: "local_probe" };
}
export function exhaustionObservation(error: APIError, reason: "session" | "weekly", previous: Observed, now = Date.now()): Observed {
  const provider = providerRetryTime(error, now);
  const local = retryObservation(previous, now);
  if (provider !== undefined && (previous.state !== "exhausted" || provider > local.retryAt!)) {
    return { state: "exhausted", reason, retryAt: Math.max(now + 1000, provider), retryBasis: "provider", failureCount: previous.failureCount };
  }
  return { ...local, reason };
}
