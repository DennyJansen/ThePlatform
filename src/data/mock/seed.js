/**
 * Seed data: one assignment, one freelancer, one client, one named approver.
 * Spec section 1, "In scope".
 *
 * The seed is generated relative to today rather than hard-coded, so the demo
 * never opens on a stale month. Three completed months sit behind the current
 * one so that F3 (history) and C2 (assignment detail) have something true to
 * show, and so the audit trail is not empty on first load.
 *
 * Amounts are integer cents. Rates follow the worked example in spec section 3:
 * client 100.00, freelancer 95.00, deduction 2.00, platform take 7.00.
 */

import { ROLE, PERIOD_STATUS, AUDIT_ACTION } from '../../domain/model.js';
import { currentPeriod, isoDate, monthDays, periodKey } from '../../domain/dates.js';
import { newId } from './store.js';

/** Hours a plausible month contains: 8 on weekdays, nothing at weekends. */
function weekdayHours(year, month, opts = {}) {
  const skip = new Set(opts.skipDays || []);
  return monthDays(year, month)
    .filter((d) => !d.weekend && !skip.has(d.day))
    .map((d) => ({ date: d.date, hours: opts.hours || 8 }));
}

/** Walk back `n` months from a { year, month } pair. */
function monthsBack(ref, n) {
  const total = ref.year * 12 + (ref.month - 1) - n;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

function sumHours(rows) {
  return Math.round(rows.reduce((sum, r) => sum + r.hours, 0) * 100) / 100;
}

export function buildSeed(now = new Date()) {
  const nowIso = now.toISOString();
  const current = currentPeriod(now);

  const org = {
    id: 'org_client',
    name: 'Meridiaan Bouwgroep B.V.',
    kvk_number: '84213977',
    vat_number: 'NL863412955B01',
    billing_email: 'crediteuren@meridiaanbouw.nl',
    payment_terms_days: 30,
    created_at: nowIso,
  };

  const freelancer = {
    id: 'usr_freelancer',
    email: 'freelancer@example.com',
    name: 'Sanne de Vries',
    role: ROLE.FREELANCER,
    organization_id: null,
    // Spec section 6: consent field exists now, outreach is not in v1 scope.
    outreach_consent: false,
    created_at: nowIso,
  };

  const approver = {
    id: 'usr_approver',
    email: 'approver@example.com',
    name: 'Joost Bakker',
    role: ROLE.APPROVER,
    organization_id: org.id,
    outreach_consent: false,
    created_at: nowIso,
  };

  const ops = {
    id: 'usr_ops',
    email: 'ops@example.com',
    name: 'Platform Ops',
    role: ROLE.OPS,
    organization_id: null,
    outreach_consent: false,
    created_at: nowIso,
  };

  const start = monthsBack(current, 3);

  const assignment = {
    id: 'asg_001',
    title: 'Interim werkvoorbereider',
    freelancer_id: freelancer.id,
    organization_id: org.id,
    approver_id: approver.id,
    client_rate_per_hour: 10000,
    freelancer_rate_per_hour: 9500,
    freelancer_fee_per_hour: 200,
    fixed_fee_amount: 35000,
    // Spec section 10 lists the payer of the fixed fee as unresolved. Null is
    // the honest value; the UI shows it as undecided rather than guessing.
    fixed_fee_payer: null,
    hour_increment: 0.25,
    start_date: isoDate(start.year, start.month, 1),
    end_date: null,
    status: 'active',
    contract_pdf: null,
    approval_window_days: 5,
    // Spec section 7: build the field, ship it disabled.
    auto_approve_enabled: false,
    created_at: nowIso,
  };

  const periods = [];
  const entries = [];
  const audit = [];

  const audited = (action, actor, objectType, objectId, payload, at) => {
    audit.push({
      id: newId('aud'),
      actor_id: actor,
      assignment_id: assignment.id,
      object_type: objectType,
      object_id: objectId,
      action,
      payload_json: payload || {},
      created_at: at,
    });
  };

  // Three settled months behind the current one, so history is not empty.
  // The oldest carries a rejection so that versioning is visible on first load
  // rather than only after someone triggers it.
  const settled = [
    { back: 3, status: PERIOD_STATUS.PAID, rejectedFirst: true, skipDays: [] },
    { back: 2, status: PERIOD_STATUS.PAID, rejectedFirst: false, skipDays: [] },
    { back: 1, status: PERIOD_STATUS.INVOICED, rejectedFirst: false, skipDays: [] },
  ];

  for (const spec of settled) {
    const p = monthsBack(current, spec.back);
    const monthEnd = new Date(Date.UTC(p.year, p.month, 0, 17, 0, 0)).toISOString();
    const decidedAt = new Date(Date.UTC(p.year, p.month, 2, 10, 30, 0)).toISOString();

    if (spec.rejectedFirst) {
      const v1 = {
        id: newId('per'),
        assignment_id: assignment.id,
        year: p.year,
        month: p.month,
        version: 1,
        supersedes_id: null,
        status: PERIOD_STATUS.REJECTED,
        submitted_at: monthEnd,
        decided_at: decidedAt,
        decided_by: approver.id,
        rejection_comment: 'Op de 12e stond een hele dag genoteerd, maar je was die middag niet op locatie. Graag corrigeren naar een halve dag.',
        created_at: monthEnd,
      };
      periods.push(v1);
      const v1Rows = weekdayHours(p.year, p.month);
      for (const e of v1Rows) {
        entries.push({ id: newId('ent'), period_id: v1.id, date: e.date, hours: e.hours });
      }
      const v1Hours = sumHours(v1Rows);
      audited(AUDIT_ACTION.PERIOD_SUBMITTED, freelancer.id, 'TimesheetPeriod', v1.id,
        {
          version: 1,
          total_hours: v1Hours,
          client_total: Math.round(v1Hours * assignment.client_rate_per_hour),
        }, monthEnd);
      audited(AUDIT_ACTION.PERIOD_REJECTED, approver.id, 'TimesheetPeriod', v1.id,
        { version: 1, comment: v1.rejection_comment }, decidedAt);

      const v2 = {
        id: newId('per'),
        assignment_id: assignment.id,
        year: p.year,
        month: p.month,
        version: 2,
        supersedes_id: v1.id,
        status: spec.status,
        submitted_at: decidedAt,
        decided_at: decidedAt,
        decided_by: approver.id,
        rejection_comment: null,
        created_at: decidedAt,
      };
      periods.push(v2);
      // The correction the rejection asked for: the 12th becomes a half day.
      const v2Rows = v1Rows.map((e) => (
        Number(e.date.slice(8, 10)) === 12 ? { date: e.date, hours: 4 } : e
      ));
      for (const e of v2Rows) {
        entries.push({ id: newId('ent'), period_id: v2.id, date: e.date, hours: e.hours });
      }
      const v2Hours = sumHours(v2Rows);
      const v2Payload = {
        version: 2,
        total_hours: v2Hours,
        client_total: Math.round(v2Hours * assignment.client_rate_per_hour),
      };
      audited(AUDIT_ACTION.PERIOD_VERSION_CREATED, freelancer.id, 'TimesheetPeriod', v2.id,
        { version: 2, supersedes: v1.id }, decidedAt);
      audited(AUDIT_ACTION.PERIOD_SUBMITTED, freelancer.id, 'TimesheetPeriod', v2.id,
        v2Payload, decidedAt);
      audited(AUDIT_ACTION.PERIOD_APPROVED, approver.id, 'TimesheetPeriod', v2.id,
        v2Payload, decidedAt);
    } else {
      const p1 = {
        id: newId('per'),
        assignment_id: assignment.id,
        year: p.year,
        month: p.month,
        version: 1,
        supersedes_id: null,
        status: spec.status,
        submitted_at: monthEnd,
        decided_at: decidedAt,
        decided_by: approver.id,
        rejection_comment: null,
        created_at: monthEnd,
      };
      periods.push(p1);
      const rows = weekdayHours(p.year, p.month, { skipDays: spec.skipDays });
      for (const e of rows) {
        entries.push({ id: newId('ent'), period_id: p1.id, date: e.date, hours: e.hours });
      }
      const hours = sumHours(rows);
      const payload = {
        version: 1,
        total_hours: hours,
        client_total: Math.round(hours * assignment.client_rate_per_hour),
      };
      audited(AUDIT_ACTION.PERIOD_SUBMITTED, freelancer.id, 'TimesheetPeriod', p1.id,
        payload, monthEnd);
      audited(AUDIT_ACTION.PERIOD_APPROVED, approver.id, 'TimesheetPeriod', p1.id,
        payload, decidedAt);
    }
  }

  // The live month, open and empty. This is what F2 lands on.
  const openPeriod = {
    id: newId('per'),
    assignment_id: assignment.id,
    year: current.year,
    month: current.month,
    version: 1,
    supersedes_id: null,
    status: PERIOD_STATUS.DRAFT,
    submitted_at: null,
    decided_at: null,
    decided_by: null,
    rejection_comment: null,
    created_at: nowIso,
  };
  periods.push(openPeriod);
  audited(AUDIT_ACTION.PERIOD_OPENED, ops.id, 'TimesheetPeriod', openPeriod.id,
    { year: current.year, month: current.month }, nowIso);

  periods.sort((a, b) => periodKey(a.year, a.month) - periodKey(b.year, b.month)
    || a.version - b.version);
  audit.sort((a, b) => a.created_at.localeCompare(b.created_at));

  return {
    schema_version: 1,
    organizations: [org],
    users: [freelancer, approver, ops],
    assignments: [assignment],
    periods,
    entries,
    charges: [],
    invoices: [],
    magic_links: [],
    audit_events: audit,
    session: null,
  };
}

/** Addresses offered on the sign-in screen so nobody has to guess. */
export const DEMO_ACCOUNTS = Object.freeze([
  { email: 'freelancer@example.com', role: ROLE.FREELANCER, name: 'Sanne de Vries' },
  { email: 'approver@example.com', role: ROLE.APPROVER, name: 'Joost Bakker' },
]);
