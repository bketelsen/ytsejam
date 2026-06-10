import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { client, setToken } from "@/lib/api";

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (await client.login(value)) {
      setToken(value);
      onLoggedIn();
    } else {
      setError(true);
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-background text-foreground">
      <form onSubmit={submit} className="w-80 space-y-3 rounded-lg border border-border bg-card p-6 text-card-foreground shadow-xl">
        <h1 className="text-lg font-semibold">ytsejam</h1>
        <Input
          type="password"
          placeholder="Access token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        {error && <p className="text-sm text-destructive">Invalid token</p>}
        <Button type="submit" className="w-full">
          Sign in
        </Button>
      </form>
    </div>
  );
}
