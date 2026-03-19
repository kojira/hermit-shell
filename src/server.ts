import express from "express";
import { handleChatCompletions } from "./handlers/chat";
import { handleModels } from "./handlers/models";

const app = express();

app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "1.0.0" });
});

app.get("/v1/models", handleModels);
app.post("/v1/chat/completions", handleChatCompletions);

export default app;
