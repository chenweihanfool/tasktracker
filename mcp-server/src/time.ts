// Vikunja returns this sentinel value for tasks with no due date set.
export const NO_DUE_DATE = "0001-01-01T00:00:00Z";

export function hasDueDate(task: { due_date?: string }): boolean {
  return Boolean(task.due_date) && task.due_date !== NO_DUE_DATE;
}

function getOffsetMinutes(timeZone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  }).formatToParts(date);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const match = tzName.match(/GMT([+-]\d+)(?::(\d+))?/);
  if (!match) return 0;
  const hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  return hours * 60 + (hours < 0 ? -minutes : minutes);
}

// Returns the [startUTC, endUTC) instants spanning "today" as understood in
// `timeZone`. Approximates using the zone's current UTC offset, so it can be
// off by one day only in the rare case a DST transition lands exactly at
// local midnight -- an acceptable trade-off for a personal task tracker.
export function getTodayBoundsUTC(
  timeZone: string,
  now: Date = new Date(),
): { startUTC: Date; endUTC: Date } {
  const offsetMin = getOffsetMinutes(timeZone, now);
  const localNow = new Date(now.getTime() + offsetMin * 60_000);
  const y = localNow.getUTCFullYear();
  const mo = localNow.getUTCMonth();
  const d = localNow.getUTCDate();
  const startLocalAsUTCMillis = Date.UTC(y, mo, d, 0, 0, 0);
  const startUTC = new Date(startLocalAsUTCMillis - offsetMin * 60_000);
  const endUTC = new Date(startUTC.getTime() + 24 * 60 * 60 * 1000);
  return { startUTC, endUTC };
}
