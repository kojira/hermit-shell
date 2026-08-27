import express from "express";
import { handleChatCompletions } from "./handlers/chat";
import { handleModels } from "./handlers/models";
import { handleSetupPage, handleSetupToken } from "./handlers/setup";
import {
  handleCodexSetupFinish,
  handleCodexSetupStart,
  handleCodexSetupStatus,
} from "./handlers/codex_setup";

const app = express();

app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "1.0.0" });
});

app.get("/v1/models", handleModels);
app.post("/v1/chat/completions", handleChatCompletions);

// 認証トークンの設定ページ（localhost 限定・setup.ts 内で 403 判定）
app.get("/setup", handleSetupPage);
app.post("/setup/token", handleSetupToken);

// OpenAI Codex (ChatGPT サブスク) の OAuth ログイン（localhost 限定・codex_setup.ts 内で 403 判定）
app.post("/setup/codex/start", handleCodexSetupStart);
app.post("/setup/codex/finish", handleCodexSetupFinish);
app.get("/setup/codex/status", handleCodexSetupStatus);

export default app;
