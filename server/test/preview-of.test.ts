import { describe, expect, test } from "vitest";
import { previewOf } from "../src/manager.ts";

function messageWithContent(content: unknown) {
  return { content } as any;
}

describe("previewOf", () => {
  test("returns short string content unchanged", () => {
    expect(previewOf(messageWithContent("hello world"))).toBe("hello world");
  });

  test("returns string content that is exactly 200 chars unchanged", () => {
    const content = "a".repeat(200);
    const result = previewOf(messageWithContent(content));

    expect(result).toBe(content);
    expect(result).toHaveLength(200);
  });

  test("truncates string content longer than 200 chars", () => {
    const content = "a".repeat(201);
    const result = previewOf(messageWithContent(content));

    expect(result).toBe(content.slice(0, 200));
    expect(result).toHaveLength(200);
  });

  test("returns empty string content unchanged", () => {
    expect(previewOf(messageWithContent(""))).toBe("");
  });

  test("returns text from a single text block", () => {
    expect(previewOf(messageWithContent([{ type: "text", text: "block text" }]))).toBe("block text");
  });

  test("returns first text block even when a non-text block precedes it", () => {
    const content = [
      { type: "image", url: "image.png" },
      { type: "text", text: "first text" },
    ];

    expect(previewOf(messageWithContent(content))).toBe("first text");
  });

  test("returns the first text block when multiple text blocks are present", () => {
    const content = [
      { type: "text", text: "first text" },
      { type: "text", text: "second text" },
    ];

    expect(previewOf(messageWithContent(content))).toBe("first text");
  });

  test("truncates text block content longer than 200 chars", () => {
    const text = "a".repeat(201);
    const result = previewOf(messageWithContent([{ type: "text", text }]));

    expect(result).toBe(text.slice(0, 200));
    expect(result).toHaveLength(200);
  });

  test("returns empty string for an empty text block", () => {
    expect(previewOf(messageWithContent([{ type: "text", text: "" }]))).toBe("");
  });

  test("returns empty string when an array has no text block", () => {
    const content = [
      { type: "image", url: "image.png" },
      { type: "tool_call", name: "lookup" },
    ];

    expect(previewOf(messageWithContent(content))).toBe("");
  });

  test("returns empty string for an empty content array", () => {
    expect(previewOf(messageWithContent([]))).toBe("");
  });

  test("returns empty string when content is undefined", () => {
    expect(previewOf({} as any)).toBe("");
  });

  test("returns empty string when content is null", () => {
    expect(previewOf(messageWithContent(null))).toBe("");
  });

  test("returns empty string for non-string non-array content", () => {
    expect(previewOf(messageWithContent(123))).toBe("");
    expect(previewOf(messageWithContent({ type: "text", text: "object text" }))).toBe("");
  });
});
