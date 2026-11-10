/** Sites declared in the environment, so a server comes up already managing them. */

import { describe, expect, it } from "vitest";
import { applySites, parseSites } from "../src/config.js";
import { Store } from "../src/db.js";

describe("STUDIO_SITES", () => {
  it("reads a list of sites with stable ids", () => {
    expect(
      parseSites(
        '[{"id":"irona","path":"/srv/sites/irona","name":"IRONA","devUrl":"https://preview.icl.rw","probeUrl":"http://preview:4321","pushAfterPublish":true,"deployRoot":"/srv/www"}]',
      ),
    ).toEqual([
      {
        id: "irona",
        path: "/srv/sites/irona",
        name: "IRONA",
        devUrl: "https://preview.icl.rw",
        probeUrl: "http://preview:4321",
        pushAfterPublish: true,
        deployRoot: "/srv/www",
      },
    ]);
  });

  it("names a site after its id when no name is given", () => {
    expect(parseSites('[{"id":"irona","path":"/srv/irona"}]')[0]).toMatchObject({
      name: "irona",
      devUrl: "",
      pushAfterPublish: false,
    });
  });

  it("refuses a probeUrl that is not an address the studio can connect to", () => {
    expect(() => parseSites('[{"id":"a","path":"/srv/a","probeUrl":"preview:4321"}]')).toThrow(
      /probeUrl/,
    );
  });

  it("wants the builder's folder as an absolute path", () => {
    expect(() => parseSites('[{"id":"a","path":"/srv/a","deployRoot":"www"}]')).toThrow(
      /absolute deployRoot/,
    );
  });

  it("says exactly what is wrong instead of starting half-configured", () => {
    expect(() => parseSites("irona=/srv")).toThrow(/STUDIO_SITES is not JSON/);
    expect(() => parseSites('[{"id":"Irona Site","path":"/srv"}]')).toThrow(/id "Irona Site"/);
    expect(() => parseSites('[{"id":"irona","path":"relative"}]')).toThrow(/absolute path/);
    expect(() => parseSites('[{"id":"irona","path":"/srv","devUrl":"javascript:x"}]')).toThrow(
      /devUrl/,
    );
    expect(() => parseSites('[{"id":"a","path":"/a"},{"id":"a","path":"/b"}]')).toThrow(/twice/);
  });

  it("creates what is missing and keeps settings in step with the environment", () => {
    const store = new Store(":memory:");
    const sites = parseSites('[{"id":"irona","path":"/srv/irona","pushAfterPublish":true}]');

    expect(applySites(store, sites)).toEqual(["irona: added"]);
    expect(store.getSite("irona")).toMatchObject({ path: "/srv/irona", pushAfterPublish: true });

    const renamed = parseSites('[{"id":"irona","path":"/srv/irona","name":"IRONA"}]');
    expect(applySites(store, renamed)).toEqual(["irona: updated"]);
    expect(store.getSite("irona")).toMatchObject({ name: "IRONA", pushAfterPublish: false });
  });

  it("refuses to move an existing site to another folder", () => {
    const store = new Store(":memory:");
    applySites(store, parseSites('[{"id":"irona","path":"/srv/irona"}]'));

    expect(() => applySites(store, parseSites('[{"id":"irona","path":"/elsewhere"}]'))).toThrow(
      /already points at \/srv\/irona/,
    );
  });
});

describe("a site's id, from whoever starts the studio in-process", () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- read beside the tests that use it
  const declared = (id: unknown) => [
    {
      id: id as string,
      path: "/srv/site",
      name: "Site",
      devUrl: "",
      probeUrl: "",
      pushAfterPublish: false,
      deployRoot: "",
    },
  ];

  it("is held to the same rule as STUDIO_SITES, or a UUID", () => {
    for (const id of [
      "my-site",
      "a",
      "0-9",
      "9B2F4C1E-7A3D-4E5F-8A6B-1C2D3E4F5A6B",
      "a".repeat(63),
    ]) {
      expect(applySites(new Store(":memory:"), declared(id)), id).toEqual([`${id}: added`]);
    }
    for (const id of [
      "",
      "My Site",
      "../etc",
      "a/b",
      "a.b",
      "-leading",
      "a".repeat(64),
      "site?x=1",
      "<script>",
      "a\nb",
      undefined,
      42,
      { toString: () => "ok" },
    ]) {
      const store = new Store(":memory:");
      expect(() => applySites(store, declared(id)), String(id)).toThrow(
        /id must be lowercase letters, digits and dashes.*\n {2}fix: /s,
      );
      expect(store.listSites()).toEqual([]);
    }
  });

  it("leaves an id already in the database alone, whatever it looks like", () => {
    const store = new Store(":memory:");
    store.addSite({
      id: "Old Site.1",
      name: "Old",
      path: "/srv/site",
      devUrl: "",
      createdAt: "2026-01-01",
    });

    expect(applySites(store, declared("Old Site.1"))).toEqual(["Old Site.1: updated"]);
    expect(store.getSite("Old Site.1")).toMatchObject({ name: "Site" });
  });
});
