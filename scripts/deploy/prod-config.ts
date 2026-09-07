#!/usr/bin/env node

// Generates a `wrangler.prod.jsonc` beside the `wrangler.jsonc` of every Worker this fork deploys
// -- the router, the backend and the gatekeepers listed in `deployment.jsonc` -- for Cloudflare
// Workers Builds to deploy with `wrangler deploy --config wrangler.prod.jsonc`.
//
//   node scripts/deploy/prod-config.ts        write every generated config
//
// The committed wrangler.jsonc files describe local development: KV entries carry a Miniflare
// `preview_id` and no namespace id, the backend has no Workers AI binding, nothing binds a
// gatekeeper, and no Worker has a route. This is the production overlay, in the shape of the
// upstream starter's `generateConfigs` and this repo's preview generator
// (scripts/preview/staging-config.ts): migrations, compatibility flags and every binding the dev
// file declares flow through unchanged, so an upstream change to either needs no edit here.
//
// Nothing account-specific is read from the environment. Workers Builds supplies the account and
// API token to wrangler itself; everything else is in deployment.jsonc, which is committed.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import {
  gatekeeperShortName, isGatekeeperPackage, readDeployablePackages,
  type BindingDecl, type DeployablePackage, type ServiceBinding, type WranglerConfig,
} from "../release/manifest-lib.ts";

/** The repository root. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The directory holding every deployable package. */
export const PACKAGES_DIR = join(ROOT, "packages");

/** The committed deployment settings. */
export const DEPLOYMENT_CONFIG_PATH = join(ROOT, "deployment.jsonc");

/** The generated per-package config file name (gitignored: it is build output). */
export const PROD_CONFIG_NAME = "wrangler.prod.jsonc";

/** The two Workers every deployment has, besides its gatekeepers. */
export const ROUTER_PACKAGE = "router";
export const BACKEND_PACKAGE = "workshop-backend";

/** Where the router answers: a workers.dev hostname, or a custom domain on the account's zone. */
export interface RouterRoute {
  workersDev?: boolean;
  customDomain?: string;
}

/** The shape of deployment.jsonc. */
export interface DeploymentConfig {
  /** The router's origin: `https://host`, no path. */
  publicBaseUrl: string;
  /** Exactly one of the two. */
  route: RouterRoute;
  /** Prepended to each package name to form its Worker name. */
  namePrefix?: string;
  /**
   * The router's Worker name, when it should not be `namePrefix + "router"`. The router is the one
   * Worker whose name is visible -- it is the workers.dev hostname -- so it is the one worth
   * choosing; every other name only appears in bindings.
   */
  routerName?: string;
  /** Gatekeepers to deploy, by short name (`mcp` is `gatekeeper-mcp`). */
  gatekeepers: string[];
  /** Accounts given the Admin menu: usernames, or emails once an auth gatekeeper is listed. */
  admins: string[];
  /** Sign-in options. */
  auth?: {
    /** Short names of gatekeepers offered as "Continue with ..." buttons. Subset of `gatekeepers`. */
    gatekeepers?: string[];
    /** Hide username/password. Honoured by the backend only when `gatekeepers` is non-empty. */
    disablePasswordAuth?: boolean;
  };
  /** Storage the backend binds, created once in the dashboard. */
  resources: {
    blueprintsKvNamespaceId: string;
    avatarsKvNamespaceId: string;
    blueprintContentBucket: string;
    /** Ids for KV namespaces a deployed gatekeeper declares, keyed by binding name. */
    gatekeeperKvNamespaceIds?: Record<string, string>;
  };
  /** Backend feature flags. */
  features?: {
    chatGptSubscriptionLogin?: boolean;
  };
}

/** A KV entry as the generated config carries it: the dev file's `preview_id` is dropped. */
export interface KvNamespaceBinding extends BindingDecl {
  id?: string;
  preview_id?: string;
}

/** An R2 entry in a generated config. */
export interface R2BucketBinding extends BindingDecl {
  bucket_name?: string;
}

/** A generated `wrangler.prod.jsonc`: the dev config plus the keys production adds. */
export interface ProdConfig extends WranglerConfig {
  /** Whether the Worker gets a workers.dev hostname. Only the router may. */
  workers_dev?: boolean;
  /** Whether versions get preview URLs. Off everywhere: the router is the only public origin. */
  preview_urls?: boolean;
  /** The router's custom domain, when it has one. */
  routes?: { pattern: string; custom_domain: boolean }[];
  /** Workers AI, bound on the backend for webFetch's document-to-Markdown conversion. */
  ai?: BindingDecl;
  kv_namespaces?: KvNamespaceBinding[];
  r2_buckets?: R2BucketBinding[];
  /** Passed through untouched from the committed config. */
  unsafe?: unknown;
}

/** The part of a deployable package the generator reads. */
export type PackageConfig = Pick<DeployablePackage, "name" | "config">;

const PLACEHOLDER = /<[^>]+>/;
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HOSTNAME =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// The backend's `normalizeUsername` lowercases and then requires this shape, so an ADMINS entry
// outside it can never match a password account.
const USERNAME = /^[a-z][a-z0-9_]*$/;
const BUCKET_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61})[a-z0-9]$/;

/** The Worker name a package deploys under. */
export function workerName(config: DeploymentConfig, pkgName: string): string {
  if (pkgName === ROUTER_PACKAGE && config.routerName) return config.routerName;
  return `${config.namePrefix ?? ""}${pkgName}`;
}

/** `gatekeeper-<short>` for a short name from deployment.jsonc. */
export function gatekeeperPackageName(shortName: string): string {
  return `gatekeeper-${shortName}`;
}

/**
 * The service binding name a gatekeeper is bound as: `gatekeeper-mcp` -> `GATEKEEPER_MCP`. The
 * router (router/src/index.ts) and the backend (buildGatekeeperVendorMap) both discover
 * gatekeepers by scanning for this prefix, so the name is the wiring.
 */
export function gatekeeperBindingName(pkgName: string): string {
  return pkgName.toUpperCase().replaceAll("-", "_");
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(`${path} must be a non-empty string with no surrounding whitespace.`);
  }
  return value;
}

/**
 * Check deployment.jsonc against the packages it names. Every message names the config path it
 * is about, since a failed Workers Build shows nothing but this script's output.
 */
export function validateConfig(
  config: DeploymentConfig,
  packages: readonly PackageConfig[],
): DeploymentConfig {
  const placeholder = JSON.stringify(config).match(PLACEHOLDER)?.[0];
  if (placeholder) {
    throw new Error(
      `deployment.jsonc still contains the placeholder ${placeholder}. Replace it with a real value.`);
  }

  const prefix = config.namePrefix ?? "";
  if (typeof prefix !== "string" || !/^[a-z0-9-]*$/.test(prefix)) {
    throw new Error("namePrefix must use lowercase letters, numbers and hyphens.");
  }
  if (config.routerName !== undefined && !WORKER_NAME.test(config.routerName)) {
    throw new Error("routerName must be a legal Worker name: lowercase letters, numbers and hyphens.");
  }
  const routerName = workerName(config, ROUTER_PACKAGE);
  const backendName = workerName(config, BACKEND_PACKAGE);
  for (const name of [routerName, backendName]) {
    if (!WORKER_NAME.test(name)) throw new Error(`Worker name "${name}" is not a legal name.`);
  }

  const route = config.route;
  if (!route || typeof route !== "object" ||
      Boolean(route.workersDev) === Boolean(route.customDomain)) {
    throw new Error("route must set exactly one of workersDev: true or customDomain.");
  }
  if (route.workersDev !== undefined && route.workersDev !== true) {
    throw new Error("route.workersDev must be true when selected.");
  }
  if (route.customDomain !== undefined && !HOSTNAME.test(route.customDomain)) {
    throw new Error("route.customDomain must be a lowercase hostname.");
  }

  const base = requireString(config.publicBaseUrl, "publicBaseUrl");
  let origin: string;
  try {
    origin = new URL(base).origin;
  } catch {
    throw new Error("publicBaseUrl must be an HTTPS origin such as https://studio.example.com.");
  }
  if (!base.startsWith("https://") || origin !== base) {
    throw new Error("publicBaseUrl must be an HTTPS origin only: no path and no trailing slash.");
  }
  if (route.customDomain && base !== `https://${route.customDomain}`) {
    throw new Error(
      `publicBaseUrl (${base}) does not match route.customDomain (${route.customDomain}). ` +
      "The router answers on the custom domain, so that is the only correct origin.");
  }
  if (route.workersDev) {
    // The account's workers.dev subdomain is not knowable here, but the rest of the host is:
    // wrangler serves the Worker at <worker>.<subdomain>.workers.dev, so anything else is a typo
    // that would become PUBLIC_BASE_URL and break every absolute link and OAuth redirect.
    const [worker, subdomain, ...suffix] = new URL(base).host.split(".");
    if (suffix.join(".") !== "workers.dev" || !subdomain || worker !== routerName) {
      throw new Error(
        `publicBaseUrl (${base}) is not the router's workers.dev origin. On a workersDev route it ` +
        `must be https://${routerName}.<subdomain>.workers.dev.`);
    }
  }

  if (!isStringList(config.gatekeepers)) {
    throw new Error("gatekeepers must be an array of gatekeeper short names.");
  }
  const available = new Set(packages.map((pkg) => pkg.name).filter(isGatekeeperPackage));
  for (const shortName of config.gatekeepers) {
    const pkgName = gatekeeperPackageName(shortName);
    if (!available.has(pkgName)) {
      throw new Error(
        `gatekeepers names "${shortName}", but there is no packages/${pkgName}/wrangler.jsonc. ` +
        `Available: ${[...available].map(gatekeeperShortName).join(", ")}.`);
    }
    if (!WORKER_NAME.test(workerName(config, pkgName))) {
      throw new Error(`Worker name "${workerName(config, pkgName)}" is not a legal name.`);
    }
  }
  if (new Set(config.gatekeepers).size !== config.gatekeepers.length) {
    throw new Error("gatekeepers lists a gatekeeper twice.");
  }

  const authGatekeepers = config.auth?.gatekeepers ?? [];
  if (!isStringList(authGatekeepers)) {
    throw new Error("auth.gatekeepers must be an array of gatekeeper short names.");
  }
  for (const shortName of authGatekeepers) {
    if (!config.gatekeepers.includes(shortName)) {
      throw new Error(
        `auth.gatekeepers names "${shortName}", which is not deployed. Add it to gatekeepers too.`);
    }
  }
  const disablePasswordAuth = config.auth?.disablePasswordAuth ?? false;
  if (typeof disablePasswordAuth !== "boolean") {
    throw new Error("auth.disablePasswordAuth must be a boolean.");
  }
  if (disablePasswordAuth && authGatekeepers.length === 0) {
    // The backend ignores the flag in this state rather than locking everyone out, so the
    // deployment would silently keep password sign-in on. Say so here instead.
    throw new Error(
      "auth.disablePasswordAuth is true but auth.gatekeepers is empty: there would be no way to " +
      "sign in. List an auth gatekeeper (for example \"google\") or set it to false.");
  }

  if (!isStringList(config.admins) || config.admins.length === 0) {
    throw new Error("admins must be a non-empty array.");
  }
  for (const admin of config.admins) {
    if (authGatekeepers.length === 0) {
      if (!USERNAME.test(admin)) {
        throw new Error(
          `admins entry "${admin}" is not a username. With password sign-in, admins are the ` +
          "usernames the team registers with: lowercase letters, digits and underscores, starting " +
          "with a letter.");
      }
    } else if (!/^[^@\s]+@[^@\s]+$/.test(admin)) {
      throw new Error(
        `admins entry "${admin}" is not an email address. With gatekeeper sign-in, accounts are ` +
        "keyed by verified email, so admins must be emails.");
    }
  }

  const resources = config.resources;
  if (!resources || typeof resources !== "object") {
    throw new Error("resources must be an object.");
  }
  requireString(resources.blueprintsKvNamespaceId, "resources.blueprintsKvNamespaceId");
  requireString(resources.avatarsKvNamespaceId, "resources.avatarsKvNamespaceId");
  const bucket = requireString(resources.blueprintContentBucket, "resources.blueprintContentBucket");
  if (!BUCKET_NAME.test(bucket)) {
    throw new Error(
      "resources.blueprintContentBucket must be 3-63 lowercase letters, numbers and hyphens.");
  }
  const gatekeeperKv = resources.gatekeeperKvNamespaceIds ?? {};
  if (typeof gatekeeperKv !== "object" || gatekeeperKv === null || Array.isArray(gatekeeperKv)) {
    throw new Error("resources.gatekeeperKvNamespaceIds must be an object keyed by binding name.");
  }
  for (const [binding, id] of Object.entries(gatekeeperKv)) {
    requireString(id, `resources.gatekeeperKvNamespaceIds.${binding}`);
  }

  const chatGpt = config.features?.chatGptSubscriptionLogin ?? false;
  if (typeof chatGpt !== "boolean") {
    throw new Error("features.chatGptSubscriptionLogin must be a boolean.");
  }
  return config;
}

/** The packages this deployment deploys, in the order their first deploy must happen. */
export function deployedPackages(
  config: DeploymentConfig,
  packages: readonly PackageConfig[],
): PackageConfig[] {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const pick = (name: string): PackageConfig => {
    const pkg = byName.get(name);
    if (!pkg) throw new Error(`packages/${name}/wrangler.jsonc is missing.`);
    return pkg;
  };
  // Gatekeepers first and the router last: a deploy fails when a service binding names a Worker
  // that does not exist yet, and the router binds every other one.
  return [
    ...config.gatekeepers.map((shortName) => pick(gatekeeperPackageName(shortName))),
    pick(BACKEND_PACKAGE),
    pick(ROUTER_PACKAGE),
  ];
}

function setCommon(prod: ProdConfig, config: DeploymentConfig, pkgName: string): void {
  prod.name = workerName(config, pkgName);
  // The router is the only public origin; a workers.dev hostname or a preview URL on any other
  // Worker is an unauthenticated path around it.
  prod.workers_dev = false;
  prod.preview_urls = false;
  delete prod.routes;
  // The dev file's custom build command is run by scripts/deploy/build.ts before wrangler is
  // invoked, so wrangler must not run it a second time. Workers Builds also documents that it
  // does not honour custom builds, so leaving it in would make the two paths differ.
  delete prod.build;
  delete prod.$schema;
}

/** Strip the Miniflare `preview_id`s the dev files carry; production KV entries carry an `id`. */
function kvWithIds(
  entries: KvNamespaceBinding[] | undefined,
  idFor: (binding: string) => string,
): KvNamespaceBinding[] | undefined {
  if (!entries) return undefined;
  return entries.map(({ binding }) => ({ binding, id: idFor(binding) }));
}

function backendVars(config: DeploymentConfig, dev: WranglerConfig): Record<string, unknown> {
  const authGatekeepers = config.auth?.gatekeepers ?? [];
  return {
    ...dev.vars,
    // A JSON array var; the backend also accepts a string that parses as one.
    ADMINS: config.admins,
    // The backend has no public route of its own, so the router's origin is the only correct
    // value: OAuth redirect URIs and absolute links are built from it.
    PUBLIC_BASE_URL: config.publicBaseUrl,
    ...(authGatekeepers.length > 0 ? { AUTH_GATEKEEPERS: authGatekeepers.join(",") } : {}),
    ...(config.auth?.disablePasswordAuth ? { DISABLE_PASSWORD_AUTH: "true" } : {}),
    ...(config.features?.chatGptSubscriptionLogin
      ? { ENABLE_CHATGPT_SUBSCRIPTION_LOGIN: "true" } : {}),
  };
}

// How the backend calls gatekeepers: the GatekeeperVendor RPC entrypoint. The Context gatekeeper
// scopes its shared collections by the `sharingDomain` prop (packages/gatekeeper-context/src/
// domain.ts); the public origin is what the hosted deploy uses.
function backendGatekeeperServices(config: DeploymentConfig): ServiceBinding[] {
  return config.gatekeepers.map((shortName) => {
    const pkgName = gatekeeperPackageName(shortName);
    return {
      binding: gatekeeperBindingName(pkgName),
      service: workerName(config, pkgName),
      entrypoint: "GatekeeperVendor",
      ...(pkgName === "gatekeeper-context"
        ? { props: { sharingDomain: config.publicBaseUrl } } : {}),
    };
  });
}

// How the router calls gatekeepers: the default entrypoint, since it forwards whole HTTP requests.
// The binding name is what picks the /gatekeeper/<short> path.
function routerGatekeeperServices(config: DeploymentConfig): ServiceBinding[] {
  return config.gatekeepers.map((shortName) => {
    const pkgName = gatekeeperPackageName(shortName);
    return { binding: gatekeeperBindingName(pkgName), service: workerName(config, pkgName) };
  });
}

function generateRouter(config: DeploymentConfig, dev: WranglerConfig): ProdConfig {
  const prod: ProdConfig = structuredClone(dev);
  setCommon(prod, config, ROUTER_PACKAGE);
  if (config.route.customDomain) {
    prod.routes = [{ pattern: config.route.customDomain, custom_domain: true }];
  } else {
    prod.workers_dev = true;
  }
  prod.services = [
    { binding: "WORKSHOP_BACKEND", service: workerName(config, BACKEND_PACKAGE) },
    ...routerGatekeeperServices(config),
  ];
  return prod;
}

function generateBackend(config: DeploymentConfig, dev: WranglerConfig): ProdConfig {
  const prod: ProdConfig = structuredClone(dev);
  setCommon(prod, config, BACKEND_PACKAGE);
  const ids: Record<string, string> = {
    BLUEPRINTS: config.resources.blueprintsKvNamespaceId,
    AVATARS: config.resources.avatarsKvNamespaceId,
  };
  prod.kv_namespaces = kvWithIds(prod.kv_namespaces, (binding) => {
    const id = ids[binding];
    if (!id) {
      throw new Error(
        `workshop-backend binds KV namespace ${binding}, which deployment.jsonc has no id for.`);
    }
    return id;
  });
  prod.r2_buckets = prod.r2_buckets?.map(({ binding }) => ({
    binding, bucket_name: config.resources.blueprintContentBucket,
  }));
  // As well as the AI Gateway transport, this binding is what webFetch's toMarkdown() runs on.
  prod.ai = { binding: "WORKERS_AI" };
  prod.services = backendGatekeeperServices(config);
  prod.vars = backendVars(config, dev);
  // The router serves the frontend; the backend has no public route.
  delete prod.assets;
  return prod;
}

function generateGatekeeper(
  config: DeploymentConfig,
  pkgName: string,
  dev: WranglerConfig,
): ProdConfig {
  const prod: ProdConfig = structuredClone(dev);
  setCommon(prod, config, pkgName);
  prod.vars = {
    ...dev.vars,
    // Every gatekeeper is mounted under the router's origin, exactly as the hosted deploy and
    // the preview generator place it.
    BASE_URL: `${config.publicBaseUrl}/gatekeeper/${gatekeeperShortName(pkgName)}`,
  };
  prod.kv_namespaces = kvWithIds(prod.kv_namespaces, (binding) => {
    const id = config.resources.gatekeeperKvNamespaceIds?.[binding];
    if (!id) {
      throw new Error(
        `${pkgName} binds KV namespace ${binding}. Create it in the dashboard and add its id ` +
        `under resources.gatekeeperKvNamespaceIds.${binding} in deployment.jsonc.`);
    }
    return id;
  });
  if (prod.r2_buckets) {
    throw new Error(`${pkgName} binds R2, which this generator does not provision.`);
  }
  // Closed beta; the gatekeeper degrades gracefully without it, as it does on hosted instances.
  delete prod.artifacts;
  return prod;
}

/**
 * Build every deployed package's production config. Pure: `packages` is `[{ name, config }]` with
 * `config` the parsed wrangler.jsonc, and the result maps package name to its generated config
 * in first-deploy order.
 */
export function generateProdConfigs(
  config: DeploymentConfig,
  packages: readonly PackageConfig[],
): Map<string, ProdConfig> {
  validateConfig(config, packages);
  const configs = new Map<string, ProdConfig>();
  for (const pkg of deployedPackages(config, packages)) {
    if (pkg.config.name !== pkg.name) {
      // Every service binding here is derived from the package directory name, so a Worker whose
      // own name diverges from it would be silently misconfigured rather than merely renamed.
      throw new Error(
        `${pkg.name}/wrangler.jsonc declares worker name "${pkg.config.name}"; the generator ` +
        "requires them to match.");
    }
    if (pkg.name === ROUTER_PACKAGE) {
      configs.set(pkg.name, generateRouter(config, pkg.config));
    } else if (pkg.name === BACKEND_PACKAGE) {
      configs.set(pkg.name, generateBackend(config, pkg.config));
    } else {
      configs.set(pkg.name, generateGatekeeper(config, pkg.name, pkg.config));
    }
  }
  return configs;
}

/** Parse deployment.jsonc, reporting the first syntax error by offset. */
export function readDeploymentConfig(path: string = DEPLOYMENT_CONFIG_PATH): DeploymentConfig {
  const errors: ParseError[] = [];
  const config = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length) {
    throw new Error(
      `deployment.jsonc: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`);
  }
  return config as DeploymentConfig;
}

/** The text of a generated config file: a header naming its origin, then the JSON. */
export function renderProdConfig(prod: ProdConfig): string {
  return "// Generated by scripts/deploy/prod-config.ts from deployment.jsonc and this package's\n" +
    "// wrangler.jsonc. Do not edit: it is gitignored and rewritten on every deploy build.\n" +
    JSON.stringify(prod, null, 2) + "\n";
}

/**
 * Generate and write every deployed package's `wrangler.prod.jsonc`. Returns the written paths in
 * first-deploy order.
 */
export function writeProdConfigs(
  config: DeploymentConfig = readDeploymentConfig(),
  packagesDir: string = PACKAGES_DIR,
): string[] {
  const configs = generateProdConfigs(config, readDeployablePackages(packagesDir));
  const written: string[] = [];
  for (const [pkgName, prod] of configs) {
    const path = join(packagesDir, pkgName, PROD_CONFIG_NAME);
    writeFileSync(path, renderProdConfig(prod));
    written.push(path);
  }
  return written;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    for (const path of writeProdConfigs()) console.log(`wrote ${path}`);
  } catch (error) {
    // One line, no stack: every failure here is a configuration problem, not a script bug.
    console.error(`\nprod-config failed. ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
