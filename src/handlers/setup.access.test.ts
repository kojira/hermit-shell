import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import {
  DEFAULT_SETUP_ALLOW_CIDR,
  handleClaudeSetupTokenCancel,
  handleClaudeSetupTokenCode,
  handleClaudeSetupTokenStart,
  handleClaudeSetupTokenStatus,
  handleSetupPage,
  handleSetupToken,
  isAddressInCidr,
} from "./setup";

type MockResponse = Response & { statusCode: number; body: unknown };

function mockResponse(): MockResponse {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    send(body: unknown) {
      this.body = body;
      return this;
    },
    type() {
      return this;
    },
    set() {
      return this;
    },
  };
  return res as unknown as MockResponse;
}

function requestFrom(address: string, body?: unknown): Request {
  // Only the socket peer address is consulted by the guard.
  return { socket: { remoteAddress: address }, body } as unknown as Request;
}

function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test("default allow CIDR is the tailnet range", () => {
  assert.equal(DEFAULT_SETUP_ALLOW_CIDR, "100.64.0.0/10");
});

test("loopback reaches /setup with and without a configured token", () => {
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    const res = mockResponse();
    handleSetupPage(requestFrom(address), res);
    assert.equal(res.statusCode, 200, address);
  }

  withEnv("ANTHROPIC_AUTH_TOKEN", "sk-ant-oat01-test-token", () => {
    const res = mockResponse();
    handleSetupPage(requestFrom("127.0.0.1"), res);
    assert.equal(res.statusCode, 200);
  });
});

test("tailnet peer inside the default CIDR reaches /setup", () => {
  for (const address of ["100.120.122.33", "::ffff:100.120.122.33"]) {
    const res = mockResponse();
    handleSetupPage(requestFrom(address), res);
    assert.equal(res.statusCode, 200, address);
  }
});

test("peer outside the allowed CIDR is rejected with a generic 403", () => {
  const res = mockResponse();
  handleSetupPage(requestFrom("203.0.113.5"), res);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: "forbidden" });
});

test("HERMIT_SETUP_ALLOW_CIDR replaces the default range", () => {
  withEnv("HERMIT_SETUP_ALLOW_CIDR", "192.168.0.0/16", () => {
    const allowed = mockResponse();
    handleSetupPage(requestFrom("192.168.1.10"), allowed);
    assert.equal(allowed.statusCode, 200);

    const rejected = mockResponse();
    handleSetupPage(requestFrom("100.120.122.33"), rejected);
    assert.equal(rejected.statusCode, 403);
  });
});

test("every setup route rejects peers outside the allowed CIDR", async () => {
  const address = "203.0.113.5";

  const page = mockResponse();
  handleSetupPage(requestFrom(address), page);
  assert.equal(page.statusCode, 403);

  const token = mockResponse();
  await handleSetupToken(requestFrom(address, { token: "sk-ant-oat01-x" }), token);
  assert.equal(token.statusCode, 403);

  const start = mockResponse();
  handleClaudeSetupTokenStart(requestFrom(address), start);
  assert.equal(start.statusCode, 403);

  const status = mockResponse();
  handleClaudeSetupTokenStatus(requestFrom(address), status);
  assert.equal(status.statusCode, 403);

  const cancel = mockResponse();
  handleClaudeSetupTokenCancel(requestFrom(address), cancel);
  assert.equal(cancel.statusCode, 403);

  const code = mockResponse();
  handleClaudeSetupTokenCode(requestFrom(address, { code: "x" }), code);
  assert.equal(code.statusCode, 403);

  for (const res of [page, token, start, status, cancel, code]) {
    assert.deepEqual(res.body, { error: "forbidden" });
  }
});

test("an unparsable CIDR fails closed for non-loopback peers", () => {
  withEnv("HERMIT_SETUP_ALLOW_CIDR", "not-a-cidr", () => {
    const res = mockResponse();
    handleSetupPage(requestFrom("100.120.122.33"), res);
    assert.equal(res.statusCode, 403);
  });
});

test("CIDR matching handles boundaries and IPv4-mapped addresses", () => {
  assert.equal(isAddressInCidr("100.64.0.0", "100.64.0.0/10"), true);
  assert.equal(isAddressInCidr("100.127.255.255", "100.64.0.0/10"), true);
  assert.equal(isAddressInCidr("100.128.0.0", "100.64.0.0/10"), false);
  assert.equal(isAddressInCidr("::ffff:100.65.1.2", "100.64.0.0/10"), true);
  assert.equal(isAddressInCidr("::1", "100.64.0.0/10"), false);
});
