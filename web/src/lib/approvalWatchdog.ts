export const APPROVAL_TTL_MS = 5 * 60 * 1000;
export const WATCHDOG_GRACE_MS = 30_000;

export function watchdogDelayMs(createdAt: number, now: number): number {
  if (!Number.isFinite(createdAt)) return 0;
  return Math.max(0, createdAt + APPROVAL_TTL_MS + WATCHDOG_GRACE_MS - now);
}
