# Deploying this fork with Workers Builds

This fork deploys straight from GitHub: each Worker is a Cloudflare Workers Builds project
connected to `daytrdr/thoughtful-os`, and a push to `main` builds and deploys all of them. No
wrangler commands are run by hand. Sign-in is the app's own login page (username and password by
default, or "Continue with Google" once a Google gatekeeper is deployed), not Cloudflare Access.

Two files in the repo carry the whole setup:

- `deployment.jsonc` (root): the public origin, route, Worker names, which gatekeepers to deploy,
  admins, storage ids and feature flags. The only file to edit.
- `scripts/deploy/prod-config.ts`: turns each package's `wrangler.jsonc` plus `deployment.jsonc`
  into a `wrangler.prod.jsonc` (gitignored). Migrations, compatibility flags and bindings come from
  the dev file, so upstream changes flow through. `scripts/deploy/build.ts` runs it and then builds
  what one Worker's deploy needs; `pnpm -w run deploy:config` writes the configs alone.

## Workers

| Worker (with the default `thoughtful-` prefix) | Root directory | Role |
| --- | --- | --- |
| `thoughtful-gatekeeper-mcp` | `packages/gatekeeper-mcp` | MCP connector; the Figma bridge |
| `thoughtful-workshop-backend` | `packages/workshop-backend` | The app: users, workspaces, agent |
| `thoughtful-os` (`routerName`) | `packages/router` | Public origin; serves the frontend, proxies `/api` and `/gatekeeper/*` |

Add a gatekeeper by listing its short name in `deployment.jsonc` and creating a project for it.

## First deploy

1. **Storage.** In the dashboard create two KV namespaces (blueprints, avatars) and one R2 bucket.
   Paste the KV ids and the bucket name into `deployment.jsonc`, replace the other placeholders
   (`publicBaseUrl`, `admins`), and commit.
2. **Connect GitHub.** Workers & Pages → Create application → Import a repository. Authorise the
   Cloudflare GitHub app for the repository once.
3. **Create the projects, in this order, waiting for each build to succeed:** gatekeepers, then
   `workshop-backend`, then `router`. A deploy fails when a service binding names a Worker that
   does not exist yet; after the first pass the order no longer matters. If the Workers were
   first deployed from a laptop (`pnpm -w run deploy:build <package>` then
   `wrangler deploy --config wrangler.prod.jsonc` in the package directory, with
   `CLOUDFLARE_ACCOUNT_ID` set), connect each existing Worker instead: Workers & Pages → the
   Worker → Settings → Builds → Connect. For each project:

   | Setting | Value |
   | --- | --- |
   | Project name | The Worker name from `deployment.jsonc`, exactly (`namePrefix` + package name; `routerName` for the router) |
   | Production branch | `main` |
   | Root directory | The package directory |
   | Build command | `pnpm -w run deploy:build <package>` with `router`, `workshop-backend` or `gatekeeper-<short>` |
   | Deploy command | `pnpm exec wrangler deploy --config wrangler.prod.jsonc` |
   | Build variable | `PNPM_VERSION` = the version in the root `package.json` `packageManager` field |
   | Non-production branch builds | Off: Durable Object Workers get no preview URLs |

   The project name must match the generated config's `name`; otherwise wrangler deploys a second
   Worker beside the connected one.
4. **Hostname.** With `route.workersDev`, the router answers at
   `https://<routerName>.<subdomain>.workers.dev`; set `publicBaseUrl` to exactly that. With
   `route.customDomain`, the zone must be on the account and the router deploy registers the
   domain.
5. **Sign in.** Open the site and create the three accounts. Usernames listed under `admins` get
   the Admin menu. Then, in Admin, turn sign-ups off; existing accounts keep signing in.

## Sign-in modes

Password accounts are keyed by username (`^[a-z][a-z0-9_]*$`) and gatekeeper accounts by verified
email, so an account can never move between the two modes. Decide before the team creates work.

- **Password (default):** `auth: { "gatekeepers": [] }`, `admins` are usernames. Nothing to set
  up. There is no forgot-password flow.
- **Google:** add `google` to `gatekeepers` and `auth.gatekeepers`, set
  `auth.disablePasswordAuth: true`, make `admins` emails. Create a Google OAuth client with redirect
  URI `<publicBaseUrl>/gatekeeper/google/oauth`, then add `CLIENT_ID` and `CLIENT_SECRET` as
  secrets on the Google gatekeeper Worker (Settings → Variables and Secrets). Secrets survive
  deploys; plain variables are owned by the generated config and rewritten on every deploy.

## Day to day

- Push to `main`: every project rebuilds and deploys on its own. Each build runs
  `vp run --no-cache`, so nothing is replayed from a cache.
- Roll back from the Worker's Deployments tab.
- The only secret-shaped setting in the default deployment is none; `ENABLE_CHATGPT_SUBSCRIPTION_LOGIN`
  is `features.chatGptSubscriptionLogin` in `deployment.jsonc`.
- Build minutes: 3,000 per month on the Free plan (one build at a time), 6,000 on Paid (six
  concurrent). Build watch paths per project (Settings → Build) keep a docs-only change from
  rebuilding everything.

## Not verified

Whether Workers Builds reads the `packageManager` field on its own (hence `PNPM_VERSION`), and
whether wrangler provisions KV and R2 in a non-interactive build (hence creating them by hand).
