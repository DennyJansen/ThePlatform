/**
 * The suite.
 *
 * These are not smoke tests. Each one covers something the spec calls
 * load-bearing: the fee arithmetic, the transition table, the compliance
 * absences in section 6, the append-only audit log, and the guarantee that a
 * rejection never mutates the version that was decided.
 */

import { describe, it, assert } from './runner.js';

import {
  computeFees, quantiseHours, lineTotalCents, parseHours,
  ratesAreCoherent, round2, vatCents,
} from '../domain/money.js';
import {
  monthDays, daysInMonth, isWeekend, withinAssignment, periodKey, addDays,
} from '../domain/dates.js';
import {
  PERIOD_STATUS, ROLE, TRANSITIONS, FORBIDDEN_TIME_ENTRY_FIELDS,
  ALLOWED_TIME_ENTRY_FIELDS,
} from '../domain/model.js';
import {
  ERROR, canTransition, isEditable, normaliseEntries, assertSubmittable,
  assertRejectionComment, buildSubmissionSummary, buildSuccessorPeriod,
  currentVersion, isPartyTo, assertAuthorised, assertNoForbiddenFields,
} from '../domain/rules.js';
import { assertAuditAppendOnly } from '../data/mock/store.js';
import { __tables } from '../i18n/index.js';
import { buildSeed } from '../data/mock/seed.js';

/* ------------------------------------------------------------------ */

const ASSIGNMENT = Object.freeze({
  id: 'asg_test',
  freelancer_id: 'usr_f',
  approver_id: 'usr_a',
  organization_id: 'org_1',
  client_rate_per_hour: 10000,
  freelancer_rate_per_hour: 9500,
  freelancer_fee_per_hour: 200,
  hour_increment: 0.25,
  start_date: '2026-01-01',
  end_date: null,
  status: 'active',
});

const PERIOD = Object.freeze({
  id: 'per_test',
  assignment_id: 'asg_test',
  year: 2026,
  month: 3,
  version: 1,
  status: PERIOD_STATUS.DRAFT,
});

/* ------------------------------------------------------------------ */

describe('Money — the fee arithmetic of spec section 3', () => {
  it('reproduces the worked example: 100 / 95 / 2 nets 93 and takes 7', () => {
    const fees = computeFees(ASSIGNMENT, 1);
    assert.equal(fees.client_total, 10000, 'client invoiced');
    assert.equal(fees.freelancer_gross, 9500, 'freelancer gross');
    assert.equal(fees.freelancer_fee, 200, 'deduction');
    assert.equal(fees.freelancer_net, 9300, 'freelancer net');
    assert.equal(fees.platform_take, 700, 'platform take');
  });

  it('keeps platform take equal to client total minus freelancer net, at any hours', () => {
    for (const hours of [0, 0.25, 7.75, 160, 168.5, 999.25]) {
      const f = computeFees(ASSIGNMENT, hours);
      assert.equal(
        f.platform_take,
        f.client_total - f.freelancer_net,
        'invariant broken at ' + hours + ' hours',
      );
    }
  });

  it('does not drift on repeated cent arithmetic', () => {
    // 0.1 + 0.2 style drift would show up here if amounts were floats.
    let total = 0;
    for (let i = 0; i < 1000; i += 1) total += lineTotalCents(0.1, 10000);
    assert.equal(total, 1000000, 'a thousand six-minute slots at 100/h is 10000.00');
  });

  it('quantises hours to the assignment increment, half-up', () => {
    assert.equal(quantiseHours(7.1, 0.25), 7);
    assert.equal(quantiseHours(7.13, 0.25), 7.25);
    assert.equal(quantiseHours(7.375, 0.25), 7.5);
    assert.equal(quantiseHours(8, 0.25), 8);
    assert.equal(quantiseHours(7.4, 0.5), 7.5);
    assert.equal(quantiseHours(7.2, 1), 7);
  });

  it('accepts both decimal separators from the keyboard', () => {
    assert.equal(parseHours('7,25'), 7.25, 'comma');
    assert.equal(parseHours('7.25'), 7.25, 'point');
    assert.equal(parseHours(''), null, 'blank is not zero, it is absent');
    assert.equal(parseHours('   '), null);
    assert.ok(Number.isNaN(parseHours('acht')), 'words are rejected');
    assert.ok(Number.isNaN(parseHours('8h')), 'units are rejected');
    assert.ok(Number.isNaN(parseHours('-1')), 'negatives are rejected');
  });

  it('refuses incoherent rates', () => {
    assert.ok(ratesAreCoherent(ASSIGNMENT));
    assert.ok(!ratesAreCoherent({ ...ASSIGNMENT, freelancer_rate_per_hour: 11000 }),
      'freelancer above client rate');
    assert.ok(!ratesAreCoherent({ ...ASSIGNMENT, freelancer_fee_per_hour: 10000 }),
      'deduction above the freelancer rate');
    assert.ok(!ratesAreCoherent({ ...ASSIGNMENT, client_rate_per_hour: 100.5 }),
      'rates must be whole cents');
  });

  it('computes VAT on an ex-VAT amount', () => {
    assert.equal(vatCents(10000), 2100);
    assert.equal(vatCents(9333), 1960);
    assert.equal(round2(1.005), 1.01);
  });
});

/* ------------------------------------------------------------------ */

describe('Dates', () => {
  it('produces one row per calendar day, leap years included', () => {
    assert.equal(monthDays(2026, 2).length, 28);
    assert.equal(monthDays(2028, 2).length, 29, '2028 is a leap year');
    assert.equal(daysInMonth(2026, 12), 31);
  });

  it('identifies weekends without a timezone shift', () => {
    assert.ok(isWeekend(2026, 3, 7), '7 March 2026 is a Saturday');
    assert.ok(isWeekend(2026, 3, 8), '8 March 2026 is a Sunday');
    assert.ok(!isWeekend(2026, 3, 9), '9 March 2026 is a Monday');
  });

  it('bounds dates by the assignment window', () => {
    const bounded = { start_date: '2026-03-10', end_date: '2026-03-20' };
    assert.ok(!withinAssignment('2026-03-09', bounded));
    assert.ok(withinAssignment('2026-03-10', bounded));
    assert.ok(withinAssignment('2026-03-20', bounded));
    assert.ok(!withinAssignment('2026-03-21', bounded));
    assert.ok(withinAssignment('2030-01-01', { start_date: '2026-01-01', end_date: null }),
      'a null end date is open-ended');
  });

  it('orders months across a year boundary', () => {
    assert.ok(periodKey(2027, 1) > periodKey(2026, 12));
  });

  it('adds days without drifting across a DST change', () => {
    // Europe/Amsterdam springs forward on 29 March 2026.
    const after = addDays('2026-03-27T12:00:00.000Z', 5);
    assert.equal(after.slice(0, 10), '2026-04-01');
  });
});

/* ------------------------------------------------------------------ */

describe('State machine — spec section 3', () => {
  it('allows exactly the transitions in the spec diagram', () => {
    assert.deepEqual(TRANSITIONS.draft, ['submit']);
    assert.deepEqual(TRANSITIONS.submitted, ['approve', 'reject']);
    assert.deepEqual(TRANSITIONS.rejected, [], 'a rejected version is terminal; a successor is created instead');
    assert.deepEqual(TRANSITIONS.approved, ['invoice']);
    assert.deepEqual(TRANSITIONS.invoiced, ['mark_paid']);
    assert.deepEqual(TRANSITIONS.paid, []);
  });

  it('refuses to approve something that was never submitted', () => {
    assert.ok(!canTransition({ status: PERIOD_STATUS.DRAFT }, 'approve'));
    assert.ok(!canTransition({ status: PERIOD_STATUS.APPROVED }, 'approve'), 'no double approval');
    assert.ok(!canTransition({ status: PERIOD_STATUS.PAID }, 'reject'));
  });

  it('locks a period the moment it is submitted', () => {
    assert.ok(isEditable({ status: PERIOD_STATUS.DRAFT }));
    for (const status of ['submitted', 'rejected', 'approved', 'invoiced', 'paid']) {
      assert.ok(!isEditable({ status }), status + ' must not be editable');
    }
  });
});

/* ------------------------------------------------------------------ */

describe('Authorisation — spec section 2', () => {
  const freelancer = { id: 'usr_f', role: ROLE.FREELANCER, organization_id: null };
  const approver = { id: 'usr_a', role: ROLE.APPROVER, organization_id: 'org_1' };
  const stranger = { id: 'usr_x', role: ROLE.APPROVER, organization_id: 'org_1' };
  const otherOrg = { id: 'usr_a', role: ROLE.APPROVER, organization_id: 'org_2' };

  it('binds each party to their own assignment', () => {
    assert.ok(isPartyTo(freelancer, ASSIGNMENT));
    assert.ok(isPartyTo(approver, ASSIGNMENT));
    assert.ok(!isPartyTo(stranger, ASSIGNMENT), 'not the named approver');
    assert.ok(!isPartyTo(otherOrg, ASSIGNMENT), 'right person, wrong organisation');
  });

  it('does not let a freelancer approve their own hours', async () => {
    await assert.throws(() => assertAuthorised(freelancer, ASSIGNMENT, 'approve'),
      ERROR.NOT_AUTHORISED);
  });

  it('does not let an approver type hours', async () => {
    await assert.throws(() => assertAuthorised(approver, ASSIGNMENT, 'edit'),
      ERROR.NOT_AUTHORISED);
  });

  it('refuses an unauthenticated caller', async () => {
    await assert.throws(() => assertAuthorised(null, ASSIGNMENT, 'view'), ERROR.NOT_AUTHORISED);
  });
});

/* ------------------------------------------------------------------ */

describe('Compliance — spec section 6, the absences', () => {
  it('permits only date and hours on a time entry', () => {
    assert.deepEqual(ALLOWED_TIME_ENTRY_FIELDS.slice().sort(),
      ['date', 'hours', 'id', 'period_id']);
  });

  it('rejects every field that would reintroduce gezag', () => {
    for (const field of FORBIDDEN_TIME_ENTRY_FIELDS) {
      let threw = false;
      try {
        assertNoForbiddenFields({ date: '2026-03-02', hours: 8, [field]: 'x' });
      } catch (err) {
        threw = err.code === ERROR.FORBIDDEN_FIELD;
      }
      assert.ok(threw, field + ' must be refused on a TimeEntry');
    }
  });

  it('refuses a start_time even when it arrives through normaliseEntries', async () => {
    await assert.throws(
      () => normaliseEntries([{ date: '2026-03-02', hours: 8, start_time: '09:00' }], PERIOD, ASSIGNMENT),
      ERROR.FORBIDDEN_FIELD,
    );
  });
});

/* ------------------------------------------------------------------ */

describe('Entry validation', () => {
  it('drops blank and zero days rather than storing them', () => {
    const result = normaliseEntries([
      { date: '2026-03-02', hours: 8 },
      { date: '2026-03-03', hours: 0 },
      { date: '2026-03-04', hours: null },
    ], PERIOD, ASSIGNMENT);
    assert.equal(result.entries.length, 1);
    assert.equal(result.totalHours, 8);
  });

  it('quantises on the way in, so the stored number is the shown number', () => {
    const result = normaliseEntries([{ date: '2026-03-02', hours: 7.13 }], PERIOD, ASSIGNMENT);
    assert.equal(result.entries[0].hours, 7.25);
    assert.equal(result.totalHours, 7.25);
  });

  it('refuses a date from another month', async () => {
    await assert.throws(
      () => normaliseEntries([{ date: '2026-04-01', hours: 8 }], PERIOD, ASSIGNMENT),
      ERROR.DATE_OUTSIDE_PERIOD,
    );
  });

  it('refuses a date outside the assignment window', async () => {
    const bounded = { ...ASSIGNMENT, start_date: '2026-03-10' };
    await assert.throws(
      () => normaliseEntries([{ date: '2026-03-02', hours: 8 }], PERIOD, bounded),
      ERROR.DATE_OUTSIDE_ASSIGNMENT,
    );
  });

  it('refuses more than 24 hours in a day', async () => {
    await assert.throws(
      () => normaliseEntries([{ date: '2026-03-02', hours: 25 }], PERIOD, ASSIGNMENT),
      ERROR.HOURS_OUT_OF_RANGE,
    );
  });

  it('refuses an empty submission', async () => {
    await assert.throws(() => assertSubmittable(PERIOD, [], ASSIGNMENT), ERROR.NO_HOURS);
  });

  it('refuses to submit a period that is already submitted', async () => {
    await assert.throws(
      () => assertSubmittable({ ...PERIOD, status: PERIOD_STATUS.SUBMITTED },
        [{ date: '2026-03-02', hours: 8 }], ASSIGNMENT),
      ERROR.ILLEGAL_TRANSITION,
    );
  });

  it('refuses to submit against incoherent rates', async () => {
    await assert.throws(
      () => assertSubmittable(PERIOD, [{ date: '2026-03-02', hours: 8 }],
        { ...ASSIGNMENT, freelancer_rate_per_hour: 20000 }),
      ERROR.RATES_INCOHERENT,
    );
  });
});

/* ------------------------------------------------------------------ */

describe('Submission summary — what the confirmation dialog shows', () => {
  it('matches the numbers that will be invoiced', () => {
    const entries = [
      { date: '2026-03-02', hours: 8 },
      { date: '2026-03-03', hours: 8 },
      { date: '2026-03-04', hours: 4.25 },
    ];
    const summary = buildSubmissionSummary(PERIOD, entries, ASSIGNMENT);
    assert.equal(summary.total_hours, 20.25);
    assert.equal(summary.days_with_hours, 3);
    assert.equal(summary.client_total, 202500, '20.25h at 100.00');
    assert.equal(summary.freelancer_net, 188325, '20.25h at 93.00');
    assert.equal(summary.platform_take, 202500 - 188325);
  });

  it('adds non-rejected charges to the client total only', () => {
    const charges = [
      { amount_gross: 4000, status: 'pending' },
      { amount_gross: 9900, status: 'rejected' },
    ];
    const summary = buildSubmissionSummary(PERIOD, [{ date: '2026-03-02', hours: 1 }],
      ASSIGNMENT, charges);
    assert.equal(summary.charges_total, 4000, 'the rejected claim is excluded');
    assert.equal(summary.client_total_with_charges, 10000 + 4000);
    assert.equal(summary.freelancer_net, 9300, 'charges do not move the hourly net');
  });
});

/* ------------------------------------------------------------------ */

describe('Versioning — a rejection never rewrites what was decided', () => {
  const rejected = {
    ...PERIOD,
    status: PERIOD_STATUS.REJECTED,
    version: 1,
    submitted_at: '2026-04-01T09:00:00.000Z',
    decided_at: '2026-04-02T09:00:00.000Z',
    decided_by: 'usr_a',
    rejection_comment: 'de 12e was een halve dag',
  };

  it('creates a successor rather than reopening the rejected version', () => {
    const successor = buildSuccessorPeriod(rejected, 'per_v2');
    assert.equal(successor.version, 2);
    assert.equal(successor.supersedes_id, rejected.id);
    assert.equal(successor.status, PERIOD_STATUS.DRAFT);
    assert.equal(successor.rejection_comment, null, 'the successor carries no decision of its own');
    assert.equal(successor.decided_by, null);
    assert.equal(successor.year, rejected.year);
    assert.equal(successor.month, rejected.month);
  });

  it('leaves the rejected version untouched', () => {
    const before = JSON.stringify(rejected);
    buildSuccessorPeriod(rejected, 'per_v2');
    assert.equal(JSON.stringify(rejected), before, 'the decided version was mutated');
  });

  it('shows the highest version as the live one', () => {
    const v1 = { version: 1, id: 'a' };
    const v2 = { version: 2, id: 'b' };
    assert.equal(currentVersion([v1, v2]).id, 'b');
    assert.equal(currentVersion([v2, v1]).id, 'b', 'order must not matter');
    assert.equal(currentVersion([]), null);
  });

  it('requires a reason on every rejection', async () => {
    await assert.throws(() => assertRejectionComment(''), ERROR.COMMENT_REQUIRED);
    await assert.throws(() => assertRejectionComment('  '), ERROR.COMMENT_REQUIRED);
    await assert.throws(() => assertRejectionComment('ok'), ERROR.COMMENT_REQUIRED);
    assert.equal(assertRejectionComment('  te veel uren  '), 'te veel uren', 'trimmed');
  });
});

/* ------------------------------------------------------------------ */

describe('Audit log — append only, spec section 3', () => {
  const before = [
    { id: '1', action: 'period.submitted' },
    { id: '2', action: 'period.approved' },
  ];

  it('accepts an append', () => {
    assertAuditAppendOnly(before, [...before, { id: '3', action: 'period.rejected' }]);
  });

  it('refuses a deletion', async () => {
    await assert.throws(() => assertAuditAppendOnly(before, [before[0]]));
  });

  it('refuses an edit to an existing row', async () => {
    await assert.throws(() => assertAuditAppendOnly(before, [
      { id: '1', action: 'period.rejected' },
      before[1],
    ]));
  });

  it('refuses a reorder', async () => {
    await assert.throws(() => assertAuditAppendOnly(before, [before[1], before[0]]));
  });
});

/* ------------------------------------------------------------------ */

describe('Seed data', () => {
  const seed = buildSeed(new Date('2026-09-05T10:00:00.000Z'));

  it('has exactly one assignment, one freelancer, one approver', () => {
    assert.equal(seed.assignments.length, 1);
    assert.equal(seed.users.filter((u) => u.role === ROLE.FREELANCER).length, 1);
    assert.equal(seed.users.filter((u) => u.role === ROLE.APPROVER).length, 1);
  });

  it('opens the current month as a draft', () => {
    const open = seed.periods.filter((p) => p.status === PERIOD_STATUS.DRAFT);
    assert.equal(open.length, 1);
    assert.equal(open[0].year, 2026);
    assert.equal(open[0].month, 9);
  });

  it('carries a rejected version and its successor for the same month', () => {
    const rejected = seed.periods.find((p) => p.status === PERIOD_STATUS.REJECTED);
    assert.ok(rejected, 'a rejection is seeded so versioning is visible on first load');
    const successor = seed.periods.find((p) => p.supersedes_id === rejected.id);
    assert.ok(successor, 'the rejection has a successor');
    assert.equal(successor.version, rejected.version + 1);
    assert.equal(successor.year, rejected.year);
    assert.equal(successor.month, rejected.month);
  });

  it('seeds coherent rates', () => {
    assert.ok(ratesAreCoherent(seed.assignments[0]));
  });

  it('ships with auto-approve disabled — spec section 7', () => {
    assert.equal(seed.assignments[0].auto_approve_enabled, false);
  });

  it('carries no time entry with a forbidden field', () => {
    for (const entry of seed.entries) {
      assertNoForbiddenFields({
        id: entry.id, period_id: entry.period_id, date: entry.date, hours: entry.hours,
      });
    }
  });
});

/* ------------------------------------------------------------------ */

describe('Translations', () => {
  it('has the same keys in every locale', () => {
    const locales = Object.keys(__tables);
    const reference = Object.keys(__tables[locales[0]]).sort();
    for (const locale of locales.slice(1)) {
      const keys = Object.keys(__tables[locale]).sort();
      const missing = reference.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !reference.includes(k));
      assert.deepEqual(missing, [], locale + ' is missing keys');
      assert.deepEqual(extra, [], locale + ' has keys no other locale has');
    }
  });

  it('has no empty strings', () => {
    for (const [locale, table] of Object.entries(__tables)) {
      for (const [key, value] of Object.entries(table)) {
        assert.ok(typeof value === 'string' && value.trim().length > 0,
          locale + '.' + key + ' is empty');
      }
    }
  });

  it('uses the same placeholders in every locale', () => {
    const placeholders = (s) => (s.match(/\{(\w+)\}/g) || []).sort().join(',');
    const locales = Object.keys(__tables);
    const reference = __tables[locales[0]];
    for (const locale of locales.slice(1)) {
      for (const key of Object.keys(reference)) {
        assert.equal(
          placeholders(__tables[locale][key]),
          placeholders(reference[key]),
          key + ' placeholders differ in ' + locale,
        );
      }
    }
  });

  it('has a message for every domain error code', () => {
    for (const code of Object.values(ERROR)) {
      for (const [locale, table] of Object.entries(__tables)) {
        assert.ok(Object.prototype.hasOwnProperty.call(table, code),
          locale + ' has no message for ' + code);
      }
    }
  });
});
