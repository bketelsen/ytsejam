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
  /**
   * Persist `date` (YYYY-MM-DD) as the baseline "already ran today" marker.
   * Called once at start() on a first-ever boot that lands past the hour, so a
   * daytime (re)start does NOT trigger an immediate unsupervised run — the job
   * waits for the next scheduled hour instead. No-op if absent.
   */
  recordBaseline?: (date: string) => void;
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

  /** Whether start() will seed today's baseline instead of running. */
  shouldSeedBaseline(): boolean {
    const now = this.opts.nowDate();
    return this.opts.lastRunDate() === null && now.getHours() >= this.opts.hour;
  }

  start(): void {
    if (this.timer) return;
    // First-ever boot past the hour: do NOT fire now (a daytime restart must
    // not trigger an unsupervised run). Record today as the baseline so the
    // job waits for the next scheduled hour. isDue() then reads it back as
    // "already ran today" and the boot tick below is a no-op.
    if (this.shouldSeedBaseline()) {
      this.opts.recordBaseline?.(ymd(this.opts.nowDate()));
    }
    const tick = async () => {
      if (this.inFlight || !this.isDue()) return;
      this.inFlight = true;
      try { await this.opts.run(); }
      catch (e) { (this.opts.logger ?? ((m) => console.warn(m)))(`[dream] run failed: ${(e as Error).message}`); }
      finally { this.inFlight = false; }
    };
    this.timer = setInterval(() => void tick(), this.opts.intervalMs ?? DEFAULT_INTERVAL_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
    void tick(); // check once at boot (no-op when baseline was just seeded)
  }

  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
