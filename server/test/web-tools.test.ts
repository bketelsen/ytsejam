import { describe, expect, test } from "vitest";
import { createWebFetchTool, createWebSearchTool } from "../src/tools/web.ts";

const fakeFetch = (body: string, contentType: string) =>
  (async () =>
    new Response(body, { status: 200, headers: { "content-type": contentType } })) as unknown as typeof fetch;

describe("web_fetch", () => {
  test("converts html to readable text", async () => {
    const tool = createWebFetchTool(fakeFetch("<html><body><h1>Title</h1><p>Para</p><script>x()</script></body></html>", "text/html"));
    const r = await tool.execute("t1", { url: "https://example.com" });
    const text = (r.content[0] as any).text;
    expect(text).toContain("Title");
    expect(text).toContain("Para");
    expect(text).not.toContain("x()");
  });

  test("passes plain text through", async () => {
    const tool = createWebFetchTool(fakeFetch("plain body", "text/plain"));
    const r = await tool.execute("t1", { url: "https://example.com" });
    expect((r.content[0] as any).text).toContain("plain body");
  });
});

describe("web_search", () => {
  test("fails clearly without BRAVE_API_KEY", async () => {
    const tool = createWebSearchTool(fetch, {});
    await expect(tool.execute("t1", { query: "x" })).rejects.toThrow(/BRAVE_API_KEY/);
  });

  test("maps brave results", async () => {
    const body = JSON.stringify({
      web: { results: [{ title: "T", url: "https://u", description: "D" }] },
    });
    const tool = createWebSearchTool(fakeFetch(body, "application/json"), { BRAVE_API_KEY: "k" });
    const r = await tool.execute("t1", { query: "x" });
    const text = (r.content[0] as any).text;
    expect(text).toContain("T");
    expect(text).toContain("https://u");
  });
});
