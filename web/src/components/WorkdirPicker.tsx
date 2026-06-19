import { useEffect, useState } from "react";
import { Folder } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { client } from "@/lib/api";

interface KnownProject {
  path: string;
  label: string;
}

interface WorkdirPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (dir: string) => void;
}

export function WorkdirPicker({ open, onOpenChange, onConfirm }: WorkdirPickerProps) {
  const [knownProjects, setKnownProjects] = useState<KnownProject[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(false);

  // Fetch suggestions each time the dialog opens
  useEffect(() => {
    if (!open) return;
    // Reset state
    setKnownProjects([]);
    setRecent([]);
    setValue("");
    setLoading(true);

    client
      .workdirSuggestions()
      .then((data) => {
        setKnownProjects(data.knownProjects ?? []);
        setRecent(data.recent ?? []);
        // Pre-select the most-recent entry for one-click confirm
        if (data.recent && data.recent.length > 0) {
          setValue(data.recent[0]);
        } else if (data.knownProjects && data.knownProjects.length > 0) {
          setValue(data.knownProjects[0].path);
        }
      })
      .catch(() => {
        // Suggestions failed — that's fine; the free-form input is still available
      })
      .finally(() => {
        setLoading(false);
      });
  }, [open]);

  function handleConfirm() {
    const trimmed = value.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  }

  function selectEntry(path: string) {
    setValue(path);
  }

  const hasLists = knownProjects.length > 0 || recent.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Choose working directory</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Select the directory the new session will run in.
          </p>

          {loading && (
            <p className="text-xs text-muted-foreground">Loading suggestions…</p>
          )}

          {!loading && knownProjects.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Projects
              </p>
              <ul className="max-h-40 overflow-y-auto rounded-md border border-border divide-y divide-border">
                {knownProjects.map((p) => (
                  <li key={p.path}>
                    <button
                      type="button"
                      onClick={() => selectEntry(p.path)}
                      className={
                        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground transition-colors" +
                        (value === p.path ? " bg-accent text-accent-foreground" : "")
                      }
                    >
                      <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-medium">{p.label}</span>
                      <span className="ml-auto truncate text-xs text-muted-foreground">
                        {p.path}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!loading && recent.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Recent
              </p>
              <ul className="max-h-32 overflow-y-auto rounded-md border border-border divide-y divide-border">
                {recent.map((r) => (
                  <li key={r}>
                    <button
                      type="button"
                      onClick={() => selectEntry(r)}
                      className={
                        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground transition-colors" +
                        (value === r ? " bg-accent text-accent-foreground" : "")
                      }
                    >
                      <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{r}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-1">
            {hasLists && (
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Path
              </p>
            )}
            <Input
              autoFocus={!hasLists}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleConfirm();
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
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!value.trim()}>
            Open
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
