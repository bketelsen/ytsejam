import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { textBlocksOf } from "../src/messages.ts";

const msg = (content: unknown): AgentMessage => ({ role: "assistant", content } as unknown as AgentMessage);

describe("textBlocksOf", () => {
  it("returns plain string content as a single text block", () => {
    expect(textBlocksOf(msg("plain text"))).toEqual(["plain text"]);
  });

  it("returns multiple text blocks in order", () => {
    expect(
      textBlocksOf(
        msg([
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ]),
      ),
    ).toEqual(["first", "second"]);
  });

  it("filters non-text blocks while preserving text order", () => {
    expect(
      textBlocksOf(
        msg([
          { type: "toolCall", tool: "bash", arguments: { command: "pwd" } },
          { type: "text", text: "visible" },
          { type: "thinking", thinking: "hidden" },
          { type: "image", url: "data:image/png;base64,..." },
          { type: "text", text: "also visible" },
        ]),
      ),
    ).toEqual(["visible", "also visible"]);
  });

  it("coerces missing and non-string text values", () => {
    expect(
      textBlocksOf(
        msg([
          { type: "text", text: undefined },
          { type: "text", text: 42 },
        ]),
      ),
    ).toEqual(["", "42"]);
  });

  it("returns empty for missing, null, scalar, and object content", () => {
    for (const content of [undefined, null, 42, { type: "text", text: "not an array" }]) {
      expect(textBlocksOf(msg(content))).toEqual([]);
    }
  });

  it("returns empty for an empty content array", () => {
    expect(textBlocksOf(msg([]))).toEqual([]);
  });

  it("skips null and falsy array elements without throwing", () => {
    expect(
      textBlocksOf(
        msg([
          null,
          false,
          { type: "text", text: "kept" },
          undefined,
        ]),
      ),
    ).toEqual(["kept"]);
  });
});
