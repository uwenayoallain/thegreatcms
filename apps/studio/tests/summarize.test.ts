import { describe, expect, it, vi } from "vitest";
import {
  deterministicSummary,
  diffDocuments,
  ModelSummarizer,
  type Change,
} from "../src/summarize.js";

function modelReturning(content: string, status = 200) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

const context = (changes: Change[]) => ({
  siteName: "Example",
  regionId: "home.hero",
  regionLabel: "Home hero",
  changes,
});

describe("diffing a document", () => {
  it("reports what actually changed, field by field", () => {
    const changes = diffDocuments(
      { heading: "Old", subtitle: "Same" },
      { heading: "New", subtitle: "Same" },
    );
    expect(changes).toEqual([{ path: "heading", kind: "changed", before: "Old", after: "New" }]);
  });

  it("distinguishes added from changed from removed", () => {
    const changes = diffDocuments({ kept: "a", removed: "gone" }, { kept: "a", added: "new" });
    expect(changes).toEqual([
      { path: "added", kind: "added", after: "new" },
      { path: "removed", kind: "removed", before: "gone" },
    ]);
  });

  it("descends into groups with a dotted path", () => {
    const changes = diffDocuments({ seo: { title: "Old" } }, { seo: { title: "New" } });
    expect(changes[0]?.path).toBe("seo.title");
  });

  it("summarises list length rather than dumping every item", () => {
    const changes = diffDocuments({ tags: ["a"] }, { tags: ["a", "b"] });
    expect(changes[0]).toMatchObject({ path: "tags", before: "1 item", after: "2 items" });
  });

  it("ignores machinery, which changes on every save and means nothing", () => {
    const changes = diffDocuments(
      { heading: "Same", _meta: { updatedAt: "then" } },
      { heading: "Same", _meta: { updatedAt: "now" } },
    );
    expect(changes).toEqual([]);
  });

  it("treats a first edit as all-new rather than crashing on a missing document", () => {
    expect(diffDocuments(null, { heading: "First" })).toEqual([
      { path: "heading", kind: "added", after: "First" },
    ]);
  });
});

describe("the deterministic summary", () => {
  it("names the single field when only one changed", () => {
    const summary = deterministicSummary(
      context([{ path: "heading", kind: "changed", before: "a", after: "b" }]),
    );
    expect(summary.title).toBe("Update heading in Home hero on Example");
    expect(summary.fromModel).toBe(false);
  });

  it("counts them when several changed", () => {
    const summary = deterministicSummary(
      context([
        { path: "heading", kind: "changed" },
        { path: "subtitle", kind: "changed" },
      ]),
    );
    expect(summary.title).toBe("Update Home hero on Example (2 fields)");
  });

  it("puts the real change list in the body, as a table a reviewer can scan", () => {
    const summary = deterministicSummary(
      context([{ path: "heading", kind: "changed", before: "Old", after: "New" }]),
    );
    expect(summary.body).toContain("| `heading` | Old → New |");
    expect(summary.body).toContain("home.hero");
  });

  it("keeps titles short enough for GitHub to show whole", () => {
    const summary = deterministicSummary({
      siteName: "A site with a very long name indeed",
      regionId: "home.hero",
      regionLabel: "An unusually long region label for testing purposes",
      changes: [{ path: "some.deeply.nested.field.name", kind: "changed" }],
    });
    expect(summary.title.length).toBeLessThanOrEqual(72);
  });

  it("still says something sensible when nothing changed", () => {
    expect(deterministicSummary(context([])).title).toBe("Republish Home hero on Example");
  });
});

describe("the model summariser", () => {
  const changes: Change[] = [{ path: "heading", kind: "changed", before: "Old", after: "New" }];

  it("uses the model's title but keeps the generated change list", async () => {
    const fetchImpl = modelReturning("Refresh the homepage headline");
    const summary = await new ModelSummarizer({
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "k",
      model: "llama-3.3-70b",
      fetch: fetchImpl as unknown as typeof fetch,
    }).summarize(context(changes));

    expect(summary.title).toBe("Refresh the homepage headline");
    expect(summary.fromModel).toBe(true);
    // The body is never the model's work: a reviewer needs it to be true.
    expect(summary.body).toContain("| `heading` | Old → New |");
  });

  it("tidies a model that ignores the instructions", async () => {
    const fetchImpl = modelReturning('  "Update the hero heading."\n\nHope that helps!  ');
    const summary = await new ModelSummarizer({
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      fetch: fetchImpl as unknown as typeof fetch,
    }).summarize(context(changes));
    expect(summary.title).toBe("Update the hero heading");
  });

  it("falls back silently when the provider errors", async () => {
    const errors: string[] = [];
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const summary = await new ModelSummarizer({
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      fetch: fetchImpl as unknown as typeof fetch,
      onError: (message) => errors.push(message),
    }).summarize(context(changes));

    expect(summary.fromModel).toBe(false);
    expect(summary.title).toContain("Update heading in Home hero");
    expect(errors[0]).toContain("429");
  });

  it("falls back when the provider hangs, rather than blocking a publish", async () => {
    const errors: string[] = [];
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );

    const summary = await new ModelSummarizer({
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      timeoutMs: 20,
      fetch: fetchImpl as unknown as typeof fetch,
      onError: (message) => errors.push(message),
    }).summarize(context(changes));

    expect(summary.fromModel).toBe(false);
    expect(errors[0]).toContain("timed out");
  });

  it("falls back when the network throws outright", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const summary = await new ModelSummarizer({
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      fetch: fetchImpl as unknown as typeof fetch,
    }).summarize(context(changes));
    expect(summary.fromModel).toBe(false);
  });

  it("sends only the changed fields, and says not to invent any", async () => {
    const fetchImpl = modelReturning("A title");
    await new ModelSummarizer({
      baseUrl: "https://x/v1",
      apiKey: "k",
      model: "m",
      fetch: fetchImpl as unknown as typeof fetch,
    }).summarize(context(changes));

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.messages[0].content).toContain("Never invent changes");
    expect(body.messages[1].content).toContain("heading");
    expect(body.model).toBe("m");
  });
});
