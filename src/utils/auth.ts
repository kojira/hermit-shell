export type AuthResult =
  | { method: "env-api-key"; apiKey: string }
  | { method: "env-auth-token"; authToken: string }
  | { method: "none" };

export function resolveAuth(): AuthResult {
  // 1. ANTHROPIC_API_KEY env var → x-api-key header
  if (process.env.ANTHROPIC_API_KEY) {
    return { method: "env-api-key", apiKey: process.env.ANTHROPIC_API_KEY };
  }

  // 2. ANTHROPIC_AUTH_TOKEN env var → Bearer header
  if (process.env.ANTHROPIC_AUTH_TOKEN) {
    return {
      method: "env-auth-token",
      authToken: process.env.ANTHROPIC_AUTH_TOKEN,
    };
  }

  // 環境変数が無ければ認証なし（fail loud）。外部プロジェクトのファイルは読まない。
  return { method: "none" };
}

/** @deprecated Use resolveAuth() instead */
export function getAnthropicAuthToken(): string | null {
  const auth = resolveAuth();
  if ("authToken" in auth) return auth.authToken;
  return null;
}

export function createAnthropicClient() {
  const Anthropic = require("@anthropic-ai/sdk");
  const auth = resolveAuth();

  const baseBeta = "fine-grained-tool-streaming-2025-05-14";
  const oauthBeta = `claude-code-20250219,oauth-2025-04-20,${baseBeta},interleaved-thinking-2025-05-14`;

  switch (auth.method) {
    case "env-api-key":
      return new Anthropic.default({
        apiKey: auth.apiKey,
        defaultHeaders: { "anthropic-beta": baseBeta },
      });
    case "env-auth-token":
      return new Anthropic.default({
        authToken: auth.authToken,
        defaultHeaders: {
          "anthropic-beta": oauthBeta,
          "user-agent": "claude-cli/2.1.62",
          "x-app": "cli",
        },
      });
    case "none":
    default:
      return new Anthropic.default({
        defaultHeaders: { "anthropic-beta": baseBeta },
      });
  }
}
