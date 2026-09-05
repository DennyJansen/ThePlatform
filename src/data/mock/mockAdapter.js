/**
 * Browser-local implementation of the data port.
 *
 * This adapter is the authority for the demo the way an API server is the
 * authority for the real thing: screens ask it to submit or approve, it decides
 * whether that is legal by calling into src/domain/rules.js, and it writes an
 * audit row for every state change. Screens never write storage themselves.
 *
 * What it cannot do, and does not pretend to do: enforce anything against a
 * determined user. Everything here runs in the browser, so anyone with a
 * console can rewrite localStorage. That is why this is the demo adapter and
 * not the production one. The same call sequence against Supabase runs behind
 * row-level security and edge functions, where the check is real.
 */

import {
  ROLE,
  PERIOD_STATUS,
  AUDIT_ACTION,
} from '../../domain/model.js';
import {
  DomainError,
  ERROR,
  assertAuthorised,
  assertEditable,
  assertRejectionComment,
  assertSubmittable,
  assertTransition,
  buildSubmissionSummary,
  buildSuccessorPeriod,
  currentVersion,
  normaliseEntries,
} from '../../domain/rules.js';
import { addDays, addHours, periodKey } from '../../domain/dates.js';
import { load, transact, save, newId, newToken, storageIsPersistent } from './store.js';
import { buildSeed } from './seed.js';

const MAGIC_LINK_TTL_HOURS = 24;
const SESSION_TTL_HOURS = 12;

/** Resolve on a macrotask so callers cannot accidentally depend on sync-ness. */
function later(value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), 0));
}

function fail(code, message, details) {
  return Promise.reject(new DomainError(code, message, details));
}

function ensureSeeded() {
  const db = load();
  if (db.users.length === 0) {
    save(buildSeed());
    return load();
  }
  return db;
}

function findUser(db, id) {
  return db.users.find((u) => u.id === id) || null;
}

function sessionUser(db) {
  if (!db.session) return null;
  if (db.session.expires_at && db.session.expires_at < new Date().toISOString()) return null;
  return findUser(db, db.session.user_id);
}

function toSession(db, user) {
  return {
    user_id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    organization_id: user.organization_id,
    issued_at: db.session ? db.session.issued_at : new Date().toISOString(),
    expires_at: db.session ? db.session.expires_at : null,
  };
}

/**
 * Append an audit row. Called inside transact so the append-only check in
 * store.js sees it. Spec section 3: actor, assignment, object, action, payload.
 */
function appendAudit(db, actorId, assignmentId, objectType, objectId, action, payload) {
  db.audit_events.push({
    id: newId('aud'),
    actor_id: actorId,
    assignment_id: assignmentId,
    object_type: objectType,
    object_id: objectId,
    action,
    payload_json: payload || {},
    created_at: new Date().toISOString(),
  });
}

/**
 * Assemble the object every period screen renders from. Doing this in one place
 * means F2 and C1 cannot drift apart on what "the period" means - which is the
 * whole point of spec section 4/C1, "same period object as F2, read-only".
 */
function buildPeriodView(db, period) {
  const assignment = db.assignments.find((a) => a.id === period.assignment_id);
  if (!assignment) throw new DomainError(ERROR.NOT_FOUND, 'Assignment missing');

  const organization = db.organizations.find((o) => o.id === assignment.organization_id) || null;
  const freelancer = findUser(db, assignment.freelancer_id);
  const approver = findUser(db, assignment.approver_id);
  const entries = db.entries
    .filter((e) => e.period_id === period.id)
    .map((e) => ({ date: e.date, hours: e.hours }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const charges = db.charges.filter((c) => c.period_id === period.id);

  const history = db.periods
    .filter((p) => p.assignment_id === period.assignment_id
      && p.year === period.year
      && p.month === period.month
      && p.id !== period.id)
    .sort((a, b) => a.version - b.version)
    .map((p) => ({
      id: p.id,
      version: p.version,
      status: p.status,
      submitted_at: p.submitted_at,
      decided_at: p.decided_at,
      rejection_comment: p.rejection_comment,
      total_hours: db.entries
        .filter((e) => e.period_id === p.id)
        .reduce((sum, e) => sum + e.hours, 0),
    }));

  const summary = buildSubmissionSummary(period, entries, assignment, charges);

  let dueDate = null;
  // Spec section 7: only surface a due date when something happens on it.
  // Auto-approve is the only consequence, and it ships disabled, so the date is
  // carried here but the UI is told not to present it as a deadline.
  if (period.submitted_at && assignment.approval_window_days) {
    dueDate = addDays(period.submitted_at, assignment.approval_window_days);
  }

  return {
    period,
    assignment,
    organization,
    freelancer,
    approver,
    entries,
    charges,
    history,
    summary,
    due_date: dueDate,
    due_date_is_binding: !!assignment.auto_approve_enabled,
  };
}

function requireSession(db) {
  const user = sessionUser(db);
  if (!user) throw new DomainError(ERROR.NOT_AUTHORISED, 'No session');
  return user;
}

function requirePeriod(db, periodId) {
  const period = db.periods.find((p) => p.id === periodId);
  if (!period) throw new DomainError(ERROR.NOT_FOUND, 'No such period');
  return period;
}

function assignmentOf(db, period) {
  const assignment = db.assignments.find((a) => a.id === period.assignment_id);
  if (!assignment) throw new DomainError(ERROR.NOT_FOUND, 'No such assignment');
  return assignment;
}

export function createMockAdapter() {
  ensureSeeded();

  const adapter = {
    isMock: true,

    /** True when data survives a reload. False in a private window. */
    isPersistent() {
      return storageIsPersistent();
    },

    /* ---------------- Auth: spec section 4/F1 ---------------- */

    /**
     * Magic link only. No passwords, no account creation - accounts are made by
     * ops when an assignment is set up, so an unknown address is a refusal
     * rather than a signup.
     *
     * There is no mail server here, so the link is returned for display. The
     * Supabase adapter returns delivery:'email' and no token; every caller must
     * handle both, which is why the shape is the same.
     */
    requestMagicLink(email) {
      try {
        const normalised = String(email || '').trim().toLowerCase();
        const db = ensureSeeded();
        const user = db.users.find((u) => u.email.toLowerCase() === normalised);
        if (!user) return fail(ERROR.UNKNOWN_EMAIL, 'No account for that address');
        if (user.role === ROLE.OPS) {
          // Spec section 2: ops works in the admin panel, not this UI.
          return fail(ERROR.NOT_AUTHORISED, 'Ops signs in to the admin panel');
        }

        const token = newToken();
        const expiresAt = addHours(new Date().toISOString(), MAGIC_LINK_TTL_HOURS);

        transact((d) => {
          d.magic_links.push({
            id: newId('mlk'),
            token,
            user_id: user.id,
            email: user.email,
            created_at: new Date().toISOString(),
            expires_at: expiresAt,
            used_at: null,
          });
          appendAudit(d, user.id, null, 'User', user.id,
            AUDIT_ACTION.MAGIC_LINK_REQUESTED, { email: user.email });
        });

        return later({ token, expires_at: expiresAt, delivery: 'on_screen' });
      } catch (err) {
        return Promise.reject(err);
      }
    },

    /** Single use, 24h. Spec section 4/F1. */
    consumeMagicLink(token) {
      try {
        const result = transact((d) => {
          const link = d.magic_links.find((l) => l.token === token);
          if (!link) throw new DomainError(ERROR.LINK_INVALID, 'Unknown link');
          if (link.used_at) throw new DomainError(ERROR.LINK_ALREADY_USED, 'Link already used');
          if (link.expires_at < new Date().toISOString()) {
            throw new DomainError(ERROR.LINK_EXPIRED, 'Link expired');
          }
          const user = findUser(d, link.user_id);
          if (!user) throw new DomainError(ERROR.LINK_INVALID, 'Account gone');

          link.used_at = new Date().toISOString();
          d.session = {
            user_id: user.id,
            issued_at: new Date().toISOString(),
            expires_at: addHours(new Date().toISOString(), SESSION_TTL_HOURS),
          };
          appendAudit(d, user.id, null, 'User', user.id,
            AUDIT_ACTION.MAGIC_LINK_CONSUMED, {});
          return toSession(d, user);
        });
        return later(result);
      } catch (err) {
        return Promise.reject(err);
      }
    },

    getSession() {
      const db = ensureSeeded();
      const user = sessionUser(db);
      return later(user ? toSession(db, user) : null);
    },

    signOut() {
      try {
        transact((d) => {
          const user = sessionUser(d);
          if (user) appendAudit(d, user.id, null, 'User', user.id, AUDIT_ACTION.SIGNED_OUT, {});
          d.session = null;
        });
        return later(undefined);
      } catch (err) {
        return Promise.reject(err);
      }
    },

    /* ---------------- Assignments ---------------- */

    listAssignments() {
      try {
        const db = ensureSeeded();
        const user = requireSession(db);
        const rows = db.assignments
          .filter((a) => {
            if (user.role === ROLE.OPS) return true;
            if (user.role === ROLE.FREELANCER) return a.freelancer_id === user.id;
            return a.approver_id === user.id && a.organization_id === user.organization_id;
          })
          .map((a) => {
            const org = db.organizations.find((o) => o.id === a.organization_id);
            const fl = findUser(db, a.freelancer_id);
            const periods = db.periods.filter((p) => p.assignment_id === a.id);
            const settled = periods.filter((p) => [
              PERIOD_STATUS.APPROVED, PERIOD_STATUS.INVOICED, PERIOD_STATUS.PAID,
            ].includes(p.status));
            const hoursToDate = settled.reduce((sum, p) => sum
              + db.entries.filter((e) => e.period_id === p.id)
                .reduce((s, e) => s + e.hours, 0), 0);
            return {
              ...a,
              organization_name: org ? org.name : null,
              freelancer_name: fl ? fl.name : null,
              hours_to_date: Math.round(hoursToDate * 100) / 100,
              spend_to_date: Math.round(hoursToDate * a.client_rate_per_hour),
            };
          });
        return later(rows);
      } catch (err) {
        return Promise.reject(err);
      }
    },

    getAssignment(id) {
      try {
        const db = ensureSeeded();
        const user = requireSession(db);
        const assignment = db.assignments.find((a) => a.id === id);
        if (!assignment) throw new DomainError(ERROR.NOT_FOUND, 'No such assignment');
        assertAuthorised(user, assignment, 'view');
        const org = db.organizations.find((o) => o.id === assignment.organization_id);
        const fl = findUser(db, assignment.freelancer_id);
        const ap = findUser(db, assignment.approver_id);
        return later({
          ...assignment,
          organization: org || null,
          freelancer: fl || null,
          approver: ap || null,
        });
      } catch (err) {
        return Promise.reject(err);
      }
    },

    /* ---------------- Periods ---------------- */

    /**
     * The current version of one month, creating it if ops has not opened it.
     * Auto-creation keeps the freelancer from being stuck on an empty screen on
     * the first of the month; the row is still audited as an opening.
     */
    openPeriod(assignmentId, year, month) {
      try {
        const result = transact((d) => {
          const user = requireSession(d);
          const assignment = d.assignments.find((a) => a.id === assignmentId);
          if (!assignment) throw new DomainError(ERROR.NOT_FOUND, 'No such assignment');
          assertAuthorised(user, assignment, 'view');

          const versions = d.periods.filter((p) => p.assignment_id === assignmentId
            && p.year === year && p.month === month);
          let period = currentVersion(versions);

          if (!period) {
            period = {
              id: newId('per'),
              assignment_id: assignmentId,
              year,
              month,
              version: 1,
              supersedes_id: null,
              status: PERIOD_STATUS.DRAFT,
              submitted_at: null,
              decided_at: null,
              decided_by: null,
              rejection_comment: null,
              created_at: new Date().toISOString(),
            };
            d.periods.push(period);
            appendAudit(d, user.id, assignmentId, 'TimesheetPeriod', period.id,
              AUDIT_ACTION.PERIOD_OPENED, { year, month });
          }
          return period.id;
        });
        const db = load();
        return later(buildPeriodView(db, requirePeriod(db, result)));
      } catch (err) {
        return Promise.reject(err);
      }
    },

    getPeriod(periodId) {
      try {
        const db = ensureSeeded();
        const user = requireSession(db);
        const period = requirePeriod(db, periodId);
        assertAuthorised(user, assignmentOf(db, period), 'view');
        return later(buildPeriodView(db, period));
      } catch (err) {
        return Promise.reject(err);
      }
    },

    /**
     * Reverse-chronological list of months for F3 and C2. One row per month,
     * showing the version that counts, with earlier versions summarised.
     */
    listPeriods(assignmentId) {
      try {
        const db = ensureSeeded();
        const user = requireSession(db);
        const assignment = db.assignments.find((a) => a.id === assignmentId);
        if (!assignment) throw new DomainError(ERROR.NOT_FOUND, 'No such assignment');
        assertAuthorised(user, assignment, 'view');

        const byMonth = new Map();
        for (const p of db.periods.filter((x) => x.assignment_id === assignmentId)) {
          const key = periodKey(p.year, p.month);
          const list = byMonth.get(key) || [];
          list.push(p);
          byMonth.set(key, list);
        }

        const rows = [...byMonth.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([, versions]) => {
            const live = currentVersion(versions);
            const hours = db.entries
              .filter((e) => e.period_id === live.id)
              .reduce((sum, e) => sum + e.hours, 0);
            const invoice = db.invoices.find((i) => i.period_id === live.id) || null;
            return {
              period_id: live.id,
              year: live.year,
              month: live.month,
              version: live.version,
              versions: versions.length,
              status: live.status,
              submitted_at: live.submitted_at,
              decided_at: live.decided_at,
              rejection_comment: live.rejection_comment,
              total_hours: Math.round(hours * 100) / 100,
              client_total: Math.round(hours * assignment.client_rate_per_hour),
              invoice_pdf: invoice ? invoice.pdf : null,
            };
          });
        return later(rows);
      } catch (err) {
        return Promise.reject(err);
      }
    },

    /**
     * The approver's inbox. Spec section 4/C1: empty eleven days out of twelve,
     * so the caller is given enough to render a useful empty state rather than
     * an empty list.
     */
    listAwaitingDecision() {
      try {
        const db = ensureSeeded();
        const user = requireSession(db);
        const mine = db.assignments.filter((a) => user.role === ROLE.OPS
          || (a.approver_id === user.id && a.organization_id === user.organization_id));
        const rows = db.periods
          .filter((p) => p.status === PERIOD_STATUS.SUBMITTED
            && mine.some((a) => a.id === p.assignment_id))
          .sort((a, b) => String(a.submitted_at).localeCompare(String(b.submitted_at)))
          .map((p) => buildPeriodView(db, p));
        return later(rows);
      } catch (err) {
        return Promise.reject(err);
      }
    },

    /* ---------------- Transitions ---------------- */

    saveDraft(periodId, entries) {
      try {
        transact((d) => {
          const user = requireSession(d);
          const period = requirePeriod(d, periodId);
          const assignment = assignmentOf(d, period);
          assertAuthorised(user, assignment, 'edit');
          assertEditable(period);

          const normalised = normaliseEntries(entries, period, assignment);

          // Replace this version's entries wholesale. Earlier versions are
          // untouched: they belong to a period that was already decided.
          d.entries = d.entries.filter((e) => e.period_id !== periodId);
          for (const e of normalised.entries) {
            d.entries.push({
              id: newId('ent'),
              period_id: periodId,
              date: e.date,
              hours: e.hours,
            });
          }
          appendAudit(d, user.id, assignment.id, 'TimesheetPeriod', periodId,
            AUDIT_ACTION.PERIOD_DRAFT_SAVED, {
              days: normalised.entries.length,
              total_hours: normalised.totalHours,
            });
        });
        const db = load();
        return later(buildPeriodView(db, requirePeriod(db, periodId)));
      } catch (err) {
        return Promise.reject(err);
      }
    },

    submitPeriod(periodId) {
      try {
        transact((d) => {
          const user = requireSession(d);
          const period = requirePeriod(d, periodId);
          const assignment = assignmentOf(d, period);
          assertAuthorised(user, assignment, 'submit');

          const entries = d.entries
            .filter((e) => e.period_id === periodId)
            .map((e) => ({ date: e.date, hours: e.hours }));
          assertSubmittable(period, entries, assignment);

          const summary = buildSubmissionSummary(period, entries, assignment, []);
          period.status = PERIOD_STATUS.SUBMITTED;
          period.submitted_at = new Date().toISOString();

          appendAudit(d, user.id, assignment.id, 'TimesheetPeriod', periodId,
            AUDIT_ACTION.PERIOD_SUBMITTED, {
              version: period.version,
              total_hours: summary.total_hours,
              client_total: summary.client_total,
              freelancer_net: summary.freelancer_net,
            });
        });
        const db = load();
        return later(buildPeriodView(db, requirePeriod(db, periodId)));
      } catch (err) {
        return Promise.reject(err);
      }
    },

    approvePeriod(periodId) {
      try {
        transact((d) => {
          const user = requireSession(d);
          const period = requirePeriod(d, periodId);
          const assignment = assignmentOf(d, period);
          assertAuthorised(user, assignment, 'approve');
          assertTransition(period, 'approve');

          const entries = d.entries
            .filter((e) => e.period_id === periodId)
            .map((e) => ({ date: e.date, hours: e.hours }));
          const summary = buildSubmissionSummary(period, entries, assignment, []);

          period.status = PERIOD_STATUS.APPROVED;
          period.decided_at = new Date().toISOString();
          period.decided_by = user.id;

          // The approved figures are written into the audit payload, not just
          // derived later. This is the record that the invoice must match.
          appendAudit(d, user.id, assignment.id, 'TimesheetPeriod', periodId,
            AUDIT_ACTION.PERIOD_APPROVED, {
              version: period.version,
              total_hours: summary.total_hours,
              client_total: summary.client_total,
              freelancer_net: summary.freelancer_net,
            });
        });
        const db = load();
        return later(buildPeriodView(db, requirePeriod(db, periodId)));
      } catch (err) {
        return Promise.reject(err);
      }
    },

    /**
     * Reject, then immediately create the successor draft pre-filled with the
     * rejected version's entries. Spec section 3: rejection does not mutate the
     * submitted version, it creates a successor.
     */
    rejectPeriod(periodId, comment) {
      try {
        const successorId = transact((d) => {
          const user = requireSession(d);
          const period = requirePeriod(d, periodId);
          const assignment = assignmentOf(d, period);
          assertAuthorised(user, assignment, 'reject');
          assertTransition(period, 'reject');
          const reason = assertRejectionComment(comment);

          period.status = PERIOD_STATUS.REJECTED;
          period.decided_at = new Date().toISOString();
          period.decided_by = user.id;
          period.rejection_comment = reason;

          appendAudit(d, user.id, assignment.id, 'TimesheetPeriod', periodId,
            AUDIT_ACTION.PERIOD_REJECTED, { version: period.version, comment: reason });

          const successor = buildSuccessorPeriod(period, newId('per'));
          d.periods.push(successor);

          for (const e of d.entries.filter((x) => x.period_id === periodId)) {
            d.entries.push({
              id: newId('ent'),
              period_id: successor.id,
              date: e.date,
              hours: e.hours,
            });
          }

          appendAudit(d, user.id, assignment.id, 'TimesheetPeriod', successor.id,
            AUDIT_ACTION.PERIOD_VERSION_CREATED, {
              version: successor.version,
              supersedes: periodId,
            });
          return successor.id;
        });
        const db = load();
        return later(buildPeriodView(db, requirePeriod(db, successorId)));
      } catch (err) {
        return Promise.reject(err);
      }
    },

    /* ---------------- Audit ---------------- */

    listAuditEvents(assignmentId) {
      try {
        const db = ensureSeeded();
        const user = requireSession(db);
        const assignment = db.assignments.find((a) => a.id === assignmentId);
        if (!assignment) throw new DomainError(ERROR.NOT_FOUND, 'No such assignment');
        assertAuthorised(user, assignment, 'view');
        const rows = db.audit_events
          .filter((e) => e.assignment_id === assignmentId)
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .map((e) => ({
            ...e,
            actor_name: (findUser(db, e.actor_id) || {}).name || 'onbekend',
          }));
        return later(rows);
      } catch (err) {
        return Promise.reject(err);
      }
    },

    /* ---------------- Demo controls ---------------- */

    resetDemoData() {
      save(buildSeed());
      return later(undefined);
    },
  };

  return adapter;
}
