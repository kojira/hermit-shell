import assert from "node:assert/strict";
import test from "node:test";
import { Request, Response } from "express";
import { handleModels } from "./models";

test("publishes claude-opus-5.5 in the Claude model catalog", () => {
  let body: any;
  handleModels({} as Request, {
    json(value: unknown) {
      body = value;
    },
  } as Response);

  assert.ok(body.data.some((model: { id: string }) => model.id === "claude-opus-5.5"));
});
