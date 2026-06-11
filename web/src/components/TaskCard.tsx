import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { client } from "@/lib/api";
import type { ChatMessage, TaskRow } from "@/lib/types";
import { Message } from "./Message";

const STATUS_STYLES: Record<string, string> = {
  pending: "text-muted-foreground",
  running: "text-warning animate-pulse",
  completed: "text-success",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
  interrupted: "text-warning",
};

function elapsed(task: TaskRow): string {
  if (!task.startedAt) return "";
  const end = task.finishedAt ? new Date(task.finishedAt).getTime() : Date.now();
  const secs = Math.max(0, Math.round((end - new Date(task.startedAt).getTime()) / 1000));
  return secs < 120 ? `${secs}s` : `${Math.round(secs / 60)}m`;
}

export function TaskTranscriptDialog({
  taskId,
  open,
  onOpenChange,
}: {
  taskId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [task, setTask] = useState<TaskRow | null>(null);

  useEffect(() => {
    if (!open || !taskId) return;
    let stop = false;
    async function poll() {
      try {
        const r = await client.getTaskTranscript(taskId!);
        if (stop) return;
        setTask(r.task);
        setMessages(r.messages);
        if (r.task.status === "running" || r.task.status === "pending") {
          setTimeout(poll, 2000);
        }
      } catch {
        // transcript may not exist yet (task pending); retry
        if (!stop) setTimeout(poll, 2000);
      }
    }
    void poll();
    return () => {
      stop = true;
    };
  }, [open, taskId]);

  const toolResults = new Map<string, ChatMessage>();
  for (const m of messages) {
    if (m.role === "toolResult" && m.toolCallId) toolResults.set(m.toolCallId, m);
  }
  // a terminal task is no longer working — any tool call without a result was
  // cut off, so render it as interrupted rather than a perpetual "running…"
  const live = !task || task.status === "running" || task.status === "pending";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl h-[100dvh] max-h-[100dvh] rounded-none sm:h-auto sm:max-h-[80vh] sm:rounded-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {task ? `${task.label} — ${task.status}` : "Task transcript"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {messages.length === 0 && <p className="text-sm text-muted-foreground">No transcript yet…</p>}
          {messages.map((m, i) => (
            <Message key={i} message={m} toolResults={toolResults} interrupted={!live} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function TaskCard({
  task,
  onViewTranscript,
}: {
  task: TaskRow | undefined;
  onViewTranscript: (taskId: string) => void;
}) {
  if (!task) {
    return (
      <div className="my-1 rounded-md border border-border bg-card p-2 text-sm text-muted-foreground">
        background task (status unknown)
      </div>
    );
  }
  return (
    <div className="my-1 flex items-center gap-3 rounded-md border border-border bg-card p-2 text-sm text-card-foreground">
      <span className={STATUS_STYLES[task.status] ?? ""}>●</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-medium">{task.label}</span>
          <span className="text-xs text-muted-foreground">
            {task.status}
            {elapsed(task) && ` · ${elapsed(task)}`}
          </span>
        </div>
        {task.resultSummary && (
          <p className="truncate text-xs text-muted-foreground">{task.resultSummary}</p>
        )}
      </div>
      {(task.status === "running" || task.status === "pending") && (
        <Button variant="outline" size="sm" onClick={() => void client.cancelTask(task.id)}>
          Cancel
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={() => onViewTranscript(task.id)}>
        View
      </Button>
    </div>
  );
}
