import type { AgentMessage } from "@earendil-works/pi-agent-core";

interface TextBlocksOfOptions {
  coerce?: boolean;
}

/**
 * Extract the text-block strings from an AgentMessage's content.
 *
 * Centralizes the pi-ai SDK-boundary cast: AgentMessage is a discriminated
 * union whose `.content` is absent on some variants, so the cast to probe it
 * lives here and nowhere else. Callers do their own first/join/sum over the
 * returned array.
 */
export function textBlocksOf(message: AgentMessage, options: TextBlocksOfOptions = {}): string[] {
  const { coerce = true } = options;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  return content
    .filter((part): part is { type: "text"; text: unknown } => Boolean(part) && (part as { type?: unknown }).type === "text")
    .flatMap((part) => {
      const text = part.text;
      if (typeof text === "string") return [text];
      return coerce ? [String(text ?? "")] : [];
    });
}
