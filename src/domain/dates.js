/**
 * Calendar helpers. All period dates are plain ISO date strings (YYYY-MM-DD)
 * with no time component and no timezone. A timesheet day is a calendar day in
 * the Netherlands; attaching a timestamp to it invites an off-by-one at the
 * end of every month and buys nothing.
 */

/** ISO date string for a Y/M/D triple. Month is 1-based. */
export function isoDate(year, month, day) {
  return [
    String(year).padStart(4, '0'),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
  ].join('-');
}

/** Number of days in a 1-based month. */
export function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 0 = Sunday ... 6 = Saturday, for a 1-based month. */
export function weekdayIndex(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function isWeekend(year, month, day) {
  const wd = weekdayIndex(year, month, day);
  return wd === 0 || wd === 6;
}

/**
 * Every calendar day of a month, in order. Spec §4/F2: "one row per calendar
 * day of the month", weekends de-emphasised but enterable.
 */
export function monthDays(year, month) {
  const total = daysInMonth(year, month);
  const days = [];
  for (let day = 1; day <= total; day += 1) {
    days.push({
      day,
      date: isoDate(year, month, day),
      weekday: weekdayIndex(year, month, day),
      weekend: isWeekend(year, month, day),
    });
  }
  return days;
}

/** The current year/month in the Europe/Amsterdam calendar. */
export function currentPeriod(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month') };
}

/** Today as an ISO date in the Europe/Amsterdam calendar. */
export function todayIso(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Localised month name, e.g. "september 2026" / "September 2026". */
export function formatMonth(year, month, locale = 'nl-NL') {
  return new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

/** Short weekday label for a row in the entry grid, e.g. "ma" / "Mon". */
export function formatWeekday(dateIso, locale = 'nl-NL') {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${dateIso}T00:00:00Z`));
}

/** Full date + time, for the audit trail. */
export function formatDateTime(isoString, locale = 'nl-NL') {
  if (!isoString) return '';
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Amsterdam',
  }).format(new Date(isoString));
}

/** Date only, for due dates and history rows. */
export function formatDate(isoString, locale = 'nl-NL') {
  if (!isoString) return '';
  const d = isoString.length === 10
    ? new Date(`${isoString}T00:00:00Z`)
    : new Date(isoString);
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeZone: isoString.length === 10 ? 'UTC' : 'Europe/Amsterdam',
  }).format(d);
}

/**
 * Add whole days to an ISO timestamp, returning an ISO timestamp.
 *
 * Whole days only: setUTCDate truncates a fractional argument, so addDays(x, 0.5)
 * silently returns x unchanged. Use addHours for anything shorter than a day.
 */
export function addDays(isoString, days) {
  const d = new Date(isoString);
  d.setUTCDate(d.getUTCDate() + Math.trunc(days));
  return d.toISOString();
}

/** Add hours to an ISO timestamp. Used for token and session lifetimes. */
export function addHours(isoString, hours) {
  return new Date(new Date(isoString).getTime() + hours * 3600 * 1000).toISOString();
}

/** Sort key so that 2026-01 sorts after 2025-12. */
export function periodKey(year, month) {
  return year * 12 + (month - 1);
}

/**
 * True when `date` (ISO day) falls inside the assignment's start/end window.
 * A null end_date means open-ended. Spec §10 flags partial months as an open
 * item; this is the mechanism that will implement whatever is decided, and
 * today it simply keeps out-of-contract days out of the grid total.
 */
export function withinAssignment(dateIso, assignment) {
  if (assignment.start_date && dateIso < assignment.start_date) return false;
  if (assignment.end_date && dateIso > assignment.end_date) return false;
  return true;
}
