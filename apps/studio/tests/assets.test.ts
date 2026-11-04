/** The client bundles: compressed once in the browser's preferred encoding, and cached for good. */

import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { asset } from "../src/assets.js";
import { Store } from "../src/db.js";
import { PASSWORD, SECRET, signedIn } from "./site.js";

const app = createApp({ store: new Store(":memory:"), password: PASSWORD, secret: SECRET });
const bundle = asset("editor.js")!;
const fetchBundle = (headers: Record<string, string>) =>
  app.request(`/assets/editor.js?v=${bundle.version}`, { headers: { ...signedIn, ...headers } });

describe("a client bundle", () => {
  it("comes as Brotli when the browser takes it, and decodes to the same bytes", async () => {
    const response = await fetchBundle({ "accept-encoding": "gzip, deflate, br, zstd" });
    expect(response.headers.get("content-encoding")).toBe("br");
    expect(response.headers.get("vary")).toBe("accept-encoding");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(brotliDecompressSync(bytes).toString()).toBe(bundle.body);
    expect(bytes.length).toBeLessThan(Buffer.byteLength(bundle.body as string) / 3);
  });

  it("falls back to gzip, then to none, and respects q=0", async () => {
    const gzip = await fetchBundle({ "accept-encoding": "gzip" });
    expect(gzip.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(Buffer.from(await gzip.arrayBuffer())).toString()).toBe(bundle.body);

    const refused = await fetchBundle({ "accept-encoding": "br;q=0, gzip;q=0" });
    expect(refused.headers.get("content-encoding")).toBeNull();
    expect(await refused.text()).toBe(bundle.body);
  });

  it("is immutable at its versioned URL, and answers a revalidation with 304", async () => {
    const response = await fetchBundle({});
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const again = await fetchBundle({ "if-none-match": `"${bundle.version}"` });
    expect(again.status).toBe(304);
  });
});
