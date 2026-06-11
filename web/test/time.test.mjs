import test from "node:test";
import assert from "node:assert/strict";

// Time helper is plain TypeScript with no JSX or React deps, so Node 22+'s
// built-in type stripping can import the .ts file directly.
const { relativeTime, absoluteTime } = await import("../src/lib/time.ts");

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test("relativeTime: <60s returns 'just now'", () => {
  const now = Date.now();
  assert.equal(relativeTime(now), "just now");
  assert.equal(relativeTime(now - 1 * SECOND), "just now");
  assert.equal(relativeTime(now - 30 * SECOND), "just now");
  assert.equal(relativeTime(now - 59 * SECOND), "just now");
});

test("relativeTime: 1-59 minutes formats as 'Nm ago'", () => {
  const now = Date.now();
  assert.equal(relativeTime(now - 1 * MINUTE), "1m ago");
  assert.equal(relativeTime(now - 5 * MINUTE), "5m ago");
  assert.equal(relativeTime(now - 59 * MINUTE), "59m ago");
});

test("relativeTime: 1-23 hours within the same calendar day formats as 'Nh ago'", () => {
  // Use noon today as the synthetic "now" reference to avoid midnight-edge
  // ambiguity: anything between 1h and 11h before noon is still today.
  // Since we can't inject `now`, just sanity-check small offsets that are
  // guaranteed same-day regardless of clock position (>=2h after midnight,
  // <=2h before midnight is the worst case — we stay well clear).
  const now = Date.now();
  const nowDate = new Date(now);
  // Only run the per-hour assertions if "now" is at least 3h after local
  // midnight and at least 3h before local midnight tomorrow, so that
  // subtracting up to 2h stays in the same calendar day.
  const minsIntoDay = nowDate.getHours() * 60 + nowDate.getMinutes();
  if (minsIntoDay >= 180 && minsIntoDay <= 24 * 60 - 180) {
    assert.equal(relativeTime(now - 1 * HOUR), "1h ago");
    assert.equal(relativeTime(now - 2 * HOUR), "2h ago");
  } else {
    // Near midnight; just confirm the format shape with a guaranteed-same-day
    // offset of 1h, which holds unless we're in the first/last hour.
    if (minsIntoDay >= 60 && minsIntoDay <= 24 * 60 - 60) {
      assert.equal(relativeTime(now - 1 * HOUR), "1h ago");
    }
  }
});

test("relativeTime: 1 calendar day ago returns 'yesterday'", () => {
  // Use noon today and noon yesterday to avoid DST/midnight edge cases.
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const yesterday = new Date(today.getTime() - DAY);
  assert.equal(relativeTime(yesterday.getTime()), "yesterday");
});

test("relativeTime: older than yesterday returns a short date string", () => {
  // 5 days ago — must not be "yesterday" / "just now" / contain "ago".
  const out = relativeTime(Date.now() - 5 * DAY);
  assert.notEqual(out, "yesterday");
  assert.notEqual(out, "just now");
  assert.doesNotMatch(out, /ago$/);
  assert.ok(out.length > 0);
});

test("relativeTime: a date in a previous calendar year includes the year", () => {
  // Pick a fixed date well in the past so it crosses a year boundary
  // regardless of when the test runs (>= 400 days ago).
  const longAgo = Date.now() - 400 * DAY;
  const out = relativeTime(longAgo);
  // Must include a 4-digit year somewhere — short month-day format never does.
  assert.match(out, /\b\d{4}\b/, `expected a 4-digit year in ${JSON.stringify(out)}`);
});

test("relativeTime: small future skew also reads 'just now'", () => {
  // Clock skew between server and browser shouldn't surface weirdness.
  assert.equal(relativeTime(Date.now() + 10 * SECOND), "just now");
});

test("absoluteTime: returns a non-empty locale string for a valid timestamp", () => {
  const out = absoluteTime(Date.now());
  assert.equal(typeof out, "string");
  assert.ok(out.length > 0, "absoluteTime should not be empty");
  // Must not be the literal "Invalid Date".
  assert.notEqual(out, "Invalid Date");
});
