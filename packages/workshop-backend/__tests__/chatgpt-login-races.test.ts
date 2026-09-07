// The ChatGPT sign-in and token refresh each await the provider over fetch, and the Durable
// Object input gate does not hold across those awaits: a disconnect or a fresh sign-in can run
// in between. These tests interleave exactly that, over a real User DO, and assert the stale
// continuation never writes over the newer state.

import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { UserDurableObject } from "../src/user.js";
import { CHATGPT_TOKEN_URL, DEVICE_TOKEN_URL, DEVICE_USER_CODE_URL } from "../src/chatgpt-oauth.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER: DurableObjectNamespace<UserDurableObject>;
  }
}

const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const ACCESS = (tag: string) => `${b64url('{"alg":"none"}')}.${
  b64url(JSON.stringify({ tag, "https://api.openai.com/auth": { chatgpt_account_id: "acct_42" } }))}.sig`;

const MODEL_ID = "chatgpt:gpt-5.6-sol";

type Credential = {
  kind: "oauth"; accessToken: string; refreshToken: string; expiresAt: number;
  accountId: string; connectedAt: number;
};
type DeviceLogin = { deviceAuthId: string; nextPollAt: number; exchanging?: boolean };
type Impl = {
  env: Record<string, string>;
  storage: {
    chatGptCredential: { get(): Credential | null; put(value: Credential | null): void };
    chatGptDeviceLogin: {
      get(): DeviceLogin | null;
      put(value: DeviceLogin | null): void;
    };
    aiModels: { put(record: unknown): void };
  };
  startChatGptDeviceLogin(): Promise<{ userCode: string }>;
  pollChatGptDeviceLogin(): Promise<{ status: string; message?: string }>;
  disconnectChatGpt(): Promise<void>;
  getChatContext(modelId: string): Promise<{ aiModel?: { config: { credential?: { accessToken: string } } } }>;
};

// A fetch stub routed by URL. Each route answers from a queue of JSON bodies; a queued function
// is a gate that yields its body only when the test releases it. The Response itself is built
// inside the stub: a Response made in the test context cannot be read inside the DO.
type Body = Record<string, unknown>;
type Answer = Body | (() => Promise<Body>);
function routes(table: Record<string, Answer[]>) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const next = table[url]?.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return Response.json(typeof next === "function" ? await next() : next);
  }));
  return calls;
}

function gate() {
  let release!: (body: Body) => void;
  const opened = new Promise<Body>(resolve => { release = resolve; });
  return { answer: () => opened, release };
}

const tokens = (tag: string): Body =>
    ({ access_token: ACCESS(tag), refresh_token: `rt-${tag}`, expires_in: 3600 });
const device = (id: string): Body => ({ device_auth_id: id, user_code: `CODE-${id}`, interval: 0 });
const approved: Body = { authorization_code: "auth-code", code_verifier: "verifier" };

// Waits for the microtasks that carry a continuation up to its next fetch.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

let counter = 0;
async function inUser(fn: (impl: Impl) => Promise<void>): Promise<void> {
  const stub = env.TEST_USER.getByName(`chatgpt-races-${counter++}`);
  await runInDurableObject(stub, async (instance: UserDurableObject) => {
    const impl = instance as unknown as Impl;
    impl.env.ENABLE_CHATGPT_SUBSCRIPTION_LOGIN = "true";
    await fn(impl);
  });
}

// Starts a sign-in and waives the provider's polling interval so the next poll goes out at once.
async function startLogin(impl: Impl): Promise<string> {
  const { userCode } = await impl.startChatGptDeviceLogin();
  impl.storage.chatGptDeviceLogin.put({ ...impl.storage.chatGptDeviceLogin.get()!, nextPollAt: 0 });
  return userCode;
}

function seedGrant(impl: Impl, tag: string, expiresIn: number): Credential {
  const credential: Credential = {
    kind: "oauth", accessToken: ACCESS(tag), refreshToken: `rt-${tag}`,
    expiresAt: Date.now() + expiresIn, accountId: "acct_42", connectedAt: 1,
  };
  impl.storage.chatGptCredential.put(credential);
  impl.storage.aiModels.put({
    profile: { id: MODEL_ID, name: "GPT 5.6 Sol (ChatGPT)" },
    config: { provider: "openai-codex", model: "gpt-5.6-sol", apiToken: "" },
  });
  return credential;
}

describe("ChatGPT sign-in state under interleaved operations", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not resurrect a grant that was disconnected during its refresh", async () => {
    const refresh = gate();
    routes({ [CHATGPT_TOKEN_URL]: [refresh.answer] });
    await inUser(async impl => {
      seedGrant(impl, "old", 10 * 60 * 1000);
      const turn = impl.getChatContext(MODEL_ID);
      await settle();
      await impl.disconnectChatGpt();
      refresh.release(tokens("refreshed"));
      await expect(turn).rejects.toThrow("disconnected while its sign-in was being refreshed");
      expect(impl.storage.chatGptCredential.get()).toBeNull();
    });
  });

  it("lets a sign-in made during a refresh win over the refreshed tokens", async () => {
    const refresh = gate();
    routes({ [CHATGPT_TOKEN_URL]: [refresh.answer] });
    await inUser(async impl => {
      seedGrant(impl, "old", 10 * 60 * 1000);
      const turn = impl.getChatContext(MODEL_ID);
      await settle();
      await impl.disconnectChatGpt();
      const reconnected = seedGrant(impl, "new", 3600 * 1000);
      refresh.release(tokens("refreshed"));
      const context = await turn;
      expect(context.aiModel?.config.credential?.accessToken).toBe(reconnected.accessToken);
      expect(impl.storage.chatGptCredential.get()?.refreshToken).toBe("rt-new");
    });
  });

  it("still refreshes in place when nothing interleaves", async () => {
    routes({ [CHATGPT_TOKEN_URL]: [tokens("refreshed")] });
    await inUser(async impl => {
      seedGrant(impl, "old", 10 * 60 * 1000);
      const context = await impl.getChatContext(MODEL_ID);
      expect(context.aiModel?.config.credential?.accessToken).toBe(ACCESS("refreshed"));
      expect(impl.storage.chatGptCredential.get()?.refreshToken).toBe("rt-refreshed");
    });
  });

  it("drops a poll of a sign-in that a newer sign-in replaced", async () => {
    const poll = gate();
    const calls = routes({
      [DEVICE_USER_CODE_URL]: [device("A"), device("B")],
      [DEVICE_TOKEN_URL]: [poll.answer],
    });
    await inUser(async impl => {
      await startLogin(impl);
      const stale = impl.pollChatGptDeviceLogin();
      await settle();
      expect(await startLogin(impl)).toBe("CODE-B");
      poll.release(approved);
      const result = await stale;
      expect(result.status).toBe("failed");
      expect(result.message).toContain("replaced by a newer one");
      // No exchange was attempted for the superseded code, and attempt B is untouched.
      expect(calls.filter(url => url === CHATGPT_TOKEN_URL)).toHaveLength(0);
      expect(impl.storage.chatGptDeviceLogin.get()).toMatchObject({ deviceAuthId: "B" });
      expect(impl.storage.chatGptCredential.get()).toBeNull();
    });
  });

  it("stores nothing for a code whose exchange was disconnected midway", async () => {
    const exchange = gate();
    const calls = routes({
      [DEVICE_USER_CODE_URL]: [device("A")],
      [DEVICE_TOKEN_URL]: [approved],
      [CHATGPT_TOKEN_URL]: [exchange.answer],
    });
    await inUser(async impl => {
      await startLogin(impl);
      const stale = impl.pollChatGptDeviceLogin();
      await settle();
      // A second poll landing during the exchange waits rather than re-asking for the code.
      expect(impl.storage.chatGptDeviceLogin.get()).toMatchObject({ deviceAuthId: "A", exchanging: true });
      expect(await impl.pollChatGptDeviceLogin()).toEqual({ status: "pending" });
      expect(calls.filter(url => url === DEVICE_TOKEN_URL)).toHaveLength(1);

      await impl.disconnectChatGpt();
      exchange.release(tokens("A"));
      expect((await stale).status).toBe("failed");
      expect(impl.storage.chatGptCredential.get()).toBeNull();
      expect(impl.storage.chatGptDeviceLogin.get()).toBeNull();
    });
  });

  it("completes an undisturbed sign-in", async () => {
    routes({
      [DEVICE_USER_CODE_URL]: [device("A")],
      [DEVICE_TOKEN_URL]: [approved],
      [CHATGPT_TOKEN_URL]: [tokens("A")],
    });
    await inUser(async impl => {
      await startLogin(impl);
      expect(await impl.pollChatGptDeviceLogin()).toMatchObject({ status: "complete", accountId: "acct_42" });
      expect(impl.storage.chatGptCredential.get()?.refreshToken).toBe("rt-A");
      expect(impl.storage.chatGptDeviceLogin.get()).toBeNull();
    });
  });
});
