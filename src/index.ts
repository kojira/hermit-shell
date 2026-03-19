import app from "./server";
import { resolveAuth } from "./utils/auth";

const PORT = parseInt(process.env.PORT || "8765", 10);

const AUTH_LABELS: Record<string, string> = {
  "env-api-key": "ANTHROPIC_API_KEY env var (x-api-key)",
  "env-auth-token": "ANTHROPIC_AUTH_TOKEN env var (Bearer)",
  "openclaw-api-key": "OpenClaw auth-profiles.json (x-api-key)",
  "openclaw-auth-token": "OpenClaw auth-profiles.json (Bearer/OAuth)",
  keychain: "macOS keychain OAuth token",
  none: "No auth configured, API calls may fail",
};

app.listen(PORT, () => {
  console.log(`Claude proxy server running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Models: http://localhost:${PORT}/v1/models`);
  console.log(`Chat: POST http://localhost:${PORT}/v1/chat/completions`);

  const auth = resolveAuth();
  console.log(`Auth: ${AUTH_LABELS[auth.method]}`);
});
