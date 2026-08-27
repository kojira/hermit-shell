import { Request, Response } from "express";
import { CODEX_MODELS } from "../utils/codex_convert";

export function handleModels(_req: Request, res: Response): void {
  const CLAUDE_MODELS = [
    "claude-haiku-4-5",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "claude-opus-4-5",
    "claude-opus-4-6",
  ];
  const models = CLAUDE_MODELS.map((id) => ({
    id,
    object: "model",
    created: 1700000000,
    owned_by: "anthropic",
    permission: [],
    root: id,
    parent: null,
  }));

  const BONSAI_MODELS = ["bonsai-8b"];
  const bonsaiModels = BONSAI_MODELS.map((id) => ({
    id,
    object: "model",
    created: 1700000000,
    owned_by: "prismml",
    permission: [],
    root: id,
    parent: null,
  }));

  // 代表モデルのみ列挙。ルーティングは gpt-* 前方一致なので未掲載の id も通る。
  const codexModels = CODEX_MODELS.map((id) => ({
    id,
    object: "model",
    created: 1700000000,
    owned_by: "openai-codex",
    permission: [],
    root: id,
    parent: null,
  }));

  res.json({
    object: "list",
    data: [...models, ...bonsaiModels, ...codexModels],
  });
}
