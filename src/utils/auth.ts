import { readFileSync } from "fs";

const AUTH_PROFILES_PATH =
  "/Volumes/2TB/openclaw/agents/main/agent/auth-profiles.json";

interface AuthProfiles {
  version: number;
  profiles: Record<
    string,
    { type: string; provider: string; token: string }
  >;
  lastGood: Record<string, string>;
}

export type AuthResult =
  | { method: "env-api-key"; apiKey: string }
  | { method: "env-auth-token"; authToken: string }
  | { method: "openclaw-oauth-token"; authToken: string }
  | { method: "openclaw-api-key"; apiKey: string }
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

  // 3. OpenClaw auth-profiles.json
  // OAT tokens (sk-ant-oat01-*) → Bearer auth (authToken) with oauth beta header
  // Standard API keys (sk-ant-api01-*) → x-api-key header (apiKey)
  try {
    const raw = readFileSync(AUTH_PROFILES_PATH, "utf8");
    const profiles: AuthProfiles = JSON.parse(raw);

    // Helper: resolve a token to the appropriate auth method
    const resolveToken = (token: string): AuthResult | null => {
      if (!token) return null;
      if (token.startsWith("sk-ant-oat01")) {
        return { method: "openclaw-oauth-token", authToken: token };
      }
      return { method: "openclaw-api-key", apiKey: token };
    };

    // 3a. Try lastGood profile first
    const lastGoodProfile = profiles.lastGood?.anthropic;
    if (lastGoodProfile) {
      const token = profiles.profiles[lastGoodProfile]?.token;
      const result = resolveToken(token);
      if (result) return result;
    }

    // 3b. Fallback: search profiles for any anthropic provider
    for (const [key, profile] of Object.entries(profiles.profiles)) {
      if (profile.provider === "anthropic" || key.startsWith("anthropic:")) {
        const result = resolveToken(profile.token);
        if (result) return result;
      }
    }
  } catch {
    // auth-profiles.json not available
  }

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
    case "openclaw-oauth-token":
      return new Anthropic.default({
        authToken: auth.authToken,
        defaultHeaders: {
          "anthropic-beta": oauthBeta,
          "user-agent": "claude-cli/2.1.62",
          "x-app": "cli",
        },
      });
    case "openclaw-api-key":
      return new Anthropic.default({
        apiKey: auth.apiKey,
        defaultHeaders: { "anthropic-beta": baseBeta },
      });
    case "none":
    default:
      return new Anthropic.default({
        defaultHeaders: { "anthropic-beta": baseBeta },
      });
  }
}
