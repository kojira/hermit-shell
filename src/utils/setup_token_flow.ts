import { spawn as spawnChild } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SetupTokenStream {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export interface SetupTokenInput {
  write(value: string | Buffer): boolean;
}

export interface SetupTokenChild {
  stdin: SetupTokenInput;
  stdout: SetupTokenStream;
  stderr: SetupTokenStream;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SetupTokenState =
  | { state: "idle" }
  | { state: "waiting_for_user"; authUrl?: string }
  | { state: "waiting_for_cli" }
  | { state: "verifying" }
  | { state: "success" }
  | { state: "error"; message: string };

export type PublicSetupTokenStatus = SetupTokenState;

export function publicSetupTokenStatus(state: SetupTokenState): PublicSetupTokenStatus {
  return state;
}

interface SetupTokenFlowDependencies {
  spawn: () => SetupTokenChild;
  verify: (token: string) => Promise<{ ok: true } | { ok: false; status?: number }>;
  apply: (token: string) => void;
  resetClient: () => void;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const TOKEN_PATTERN = /sk-ant-oat01-[A-Za-z0-9_-]{20,1024}/;
const URL_PATTERN = /https:\/\/[^\s\x00-\x1f\x7f]+/g;
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const AUTH_CODE_FAILURE_PHRASES = [
  "Authentication failed: Invalid authorization code",
  "Token exchange failed (",
  "Failed to exchange authorization code for access token. Please try again.",
  "OAuth error: Request failed with status code 400",
];

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

function officialClaudeAuthUrl(value: string): string | null {
  for (const candidate of value.match(URL_PATTERN) ?? []) {
    try {
      const url = new URL(candidate);
      if (
        url.protocol === "https:" &&
        url.hostname === "claude.com" &&
        url.pathname === "/cai/oauth/authorize"
      ) {
        return url.toString();
      }
    } catch {
      // A partial URL can arrive in one chunk; the retained tail is retried next time.
    }
  }
  return null;
}

export class ClaudeSetupTokenFlow {
  private readonly deps: Required<Pick<SetupTokenFlowDependencies, "timeoutMs" | "maxOutputBytes">> &
    Omit<SetupTokenFlowDependencies, "timeoutMs" | "maxOutputBytes">;
  private current: SetupTokenState = { state: "idle" };
  private child: SetupTokenChild | null = null;
  private timer: NodeJS.Timeout | null = null;
  private outputBytes = 0;
  private scanTail = "";
  private bestAuthUrlQueryKeys = 0;
  private capturedToken: string | null = null;
  private codeForwarded = false;
  private outputAfterCodeForwarded = false;
  private finished = false;

  constructor(deps: SetupTokenFlowDependencies) {
    this.deps = {
      ...deps,
      timeoutMs: deps.timeoutMs ?? 10 * 60 * 1_000,
      maxOutputBytes: deps.maxOutputBytes ?? 256 * 1_024,
    };
  }

  status(): SetupTokenState {
    return this.current;
  }

  submitAuthorizationCode(code: string):
    | { submitted: true }
    | { submitted: false; reason: "not_waiting" | "invalid_code" | "write_failed" } {
    if (this.current.state !== "waiting_for_user" || !this.child) {
      return { submitted: false, reason: "not_waiting" };
    }
    const trimmed = code.trim();
    if (!trimmed || Buffer.byteLength(trimmed) > 4_096) {
      return { submitted: false, reason: "invalid_code" };
    }
    try {
      this.child.stdin.write(`${trimmed}\n`);
      this.scanTail = "";
      this.current = { state: "waiting_for_cli" };
      this.trace("code_submitted", {
        length: trimmed.length,
        hasStateSeparator: trimmed.includes("#"),
      });
      return { submitted: true };
    } catch {
      this.fail("Claude認証コードを送信できませんでした");
      return { submitted: false, reason: "write_failed" };
    }
  }

  start(): { started: true } | { started: false; reason: "already_running" } {
    if (
      this.current.state === "waiting_for_user" ||
      this.current.state === "waiting_for_cli" ||
      this.current.state === "verifying"
    ) {
      return { started: false, reason: "already_running" };
    }

    this.resetAttempt();
    let child: SetupTokenChild;
    try {
      child = this.deps.spawn();
    } catch {
      this.fail("Claude認証を開始できませんでした");
      return { started: true };
    }

    this.child = child;
    this.current = { state: "waiting_for_user" };
    this.trace("flow_started");
    child.stdout.on("data", (chunk) => this.acceptOutput(chunk));
    child.stderr.on("data", (chunk) => this.acceptOutput(chunk));
    child.on("error", () => this.fail("Claude認証を開始できませんでした"));
    child.on("close", (code) => void this.handleClose(code));
    this.timer = setTimeout(
      () => this.fail("Claude認証が時間切れになりました"),
      this.deps.timeoutMs
    );
    this.timer.unref?.();
    return { started: true };
  }

  private resetAttempt(): void {
    this.clearTimer();
    this.child = null;
    this.outputBytes = 0;
    this.scanTail = "";
    this.bestAuthUrlQueryKeys = 0;
    this.capturedToken = null;
    this.codeForwarded = false;
    this.outputAfterCodeForwarded = false;
    this.finished = false;
  }

  private acceptOutput(chunk: Buffer | string): void {
    if (this.finished) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    this.outputBytes += bytes;
    if (this.outputBytes > this.deps.maxOutputBytes) {
      this.fail("Claude認証の出力上限を超えました");
      return;
    }

    if (this.capturedToken) return;
    const raw = this.scanTail + chunk.toString();
    const authUrl = officialClaudeAuthUrl(raw);
    if (
      authUrl &&
      (this.current.state === "waiting_for_user" || this.current.state === "waiting_for_cli")
    ) {
      const queryKeys = new URL(authUrl).searchParams.size;
      if (queryKeys >= this.bestAuthUrlQueryKeys) {
        const retry = this.current.state === "waiting_for_cli";
        this.bestAuthUrlQueryKeys = queryKeys;
        this.current = { state: "waiting_for_user", authUrl };
        this.trace("auth_url_ready", { retry, queryKeys });
      } else {
        this.trace("partial_auth_url_ignored", { queryKeys });
      }
    }

    const clean = stripAnsi(raw);
    const chunkText = chunk.toString();
    if (chunkText.includes("HERMIT_AUTH_CODE_FORWARDED")) {
      if (!this.codeForwarded) this.trace("code_forwarded");
      this.codeForwarded = true;
    } else if (this.codeForwarded && !this.outputAfterCodeForwarded) {
      this.outputAfterCodeForwarded = true;
      this.trace("cli_output_after_code", { bytes });
    }
    if (
      this.current.state === "waiting_for_cli" &&
      AUTH_CODE_FAILURE_PHRASES.some((phrase) => clean.includes(phrase))
    ) {
      this.trace("authorization_code_rejected");
      this.fail("Claude認証コードが無効または期限切れです。もう一度認証してください。");
      return;
    }

    const match = clean.match(TOKEN_PATTERN);
    if (match) {
      this.capturedToken = match[0];
      this.scanTail = "";
      this.trace("final_token_detected");
    } else {
      this.scanTail = raw.slice(-2_048);
    }
  }

  private async handleClose(code: number | null): Promise<void> {
    if (this.finished) return;
    this.trace("cli_closed", { code });
    this.clearTimer();
    if (code !== 0 || !this.capturedToken) {
      this.fail("Claude認証を完了できませんでした", false);
      return;
    }

    this.current = { state: "verifying" };
    this.trace("verification_started");
    const token = this.capturedToken;
    this.capturedToken = null;
    this.scanTail = "";
    try {
      const verified = await this.deps.verify(token);
      if (!verified.ok) {
        this.trace("verification_failed", { status: verified.status ?? null });
        this.fail("Claude認証の検証に失敗しました", false);
        return;
      }
      this.trace("verification_succeeded");
      this.deps.apply(token);
      this.deps.resetClient();
      this.trace("token_applied");
      this.finished = true;
      this.child = null;
      this.current = { state: "success" };
    } catch {
      this.fail("Claude認証を適用できませんでした", false);
    }
  }

  private fail(message: string, kill = true): void {
    if (this.finished) return;
    this.finished = true;
    this.clearTimer();
    const child = this.child;
    this.child = null;
    this.capturedToken = null;
    this.scanTail = "";
    if (kill && child) {
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may already have exited. The public result remains generic.
      }
    }
    this.current = { state: "error", message };
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private trace(event: string, details: Record<string, unknown> = {}): void {
    console.info("[hermit-claude-setup]", JSON.stringify({ event, ...details }));
  }
}

export function claudeSetupEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    BROWSER: "false",
    TERM: "xterm-256color",
  };
  for (const name of [
    "HOME",
    "PATH",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "SHELL",
    "LANG",
    "LC_ALL",
  ]) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

const EXPECT_SETUP_TOKEN_SCRIPT = `
set timeout -1
spawn -noecho -nottycopy -nottyinit $env(HERMIT_CLAUDE_EXECUTABLE) setup-token
proc forward_stdin {} {
  if {[eof stdin]} {
    fileevent stdin readable {}
    return
  }
  if {[gets stdin line] >= 0} {
    send -- "$line\\r"
    puts "HERMIT_AUTH_CODE_FORWARDED"
  }
}
fileevent stdin readable forward_stdin
expect eof
set wait_result [wait]
if {[lindex $wait_result 2] == 0} {
  exit [lindex $wait_result 3]
}
exit 1
`;

export function spawnOfficialClaudeSetupToken(): SetupTokenChild {
  const configured = process.env.HERMIT_CLAUDE_BIN;
  const claudeBin = configured || path.join(os.homedir(), ".local", "bin", "claude");
  if (!path.isAbsolute(claudeBin)) {
    throw new Error("HERMIT_CLAUDE_BIN must be absolute");
  }
  fs.accessSync(claudeBin, fs.constants.X_OK);

  // `expect` owns Claude Code's PTY while its stdin remains available for the
  // browser-returned authorization code. The executable path is an environment
  // value consumed directly by Tcl; no shell parses it.
  return spawnChild(
    "/usr/bin/expect",
    ["-c", EXPECT_SETUP_TOKEN_SCRIPT],
    {
      env: {
        ...claudeSetupEnvironment(),
        HERMIT_CLAUDE_EXECUTABLE: claudeBin,
      },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
}
