/** A dev server that starts when asked for and stops when forgotten, through the proxy an editor meets. */

import { type AddressInfo, connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createPreviewServer, waitingPage, type PreviewOptions } from "./preview.js";

// The "dev server": Node answering hello on $PORT, after a short delay, with a WebSocket echo.
const DEV = `node -e '
const http = require("node:http");
setTimeout(() => {
  const server = http.createServer((req, res) => { res.setHeader("x-dev", "1"); res.end("hello from " + req.url); });
  server.on("upgrade", (req, socket) => {
    if (req.url === "/refuse") return socket.end("HTTP/1.1 400 Bad Request\\r\\ncontent-length: 7\\r\\n\\r\\nrefused");
    const key = require("node:crypto").createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + key + "\\r\\n\\r\\n");
    socket.on("data", (d) => socket.write(d));
  });
  server.listen(process.env.PORT, "127.0.0.1");
}, 300);
'`;

const started: ReturnType<typeof createPreviewServer>[] = [];
const log: string[] = [];

async function up(overrides: Partial<PreviewOptions> = {}) {
  const upstreamPort = 4400 + Math.floor(Math.random() * 400);
  const preview = createPreviewServer({
    source: process.cwd(),
    command: DEV,
    port: 0,
    upstreamPort,
    idle: 1,
    startTimeout: 10,
    log: (line) => log.push(line),
    ...overrides,
  });
  await new Promise<void>((resolve) => preview.server.listen(0, "127.0.0.1", resolve));
  started.push(preview);
  const { port } = preview.server.address() as AddressInfo;
  return { ...preview, url: `http://127.0.0.1:${port}` };
}

afterEach(() => {
  for (const preview of started.splice(0)) {
    preview.runner.stop();
    preview.server.close();
  }
  log.length = 0;
});

const until = (check: () => boolean | Promise<boolean>, ms = 8000) =>
  expect.poll(check, { timeout: ms, interval: 100 }).toBe(true);

describe("the preview proxy", () => {
  it("starts the dev server on the first request and shows a waiting page until it answers", async () => {
    const { url, runner } = await up();
    expect(runner.state).toBe("stopped");

    const first = await fetch(`${url}/page`);
    expect(first.status).toBe(503);
    expect(await first.text()).toContain("Starting your preview");
    expect(runner.state).toBe("starting");

    await until(async () => (await fetch(`${url}/page`)).status === 200);
    const served = await fetch(`${url}/page`);
    expect(served.headers.get("x-dev")).toBe("1");
    expect(await served.text()).toBe("hello from /page");
    expect(runner.state).toBe("running");
  });

  it("stops it again once nobody has asked for a while, and says so", async () => {
    const { url, runner } = await up({ idle: 1 });
    await fetch(url);
    await until(async () => (await fetch(url)).status === 200);
    await until(() => runner.state === "stopped", 6000);
    expect(log.some((line) => line.includes("idle"))).toBe(true);

    const status = await (await fetch(`${url}/__greatcms/preview`)).json();
    expect(status.state).toBe("stopped");
  }, 15000);

  it("reports a dev server that never comes up instead of waiting forever", async () => {
    const { url, runner } = await up({ command: "exit 3", startTimeout: 5 });
    await fetch(url);
    await until(() => runner.state === "stopped");
    expect(waitingPage(runner)).toContain("could not start");
    expect(waitingPage(runner)).not.toContain("http-equiv");
  });
});

/** The first line a raw WebSocket upgrade gets back through the proxy. */
function upgradeAnswer(url: string, path: string): Promise<string> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () =>
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${hostname}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      ),
    );
    socket.setTimeout(4000, () => reject(new Error("no answer")));
    socket.once("data", (data) => {
      socket.destroy();
      resolve(String(data).split("\r\n")[0] ?? "");
    });
    socket.on("error", reject);
  });
}

describe("live reload through the proxy", () => {
  it("passes a WebSocket through, and a refused one back at once", async () => {
    const { url } = await up();
    await fetch(url);
    await until(async () => (await fetch(url)).status === 200);

    expect(await upgradeAnswer(url, "/socket")).toBe("HTTP/1.1 101 Switching Protocols");
    expect(await upgradeAnswer(url, "/refuse")).toBe("HTTP/1.1 400 Bad Request");
  });
});
