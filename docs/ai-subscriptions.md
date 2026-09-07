# AI subscriptions: what can and cannot pay for the agent

The Workshop bills inference to one of three things: a provider API key the user adds under
**AI providers**, an AI Gateway the deployment or the user connects (see
[ai-gateway-billing.md](ai-gateway-billing.md)), or, optionally, the user's own ChatGPT plan. This
page covers the last one and explains why there is no equivalent for Claude.

## Claude: API key only

Anthropic's consumer terms (revised 2026-02-20, enforced since 2026-04-04) prohibit using a Claude
Pro or Max subscription's OAuth tokens in third-party harnesses. The carve-out for apps built on the
Claude Agent SDK does not help here: the SDK drives the Claude Code binary, which cannot run inside
a Worker. The LLM layer this app uses (pi-ai) does contain a Claude OAuth path that presents itself
as Claude Code; it is deliberately not wired, and a change that wires it should be refused in
review. Claude in the Workshop therefore uses an Anthropic API key, and the subscription stays with
Claude Code itself.

## ChatGPT: device-code sign-in, off by default

OpenAI has neither blocked nor sanctioned third-party clients on a ChatGPT plan (openai/codex
discussion #8338; issue #10974 is still open). The flow below is the one the Codex CLI uses, and it
counts against the person's plan limits like the CLI does. Treat it as a gray zone: enable it for a
team that has decided to accept that, not for a public deployment.

A deployment opts in by setting `ENABLE_CHATGPT_SUBSCRIPTION_LOGIN=true` on the backend Worker.
Locally, export it when starting the stack or put it in the root `.dev.vars` (gitignored):
`ENABLE_CHATGPT_SUBSCRIPTION_LOGIN=true pnpm run-local`. The dev config generator passes it
through like the other optional feature flags. With it on:

1. **AI providers → Add provider → Sign in with ChatGPT** starts OpenAI's device-code flow
   (`AuthenticatedApi.startChatGptDeviceLogin()`): the page shows a short code and a link to
   `https://auth.openai.com/codex/device`.
2. The person approves the code in their browser; the page polls
   (`pollChatGptDeviceLogin()`) at the interval OpenAI names. The server enforces that interval,
   so a fast client never trips OpenAI's rate limit, and abandons the attempt after 15 minutes.
3. On approval the server exchanges the authorization code (with the PKCE verifier OpenAI generated
   for it) for an access token and a refresh token, reads the `chatgpt_account_id` claim from the
   token, and stores the grant once for the user. The grant never reaches the browser.
4. The person then picks one of the `openai-codex` models (the picker lists the same GPT 5.6
   family plus Codex Spark, with ChatGPT's own context windows). The model is stored with an empty
   `apiToken`; when a chat resolves it, the user's Durable Object attaches the grant, refreshing the
   access token first if less than an hour remains. Refreshes are coalesced, since OpenAI rotates
   the refresh token on each one.

Inference goes straight to `chatgpt.com/backend-api` over SSE (Workers have no outbound WebSocket
constructor, so the WebSocket transport pi prefers is not attempted). These models never route
through an AI Gateway, so gateway-mode deployments can still offer them, and no gateway log or cost
row exists for them: the plan pays.

**Reconnect** on the AI providers page runs the same flow again and replaces the grant;
**Disconnect** forgets it and deletes the models that ran on it. A refresh that fails (the plan was
cancelled, the grant was revoked) surfaces as a chat error, and the page's expiry shows the
subscription needs reconnecting.

### Deliberate limits

- Subscription models are chat-only. Binding one to a gadget (`newAiModelGatekeeper`) is refused:
  a binding would freeze one access token in the gatekeeper's props and let a gadget drive a
  personal plan programmatically.
- PDF attachments are declined for these models; only text and images are sent.
- A chat run keeps the token it started with. A run longer than the token's remaining validity
  fails on the next request; the next turn picks up a refreshed token.

### Code map

- `packages/workshop-backend/src/chatgpt-oauth.ts`: the three legs of the device flow and the
  refresh, on plain `fetch`. Endpoints, client id and claim names follow pi's Node-only
  implementation (`@earendil-works/pi-ai/dist/auth/oauth/openai-codex.js`).
- `packages/workshop-backend/src/user.ts`: `chatGptCredential` / `chatGptDeviceLogin` storage, the
  four RPCs, and the coalesced refresh that `getChatContext()` applies.
- `packages/workshop-backend/src/ai-models.ts`: the `openai-codex` branch of `getModelDirect()`
  and the `openai-codex-responses` stream (pi's), forced to SSE.
- `packages/workshop-shared/src/api.ts`: `SUBSCRIPTION_PROVIDERS`, `AiModelOAuthCredential`, the
  `ChatGpt*` RPC types and `ServerConfig.chatGptSubscriptionLogin`.
- `packages/workshop-frontend/src/AddModelModal.tsx` and `routes/providers.tsx`: the sign-in card,
  the connected-plan notice, Reconnect and Disconnect.
