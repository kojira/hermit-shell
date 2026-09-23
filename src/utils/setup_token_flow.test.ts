import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { renderPage } from "../handlers/setup";
import {
  ClaudeSetupTokenFlow,
  SetupTokenChild,
  claudeSetupEnvironment,
  publicSetupTokenStatus,
} from "./setup_token_flow";

class FakeStream extends EventEmitter {}

class FakeInput {
  writes: string[] = [];
  write(value: string | Buffer): boolean {
    this.writes.push(value.toString());
    return true;
  }
}

class FakeChild extends EventEmitter implements SetupTokenChild {
  stdin = new FakeInput();
  stdout = new FakeStream();
  stderr = new FakeStream();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

const token = `sk-ant-oat01-${"a".repeat(48)}`;

function makeFlow(overrides: Partial<ConstructorParameters<typeof ClaudeSetupTokenFlow>[0]> = {}) {
  const child = new FakeChild();
  const applied: string[] = [];
  let resets = 0;
  const flow = new ClaudeSetupTokenFlow({
    spawn: () => child,
    verify: async () => ({ ok: true }),
    apply: (value) => applied.push(value),
    resetClient: () => {
      resets += 1;
    },
    timeoutMs: 1_000,
    maxOutputBytes: 4_096,
    ...overrides,
  });
  return { flow, child, applied, resets: () => resets };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("emits redacted lifecycle evidence without code, token, or OAuth query", async () => {
  const logs: string[] = [];
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    const { flow, child } = makeFlow();
    flow.start();
    child.stdout.emit(
      "data",
      Buffer.from("https://claude.com/cai/oauth/authorize?secret=query\n")
    );
    flow.submitAuthorizationCode("browser-code#oauth-secret");
    child.stdout.emit(
      "data",
      Buffer.from(
        "HERMIT_AUTH_CODE_SEND_BEGIN\nHERMIT_AUTH_CODE_ENTER_SENT\nHERMIT_AUTH_CODE_FORWARDED\n"
      )
    );
    child.stdout.emit("data", Buffer.from(`${token}\n`));
    child.emit("close", 0, null);
    await settle();

    const joined = logs.join("\n");
    for (const event of [
      "flow_started",
      "auth_url_ready",
      "code_submitted",
      "cli_output",
      "code_send_begin",
      "enter_sent",
      "code_forwarded",
      "cli_output_after_code",
      "final_token_detected",
      "cli_closed",
      "verification_started",
      "verification_succeeded",
      "token_applied",
    ]) {
      assert.match(joined, new RegExp(event));
    }
    assert.doesNotMatch(joined, /browser-code|oauth-secret|sk-ant-|secret=query/);
  } finally {
    console.info = originalInfo;
  }
});

test("captures a split setup token internally, verifies, applies, and never exposes it", async () => {
  const observedLogs: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args: unknown[]) => observedLogs.push(args.join(" "));
  console.log = (...args: unknown[]) => observedLogs.push(args.join(" "));
  try {
    const { flow, child, applied, resets } = makeFlow();
    assert.deepEqual(flow.start(), { started: true });
    child.stdout.emit("data", Buffer.from(`Open browser\n${token.slice(0, 25)}`));
    child.stdout.emit("data", Buffer.from(`${token.slice(25)}\n`));
    child.emit("close", 0, null);
    await settle();

    assert.deepEqual(applied, [token]);
    assert.equal(resets(), 1);
    assert.equal(flow.status().state, "success");
    assert.doesNotMatch(JSON.stringify(publicSetupTokenStatus(flow.status())), /sk-ant-/);
    assert.doesNotMatch(observedLogs.join("\n"), /sk-ant-/);
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
});

test("publishes only the official Claude authentication URL while waiting", () => {
  const { flow, child } = makeFlow();
  flow.start();
  child.stdout.emit("data", Buffer.from("https://example.com/oauth/authorize\n"));
  assert.deepEqual(flow.status(), { state: "waiting_for_user" });

  child.stdout.emit(
    "data",
    Buffer.from(
      "Browser didn't open? \u001b]8;;https://claude.com/cai/oauth/authorize?code=true\u0007Sign in\u001b]8;;\u0007\n"
    )
  );

  assert.deepEqual(flow.status(), {
    state: "waiting_for_user",
    authUrl: "https://claude.com/cai/oauth/authorize?code=true",
  });
});

test("does not replace a complete OAuth URL with its wrapped partial prefix", () => {
  const { flow, child } = makeFlow();
  flow.start();
  const complete =
    "https://claude.com/cai/oauth/authorize?code=true&client_id=client&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=challenge&code_challenge_method=S256&state=state";
  child.stdout.emit("data", Buffer.from(`${complete}\n`));
  child.stdout.emit("data", Buffer.from("x".repeat(3_000)));
  child.stdout.emit(
    "data",
    Buffer.from("https://claude.com/cai/oauth/authorize?code=true&client_id=client\n")
  );
  assert.deepEqual(flow.status(), { state: "waiting_for_user", authUrl: complete });
});

test("submits the browser authorization code only to the active CLI stdin", () => {
  const { flow, child } = makeFlow();
  assert.deepEqual(flow.submitAuthorizationCode("before-start"), {
    submitted: false,
    reason: "not_waiting",
  });

  flow.start();
  child.stdout.emit(
    "data",
    Buffer.from("https://claude.com/cai/oauth/authorize?code=true\n")
  );
  assert.deepEqual(flow.submitAuthorizationCode(" browser-code#oauth-secret "), {
    submitted: true,
  });
  assert.deepEqual(child.stdin.writes, ["browser-code#oauth-secret\n"]);
  assert.deepEqual(flow.status(), { state: "waiting_for_cli" });
  assert.doesNotMatch(JSON.stringify(flow.status()), /browser-code|oauth-secret/);
  assert.deepEqual(flow.submitAuthorizationCode("second-code"), {
    submitted: false,
    reason: "not_waiting",
  });
});

test("continues past a successful CLI press-Enter prompt", () => {
  const { flow, child } = makeFlow();
  flow.start();
  child.stdout.emit(
    "data",
    Buffer.from("https://claude.com/cai/oauth/authorize?code=true\n")
  );
  flow.submitAuthorizationCode("valid-code#valid-state");
  child.stdout.emit(
    "data",
    Buffer.from("Authentication successful. Press Enter to continue.\n")
  );
  assert.deepEqual(child.stdin.writes, ["valid-code#valid-state\n", "\n"]);
});

test("returns from waiting_for_cli to a fresh official authorization URL", () => {
  const { flow, child } = makeFlow();
  flow.start();
  child.stdout.emit(
    "data",
    Buffer.from("https://claude.com/cai/oauth/authorize?attempt=first\n")
  );
  assert.deepEqual(flow.submitAuthorizationCode("expired-code#state"), {
    submitted: true,
  });
  assert.deepEqual(flow.status(), { state: "waiting_for_cli" });

  child.stdout.emit(
    "data",
    Buffer.from("https://claude.com/cai/oauth/authorize?attempt=retry\n")
  );
  assert.deepEqual(flow.status(), {
    state: "waiting_for_user",
    authUrl: "https://claude.com/cai/oauth/authorize?attempt=retry",
  });
});

test("known invalid-code and token-exchange failures return only a generic retry error", () => {
  for (const phrase of [
    "Authentication failed: Invalid authorization code",
    "Token exchange failed (401): Unauthorized",
    "Failed to exchange authorization code for access token. Please try again.",
    "OAuth error: Request failed with status code 400",
  ]) {
    const { flow, child } = makeFlow();
    flow.start();
    child.stdout.emit(
      "data",
      Buffer.from("https://claude.com/cai/oauth/authorize?attempt=first\n")
    );
    flow.submitAuthorizationCode("rejected-code#secret-state");
    child.stderr.emit("data", Buffer.from(`\u001b[31m${phrase}\u001b[0m\n`));

    assert.deepEqual(flow.status(), {
      state: "error",
      message: "Claude認証コードが無効または期限切れです。もう一度認証してください。",
    });
    assert.equal(child.killed, true);
    assert.doesNotMatch(
      JSON.stringify(publicSetupTokenStatus(flow.status())),
      /rejected-code|secret-state|Invalid authorization code|Token exchange/
    );
  }
});

test("forces the CLI to emit its fallback URL in a usable PTY", () => {
  const env = claudeSetupEnvironment({
    PATH: "/example/bin",
    TERM: "dumb",
    ANTHROPIC_AUTH_TOKEN: "must-not-be-inherited",
    CLAUDE_CODE_ENTRYPOINT: "must-not-be-inherited",
  });
  assert.equal(env.PATH, "/example/bin");
  assert.equal(env.BROWSER, "false");
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
});

test("allows only one active browser authentication flow", () => {
  let spawns = 0;
  const { flow } = makeFlow({
    spawn: () => {
      spawns += 1;
      return new FakeChild();
    },
  });
  assert.deepEqual(flow.start(), { started: true });
  assert.deepEqual(flow.start(), { started: false, reason: "already_running" });
  assert.equal(spawns, 1);
});

test("command failure does not verify, persist, reset, or expose child output", async () => {
  let verifies = 0;
  const secretOutput = `${token} internal failure details`;
  const { flow, child, applied, resets } = makeFlow({
    verify: async () => {
      verifies += 1;
      return { ok: true };
    },
  });
  flow.start();
  child.stderr.emit("data", Buffer.from(secretOutput));
  child.emit("close", 1, null);
  await settle();

  assert.equal(verifies, 0);
  assert.deepEqual(applied, []);
  assert.equal(resets(), 0);
  const status = publicSetupTokenStatus(flow.status());
  assert.equal(status.state, "error");
  assert.doesNotMatch(JSON.stringify(status), /sk-ant-|internal failure/);
});

test("missing token and verification failure never persist state", async () => {
  const first = makeFlow();
  first.flow.start();
  first.child.stdout.emit("data", Buffer.from("Authentication completed"));
  first.child.emit("close", 0, null);
  await settle();
  assert.deepEqual(first.applied, []);
  assert.equal(first.resets(), 0);
  assert.equal(first.flow.status().state, "error");

  const second = makeFlow({ verify: async () => ({ ok: false, status: 401 }) });
  second.flow.start();
  second.child.stdout.emit("data", Buffer.from(token));
  second.child.emit("close", 0, null);
  await settle();
  assert.deepEqual(second.applied, []);
  assert.equal(second.resets(), 0);
  assert.equal(second.flow.status().state, "error");
  assert.doesNotMatch(JSON.stringify(second.flow.status()), /sk-ant-/);
});

test("bounded output aborts the child without applying credentials", async () => {
  const { flow, child, applied } = makeFlow({ maxOutputBytes: 8 });
  flow.start();
  child.stdout.emit("data", Buffer.from("too much output"));
  await settle();
  assert.equal(child.killed, true);
  assert.deepEqual(applied, []);
  assert.equal(flow.status().state, "error");
});

test("timeout aborts the child without applying credentials", async () => {
  const { flow, child, applied } = makeFlow({ timeoutMs: 5 });
  flow.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(child.killed, true);
  assert.deepEqual(applied, []);
  assert.equal(flow.status().state, "error");
});

test("setup page keeps manual entry and makes browser login explicitly human-operated", () => {
  const previous = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = token;
  try {
    const html = renderPage();
    assert.match(html, /Claudeで再認証/);
    assert.match(html, /ログイン・同意・2段階認証は、開いたブラウザでご自身が行います/);
    assert.match(html, /\/setup\/claude\/start/);
    assert.match(html, /window\.open\('about:blank'/);
    assert.match(html, /data\.authUrl/);
    assert.match(html, /id="claude-auth-link"/);
    assert.match(html, /Claude公式認証ページを開く/);
    assert.match(html, /認証コード/);
    assert.match(html, /\/setup\/claude\/code/);
    assert.match(html, /Claudeへ続行/);
    assert.match(html, /トークンを手動入力/);
    assert.doesNotMatch(html, new RegExp(token));
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = previous;
  }
});
