import { existsSync } from "node:fs";
import os from "node:os";
import * as pty from "node-pty";

export interface TerminalSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface TerminalSessionOptions {
  cols?: number;
  rows?: number;
  shell?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onData: (data: string) => void;
  onExit: (code: number | undefined) => void;
}

function defaultShell(): string {
  if (process.env.SHELL) return process.env.SHELL;
  if (process.platform === "win32") return "powershell.exe";
  return existsSync("/bin/bash") || existsSync("/usr/bin/bash") ? "bash" : "sh";
}

export function createTerminalSession({
  cols = 80,
  rows = 24,
  shell = defaultShell(),
  args = [],
  cwd = os.homedir(),
  env = process.env,
  onData,
  onExit,
}: TerminalSessionOptions): TerminalSession {
  const proc = pty.spawn(shell, args, {
    name: "xterm-color",
    cols,
    rows,
    cwd,
    env,
  });

  let killed = false;
  let exited = false;
  const dataDisposable = proc.onData(onData);
  let exitDisposable: pty.IDisposable | null = null;
  exitDisposable = proc.onExit((event) => {
    exited = true;
    dataDisposable.dispose();
    exitDisposable?.dispose();
    onExit(event.exitCode);
  });

  return {
    write(data) {
      if (!killed && !exited) proc.write(data);
    },
    resize(nextCols, nextRows) {
      if (!killed && !exited) proc.resize(nextCols, nextRows);
    },
    kill() {
      if (killed || exited) return;
      killed = true;
      dataDisposable.dispose();
      proc.kill();
    },
  };
}
