import { memo, useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import type { ChatMessage, ContentBlock, TaskRow } from "@/lib/types";
import { absoluteTime, relativeTime } from "@/lib/time";
import { Button } from "./ui/button";
import { TaskCard } from "./TaskCard";

function blocks(message: ChatMessage): ContentBlock[] {
  return typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content;
}

/** The human-facing text of a message: just text blocks, joined with newlines.
 *  Thinking blocks and tool-call JSON are intentionally excluded — this is
 *  what the model actually said. */
function copyableText(message: ChatMessage): string {
  return blocks(message)
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text ?? "")
    .join("\n");
}

/** Feature-detect the clipboard pathways once at module load. The async
 *  Clipboard API is gated on a secure context; the legacy execCommand path
 *  works on plain-http LAN. If neither is available the copy button hides. */
function hasAsyncClipboard(): boolean {
  return typeof navigator !== "undefined" && !!navigator.clipboard?.writeText;
}
function hasLegacyClipboard(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.execCommand === "function" &&
    typeof document.queryCommandSupported === "function" &&
    document.queryCommandSupported("copy")
  );
}
const COPY_AVAILABLE = hasAsyncClipboard() || hasLegacyClipboard();

async function copyToClipboard(text: string): Promise<boolean> {
  if (hasAsyncClipboard()) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy
    }
  }
  if (hasLegacyClipboard()) {
    const ta = document.createElement("textarea");
    ta.value = text;
    // hide off-screen but keep selectable
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.left = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      const ok = document.execCommand("copy");
      return ok;
    } catch {
      return false;
    } finally {
      document.body.removeChild(ta);
    }
  }
  return false;
}

/** Absolutely-positioned hover affordance (relative timestamp + copy button).
 *  Rendered as a sibling of the bubble's content inside a `group relative`
 *  bubble; itself uses `position: absolute` so it occupies NO layout box and
 *  cannot push neighbours when it appears. Only opacity transitions. */
function MessageHoverCluster({
  text,
  timestamp,
  align,
}: {
  text: string;
  timestamp: number | undefined;
  align: "start" | "end";
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const onCopy = useCallback(async () => {
    if (!text) return;
    const ok = await copyToClipboard(text);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  }, [text]);

  const showCopy = COPY_AVAILABLE && text.length > 0;
  const hasTimestamp = typeof timestamp === "number" && Number.isFinite(timestamp);

  // Nothing useful to show — render nothing so the bubble has no decoration.
  if (!showCopy && !hasTimestamp) return null;

  // Anchor to the bubble's start or end edge depending on user vs assistant,
  // and float ABOVE the bubble so the cluster cannot overlap message text at
  // any width. Absolute positioning + opacity-only transition is what gives us
  // the zero-layout-shift guarantee — see the `.message-hover-cluster` rule in
  // index.css for the touch fallback that keeps the same `position: absolute`.
  const positionClass = align === "end" ? "right-0" : "left-0";

  return (
    <div
      className={`message-hover-cluster pointer-events-none absolute -top-5 ${positionClass} flex items-center gap-1 text-xs text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100`}
    >
      {hasTimestamp && (
        <span
          className="select-none rounded bg-background/80 px-1.5 py-0.5 backdrop-blur-sm"
          title={absoluteTime(timestamp!)}
        >
          {relativeTime(timestamp!)}
        </span>
      )}
      {showCopy && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={copied ? "Copied" : "Copy message"}
          title={copied ? "Copied" : "Copy message"}
          onClick={onCopy}
          className="pointer-events-auto bg-background/80 backdrop-blur-sm"
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
      )}
    </div>
  );
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
        className="flex w-full items-center gap-2 p-2 text-left text-foreground hover:bg-muted/50 transition-colors rounded-md"
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

export const Message = memo(function Message({
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
  const hasTimestamp = typeof message.timestamp === "number" && Number.isFinite(message.timestamp);
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`group relative max-w-[80%] min-w-0 rounded-lg px-3 py-2 ${
          isUser ? "bg-primary text-primary-foreground" : "border border-border bg-card text-card-foreground"
        }`}
        title={hasTimestamp ? absoluteTime(message.timestamp!) : undefined}
      >
        <MessageHoverCluster
          text={copyableText(message)}
          timestamp={message.timestamp}
          align={isUser ? "end" : "start"}
        />
        {message.errorMessage && (
          <p className="mb-1 rounded bg-destructive/15 p-2 text-sm text-destructive">
            {message.stopReason === "aborted" ? "Aborted" : `Error: ${message.errorMessage}`}
          </p>
        )}
        {blocks(message).map((b, i) => {
          if (b.type === "text" && b.text) {
            return (
              <div key={i} className="prose dark:prose-invert prose-sm max-w-none break-words [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full">
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
              (result?.details as { taskId?: string } | undefined)?.taskId ??
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
});
