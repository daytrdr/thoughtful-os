// The pure half of the Workers Builds deploy path (scripts/deploy/prod-config.ts and build.ts):
// what deployment.jsonc is allowed to say, and the shape of the configs built from the repo's REAL
// wrangler.jsonc files. Deploying them is not covered here -- that needs an account.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "jsonc-parser";
import { readDeployablePackages } from "../release/manifest-lib.ts";
import { buildSteps } from "./build.ts";
import {
  PACKAGES_DIR,
  generateProdConfigs,
  readDeploymentConfig,
  renderProdConfig,
  validateConfig,
  type DeploymentConfig,
} from "./prod-config.ts";

const PACKAGES = readDeployablePackages(PACKAGES_DIR);
const devConfig = (name: string) => {
  const pkg = PACKAGES.find((candidate) => candidate.name === name);
  assert.ok(pkg, `packages/${name}/wrangler.jsonc`);
  return pkg.config;
};

const KV_A = "a".repeat(32);
const KV_B = "b".repeat(32);
const BASE: DeploymentConfig = {
  publicBaseUrl: "https://thoughtful-router.example.workers.dev",
  route: { workersDev: true },
  namePrefix: "thoughtful-",
  gatekeepers: ["mcp"],
  admins: ["brandon"],
  auth: { gatekeepers: [], disablePasswordAuth: false },
  resources: {
    blueprintsKvNamespaceId: KV_A,
    avatarsKvNamespaceId: KV_B,
    blueprintContentBucket: "thoughtful-blueprint-content",
  },
  features: { chatGptSubscriptionLogin: false },
};

/** `BASE` with top-level keys replaced. */
function withConfig(patch: Partial<DeploymentConfig>): DeploymentConfig {
  return { ...structuredClone(BASE), ...patch };
}

const GOOGLE = withConfig({
  gatekeepers: ["mcp", "google"],
  auth: { gatekeepers: ["google"], disablePasswordAuth: true },
  admins: ["someone@example.com"],
  features: { chatGptSubscriptionLogin: true },
});

test("the committed deployment.jsonc parses and carries every section", () => {
  const config = readDeploymentConfig();
  for (const key of ["publicBaseUrl", "route", "namePrefix", "gatekeepers", "admins", "auth",
    "resources", "features"] as const) {
    assert.ok(key in config, `deployment.jsonc has no ${key}`);
  }
  // The generator either accepts the file or refuses it for a placeholder -- never for its shape.
  try {
    validateConfig(config, PACKAGES);
  } catch (error) {
    assert.match((error as Error).message, /placeholder/);
  }
});

test("generates the gatekeepers, the backend and the router, in first-deploy order", () => {
  const configs = generateProdConfigs(BASE, PACKAGES);
  // A deploy fails when a service binding names a Worker that does not exist yet, so the order
  // here is the order the Workers Builds projects are created in.
  assert.deepEqual([...configs.keys()], ["gatekeeper-mcp", "workshop-backend", "router"]);
  for (const [name, config] of configs) {
    assert.equal(config.name, `thoughtful-${name}`);
    assert.equal(config.$schema, undefined, `${name}: $schema`);
    assert.equal(config.build, undefined, `${name}: wrangler must not run the dev build command`);
    // Everything the dev file says about the runtime flows through untouched.
    const dev = devConfig(name);
    assert.deepEqual(config.migrations, dev.migrations, `${name}: migrations`);
    assert.deepEqual(config.compatibility_flags, dev.compatibility_flags, `${name}: flags`);
    assert.equal(config.compatibility_date, dev.compatibility_date, `${name}: date`);
    assert.equal(config.main, dev.main, `${name}: main`);
    assert.deepEqual(config.observability, dev.observability, `${name}: observability`);
  }
});

test("the router is the only worker with a public hostname", () => {
  for (const [name, config] of generateProdConfigs(BASE, PACKAGES)) {
    const exposed = name === "router";
    assert.equal(config.workers_dev, exposed, `${name}: workers_dev`);
    assert.equal(config.preview_urls, false, `${name}: preview_urls`);
    assert.equal(config.routes, undefined, `${name}: routes on a workers.dev deployment`);
  }

  const custom = generateProdConfigs(withConfig({
    publicBaseUrl: "https://studio.example.com",
    route: { customDomain: "studio.example.com" },
  }), PACKAGES);
  const router = custom.get("router")!;
  assert.equal(router.workers_dev, false);
  assert.deepEqual(router.routes, [{ pattern: "studio.example.com", custom_domain: true }]);
  assert.equal(custom.get("workshop-backend")!.routes, undefined);
});

test("the backend binds its storage by id, Workers AI and every gatekeeper", () => {
  const backend = generateProdConfigs(BASE, PACKAGES).get("workshop-backend")!;
  assert.deepEqual(backend.kv_namespaces, [
    { binding: "BLUEPRINTS", id: KV_A },
    { binding: "AVATARS", id: KV_B },
  ]);
  assert.deepEqual(backend.r2_buckets, [
    { binding: "BLUEPRINT_CONTENT", bucket_name: "thoughtful-blueprint-content" },
  ]);
  assert.deepEqual(backend.ai, { binding: "WORKERS_AI" });
  assert.deepEqual(backend.services, [{
    binding: "GATEKEEPER_MCP", service: "thoughtful-gatekeeper-mcp", entrypoint: "GatekeeperVendor",
  }]);
  assert.deepEqual(backend.vars, {
    ADMINS: ["brandon"],
    PUBLIC_BASE_URL: "https://thoughtful-router.example.workers.dev",
  });
  assert.equal(backend.assets, undefined, "the router serves the frontend");
  // The dev file's bindings that need no account-specific value pass through as they are.
  const dev = devConfig("workshop-backend");
  assert.deepEqual(backend.browser, dev.browser);
  assert.deepEqual(backend.worker_loaders, dev.worker_loaders);
});

test("the router binds the backend and every gatekeeper by Worker name and keeps its assets", () => {
  const router = generateProdConfigs(BASE, PACKAGES).get("router")!;
  assert.deepEqual(router.services, [
    { binding: "WORKSHOP_BACKEND", service: "thoughtful-workshop-backend" },
    { binding: "GATEKEEPER_MCP", service: "thoughtful-gatekeeper-mcp" },
  ]);
  assert.deepEqual(router.assets, devConfig("router").assets);
});

test("a gatekeeper is mounted under the router's origin and keeps its own vars", () => {
  const mcp = generateProdConfigs(BASE, PACKAGES).get("gatekeeper-mcp")!;
  assert.deepEqual(mcp.vars, {
    ...devConfig("gatekeeper-mcp").vars,
    BASE_URL: "https://thoughtful-router.example.workers.dev/gatekeeper/mcp",
  });
  assert.equal(mcp.services, undefined);
});

test("gatekeeper sign-in and feature flags become the backend's vars", () => {
  const configs = generateProdConfigs(GOOGLE, PACKAGES);
  assert.deepEqual([...configs.keys()],
    ["gatekeeper-mcp", "gatekeeper-google", "workshop-backend", "router"]);
  assert.deepEqual(configs.get("workshop-backend")!.vars, {
    ADMINS: ["someone@example.com"],
    PUBLIC_BASE_URL: "https://thoughtful-router.example.workers.dev",
    AUTH_GATEKEEPERS: "google",
    DISABLE_PASSWORD_AUTH: "true",
    ENABLE_CHATGPT_SUBSCRIPTION_LOGIN: "true",
  });
  assert.equal(configs.get("gatekeeper-google")!.vars!.BASE_URL,
    "https://thoughtful-router.example.workers.dev/gatekeeper/google");
});

test("a gatekeeper with KV of its own needs an id from deployment.jsonc", () => {
  const context = withConfig({ gatekeepers: ["context"] });
  assert.throws(() => generateProdConfigs(context, PACKAGES),
    /gatekeeperKvNamespaceIds\.CONTEXT_COLLECTIONS/);

  const withId = withConfig({
    gatekeepers: ["context"],
    resources: { ...BASE.resources, gatekeeperKvNamespaceIds: { CONTEXT_COLLECTIONS: KV_A } },
  });
  const gatekeeper = generateProdConfigs(withId, PACKAGES).get("gatekeeper-context")!;
  assert.deepEqual(gatekeeper.kv_namespaces, [{ binding: "CONTEXT_COLLECTIONS", id: KV_A }]);
  assert.equal(gatekeeper.artifacts, undefined, "closed beta, cut as the hosted deploy cuts it");
  assert.deepEqual(generateProdConfigs(withId, PACKAGES).get("workshop-backend")!.services, [{
    binding: "GATEKEEPER_CONTEXT", service: "thoughtful-gatekeeper-context",
    entrypoint: "GatekeeperVendor",
    props: { sharingDomain: "https://thoughtful-router.example.workers.dev" },
  }]);
});

test("no generated config carries a Miniflare preview id", () => {
  for (const [name, config] of generateProdConfigs(GOOGLE, PACKAGES)) {
    for (const entry of config.kv_namespaces ?? []) {
      assert.equal(entry.preview_id, undefined, `${name}: ${entry.binding}`);
      assert.ok(entry.id, `${name}: ${entry.binding} has no id`);
    }
  }
});

test("a rendered config is JSONC that wrangler parses back to the same object", () => {
  const router = generateProdConfigs(BASE, PACKAGES).get("router")!;
  const text = renderProdConfig(router);
  assert.match(text, /^\/\/ Generated by scripts\/deploy\/prod-config\.ts/);
  assert.deepEqual(parse(text), router);
});

const REJECTED: [string, DeploymentConfig, RegExp][] = [
  ["a placeholder", withConfig({ admins: ["<admin-username>"] }), /placeholder <admin-username>/],
  ["both routes", withConfig({ route: { workersDev: true, customDomain: "a.example.com" } }),
    /exactly one/],
  ["no route", withConfig({ route: {} }), /exactly one/],
  ["an http origin", withConfig({ publicBaseUrl: "http://thoughtful-router.example.workers.dev" }),
    /HTTPS origin/],
  ["a path on the origin", withConfig({ publicBaseUrl: "https://thoughtful-router.example.workers.dev/" }),
    /no path/],
  ["an origin that is not the custom domain", withConfig({
    publicBaseUrl: "https://other.example.com", route: { customDomain: "studio.example.com" },
  }), /does not match route\.customDomain/],
  ["a workers.dev origin naming another Worker", withConfig({
    publicBaseUrl: "https://router.example.workers.dev",
  }), /must be https:\/\/thoughtful-router\.<subdomain>\.workers\.dev/],
  ["a gatekeeper that does not exist", withConfig({ gatekeepers: ["figma"] }),
    /no packages\/gatekeeper-figma\/wrangler\.jsonc/],
  ["an auth gatekeeper that is not deployed", withConfig({
    auth: { gatekeepers: ["google"] }, admins: ["someone@example.com"],
  }), /not deployed/],
  ["password sign-in disabled with nothing to replace it", withConfig({
    auth: { gatekeepers: [], disablePasswordAuth: true },
  }), /no way to sign in/],
  ["an admin that is not a username", withConfig({ admins: ["Brandon"] }), /not a username/],
  ["an admin that is not an email under gatekeeper sign-in",
    { ...GOOGLE, admins: ["brandon"] }, /not an email/],
  ["no admins", withConfig({ admins: [] }), /non-empty/],
  ["a bad bucket name", withConfig({
    resources: { ...BASE.resources, blueprintContentBucket: "Bad_Bucket" },
  }), /blueprintContentBucket/],
  ["a name prefix wrangler rejects", withConfig({ namePrefix: "Thoughtful_" }), /namePrefix/],
];

for (const [what, config, message] of REJECTED) {
  test(`rejects ${what}`, () => {
    assert.throws(() => validateConfig(config, PACKAGES), message);
  });
}

/** Package.json names as the build looks them up; the real ones are irrelevant to the shape. */
const names = (dir: string) => `@gadgets/${dir}`;

test("each target builds what its wrangler deploy needs, never from cache", () => {
  const router = buildSteps("router", names);
  assert.deepEqual(router.map((step) => step.args.at(-3)),
    ["@gadgets/typed-storage", "@gadgets/workshop-frontend", "@gadgets/router"]);
  assert.deepEqual(router[1].unsetEnv, ["VITE_CF_ACCESS_MODE"],
    "the frontend must be built for the app's own login page");

  const backend = buildSteps("workshop-backend", names);
  assert.deepEqual(backend.at(-1), { args: ["run", "build:worker"], cwd: "packages/workshop-backend" });

  const gatekeeper = buildSteps("gatekeeper-mcp", names);
  assert.equal(gatekeeper[1].args.at(-3), "@gadgets/gatekeeper-mcp");
  assert.deepEqual(gatekeeper.at(-1), {
    args: ["exec", "capnweb-validate", "build", "--out", ".wrangler/validate"],
    cwd: "packages/gatekeeper-mcp",
  });

  for (const step of [...router, ...backend, ...gatekeeper]) {
    if (step.args.includes("vp")) {
      assert.ok(step.args.includes("--no-cache"), `${step.args.join(" ")}: deploys never replay cache`);
    }
  }
  assert.throws(() => buildSteps("workshop-frontend", names), /Unknown build target/);
});
