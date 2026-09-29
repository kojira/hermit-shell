import assert from "node:assert/strict";
import test from "node:test";
import { resolveTemperature } from "./convert";

test("drops temperature for models that reject sampling parameters", () => {
  assert.equal(resolveTemperature("claude-sonnet-5-5", 0.7), undefined);
  assert.equal(resolveTemperature("claude-opus-5-5", 0.7), undefined);
});

test("keeps temperature for models that accept it", () => {
  assert.equal(resolveTemperature("claude-sonnet-4-6", 0.7), 0.7);
  assert.equal(resolveTemperature("claude-haiku-4-5", 0.2), 0.2);
});
