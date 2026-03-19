import { Request, Response } from "express";
import { MODEL_MAP } from "../utils/convert";

export function handleModels(_req: Request, res: Response): void {
  const models = Object.keys(MODEL_MAP).map((id) => ({
    id,
    object: "model",
    created: 1700000000,
    owned_by: "anthropic-proxy",
    permission: [],
    root: id,
    parent: null,
  }));

  res.json({
    object: "list",
    data: models,
  });
}
