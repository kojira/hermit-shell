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
export function rateLimitRetryAfter(error: APIError): string | undefined {
  const value = error.headers?.get("retry-after");
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return value;
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
