import { Request, Response } from "express";

export function handleModels(_req: Request, res: Response): void {
  const CLAUDE_MODELS = [
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-5-20251101",
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

  res.json({
    object: "list",
    data: models,
  });
}
