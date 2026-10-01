import express from "express";
import { handleChatCompletions } from "./handlers/chat";
import { handleModels } from "./handlers/models";
import {
  handleClaudeSetupTokenCancel,
  handleClaudeSetupTokenCode,
  handleClaudeSetupTokenStart,
  handleClaudeSetupTokenStatus,
  handleSetupPage,
  handleSetupToken,
} from "./handlers/setup";

const app = express();

// Anthropic's Messages API accepts request bodies up to 32 MB. Image-heavy
// conversations (base64 screenshots) routinely exceed the old 10 MB bound
// even though upstream would accept them.
export const REQUEST_BODY_LIMIT = "32mb";

app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "1.0.0" });
});

app.get("/v1/models", handleModels);
app.post("/v1/chat/completions", handleChatCompletions);

// 認証トークンの設定ページ（localhost 限定・setup.ts 内で 403 判定）
app.get("/setup", handleSetupPage);
app.post("/setup/token", handleSetupToken);
app.post("/setup/claude/start", handleClaudeSetupTokenStart);
app.post("/setup/claude/cancel", handleClaudeSetupTokenCancel);
app.post("/setup/claude/code", handleClaudeSetupTokenCode);
app.get("/setup/claude/status", handleClaudeSetupTokenStatus);

export default app;
