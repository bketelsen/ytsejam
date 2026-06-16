import { useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/api";
import type { SessionRow } from "@/lib/types";

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
}

export function Sidebar({
  sessions,
  currentId,
  onSelect,
  onNew,
  onArchived,
  onOpenSettings,
  onOpenTasks,
  runningTasks,
}: {
  sessions: SessionRow[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** Called after archive/unarchive completes so the active list can refresh. */
  onArchived: (id: string) => void;
  onOpenSettings: () => void;
  onOpenTasks: () => void;
  runningTasks: number;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [archivedRows, setArchivedRows] = useState<SessionRow[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Synchronous re-entry latch: Enter and a trailing blur can both call commitRename
  // bound to the same render closure (where editingId still equals id), so a state-read
  // guard wouldn't stop the second. A ref is shared across closures and set synchronously,
  // so the first call latches it and the second returns immediately — independent of
  // whether React fires onBlur for the unmounting input.
  const committingRef = useRef(false);

  // Reload the archived list when the panel is opened. It's a small fetch on a
  // user gesture; not worth maintaining a live cache.
  useEffect(() => {
    if (!showArchived) return;
    let cancelled = false;
    setArchivedLoading(true);
    void client.listSessions({ includeArchived: true }).then((r) => {
      if (cancelled) return;
      setArchivedRows(r.sessions.filter((s) => s.archived));
      setArchivedLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [showArchived]);

  async function archive(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    // No confirm — archive is reversible by design.
    await client.archiveSession(id);
    onArchived(id);
  }

  async function unarchive(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    await client.unarchiveSession(id);
    setArchivedRows((prev) => prev.filter((s) => s.id !== id));
    onArchived(id);
  }

  function startRename(s: SessionRow, e: React.MouseEvent) {
    e.stopPropagation();
    setEditingId(s.id);
    setDraft(s.title ?? "");
  }

  async function commitRename(id: string) {
    if (committingRef.current) return; // re-entry latch (handles Enter+blur double-fire)
    committingRef.current = true;
    try {
      const next = draft.trim();
      const original = sessions.find((s) => s.id === id)?.title ?? "";
      setEditingId(null);
      if (!next || next === original) return; // empty/whitespace or unchanged → no write
      await client.patchSession(id, { title: next });
      // Server emits a session_info update over WS; useApp's list re-renders the row.
    } finally {
      committingRef.current = false;
    }
  }

  function cancelRename() {
    setEditingId(null);
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 px-3 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <Button onClick={onNew} className="flex-1">
          New chat
        </Button>
        <Button variant="outline" onClick={onOpenTasks}>
          Tasks{runningTasks > 0 ? ` (${runningTasks})` : ""}
        </Button>
        <Button variant="outline" onClick={onOpenSettings}>
          ⚙
        </Button>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-2">
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={[
              "group cursor-pointer rounded-md p-2",
              s.id === currentId ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent",
              s.approvalMode === "yolo" ? "border-l-2 border-warning" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          >
            <div className="flex items-center gap-2">
              {s.compacting ? (
                <span className="size-2 shrink-0 animate-pulse rounded-full bg-warning" />
              ) : s.running ? (
                <span className="size-2 shrink-0 animate-pulse rounded-full bg-success" />
              ) : s.unread ? (
                <span className="size-2 shrink-0 rounded-full bg-primary" />
              ) : null}
              {editingId === s.id ? (
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void commitRename(s.id);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelRename();
                    }
                  }}
                  onBlur={() => void commitRename(s.id)}
                  className="flex-1 rounded border border-sidebar-border bg-sidebar px-1 text-sm text-sidebar-foreground outline-none"
                  aria-label="Session title"
                />
              ) : (
                <span
                  className="flex-1 truncate text-sm"
                  title={s.title ?? undefined}
                  onDoubleClick={(e) => startRename(s, e)}
                >
                  {s.title ?? "New session"}
                  {s.approvalMode === "yolo" ? <span className="sr-only"> (approvals off)</span> : null}
                </span>
              )}
              {editingId === s.id ? null : <span className="text-xs text-muted-foreground">{timeAgo(s.updatedAt)}</span>}
              {editingId === s.id ? null : (
                <button
                  data-slot="button"
                  onClick={(e) => startRename(s, e)}
                  className="block text-muted-foreground hover:text-foreground md:hidden md:group-hover:block"
                  title="Rename"
                  aria-label="Rename session"
                >
                  <Pencil className="size-4" />
                </button>
              )}
              {editingId === s.id ? null : (
                <button
                  data-slot="button"
                  onClick={(e) => archive(s.id, e)}
                  className="block text-muted-foreground hover:text-foreground md:hidden md:group-hover:block"
                  title="Archive"
                  aria-label="Archive session"
                >
                  <Archive className="size-4" />
                </button>
              )}
            </div>
            <p className="truncate text-xs text-muted-foreground">{s.preview}</p>
          </div>
        ))}
        {sessions.length === 0 && <p className="p-2 text-sm text-muted-foreground">No sessions yet</p>}
      </nav>
      {/* Archived sessions panel — collapsed by default, fetched on open. */}
      <div className="border-t border-sidebar-border">
        <button
          data-slot="button"
          onClick={() => setShowArchived((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={showArchived}
        >
          <span>{showArchived ? "Hide archived" : "Show archived"}</span>
          <span aria-hidden>{showArchived ? "−" : "+"}</span>
        </button>
        {showArchived && (
          <div className="max-h-48 overflow-y-auto px-2 pb-2">
            {archivedLoading && <p className="p-2 text-xs text-muted-foreground">Loading…</p>}
            {!archivedLoading && archivedRows.length === 0 && (
              <p className="p-2 text-xs text-muted-foreground">No archived sessions</p>
            )}
            {archivedRows.map((s) => (
              <div key={s.id} className="group rounded-md p-2 opacity-60 hover:opacity-100">
                <div className="flex items-center gap-2">
                  <span className="flex-1 truncate text-sm">{s.title ?? "New session"}</span>
                  <span className="text-xs text-muted-foreground">{timeAgo(s.updatedAt)}</span>
                  <button
                    data-slot="button"
                    onClick={(e) => unarchive(s.id, e)}
                    className="block text-muted-foreground hover:text-foreground"
                    title="Unarchive"
                    aria-label="Unarchive session"
                  >
                    <ArchiveRestore className="size-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
