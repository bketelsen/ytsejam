import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Folder, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { client, getToken, setToken } from "@/lib/api";
import type { ChatMessage, SkillSummary, TaskRow } from "@/lib/types";
import { Message } from "./Message";
import { MessageErrorBoundary } from "./MessageErrorBoundary";
import { TaskTranscriptDialog } from "./TaskCard";
import { SlashOverlay } from "./SlashOverlay";
import { useSlashMenu } from "./useSlashMenu";

export function Chat({
  sessionId,
  messages,
  streaming,
  running,
  compacting,
  tasks,
  cwd,
  onCwdChange,
  onSend,
  onMenuClick,
  headerRight,
}: {
  sessionId: string | null;
  messages: ChatMessage[];
  streaming: ChatMessage | null;
  running: boolean;
  compacting: boolean;
  tasks: Record<string, TaskRow>;
  cwd: string | undefined;
  onCwdChange: (cwd: string | undefined) => void;
  onSend: (text: string) => Promise<void>;
  onMenuClick: () => void;
  headerRight?: React.ReactNode;
}) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const [transcriptTaskId, setTranscriptTaskId] = useState<string | null>(null);
  const [cwdEditorOpen, setCwdEditorOpen] = useState(false);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  useEffect(() => {
    let alive = true;
    client
      .listSkills()
      .then((r) => {
        if (alive) setSkills(r.skills);
      })
      .catch(() => {
        /* overlay is opt-in; silently degrade on auth/network */
      });
    return () => {
      alive = false;
    };
  }, []);

  const slash = useSlashMenu(draft, skills);

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

  // Derive a short label for the working-dir button. Show the last path
  // segment (basename) so it stays narrow on mobile; full path goes in the
  // title= tooltip. Fall back to a generic label when no session is loaded.
  const cwdBasename = useMemo(() => {
    if (!cwd) return "working dir";
    const trimmed = cwd.replace(/\/+$/, "");
    if (!trimmed) return "/";
    const idx = trimmed.lastIndexOf("/");
    return idx >= 0 ? trimmed.slice(idx + 1) || "/" : trimmed;
  }, [cwd]);

  return (
    <main className="flex min-w-0 flex-1 flex-col">
      {/*
        Header strip is always rendered (the burger button is mobile-only via md:hidden,
        and headerRight is conditional). Today App.tsx always supplies headerRight, so the
        desktop strip is never empty. If a future caller mounts <Chat> without headerRight,
        consider guarding the entire <header> on (mobile || headerRight) to avoid a
        ~40px empty bar with a bottom border on desktop.
      */}
      <header className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <Button variant="ghost" size="icon" onClick={onMenuClick} aria-label="Open sessions" className="md:hidden">
          <Menu />
        </Button>
        {headerRight && <div className="ml-auto flex items-center gap-2">{headerRight}</div>}
      </header>
      {compacting && (
        <div className="flex items-center justify-center border-b border-border px-2 py-1">
          <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-xs text-warning animate-pulse">
            compacting…
          </span>
        </div>
      )}
      <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto max-w-4xl space-y-3 p-4">
          {messages.length === 0 && !streaming && (
            <p className="pt-20 text-center text-muted-foreground">Start a conversation</p>
          )}
          {messages.map((m, i) => (
            <MessageErrorBoundary key={i} message={m}>
              <Message message={m} toolResults={toolResults} tasks={tasks} onViewTranscript={setTranscriptTaskId} />
            </MessageErrorBoundary>
          ))}
          {streaming && (
            <MessageErrorBoundary message={streaming}>
              <Message message={streaming} toolResults={toolResults} tasks={tasks} onViewTranscript={setTranscriptTaskId} />
            </MessageErrorBoundary>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="border-t border-border bg-background pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto flex max-w-4xl flex-col gap-2 px-3">
          <div className="relative">
            {slash.open && (
              <SlashOverlay
                items={slash.items}
                activeIndex={slash.activeIndex}
                onSelect={(name) => setDraft(slash.accept(name))}
                onActiveChange={slash.setActiveIndex}
              />
            )}
            <Textarea
              value={draft}
              role="combobox"
              aria-haspopup="listbox"
              aria-expanded={slash.open}
              aria-controls={slash.open ? "slash-overlay" : undefined}
              aria-activedescendant={
                slash.open && slash.items.length > 0
                  ? `slash-option-${slash.activeIndex}`
                  : undefined
              }
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (slash.open) {
                  if (e.nativeEvent.isComposing) return;
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    slash.setActiveIndex(
                      (slash.activeIndex + 1) %
                        Math.max(slash.items.length, 1),
                    );
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    slash.setActiveIndex(
                      (slash.activeIndex - 1 + slash.items.length) %
                        Math.max(slash.items.length, 1),
                    );
                    return;
                  }
                  if (
                    (e.key === "Enter" || e.key === "Tab") &&
                    slash.items.length > 0
                  ) {
                    e.preventDefault();
                    setDraft(
                      slash.accept(slash.items[slash.activeIndex].skill.name),
                    );
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    // Close by appending a space — slash.open is derived from
                    // draft and goes false once any whitespace appears. The
                    // visible draft becomes "/foo " which is harmless. The
                    // pure-derivation design (see Task 3) deliberately has no
                    // dismiss-flag — open state is a pure function of draft.
                    setDraft(draft + " ");
                    return;
                  }
                }
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder={
                running
                  ? "Assistant is working — messages will steer it"
                  : "Message…"
              }
              rows={2}
              className="w-full resize-none"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            {/* Left side: a flex group that can grow as more composer
                buttons (attachments, etc.) are added next to the working-dir
                button. Send stays pinned right via justify-between. */}
            <div className="flex min-w-0 items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCwdEditorOpen(true)}
                disabled={!sessionId}
                title={cwd ?? "No session selected"}
                aria-label={cwd ? `Working directory: ${cwd}` : "Set working directory"}
                className="max-w-[60vw] sm:max-w-xs"
              >
                <Folder />
                <span className="truncate">{cwdBasename}</span>
              </Button>
            </div>
            {running && sessionId ? (
              <Button variant="destructive" onClick={() => void client.abort(sessionId)}>
                Stop
              </Button>
            ) : (
              <Button onClick={() => void submit()}>Send</Button>
            )}
          </div>
        </div>
      </div>
      <CwdEditorDialog
        open={cwdEditorOpen}
        onOpenChange={setCwdEditorOpen}
        sessionId={sessionId}
        cwd={cwd}
        onSaved={(resolved) => {
          onCwdChange(resolved);
          setCwdEditorOpen(false);
        }}
      />
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

function CwdEditorDialog({
  open,
  onOpenChange,
  sessionId,
  cwd,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string | null;
  cwd: string | undefined;
  onSaved: (resolved: string) => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Re-prime the input every time the dialog opens so it reflects the latest
  // server-side cwd (instead of whatever the user previously typed and abandoned).
  useEffect(() => {
    if (open) {
      setValue(cwd ?? "");
      setError(null);
      setSaving(false);
    }
  }, [open, cwd]);

  async function save() {
    if (!sessionId) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      // Do the POST directly (not via the api() helper) so we can read the
      // server's {error: "..."} payload on a 400 and surface it inline.
      const res = await fetch(`/api/sessions/${sessionId}/cwd`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${getToken() ?? ""}`,
        },
        body: JSON.stringify({ cwd: trimmed }),
      });
      if (res.status === 401) {
        // Mirror the api() helper's behaviour: token is dead, force re-login.
        setToken(null);
        window.location.reload();
        return;
      }
      const body = (await res.json().catch(() => null)) as
        | { ok?: true; cwd?: string; error?: string }
        | null;
      if (!res.ok || !body?.cwd) {
        setError(body?.error ?? `HTTP ${res.status}`);
        return;
      }
      onSaved(body.cwd);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Working directory</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Absolute path the assistant&apos;s shell tools will run in for this session.
          </p>
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onOpenChange(false);
              }
            }}
            placeholder="/absolute/path/to/dir"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
          />
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || !value.trim() || !sessionId}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// (The api() helper consumes/discards non-2xx response bodies, so for the
// inline error message in CwdEditorDialog we POST directly above with fetch().)
