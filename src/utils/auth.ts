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

  // 3. OpenClaw auth-profiles.json — ALL tokens used as apiKey (x-api-key header)
  // Both sk-ant-api01-* and sk-ant-oat01-* work with x-api-key but oat tokens
  // do NOT work as Bearer authToken ("OAuth authentication is currently not supported")
  try {
    const raw = readFileSync(AUTH_PROFILES_PATH, "utf8");
    const profiles: AuthProfiles = JSON.parse(raw);
    const lastGoodProfile = profiles.lastGood?.anthropic;
    if (lastGoodProfile) {
      const token = profiles.profiles[lastGoodProfile]?.token;
      if (token) {
        return { method: "openclaw-api-key", apiKey: token };
      }
    }
  } catch {
    // auth-profiles.json not available
  }

  // 4. macOS keychain — SKIPPED: OAuth access tokens don't work as API tokens

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

  if ("apiKey" in auth) {
    return new Anthropic.default({ apiKey: auth.apiKey });
  }
  if ("authToken" in auth) {
    return new Anthropic.default({ authToken: auth.authToken });
  }

  // Fallback: let SDK find credentials automatically
  return new Anthropic.default();
}
