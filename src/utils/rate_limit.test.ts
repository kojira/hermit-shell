import assert from "node:assert/strict";
import test from "node:test";
import { APIError } from "@anthropic-ai/sdk";
import { classifyExhaustion, providerRetryTime, exhaustionObservation, rateLimitRetryAfter } from "./rate_limit";
const now = 1800000000000;
function error(headers: Record<string, string>, status = 429, type = "rate_limit_error") {
  return new APIError(status, { error: { type } }, "fixture", new Headers(headers));
}
test("quota classification requires APIError, rate-limit envelope and exact rejected/claim values", () => {
  assert.equal(classifyExhaustion({ status: 429 }), undefined);
  assert.equal(classifyExhaustion(error({})), undefined);
  assert.equal(classifyExhaustion(error({ "Anthropic-RateLimit-Unified-7d-Status": "rejected" })), "weekly");
  for (const [claim, expected] of [["five_hour", "session"], ["seven_day", "weekly"], ["other", undefined], ["Five_Hour", undefined]] as const) {
    assert.equal(classifyExhaustion(error({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-representative-claim": claim })), expected);
  }
  assert.equal(classifyExhaustion(error({ "anthropic-ratelimit-unified-7d-status": "Rejected" })), undefined);
  assert.equal(classifyExhaustion(error({ "anthropic-ratelimit-unified-7d-status": "rejected" }, 500, "api_error")), undefined);
  assert.equal(classifyExhaustion(error({ "anthropic-ratelimit-unified-7d-status": "rejected" }, 400)), "weekly");
  assert.equal(classifyExhaustion(error({ "anthropic-ratelimit-unified-7d-status": "rejected", "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-representative-claim": "five_hour" })), "weekly");
});
test("provider times accept bounded integer reset seconds and safe Retry-After, choosing the later", () => {
  assert.equal(providerRetryTime(error({ "anthropic-ratelimit-unified-reset": String(now / 1000 + 10), "retry-after": "20" }), now), now + 20000);
  for (const value of [String(now / 1000), String(now / 1000 + 8 * 86400 + 1), "1.5", "-1", "9007199254740992", "tomorrow"]) {
    assert.equal(providerRetryTime(error({ "anthropic-ratelimit-unified-reset": value }), now), undefined);
  }
  assert.equal(providerRetryTime(error({ "retry-after": "0" }), now), now);
  assert.equal(providerRetryTime(error({ "retry-after": new Date(now - 1000).toUTCString() }), now), now);
  assert.equal(providerRetryTime(error({ "retry-after": new Date(now + 1000).toUTCString() }), now), now + 1000);
  assert.equal(rateLimitRetryAfter(error({ "retry-after": "99999999999999999" }), now), undefined);
});
test("quota observations retain provider timing without inventing a cooldown", () => {
  assert.deepEqual(exhaustionObservation(error({}), "session", now), {
    state: "exhausted", reason: "session", retryAt: null, retryBasis: null, failureCount: 0,
  });
  const observed = exhaustionObservation(error({ "retry-after": "7200" }), "weekly", now);
  assert.equal(observed.retryAt, now + 7200000); assert.equal(observed.retryBasis, "provider");
});
