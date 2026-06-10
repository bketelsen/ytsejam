import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { client } from "@/lib/api";
import type { ChatMessage } from "@/lib/types";
import { Message } from "./Message";

export function Chat({
  sessionId,
  messages,
  streaming,
  running,
  onSend,
}: {
  sessionId: string | null;
  messages: ChatMessage[];
  streaming: ChatMessage | null;
  running: boolean;
  onSend: (text: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

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
          <p className="pt-20 text-center text-neutral-600">Start a conversation</p>
        )}
        {messages.map((m, i) => (
          <Message key={i} message={m} toolResults={toolResults} />
        ))}
        {streaming && <Message message={streaming} toolResults={toolResults} />}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-neutral-800 p-3">
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
    </main>
  );
}
