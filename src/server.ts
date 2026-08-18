import express from "express";
import { handleChatCompletions } from "./handlers/chat";
import { handleModels } from "./handlers/models";
import { handleSetupPage, handleSetupToken } from "./handlers/setup";

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

export default app;
