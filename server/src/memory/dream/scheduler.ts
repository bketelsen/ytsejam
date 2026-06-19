const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // hourly

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface DreamSchedulerOpts {
  run: () => Promise<unknown>;
  hour: number;
  lastRunDate: () => string | null;
  nowDate: () => Date;
  intervalMs?: number;
  logger?: (m: string) => void;
}

export class DreamScheduler {
  private opts: DreamSchedulerOpts;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  constructor(opts: DreamSchedulerOpts) { this.opts = opts; }

  isDue(): boolean {
    const now = this.opts.nowDate();
    if (now.getHours() < this.opts.hour) return false;
    return this.opts.lastRunDate() !== ymd(now);
  }

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.inFlight || !this.isDue()) return;
      this.inFlight = true;
      try { await this.opts.run(); }
      catch (e) { (this.opts.logger ?? ((m) => console.warn(m)))(`[dream] run failed: ${(e as Error).message}`); }
      finally { this.inFlight = false; }
    };
    this.timer = setInterval(() => void tick(), this.opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
    void tick(); // check once at boot
  }

  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
