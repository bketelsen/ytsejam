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
    <div className="flex h-screen items-center justify-center bg-neutral-950">
      <form onSubmit={submit} className="w-80 space-y-3 rounded-lg border border-neutral-800 p-6">
        <h1 className="text-lg font-semibold text-neutral-100">ytsejam</h1>
        <Input
          type="password"
          placeholder="Access token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        {error && <p className="text-sm text-red-400">Invalid token</p>}
        <Button type="submit" className="w-full">
          Sign in
        </Button>
      </form>
    </div>
  );
}
