/** Sites declared in the environment, so a server comes up already managing them. */

import { describe, expect, it } from "vitest";
import { applySites, parseSites } from "../src/config.js";
import { Store } from "../src/db.js";

describe("STUDIO_SITES", () => {
  it("reads a list of sites with stable ids", () => {
    expect(
      parseSites(
        '[{"id":"irona","path":"/srv/sites/irona","name":"IRONA","devUrl":"https://preview.icl.rw","pushAfterPublish":true}]',
      ),
    ).toEqual([
      {
        id: "irona",
        path: "/srv/sites/irona",
        name: "IRONA",
        devUrl: "https://preview.icl.rw",
        pushAfterPublish: true,
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
