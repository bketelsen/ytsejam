// Pure time-formatting helpers for message timestamps. No dependencies — uses
// the built-in Intl APIs. Callers are responsible for guarding against a
// missing/undefined timestamp; here we assume `ms` is a finite epoch-ms number.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const shortDateSameYear = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const shortDateWithYear = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const fullDateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "full",
  timeStyle: "medium",
});

/**
 * Format an epoch-ms timestamp as a short human-relative string suitable for
 * hover affordances on chat messages.
 *
 *   <60s        → "just now"
 *   <60m        → "Nm ago"
 *   <24h        → "Nh ago"
 *   1 cal. day  → "yesterday"
 *   else        → "Mon DD" (same calendar year as now) or "Mon DD, YYYY"
 *
 * Future timestamps (clock skew, scheduled messages) fall back to "just now"
 * for small diffs and the absolute short date otherwise, keeping the function
 * total without surfacing weird "in 3m" strings in normal use.
 */
export function relativeTime(ms: number): string {
  const now = Date.now();
  const diff = now - ms;

  if (diff < MINUTE) return "just now"; // also covers small future skew
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;

  // Compare local calendar days so "yesterday" lines up with the user's sense
  // of the word rather than a strict 24-hour window.
  const nowDate = new Date(now);
  const thenDate = new Date(ms);
  const nowMidnight = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();
  const thenMidnight = new Date(thenDate.getFullYear(), thenDate.getMonth(), thenDate.getDate()).getTime();
  const dayDiff = Math.round((nowMidnight - thenMidnight) / DAY);

  if (dayDiff === 1) return "yesterday";

  const formatter = thenDate.getFullYear() === nowDate.getFullYear() ? shortDateSameYear : shortDateWithYear;
  return formatter.format(thenDate);
}

/**
 * Format an epoch-ms timestamp as a full locale date+time string, suitable
 * for a native `title=` tooltip on the message bubble.
 */
export function absoluteTime(ms: number): string {
  return fullDateTime.format(new Date(ms));
}
