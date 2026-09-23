import assert from "node:assert/strict";
import test from "node:test";
import { CLAUDE_CLI_USER_AGENT } from "./auth";

test("uses the minimum Claude CLI version required by Claude Opus 5.5", () => {
  assert.equal(CLAUDE_CLI_USER_AGENT, "claude-cli/2.1.280");
});
