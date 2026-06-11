import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { TaskRow } from "@/lib/types";
import { TaskCard, TaskTranscriptDialog } from "./TaskCard";

export function TasksDialog({
  open,
  onOpenChange,
  tasks,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tasks: Record<string, TaskRow>;
}) {
  const [transcriptTaskId, setTranscriptTaskId] = useState<string | null>(null);
  const sorted = Object.values(tasks).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl h-[100dvh] max-h-[100dvh] rounded-none sm:h-auto sm:max-h-[80vh] sm:rounded-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Background tasks</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {sorted.length === 0 && <p className="text-sm text-muted-foreground">No tasks yet.</p>}
            {sorted.map((t) => (
              <TaskCard key={t.id} task={t} onViewTranscript={setTranscriptTaskId} />
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <TaskTranscriptDialog
        taskId={transcriptTaskId}
        open={transcriptTaskId !== null}
        onOpenChange={(o) => {
          if (!o) setTranscriptTaskId(null);
        }}
      />
    </>
  );
}
