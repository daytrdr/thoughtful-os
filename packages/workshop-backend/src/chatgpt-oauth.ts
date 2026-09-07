// "Sign in with ChatGPT": OpenAI's device-code OAuth flow for the Codex client, on plain fetch so
// it runs in a Worker. pi ships the same flow, but only for Node (it wants node:crypto and
// node:http) and does not export the pieces, so the endpoints, client id and claim names below
// follow @earendil-works/pi-ai/dist/auth/oauth/openai-codex.js (0.84.4) rather than importing it.
//
// Terms: OpenAI has neither blocked nor sanctioned third-party clients on a ChatGPT plan (see
// docs/ai-subscriptions.md). A deployment opts in with ENABLE_CHATGPT_SUBSCRIPTION_LOGIN=true.
//
// The device flow has three legs, each a separate RPC from the client so no Worker request has to
// wait for a person: (1) ask for a user code, (2) poll until the person approves it in their
// browser, which yields an authorization code plus the PKCE verifier OpenAI generated for it,
// (3) exchange those for tokens. Refreshing later uses the standard refresh_token grant.

import type { AiModelOAuthCredential } from "@gadgets/workshop-shared/api";

export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
export const CHATGPT_TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
export const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
export const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
/** Where the person types the user code. */
export const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
// The redirect the device flow's authorization code was issued for; the exchange must repeat it.
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
/** How long a user code stays valid (OpenAI's limit, mirrored from pi). */
export const DEVICE_CODE_TIMEOUT_MS = 15 * 60 * 1000;
/** Where a signed-in model's inference goes (pi's openai-codex provider base URL). */
export const CHATGPT_API_BASE_URL = "https://chatgpt.com/backend-api";
/**
 * Refresh an access token with less than this left. A chat run keeps the token it started with,
 * so the margin is what a long run has to fit in; the next turn picks up a fresh one.
 */
export const CHATGPT_REFRESH_SKEW_MS = 60 * 60 * 1000;
// RFC 8628: the client must use 5 s when the server names no interval, and back off by 5 s on
// slow_down.
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
export const SLOW_DOWN_INCREMENT_SECONDS = 5;
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

export function isChatGptSubscriptionLoginEnabled(env: Cloudflare.Env): boolean {
  return env.ENABLE_CHATGPT_SUBSCRIPTION_LOGIN?.trim().toLowerCase() === "true";
}

type FetchFn = typeof fetch;

/** The first leg: a code for the person to approve, and the handle to poll with. */
export type DeviceAuth = { deviceAuthId: string; userCode: string; intervalSeconds: number };

export async function startDeviceAuth(fetchFn: FetchFn = fetch): Promise<DeviceAuth> {
  const response = await fetchFn(DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`ChatGPT sign-in could not start (${response.status})${body ? `: ${body}` : ""}`);
  }
  const json = await response.json() as {
    device_auth_id?: unknown; user_code?: unknown; interval?: unknown;
  };
  const interval = typeof json.interval === "string" ? Number(json.interval.trim())
      : typeof json.interval === "number" ? json.interval : DEFAULT_POLL_INTERVAL_SECONDS;
  if (typeof json.device_auth_id !== "string" || !json.device_auth_id ||
      typeof json.user_code !== "string" || !json.user_code ||
      !Number.isFinite(interval) || interval < 0) {
    throw new Error("ChatGPT sign-in returned an unexpected response.");
  }
  return {
    deviceAuthId: json.device_auth_id,
    userCode: json.user_code,
    intervalSeconds: Math.max(1, interval),
  };
}

/** One poll of the second leg. `slow_down` asks the caller to widen its interval. */
export type DevicePollResult =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "complete"; authorizationCode: string; codeVerifier: string }
  | { status: "failed"; message: string };

export async function pollDeviceAuth(
    device: Pick<DeviceAuth, "deviceAuthId" | "userCode">,
    fetchFn: FetchFn = fetch): Promise<DevicePollResult> {
  const response = await fetchFn(DEVICE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
  });
  if (response.ok) {
    const json = await response.json() as { authorization_code?: unknown; code_verifier?: unknown };
    if (typeof json.authorization_code !== "string" || typeof json.code_verifier !== "string") {
      return { status: "failed", message: "ChatGPT sign-in returned an unexpected approval." };
    }
    return {
      status: "complete", authorizationCode: json.authorization_code, codeVerifier: json.code_verifier,
    };
  }
  // Not approved yet is reported as 403/404, or as a JSON error code on other statuses.
  if (response.status === 403 || response.status === 404) return { status: "pending" };
  const body = await response.text().catch(() => "");
  let code: unknown;
  try {
    const json = JSON.parse(body) as { error?: unknown };
    code = typeof json.error === "object" && json.error !== null
        ? (json.error as { code?: unknown }).code : json.error;
  } catch { /* not JSON */ }
  if (code === "deviceauth_authorization_pending") return { status: "pending" };
  if (code === "slow_down") return { status: "slow_down" };
  return {
    status: "failed",
    message: `ChatGPT sign-in failed (${response.status})${body ? `: ${body}` : ""}`,
  };
}

/** The third leg: tokens for the approved authorization code. */
export function exchangeDeviceCode(
    authorizationCode: string, codeVerifier: string,
    fetchFn: FetchFn = fetch): Promise<AiModelOAuthCredential> {
  return tokenRequest({
    grant_type: "authorization_code",
    client_id: CHATGPT_CLIENT_ID,
    code: authorizationCode,
    code_verifier: codeVerifier,
    redirect_uri: DEVICE_REDIRECT_URI,
  }, "exchange", fetchFn);
}

/** A new access token (and, usually, a rotated refresh token) for a stored grant. */
export function refreshChatGptCredential(
    refreshToken: string, fetchFn: FetchFn = fetch): Promise<AiModelOAuthCredential> {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CHATGPT_CLIENT_ID,
  }, "refresh", fetchFn);
}

async function tokenRequest(
    params: Record<string, string>, operation: "exchange" | "refresh",
    fetchFn: FetchFn): Promise<AiModelOAuthCredential> {
  let response: Response;
  try {
    response = await fetchFn(CHATGPT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
  } catch (err) {
    throw new Error(
        `ChatGPT token ${operation} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err });
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
        `ChatGPT token ${operation} failed (${response.status})${body ? `: ${body}` : ""}`);
  }
  const json = await response.json() as {
    access_token?: unknown; refresh_token?: unknown; expires_in?: unknown;
  };
  if (typeof json.access_token !== "string" || typeof json.refresh_token !== "string" ||
      typeof json.expires_in !== "number") {
    throw new Error(`ChatGPT token ${operation} response is missing fields.`);
  }
  const accountId = chatGptAccountId(json.access_token);
  if (!accountId) {
    throw new Error(`ChatGPT token ${operation} returned a token without an account id.`);
  }
  return {
    kind: "oauth",
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    accountId,
  };
}

/** The `chatgpt_account_id` claim of an access token, or null when the token carries none. */
export function chatGptAccountId(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH];
  const accountId = typeof auth === "object" && auth !== null
      ? (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id : undefined;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

// JWT payloads are base64url without padding; atob wants standard base64.
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
    const bytes = Uint8Array.from(atob(padded), c => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
