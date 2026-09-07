#!/usr/bin/env node

// The build command of every Workers Builds project this fork deploys:
//
//   pnpm -w run deploy:build <package>      package: router | workshop-backend | gatekeeper-<short>
//
// It writes every `wrangler.prod.jsonc` (scripts/deploy/prod-config.ts) and then builds what the
// named package's `wrangler deploy` needs -- the frontend bundle the router serves as assets, the
// backend's validated entry point and browser runtime, a gatekeeper's configurator and validated
// entry point. The project's deploy command then runs
// `pnpm exec wrangler deploy --config wrangler.prod.jsonc` in the package directory.
//
// Every task runs through `vp run --no-cache`. A cache hit is only as correct as its fingerprint is
// complete, which is cheap to get wrong on a build you can re-run and expensive on a deploy you
// cannot; it is this repo's rule for the same reason (scripts/deploy-scripts.test.ts). Build
// machines start clean anyway, so nothing is lost.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isGatekeeperPackage, readDeployablePackages } from "../release/manifest-lib.ts";
import { pnpmCommand } from "../pnpm-command.ts";
import {
  BACKEND_PACKAGE, PACKAGES_DIR, PROD_CONFIG_NAME, ROOT, ROUTER_PACKAGE,
  deployedPackages, readDeploymentConfig, writeProdConfigs,
} from "./prod-config.ts";

/** One pnpm invocation of the build. */
export interface BuildStep {
  /** Arguments to pnpm. */
  args: string[];
  /** Directory to run in, relative to the repository root. */
  cwd: string;
  /** Variables removed from the environment for this step. */
  unsetEnv?: string[];
}

/** `vp run --no-cache <task>` for a workspace package, from the root. */
function vpTask(pkgJsonName: string, task = "build"): BuildStep {
  return { args: ["exec", "vp", "run", "-F", pkgJsonName, "--no-cache", task], cwd: "." };
}

/**
 * The steps that build `target`, given a way to look up a package directory's package.json name
 * (what `vp run -F` filters on).
 */
export function buildSteps(
  target: string,
  packageJsonName: (pkgDir: string) => string,
): BuildStep[] {
  // First for every target: `typed-storage` is the one package whose `exports` resolve to build
  // output, and wrangler bundles that `dist/index.js` rather than the sources.
  const steps = [vpTask(packageJsonName("typed-storage"))];
  if (target === ROUTER_PACKAGE) {
    steps.push({
      ...vpTask(packageJsonName("workshop-frontend")),
      // Access mode is a build-time constant in the bundle (workshop-frontend/src/useAuth.ts).
      // This deployment signs in on the app's own login page, so the flag must be absent even if
      // a build variable set it: a bundle built under the other value is wrong, not just stale.
      unsetEnv: ["VITE_CF_ACCESS_MODE"],
    });
    steps.push(vpTask(packageJsonName(ROUTER_PACKAGE)));
  } else if (target === BACKEND_PACKAGE) {
    // Type check, format blueprints and the browser runtime; then the validated entry point the
    // dev wrangler.jsonc names as `main` (its custom build command, run here because the generated
    // config drops it).
    steps.push(vpTask(packageJsonName(BACKEND_PACKAGE)));
    steps.push({ args: ["run", "build:worker"], cwd: `packages/${BACKEND_PACKAGE}` });
  } else if (isGatekeeperPackage(target)) {
    // `build` is the configurator codegen plus the type check; the validated entry point is the
    // dev config's custom build command, as for the backend.
    steps.push(vpTask(packageJsonName(target)));
    steps.push({
      args: ["exec", "capnweb-validate", "build", "--out", ".wrangler/validate"],
      cwd: `packages/${target}`,
    });
  } else {
    throw new Error(
      `Unknown build target "${target}". Expected router, workshop-backend or gatekeeper-<short>.`);
  }
  return steps;
}

function readPackageJsonName(pkgDir: string): string {
  const manifest = JSON.parse(readFileSync(join(PACKAGES_DIR, pkgDir, "package.json"), "utf8"));
  return manifest.name as string;
}

function run(step: BuildStep): void {
  const env = { ...process.env };
  for (const name of step.unsetEnv ?? []) delete env[name];
  const [command, argv] = pnpmCommand(step.args, env);
  console.log(`running: pnpm ${step.args.join(" ")} (in ${step.cwd})`);
  const result = spawnSync(command, argv, { cwd: join(ROOT, step.cwd), env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pnpm ${step.args.join(" ")} failed in ${step.cwd}. Its output is above.`);
  }
}

function main(): void {
  const target = process.argv[2];
  if (!target || process.argv.length > 3) {
    throw new Error("Usage: node scripts/deploy/build.ts <router|workshop-backend|gatekeeper-<short>>");
  }
  // Validates deployment.jsonc before any build time is spent, and writes every config so the
  // deploy command finds this package's.
  const config = readDeploymentConfig();
  const deployed = deployedPackages(config, readDeployablePackages(PACKAGES_DIR))
    .map((pkg) => pkg.name);
  if (!deployed.includes(target)) {
    throw new Error(
      `"${target}" is not deployed by deployment.jsonc. Deployed packages: ${deployed.join(", ")}.`);
  }
  for (const path of writeProdConfigs(config)) console.log(`wrote ${path}`);
  for (const step of buildSteps(target, readPackageJsonName)) run(step);
  console.log(`\n${target} is built. Deploy with: pnpm exec wrangler deploy --config ${PROD_CONFIG_NAME}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`\nDeploy build failed. ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
