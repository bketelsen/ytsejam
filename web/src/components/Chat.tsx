import { useEffect, useRef, useState } from "react";
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
}: {
  sessionId: string | null;
  messages: ChatMessage[];
  streaming: ChatMessage | null;
  running: boolean;
  tasks: Record<string, TaskRow>;
  onSend: (text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const [transcriptTaskId, setTranscriptTaskId] = useState<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streaming]);

  const toolResults = new Map<string, ChatMessage>();
  for (const m of messages) {
    if (m.role === "toolResult" && m.toolCallId) toolResults.set(m.toolCallId, m);
  }

  async function submit() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    await onSend(text);
  }

  return (
    <main className="flex flex-1 flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && !streaming && (
          <p className="pt-20 text-center text-muted-foreground">Start a conversation</p>
        )}
        {messages.map((m, i) => (
          <Message key={i} message={m} toolResults={toolResults} tasks={tasks} onViewTranscript={setTranscriptTaskId} />
        ))}
        {streaming && <Message message={streaming} toolResults={toolResults} tasks={tasks} onViewTranscript={setTranscriptTaskId} />}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-border bg-background p-3">
        <div className="flex gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
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
