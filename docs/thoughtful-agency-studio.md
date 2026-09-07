# Thoughtful Agency studio

How this deployment is set up as the internal design studio for the Thoughtful Agency team (three
people collaborating with each other and with the agent; clients are not users). This is the
operating guide for the plan in `plans/` and the Design Review format shipped in
`packages/workshop-backend/format-blueprints/workspace-design-review/`.

## Accounts and access

- Three accounts, one per teammate (username/password today). Every engagement gets one workspace;
  its owner adds the other two by email from the Share dialog with the **build** role, so all three
  chat with the agent, edit code and review in the same place. Collaborators' chats run on their
  own model credentials (see `docs/sharing.md`).
- Later, optionally: register a Google OAuth app and set `AUTH_GATEKEEPERS=google` so the team
  signs in with Google Workspace, then turn signups off in Admin → Access.

## AI access

- Each teammate adds an **Anthropic API key** and an **OpenAI API key** at `/providers`. Claude
  Pro/Max subscriptions cannot be used here: Anthropic's consumer terms allow subscription OAuth
  only in Anthropic's own products and apps built on the Claude Agent SDK, which cannot run inside
  a Worker. Keep the Max subscription for Claude Code itself.
- "Sign in with ChatGPT" (device-code login, billed to the person's ChatGPT plan) is built and
  off by default: set `ENABLE_CHATGPT_SUBSCRIPTION_LOGIN=true` on the backend Worker to offer it
  under AI providers. OpenAI has neither blocked nor sanctioned third-party clients on a plan, so
  turning it on is a team decision; [ai-subscriptions.md](ai-subscriptions.md) has the flow and
  its limits (chat-only, no gadget bindings).
- Optional cost visibility: set `CF_AI_GATEWAY` and `CF_AI_GATEWAY_PROVIDERS=anthropic,openai` with
  company keys so every chat is logged and priced per workspace.

## Figma bridge

Connect Figma's remote MCP server through the MCP connector: in a workspace, add a connection,
choose **Any MCP server**, and paste `https://mcp.figma.com/mcp`. Complete the OAuth pop-up, then
scope the grant with **Choose tools** (the read tools plus the few write tools you want). The agent
can then read frames and design context from Figma and push generated screens back. If the server
refuses dynamic client registration, the fallback is a dedicated Figma gatekeeper.

## Branding

- Shell: the brand accent defaults to Thoughtful Agency indigo (`#191f76`) in
  `packages/workshop-frontend/src/styles.css`. In Admin → General set the site name to
  **Thoughtful Agency** and upload `docs/brand/thoughtful-agency-mark.svg` as the site logo
  (`docs/brand/thoughtful-agency-wordmark.svg` is the horizontal lockup).
- Tokens (sampled from the PromptUX site): brand `#191f76` / `#2d3491` / `#4a52b6`, ink `#0f1115`,
  ink-soft `#5a5d63`, paper `#F5F1E6`, paper-2 `#F8F8F8`, hairline `#e5e5e8`; Helvetica Neue body,
  Instrument Serif display; pill buttons, `rounded-2xl` cards, lowercase wordmark with a dot.

## Design Review format

- Ships with the deployment as `format.design-review`. After the first `/api` request installs it,
  promote it in Admin → Formats so **New Design** appears in the composer's `+` menu and the agent
  prefers it when asked for a review board.
- Usage, keys, data model and the agent-facing API are documented in the blueprint's own
  `files/README.md`. The short version: `C` to pin a note, `E` to edit copy in place, flag a thread
  with **Ask agent**, then tell the chat "apply the open comments on frame 2".
- Exports: HTML, PDF, PNG of the whole board, and a Markdown review summary.
