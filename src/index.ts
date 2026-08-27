import app from "./server";
import { resolveAuth } from "./utils/auth";
import { codexStatus } from "./handlers/codex_setup";

const PORT = parseInt(process.env.PORT || "8765", 10);

const AUTH_LABELS: Record<string, string> = {
  "env-api-key": "ANTHROPIC_API_KEY env var (x-api-key)",
  "env-auth-token": "ANTHROPIC_AUTH_TOKEN env var (Bearer)",
  none: "No auth configured, API calls may fail",
};

app.listen(PORT, () => {
  console.log(`Claude proxy server running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Models: http://localhost:${PORT}/v1/models`);
  console.log(`Chat: POST http://localhost:${PORT}/v1/chat/completions`);

  const auth = resolveAuth();
  console.log(`Auth: ${AUTH_LABELS[auth.method]}`);

  const codex = codexStatus();
  console.log(
    codex.configured
      ? `Codex auth: configured (account ${codex.maskedAccountId})`
      : "Codex auth: not configured — open /setup to login (gpt-* models unavailable)"
  );
});
