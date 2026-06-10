import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { client } from "@/lib/api";
import type { ModelInfo } from "@/lib/types";

export function Settings({
  open,
  onOpenChange,
  currentSessionId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentSessionId: string | null;
}) {
  const [persona, setPersona] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    void client.getPersona().then((r) => setPersona(r.content));
    void client.getModels().then((r) => {
      setModels(r.models);
      setDefaultModel(r.defaultModel);
    });
    setSaved(false);
  }, [open]);

  async function save() {
    await client.savePersona(persona);
    setSaved(true);
  }

  async function switchModel(ref: string) {
    if (currentSessionId) await client.patchSession(currentSessionId, { model: ref });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <h3 className="mb-1 text-sm font-medium">Persona</h3>
            <Textarea value={persona} onChange={(e) => setPersona(e.target.value)} rows={12} className="font-mono text-sm" />
            <div className="mt-2 flex items-center gap-2">
              <Button onClick={() => void save()}>Save persona</Button>
              {saved && <span className="text-sm text-success">Saved — applies from the next turn</span>}
            </div>
          </div>
          <div>
            <h3 className="mb-1 text-sm font-medium">Model for current session</h3>
            {currentSessionId ? (
              <select
                className="w-full rounded-md border border-input bg-background p-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) void switchModel(e.target.value);
                }}
              >
                <option value="" disabled>
                  Switch model… (default: {defaultModel})
                </option>
                {models.map((m) => (
                  <option key={m.ref} value={m.ref}>
                    {m.provider} / {m.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-sm text-muted-foreground">Open a session to switch its model.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
