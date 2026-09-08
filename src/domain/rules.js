/**
 * The rules. Pure functions, no I/O, no storage, no DOM.
 *
 * Everything here is what the spec calls "server-side": the transition table,
 * who may fire which transition, what makes a submission valid, and how a
 * rejection produces a successor version. The mock adapter calls into this
 * module; the Supabase adapter will call the same logic from an edge function.
 * Neither is allowed to reimplement it, because two implementations of a state
 * machine are two state machines.
 *
 * The browser calling these functions is a convenience for rendering, never
 * the authority. See docs/architecture.md, "Trust boundary".
 */

import {
  ROLE,
  PERIOD_STATUS,
  TRANSITIONS,
  TRANSITION_RESULT,
  EDITABLE_STATUSES,
  ALLOWED_TIME_ENTRY_FIELDS,
} from './model.js';
import {
  computeFees,
  quantiseHours,
  ratesAreCoherent,
  round2,
  MAX_HOURS_PER_DAY,
  DEFAULT_HOUR_INCREMENT,
} from './money.js';
import { monthDays, withinAssignment } from './dates.js';

/**
 * A refusal with a stable machine-readable code. The UI translates the code;
 * the message is a developer-facing fallback, never shown verbatim to a user.
 */
export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export const ERROR = Object.freeze({
  NOT_AUTHORISED: 'error.not_authorised',
  ILLEGAL_TRANSITION: 'error.illegal_transition',
  PERIOD_LOCKED: 'error.period_locked',
  NO_HOURS: 'error.no_hours',
  HOURS_OUT_OF_RANGE: 'error.hours_out_of_range',
  HOURS_NOT_A_NUMBER: 'error.hours_not_a_number',
  DATE_OUTSIDE_PERIOD: 'error.date_outside_period',
  DATE_OUTSIDE_ASSIGNMENT: 'error.date_outside_assignment',
  COMMENT_REQUIRED: 'error.comment_required',
  RATES_INCOHERENT: 'error.rates_incoherent',
  FORBIDDEN_FIELD: 'error.forbidden_field',
  ASSIGNMENT_ENDED: 'error.assignment_ended',
  ASSIGNMENT_NOT_ACTIVE: 'error.assignment_not_active',
  NOT_FOUND: 'error.not_found',
  LINK_INVALID: 'error.link_invalid',
  LINK_EXPIRED: 'error.link_expired',
  LINK_ALREADY_USED: 'error.link_already_used',
  UNKNOWN_EMAIL: 'error.unknown_email',
  // The link could not be sent. Distinct from "no such account" on purpose —
  // see the note on requestMagicLink in the Supabase adapter.
  LINK_RATE_LIMITED: 'error.link_rate_limited',
  LINK_SEND_FAILED: 'error.link_send_failed',
});

/* ------------------------------------------------------------------ *
 * Authorisation - spec section 2
 * ------------------------------------------------------------------ */

/**
 * Which actions each role may fire. `ops` is deliberately absent from the
 * per-action lists and short-circuited below: spec section 2 gives ops
 * everything, via the admin panel rather than a custom UI.
 */
const ROLE_ACTIONS = Object.freeze({
  [ROLE.FREELANCER]: Object.freeze(['view', 'edit', 'submit']),
  [ROLE.APPROVER]: Object.freeze(['view', 'approve', 'reject']),
});

/**
 * True when `user` is a party to `assignment`. Membership, not role - a
 * freelancer may only touch their own assignment, an approver only the
 * assignment they are named on, and only within their own organisation.
 */
export function isPartyTo(user, assignment) {
  if (!user || !assignment) return false;
  if (user.role === ROLE.OPS) return true;
  if (user.role === ROLE.FREELANCER) return assignment.freelancer_id === user.id;
  if (user.role === ROLE.APPROVER) {
    return assignment.approver_id === user.id
      && !!user.organization_id
      && assignment.organization_id === user.organization_id;
  }
  return false;
}

/** Throws unless `user` may fire `action` on `assignment`. */
export function assertAuthorised(user, assignment, action) {
  if (!user) {
    throw new DomainError(ERROR.NOT_AUTHORISED, 'No session');
  }
  if (user.role === ROLE.OPS) return;
  if (!isPartyTo(user, assignment)) {
    throw new DomainError(ERROR.NOT_AUTHORISED, 'Not a party to this assignment');
  }
  const allowed = ROLE_ACTIONS[user.role] || [];
  if (!allowed.includes(action)) {
    throw new DomainError(ERROR.NOT_AUTHORISED, 'Role may not perform ' + action);
  }
}

/* ------------------------------------------------------------------ *
 * State machine - spec section 3
 * ------------------------------------------------------------------ */

export function canTransition(period, action) {
  const allowed = TRANSITIONS[period && period.status] || [];
  return allowed.includes(action);
}

export function nextStatus(action) {
  return TRANSITION_RESULT[action] || null;
}

/** Throws unless the period is in a status from which `action` is legal. */
export function assertTransition(period, action) {
  if (!period) throw new DomainError(ERROR.NOT_FOUND, 'No period');
  if (!canTransition(period, action)) {
    throw new DomainError(
      ERROR.ILLEGAL_TRANSITION,
      'Cannot ' + action + ' a period in status ' + period.status,
      { from: period.status, action },
    );
  }
}

/** Spec section 3: nothing is editable once submitted. */
export function isEditable(period) {
  return !!period && EDITABLE_STATUSES.includes(period.status);
}

export function assertEditable(period) {
  if (!isEditable(period)) {
    throw new DomainError(ERROR.PERIOD_LOCKED, 'Period is locked', {
      status: period && period.status,
    });
  }
}

/* ------------------------------------------------------------------ *
 * Entry validation - spec section 4/F2 and section 6
 * ------------------------------------------------------------------ */

/**
 * COMPLIANCE section 6. Rejects any entry carrying a field outside the
 * allow-list. This runs on every draft save so a field cannot be smuggled in
 * through a client that was built against a newer, non-compliant model.
 */
export function assertNoForbiddenFields(entry) {
  for (const key of Object.keys(entry)) {
    if (!ALLOWED_TIME_ENTRY_FIELDS.includes(key)) {
      throw new DomainError(ERROR.FORBIDDEN_FIELD, 'TimeEntry may not carry ' + key, {
        field: key,
      });
    }
  }
}

/**
 * Normalise and validate a set of day entries against a period.
 *
 * Returns { entries, totalHours } where entries are quantised, zero and blank
 * days are dropped, and the total is the number the freelancer sees and the
 * number that will be invoiced.
 */
export function normaliseEntries(rawEntries, period, assignment) {
  const increment = assignment.hour_increment || DEFAULT_HOUR_INCREMENT;
  const validDates = new Set(monthDays(period.year, period.month).map((d) => d.date));
  const byDate = new Map();

  for (const raw of rawEntries) {
    assertNoForbiddenFields(raw);

    if (!validDates.has(raw.date)) {
      throw new DomainError(ERROR.DATE_OUTSIDE_PERIOD, raw.date + ' is not in this period', {
        date: raw.date,
      });
    }
    if (!withinAssignment(raw.date, assignment)) {
      throw new DomainError(
        ERROR.DATE_OUTSIDE_ASSIGNMENT,
        raw.date + ' falls outside the assignment window',
        { date: raw.date },
      );
    }

    const hours = raw.hours;
    if (hours === null || hours === undefined || hours === '') continue;
    if (!Number.isFinite(hours)) {
      throw new DomainError(ERROR.HOURS_NOT_A_NUMBER, raw.date + ': not a number', {
        date: raw.date,
      });
    }
    if (hours < 0 || hours > MAX_HOURS_PER_DAY) {
      throw new DomainError(
        ERROR.HOURS_OUT_OF_RANGE,
        raw.date + ': out of range',
        { date: raw.date, hours, max: MAX_HOURS_PER_DAY },
      );
    }

    const quantised = quantiseHours(hours, increment);
    if (quantised <= 0) continue;

    // Last write wins if a date appears twice; the grid cannot produce this,
    // but an adapter replaying a payload could.
    byDate.set(raw.date, { date: raw.date, hours: quantised });
  }

  const entries = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const totalHours = round2(entries.reduce((sum, e) => sum + e.hours, 0));
  return { entries, totalHours };
}

/**
 * Everything the confirmation step in F2 must show before commit: total hours,
 * total charges, and the resulting invoice amount. Spec section 4/F2.
 */
export function buildSubmissionSummary(period, entries, assignment, charges = []) {
  const normalised = normaliseEntries(entries, period, assignment);
  const fees = computeFees(assignment, normalised.totalHours);
  const chargeTotal = charges
    .filter((c) => c.status !== 'rejected')
    .reduce((sum, c) => sum + (c.amount_gross || 0), 0);

  return Object.assign({
    entries: normalised.entries,
    days_with_hours: normalised.entries.length,
    total_hours: normalised.totalHours,
    charges_total: chargeTotal,
  }, fees, {
    client_total_with_charges: fees.client_total + chargeTotal,
  });
}

/** Throws unless the period is fit to submit. */
export function assertSubmittable(period, entries, assignment) {
  const anyDayInWindow = monthDays(period.year, period.month)
    .some((d) => withinAssignment(d.date, assignment));
  if (!anyDayInWindow) {
    throw new DomainError(ERROR.ASSIGNMENT_ENDED, 'No day of this period falls in the assignment');
  }
  if (!ratesAreCoherent(assignment)) {
    throw new DomainError(ERROR.RATES_INCOHERENT, 'Assignment rates are inconsistent');
  }
  assertTransition(period, 'submit');
  const normalised = normaliseEntries(entries, period, assignment);
  if (normalised.totalHours <= 0) {
    throw new DomainError(ERROR.NO_HOURS, 'A period cannot be submitted with zero hours');
  }
}

/** Spec section 4/C1: comment mandatory on reject. */
export function assertRejectionComment(comment) {
  if (typeof comment !== 'string' || comment.trim().length < 3) {
    throw new DomainError(ERROR.COMMENT_REQUIRED, 'A rejection must carry a reason');
  }
  return comment.trim();
}

/* ------------------------------------------------------------------ *
 * Versioning - spec section 3
 * ------------------------------------------------------------------ */

/**
 * The successor a rejection produces. The rejected version is never mutated:
 * it keeps its status, its numbers and its decision. The successor starts as a
 * fresh draft, pre-filled with the rejected version's entries so the freelancer
 * corrects rather than retypes (spec section 4/F2).
 */
export function buildSuccessorPeriod(rejected, newId, now = new Date()) {
  return {
    id: newId,
    assignment_id: rejected.assignment_id,
    year: rejected.year,
    month: rejected.month,
    version: rejected.version + 1,
    supersedes_id: rejected.id,
    status: PERIOD_STATUS.DRAFT,
    submitted_at: null,
    decided_at: null,
    decided_by: null,
    rejection_comment: null,
    created_at: now.toISOString(),
  };
}

/** The version a screen should show for a given month: the highest one. */
export function currentVersion(periods) {
  if (!periods || periods.length === 0) return null;
  return periods.reduce((best, p) => (p.version > best.version ? p : best));
}
