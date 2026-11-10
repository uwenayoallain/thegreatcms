/** The GitHub App's token goes to the host it was minted for, and to no other, whatever git is told. */

import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHub } from "../src/github.js";
import { withGitConfig } from "../src/repo.js";

const seen: Array<{ server: string; url: string; authorization: string | undefined }> = [];
let home: Server;
let elsewhere: Server;
let dir: string;
let github: GitHub;

const listen = (name: string, redirectTo?: () => string) =>
  new Promise<Server>((resolve) => {
    const server = createServer((request, response) => {
      seen.push({
        server: name,
        url: request.url ?? "",
        authorization: request.headers.authorization,
      });
      if (redirectTo && request.url?.startsWith("/acme/moved")) {
        response.writeHead(302, { location: `${redirectTo()}${request.url}` }).end();
      } else if (name === "elsewhere" && request.url?.includes("/info/refs")) {
        // Enough of protocol v2 for git to carry on and post its next request here.
        response
          .writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" })
          .end("000eversion 2\n000cls-refs\n0000");
      } else {
        response.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
const origin = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** `git ls-remote` with the config the studio would send for this address. */
const ask = async (url: string, extra: Array<[string, string]> = []) => {
  seen.length = 0;
  const config = [...(await github.gitConfigFor(url)), ...extra];
  await new Promise<void>((resolve) =>
    execFile(
      "git",
      ["ls-remote", url],
      {
        env: withGitConfig(
          { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: dir },
          config,
        ),
      },
      () => resolve(),
    ),
  );
  return [...seen];
};

beforeAll(async () => {
  elsewhere = await listen("elsewhere");
  home = await listen("home", () => origin(elsewhere));
  dir = mkdtempSync(join(tmpdir(), "greatcms-auth-scope-"));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const file = join(dir, "github-app.json");
  writeFileSync(
    file,
    JSON.stringify({
      id: 1,
      slug: "studio",
      clientId: "Iv1",
      pem: privateKey.export({ type: "pkcs1", format: "pem" }),
      htmlUrl: `${origin(home)}/apps/studio`,
      owner: "acme",
      ownerType: "User",
    }),
  );
  github = new GitHub(file, origin(home), (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    const body = path.endsWith("/access_tokens")
      ? { token: "ghs_secret", expires_at: new Date(Date.now() + 3_600_000).toISOString() }
      : [{ id: 7, account: { login: "acme" } }];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch);
});

afterAll(() => {
  home.close();
  elsewhere.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the app's token", () => {
  it("is sent to a repository on its own host", async () => {
    const requests = await ask(`${origin(home)}/acme/site.git`);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.authorization?.startsWith("basic "))).toBe(true);
  });

  it("is not made for another host, another port, or an account it is not installed on", async () => {
    expect(await github.gitConfigFor(`${origin(elsewhere)}/acme/site.git`)).toEqual([]);
    expect(await github.gitConfigFor("http://127.0.0.1.example.com/acme/site.git")).toEqual([]);
    expect(await github.gitConfigFor(`${origin(home)}/someone-else/site.git`)).toEqual([]);
  });

  it("stays behind when git is pointed at another host with the same config", async () => {
    const config = await github.gitConfigFor(`${origin(home)}/acme/site.git`);
    const requests = await ask(`${origin(elsewhere)}/acme/site.git`, config);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.authorization === undefined)).toBe(true);
  });

  it("does not follow a redirect to another host, which git would then send it to", async () => {
    const requests = await ask(`${origin(home)}/acme/moved.git`);
    expect(requests.map((request) => request.server)).toEqual(["home"]);
  });
});
