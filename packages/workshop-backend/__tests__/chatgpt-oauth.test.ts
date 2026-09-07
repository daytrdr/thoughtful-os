import { describe, expect, it } from "vitest";
import {
  CHATGPT_CLIENT_ID, CHATGPT_TOKEN_URL, DEVICE_TOKEN_URL, DEVICE_USER_CODE_URL,
  chatGptAccountId, exchangeDeviceCode, isChatGptSubscriptionLoginEnabled, pollDeviceAuth,
  refreshChatGptCredential, startDeviceAuth,
} from "../src/chatgpt-oauth.js";

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// A token whose payload carries OpenAI's account claim, the way the real access tokens do.
function jwt(payload: Record<string, unknown>): string {
  return `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(payload))}.sig`;
}
const ACCESS = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_42" } });

type Call = { url: string; init: RequestInit };

// A fetch stub that records each call and answers from a queue of responses.
function stub(...responses: Response[]) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("ChatGPT device-code sign-in", () => {
  it("is off unless the deployment sets ENABLE_CHATGPT_SUBSCRIPTION_LOGIN=true", () => {
    expect(isChatGptSubscriptionLoginEnabled({} as Cloudflare.Env)).toBe(false);
    expect(isChatGptSubscriptionLoginEnabled(
        { ENABLE_CHATGPT_SUBSCRIPTION_LOGIN: "false" } as Cloudflare.Env)).toBe(false);
    expect(isChatGptSubscriptionLoginEnabled(
        { ENABLE_CHATGPT_SUBSCRIPTION_LOGIN: " True " } as Cloudflare.Env)).toBe(true);
  });

  it("asks OpenAI for a user code with the Codex client id", async () => {
    const { calls, fetchFn } = stub(Response.json(
        { device_auth_id: "dev_1", user_code: "ABCD-EFGH", interval: "7" }));
    const device = await startDeviceAuth(fetchFn);
    expect(device).toEqual({ deviceAuthId: "dev_1", userCode: "ABCD-EFGH", intervalSeconds: 7 });
    expect(calls[0].url).toBe(DEVICE_USER_CODE_URL);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ client_id: CHATGPT_CLIENT_ID });
  });

  it("falls back to the RFC 8628 interval and rejects a malformed start", async () => {
    const ok = await startDeviceAuth(stub(Response.json(
        { device_auth_id: "dev_1", user_code: "X" })).fetchFn);
    expect(ok.intervalSeconds).toBe(5);
    await expect(startDeviceAuth(stub(Response.json({ user_code: "X" })).fetchFn))
        .rejects.toThrow("unexpected response");
    await expect(startDeviceAuth(stub(new Response("nope", { status: 500 })).fetchFn))
        .rejects.toThrow("could not start (500)");
  });

  it("reports an unapproved code as pending and honors slow_down", async () => {
    const device = { deviceAuthId: "dev_1", userCode: "ABCD" };
    expect(await pollDeviceAuth(device, stub(new Response("", { status: 403 })).fetchFn))
        .toEqual({ status: "pending" });
    expect(await pollDeviceAuth(device, stub(new Response("", { status: 404 })).fetchFn))
        .toEqual({ status: "pending" });
    expect(await pollDeviceAuth(device, stub(Response.json(
        { error: { code: "deviceauth_authorization_pending" } }, { status: 400 })).fetchFn))
        .toEqual({ status: "pending" });
    expect(await pollDeviceAuth(device, stub(Response.json(
        { error: "slow_down" }, { status: 429 })).fetchFn))
        .toEqual({ status: "slow_down" });
    const failed = await pollDeviceAuth(device, stub(Response.json(
        { error: "access_denied" }, { status: 400 })).fetchFn);
    expect(failed.status).toBe("failed");
  });

  it("returns the authorization code and verifier once approved", async () => {
    const { calls, fetchFn } = stub(Response.json(
        { authorization_code: "code_1", code_verifier: "ver_1" }));
    expect(await pollDeviceAuth({ deviceAuthId: "dev_1", userCode: "ABCD" }, fetchFn))
        .toEqual({ status: "complete", authorizationCode: "code_1", codeVerifier: "ver_1" });
    expect(calls[0].url).toBe(DEVICE_TOKEN_URL);
    expect(JSON.parse(String(calls[0].init.body)))
        .toEqual({ device_auth_id: "dev_1", user_code: "ABCD" });
  });

  it("exchanges the code with OpenAI's own PKCE verifier and reads the account id", async () => {
    const { calls, fetchFn } = stub(Response.json(
        { access_token: ACCESS, refresh_token: "ref_1", expires_in: 3600 }));
    const before = Date.now();
    const credential = await exchangeDeviceCode("code_1", "ver_1", fetchFn);
    expect(credential.kind).toBe("oauth");
    expect(credential.accessToken).toBe(ACCESS);
    expect(credential.refreshToken).toBe("ref_1");
    expect(credential.accountId).toBe("acct_42");
    expect(credential.expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(calls[0].url).toBe(CHATGPT_TOKEN_URL);
    const body = new URLSearchParams(String(calls[0].init.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("code_1");
    expect(body.get("code_verifier")).toBe("ver_1");
    expect(body.get("client_id")).toBe(CHATGPT_CLIENT_ID);
    expect(body.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
  });

  it("refreshes with the refresh_token grant", async () => {
    const { calls, fetchFn } = stub(Response.json(
        { access_token: ACCESS, refresh_token: "ref_2", expires_in: 60 }));
    const credential = await refreshChatGptCredential("ref_1", fetchFn);
    expect(credential.refreshToken).toBe("ref_2");
    const body = new URLSearchParams(String(calls[0].init.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("ref_1");
  });

  it("rejects a token response without the fields or the account claim", async () => {
    await expect(refreshChatGptCredential("ref", stub(Response.json(
        { access_token: ACCESS })).fetchFn)).rejects.toThrow("missing fields");
    await expect(refreshChatGptCredential("ref", stub(Response.json(
        { access_token: jwt({ sub: "x" }), refresh_token: "r", expires_in: 1 })).fetchFn))
        .rejects.toThrow("without an account id");
    await expect(refreshChatGptCredential("ref", stub(
        new Response("invalid_grant", { status: 400 })).fetchFn))
        .rejects.toThrow("refresh failed (400): invalid_grant");
  });

  it("decodes base64url payloads and tolerates junk", () => {
    // A payload long enough to need padding and to contain url-safe characters.
    const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_>>??" }, pad: "~~~" });
    expect(chatGptAccountId(token)).toBe("acct_>>??");
    expect(chatGptAccountId("not-a-jwt")).toBeNull();
    expect(chatGptAccountId("a.b.c")).toBeNull();
  });
});
