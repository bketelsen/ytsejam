import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ContentBlock, TaskRow } from "@/lib/types";
import { TaskCard } from "./TaskCard";

function blocks(message: ChatMessage): ContentBlock[] {
  return typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;
}

export function ToolCallCard({
  call,
  result,
  interrupted = false,
}: {
  call: ContentBlock;
  result: ChatMessage | undefined;
  /** the turn ended (task is terminal) with no result — the call never finished */
  interrupted?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const resultText = result
    ? blocks(result)
        .map((b) => b.text ?? "")
        .join("\n")
    : null;
  return (
    <div className="my-1 rounded-md border border-border bg-background text-sm text-foreground">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 p-2 text-left text-foreground"
      >
        <span>{open ? "▾" : "▸"}</span>
        <span className="font-mono">{call.name}</span>
        {!result && !interrupted && <span className="animate-pulse text-xs text-warning">running…</span>}
        {!result && interrupted && <span className="text-xs text-destructive">interrupted</span>}
        {result?.isError && <span className="text-xs text-destructive">error</span>}
      </button>
      {open && (
        <div className="space-y-2 border-t border-border p-2 font-mono text-xs">
          <pre className="overflow-x-auto whitespace-pre-wrap text-muted-foreground">
            {JSON.stringify(call.arguments, null, 2)}
          </pre>
          {resultText && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-foreground">{resultText}</pre>
          )}
        </div>
      )}
    </div>
  );
}

export function Message({
  message,
  toolResults,
  tasks,
  onViewTranscript,
  interrupted = false,
}: {
  message: ChatMessage;
  toolResults: Map<string, ChatMessage>;
  tasks?: Record<string, TaskRow>;
  onViewTranscript?: (taskId: string) => void;
  /** render resultless tool calls as interrupted, not running (terminal transcript) */
  interrupted?: boolean;
}) {
  if (message.role === "toolResult") return null; // rendered inside the assistant's tool card
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-3 py-2 ${
          isUser ? "bg-primary text-primary-foreground" : "border border-border bg-card text-card-foreground"
        }`}
      >
        {message.errorMessage && (
          <p className="mb-1 rounded bg-destructive/15 p-2 text-sm text-destructive">
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
              <p key={i} className="border-l-2 border-border pl-2 text-sm italic text-muted-foreground">
                {b.thinking}
              </p>
            );
          }
          if (b.type === "toolCall" && b.name === "delegate" && tasks && onViewTranscript) {
            const result = b.id ? toolResults.get(b.id) : undefined;
            const taskId =
              (result?.details as any)?.taskId ??
              /task ([0-9a-f-]{16,})/i.exec(
                typeof result?.content === "string"
                  ? result.content
                  : (result?.content ?? []).map((c) => c.text ?? "").join(" "),
              )?.[1];
            return <TaskCard key={i} task={taskId ? tasks[taskId] : undefined} onViewTranscript={onViewTranscript} />;
          }
          if (b.type === "toolCall") {
            const result = b.id ? toolResults.get(b.id) : undefined;
            return <ToolCallCard key={i} call={b} result={result} interrupted={interrupted && !result} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}
