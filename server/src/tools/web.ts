import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { convert } from "html-to-text";
import { truncate } from "./shell.ts";

const fetchParams = Type.Object({ url: Type.String({ description: "URL to fetch" }) });

export function createWebFetchTool(fetchFn: typeof fetch = fetch): AgentTool<typeof fetchParams> {
  return {
    name: "web_fetch",
    label: "Fetch web page",
    description: "Fetch a URL and return its readable text content.",
    parameters: fetchParams,
    execute: async (_id, params) => {
      const res = await fetchFn(params.url, {
        headers: { "user-agent": "ytsejam/1.0" },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${params.url}`);
      const contentType = res.headers.get("content-type") ?? "";
      const body = await res.text();
      const text = contentType.includes("html")
        ? convert(body, {
            wordwrap: false,
            selectors: [
              { selector: "script", format: "skip" },
              { selector: "style", format: "skip" },
              { selector: "nav", format: "skip" },
              { selector: "a", options: { ignoreHref: false } },
              { selector: "h1", options: { uppercase: false } },
              { selector: "h2", options: { uppercase: false } },
              { selector: "h3", options: { uppercase: false } },
              { selector: "h4", options: { uppercase: false } },
              { selector: "h5", options: { uppercase: false } },
              { selector: "h6", options: { uppercase: false } },
            ],
          })
        : body;
      return { content: [{ type: "text", text: truncate(text, 30_000) }], details: { url: params.url } };
    },
  };
}

const searchParams = Type.Object({
  query: Type.String(),
  count: Type.Optional(Type.Number({ description: "Result count, default 8, max 20" })),
});

export function createWebSearchTool(
  fetchFn: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): AgentTool<typeof searchParams> {
  return {
    name: "web_search",
    label: "Web search",
    description: "Search the web (Brave Search). Returns titles, URLs, and snippets.",
    parameters: searchParams,
    execute: async (_id, params) => {
      const key = env.BRAVE_API_KEY;
      if (!key) throw new Error("web_search is not configured: set BRAVE_API_KEY on the server");
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", params.query);
      url.searchParams.set("count", String(Math.min(params.count ?? 8, 20)));
      const res = await fetchFn(url, {
        headers: { "X-Subscription-Token": key, Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Brave search failed: HTTP ${res.status}`);
      const data = (await res.json()) as {
        web?: { results?: Array<{ title: string; url: string; description?: string }> };
      };
      const results = data.web?.results ?? [];
      const text = results.length
        ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description ?? ""}`).join("\n")
        : "(no results)";
      return { content: [{ type: "text", text }], details: { count: results.length } };
    },
  };
}
