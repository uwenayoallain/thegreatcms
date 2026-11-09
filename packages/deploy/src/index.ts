/** `greatcms-deploy`: watch a repository, build every new commit, keep the live folder whole. */

import { Deployer, readStatus, type DeployOptions } from "./deploy.js";

export { Deployer, readStatus } from "./deploy.js";
export { PreviewRunner, createPreviewServer, previewMain, waitingPage } from "./preview.js";
export type { PreviewOptions, PreviewState } from "./preview.js";
export { createPreviewSitesServer, devCommand, PreviewSites, SiteList } from "./previews.js";
export type { PreviewSite, PreviewSitesOptions } from "./previews.js";
export type { DeployOptions, Outcome, Release, Status } from "./deploy.js";

const HELP = `greatcms-deploy: build a site on every new commit and swap it live.

  greatcms-deploy            watch forever (the normal way to run it)
  greatcms-deploy once       build the branch tip if it is not live, then exit
  greatcms-deploy status     print status.json
  greatcms-deploy releases   list the releases kept on disk, newest first
  greatcms-deploy rollback <sha>   put an earlier release back live until the next commit

Environment:
  DEPLOY_SOURCE    repository: a path on this machine, or a URL git can clone   (required)
  DEPLOY_ROOT      where releases/, current and status.json live               (required)
  DEPLOY_BUILD     shell command run in the checkout      (default: pnpm install --frozen-lockfile && pnpm build)
  DEPLOY_OUTPUT    folder the build writes, in the checkout                     (default: dist)
  DEPLOY_BRANCH    (default: main)
  DEPLOY_INTERVAL  seconds between checks                                       (default: 10)
  DEPLOY_KEEP      releases to keep for rollback                                (default: 5)
  DEPLOY_TIMEOUT   seconds a build may take                                     (default: 900)

Serve DEPLOY_ROOT/current with any web server. A failed build leaves the previous release live.
Writing a commit sha into DEPLOY_ROOT/rollback asks the watcher to roll back to it; the studio does
this when it can reach DEPLOY_ROOT.
`;

export function optionsFromEnv(env: NodeJS.ProcessEnv): DeployOptions {
  const missing = ["DEPLOY_SOURCE", "DEPLOY_ROOT"].filter((name) => !env[name]);
  if (missing.length) throw new Error(`${missing.join(" and ")} must be set.\n\n${HELP}`);
  const seconds = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`${name} must be a positive number.`);
    return value;
  };
  return {
    source: env.DEPLOY_SOURCE as string,
    root: env.DEPLOY_ROOT as string,
    branch: env.DEPLOY_BRANCH || "main",
    build: env.DEPLOY_BUILD || "pnpm install --frozen-lockfile && pnpm build",
    output: env.DEPLOY_OUTPUT || "dist",
    keep: seconds("DEPLOY_KEEP", 5),
    timeout: seconds("DEPLOY_TIMEOUT", 900) * 1000,
    log: (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`),
  };
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const command = argv[0] ?? "watch";
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  let options: DeployOptions;
  try {
    options = optionsFromEnv(env);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(readStatus(options.root), null, 2)}\n`);
    return 0;
  }
  const deployer = new Deployer(options);
  if (command === "rollback") {
    const ok = await deployer.rollback(argv[1] ?? "");
    if (!ok) process.stderr.write("No such release. `greatcms-deploy releases` lists them.\n");
    return ok ? 0 : 1;
  }
  if (command === "releases") {
    process.stdout.write(`${deployer.releases().join("\n")}\n`);
    return 0;
  }
  if (command === "once") {
    const result = await deployer.once();
    return result.outcome === "failed" ? 1 : 0;
  }
  if (command !== "watch") {
    process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
    return 1;
  }

  const interval = Number(env.DEPLOY_INTERVAL || 10) * 1000;
  options.log(
    `watching ${options.source} (${options.branch}) every ${interval / 1000}s; serving ${options.root}/current`,
  );
  // One check at a time, the next scheduled only after this one has finished.
  return new Promise<number>((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const stop = () => {
      clearTimeout(timer);
      resolve(0);
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
    const check = () =>
      deployer
        .takeRequest()
        .then(() => deployer.once())
        .catch((error: Error) => options.log(`check failed: ${error.message.split("\n")[0]}`))
        .then(() => {
          timer = setTimeout(check, interval);
        });
    void check();
  });
}
