import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import app from "../server";

async function post(port: number, bytes: number): Promise<number> {
  const body = JSON.stringify({ model: "x", messages: [], pad: "a".repeat(bytes) });
  const res = await fetch(`http://127.0.0.1:${port}/v1/does-not-exist`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  await res.arrayBuffer();
  return res.status;
}

test("accepts image-heavy request bodies up to Anthropic's 32 MB limit", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    // Past body parsing, an unknown route returns 404 instead of 413.
    assert.equal(await post(port, 12 * 1024 * 1024), 404);
    assert.equal(await post(port, 33 * 1024 * 1024), 413);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
