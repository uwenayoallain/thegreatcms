/** Copy from Git looks a name up once, and git is held to the address that was checked. */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppOptions } from "../src/app.js";
import { Clones, cloneRoute, type SshLookup } from "../src/connect.js";
import { Store } from "../src/db.js";
import { PASSWORD, SECRET, signedIn } from "./site.js";

let root: string;
let server: Server | undefined;
const saved = { ...process.env };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "greatcms-clone-pin-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  server?.close();
  server = undefined;
  for (const name of ["GIT_SSH_COMMAND", "GIT_SSH"]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const PUBLIC = "93.184.215.14";
const plainSsh: SshLookup = async (hostname, port) => ({
  hostname,
  port: port ?? 22,
  proxied: false,
});

const aliased: SshLookup = async () => ({
  hostname: "ssh.git.example.com",
  port: 443,
  proxied: false,
});
const inside: SshLookup = async () => ({ hostname: "10.0.0.9", port: 22, proxied: false });
const jumped: SshLookup = async (hostname) => ({ hostname, port: 22, proxied: true });
const clone = (app: ReturnType<typeof createApp>, url: string) =>
  app.request("/sites/clone", {
    method: "POST",
    headers: { ...signedIn, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ url }),
  });

/** A name that answers with a public address the first time and a private one ever after. */
function rebinding() {
  let asked = 0;
  return {
    resolve: async () => (asked++ === 0 ? [PUBLIC] : ["127.0.0.1"]),
    asked: () => asked,
  };
}

describe("where a clone connects", () => {
  it("pins an https address to what the name resolved to, with its port", async () => {
    expect(
      await cloneRoute("https://git.example.com/me/site.git", [], async () => [PUBLIC]),
    ).toEqual({
      private: false,
      pin: [["http.curloptResolve", `git.example.com:443:${PUBLIC}`]],
    });
    expect(
      (
        await cloneRoute("http://git.example.com:8080/x.git", [], async () => [
          PUBLIC,
          "2606:4700::1111",
        ])
      ).pin,
    ).toEqual([["http.curloptResolve", `git.example.com:8080:${PUBLIC},[2606:4700::1111]`]]);
  });

  it("looks a name up once, so a second answer is never asked for", async () => {
    const name = rebinding();
    const route = await cloneRoute("https://rebind.example/x.git", [], name.resolve);
    expect(name.asked()).toBe(1);
    expect(route.pin).toEqual([["http.curloptResolve", `rebind.example:443:${PUBLIC}`]]);
  });

  it("pins an SSH address through ssh's own options, keeping the key filed under the name", async () => {
    delete process.env.GIT_SSH_COMMAND;
    const scp = await cloneRoute(
      "git@git.example.com:me/site.git",
      [],
      async () => [PUBLIC],
      plainSsh,
    );
    expect(scp.private).toBe(false);
    expect(scp.pin).toHaveLength(1);
    expect(scp.pin[0]?.[0]).toBe("core.sshCommand");
    expect(scp.pin[0]?.[1]).toMatch(
      new RegExp(
        ` -o HostName=${PUBLIC.replaceAll(".", "\\.")} -o HostKeyAlias=git\\.example\\.com$`,
      ),
    );

    const ported = await cloneRoute(
      "ssh://git@git.example.com:2222/me/site.git",
      [],
      async () => [PUBLIC],
      plainSsh,
    );
    expect(ported.pin[0]?.[1]).toContain("-o HostKeyAlias=[git.example.com]:2222");
  });

  it("keeps the operator's own ssh command in front of the pin", async () => {
    process.env.GIT_SSH_COMMAND = "ssh -i /keys/deploy";
    const route = await cloneRoute(
      "git@git.example.com:me/site.git",
      [],
      async () => [PUBLIC],
      plainSsh,
    );
    expect(route.pin[0]?.[1]).toBe(
      `ssh -i /keys/deploy -o HostName=${PUBLIC} -o HostKeyAlias=git.example.com`,
    );
  });

  it("checks the host the ssh config really names, not the alias that was typed", async () => {
    const asked: string[] = [];
    const route = await cloneRoute(
      "git@git.example.com:me/site.git",
      [],
      async (host) => {
        asked.push(host);
        return [PUBLIC];
      },
      aliased,
    );
    expect(asked).toEqual(["ssh.git.example.com"]);
    expect(route.pin[0]?.[1]).toContain("-o HostKeyAlias=[ssh.git.example.com]:443");

    expect(
      (await cloneRoute("git@looks.public.example:x.git", [], async () => [PUBLIC], inside))
        .private,
    ).toBe(true);
  });

  it("leaves a jump host's lookups to the jump host", async () => {
    expect(await cloneRoute("git@git.example.com:x.git", [], async () => [PUBLIC], jumped)).toEqual(
      {
        private: false,
        pin: [],
      },
    );
  });

  it("pins the address git is rewritten to, when this clone signs in over https", async () => {
    const route = await cloneRoute(
      "git@github.com:acme/site.git",
      [["url.https://github.com/.insteadOf", "git@github.com:"]],
      async () => [PUBLIC],
      async () => {
        throw new Error("ssh is not asked about an https address");
      },
    );
    expect(route.pin).toEqual([["http.curloptResolve", `github.com:443:${PUBLIC}`]]);
  });

  it("refuses a private answer and pins nothing", async () => {
    expect(
      await cloneRoute("https://rebind.example/x.git", [], async () => [PUBLIC, "10.0.0.7"]),
    ).toEqual({
      private: true,
      pin: [],
    });
    expect(
      await cloneRoute("git@rebind.example:x.git", [], async () => ["192.168.1.4"], plainSsh),
    ).toEqual({
      private: true,
      pin: [],
    });
  });
});

describe("the copy itself", () => {
  const studio = (extra: Partial<AppOptions>) =>
    createApp({
      store: new Store(":memory:"),
      password: PASSWORD,
      secret: SECRET,
      sitesRoot: root,
      ...extra,
    });

  it("hands git the pin, and none once the studio is told its Git server is private", async () => {
    const given: Array<Array<[string, string]>> = [];
    const cloneGit: AppOptions["cloneGit"] = async (_args, config) => {
      given.push(config);
    };
    const name = rebinding();
    await clone(studio({ cloneGit, resolveHost: name.resolve }), "https://rebind.example/a.git");
    await clone(
      studio({ cloneGit, resolveHost: name.resolve, clonePrivate: true }),
      "https://rebind.example/b.git",
    );

    expect(given).toEqual([[["http.curloptResolve", `rebind.example:443:${PUBLIC}`]], []]);
    expect(name.asked()).toBe(1);
  });

  it("makes git connect to the pinned address without looking the name up", async () => {
    const hosts: string[] = [];
    server = createServer((request, response) => {
      hosts.push(`${request.headers.host} ${request.url}`);
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    // The name exists nowhere: only the pin can have led git to this server.
    await new Clones(root).start(`http://pinned.invalid:${port}/site.git`, "site", "", [
      ["http.curloptResolve", `pinned.invalid:${port}:127.0.0.1`],
    ]);

    expect(hosts[0]).toBe(`pinned.invalid:${port} /site.git/info/refs?service=git-upload-pack`);
  });

  it("makes ssh connect to the pinned address", async () => {
    const seen = join(root, "ssh-args");
    const fake = join(root, "fake-ssh");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${seen}'\nexit 1\n`);
    chmodSync(fake, 0o755);
    // An ssh command already in the environment is what the pin has to win over.
    process.env.GIT_SSH_COMMAND = fake;
    const route = await cloneRoute(
      "git@git.example.com:me/site.git",
      [],
      async () => [PUBLIC],
      plainSsh,
    );

    await new Clones(root).start("git@git.example.com:me/site.git", "site", "", route.pin);

    expect(existsSync(seen)).toBe(true);
    const args = readFileSync(seen, "utf8").split("\n");
    expect(args).toContain(`HostName=${PUBLIC}`);
    expect(args).toContain("HostKeyAlias=git.example.com");
    expect(args).toContain("git@git.example.com");
  });
});
