import { useEffect, useMemo, useRef, useState } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { client } from "@/lib/api";
import type { ChatMessage, TaskRow } from "@/lib/types";
import { Message } from "./Message";
import { TaskTranscriptDialog } from "./TaskCard";

export function Chat({
  sessionId,
  messages,
  streaming,
  running,
  tasks,
  onSend,
  onMenuClick,
}: {
  sessionId: string | null;
  messages: ChatMessage[];
  streaming: ChatMessage | null;
  running: boolean;
  tasks: Record<string, TaskRow>;
  onSend: (text: string) => Promise<void>;
  onMenuClick: () => void;
}) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const [transcriptTaskId, setTranscriptTaskId] = useState<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streaming]);

  // Memoize so the reference is stable across re-renders driven by unrelated
  // state (e.g. the composer's `draft`). Without this, the fresh Map on every
  // keystroke would defeat React.memo on <Message> below. (#23)
  const toolResults = useMemo(() => {
    const map = new Map<string, ChatMessage>();
    for (const m of messages) {
      if (m.role === "toolResult" && m.toolCallId) map.set(m.toolCallId, m);
    }
    return map;
  }, [messages]);

  async function submit() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await onSend(text);
  }

  return (
    <main className="flex flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-2 py-1.5 md:hidden">
        <Button variant="ghost" size="icon" onClick={onMenuClick} aria-label="Open sessions">
          <Menu />
        </Button>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-3 p-4">
          {messages.length === 0 && !streaming && (
            <p className="pt-20 text-center text-muted-foreground">Start a conversation</p>
          )}
          {messages.map((m, i) => (
            <Message key={i} message={m} toolResults={toolResults} tasks={tasks} onViewTranscript={setTranscriptTaskId} />
          ))}
          {streaming && <Message message={streaming} toolResults={toolResults} tasks={tasks} onViewTranscript={setTranscriptTaskId} />}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="border-t border-border bg-background pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-4xl gap-2 px-3">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={running ? "Assistant is working — messages will steer it" : "Message…"}
            rows={2}
            className="flex-1 resize-none"
          />
          {running && sessionId ? (
            <Button variant="destructive" onClick={() => void client.abort(sessionId)}>
              Stop
            </Button>
          ) : (
            <Button onClick={() => void submit()}>Send</Button>
          )}
        </div>
      </div>
      <TaskTranscriptDialog
        taskId={transcriptTaskId}
        open={transcriptTaskId !== null}
        onOpenChange={(open) => {
          if (!open) setTranscriptTaskId(null);
        }}
      />
    </main>
  );
}
