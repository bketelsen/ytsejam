import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { complete } from "@earendil-works/pi-ai";

// Regression test for the patched @earendil-works/pi-ai anthropic provider
// (patches/@earendil-works+pi-ai+*.patch): when the API stops generation with a
// content-safety stop_reason (refusal/sensitive), the errorMessage must name
// that stop_reason instead of the generic "An unknown error occurred".

function sseBody(events: Array<{ event: string; data: unknown }>): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
}

const REFUSAL_STREAM = sseBody([
  {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: "msg_test",
        usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
  },
  { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
  { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial out" } } },
  { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 5 } } },
  { event: "message_stop", data: { type: "message_stop" } },
]);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(REFUSAL_STREAM);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("anthropic provider stop_reason reporting", () => {
  test("names the API stop_reason when generation is stopped by content filtering", async () => {
    const model = {
      id: "test-model",
      name: "Test Model",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    } as any;

    const message = await complete(
      model,
      { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
      { apiKey: "test-key" },
    );

    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("refusal");
  });
});
