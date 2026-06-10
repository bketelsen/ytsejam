import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ContentBlock } from "@/lib/types";

function blocks(message: ChatMessage): ContentBlock[] {
  return typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;
}

export function ToolCallCard({
  call,
  result,
}: {
  call: ContentBlock;
  result: ChatMessage | undefined;
}) {
  const [open, setOpen] = useState(false);
  const resultText = result
    ? blocks(result)
        .map((b) => b.text ?? "")
        .join("\n")
    : null;
  return (
    <div className="my-1 rounded-md border border-neutral-700 bg-neutral-900 text-sm">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 p-2 text-left text-neutral-300"
      >
        <span>{open ? "▾" : "▸"}</span>
        <span className="font-mono">{call.name}</span>
        {!result && <span className="animate-pulse text-xs text-yellow-400">running…</span>}
        {result?.isError && <span className="text-xs text-red-400">error</span>}
      </button>
      {open && (
        <div className="space-y-2 border-t border-neutral-800 p-2 font-mono text-xs">
          <pre className="overflow-x-auto whitespace-pre-wrap text-neutral-400">
            {JSON.stringify(call.arguments, null, 2)}
          </pre>
          {resultText && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-neutral-300">{resultText}</pre>
          )}
        </div>
      )}
    </div>
  );
}

export function Message({
  message,
  toolResults,
}: {
  message: ChatMessage;
  toolResults: Map<string, ChatMessage>;
}) {
  if (message.role === "toolResult") return null; // rendered inside the assistant's tool card
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 ${
          isUser ? "bg-blue-900/60" : "bg-neutral-900"
        }`}
      >
        {message.errorMessage && (
          <p className="mb-1 rounded bg-red-950 p-2 text-sm text-red-300">
            {message.stopReason === "aborted" ? "Aborted" : `Error: ${message.errorMessage}`}
          </p>
        )}
        {blocks(message).map((b, i) => {
          if (b.type === "text" && b.text) {
            return (
              <div key={i} className="prose prose-invert prose-sm max-w-none">
                <Markdown remarkPlugins={[remarkGfm]}>{b.text}</Markdown>
              </div>
            );
          }
          if (b.type === "thinking" && b.thinking) {
            return (
              <p key={i} className="border-l-2 border-neutral-700 pl-2 text-sm italic text-neutral-500">
                {b.thinking}
              </p>
            );
          }
          if (b.type === "toolCall") {
            return <ToolCallCard key={i} call={b} result={b.id ? toolResults.get(b.id) : undefined} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}
