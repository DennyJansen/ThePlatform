/**
 * End-to-end tests against the mock adapter: the full loop from spec section 1.
 *
 *   freelancer submits hours -> client approves or rejects -> the numbers match
 *
 * These run against real localStorage, so the suite snapshots the stored
 * document before it starts and restores it afterwards. Running the tests must
 * not cost you the demo data you were halfway through entering.
 */

import { describe, it, assert } from './runner.js';
import { createMockAdapter } from '../data/mock/mockAdapter.js';
import { load, save, __testing } from '../data/mock/store.js';
import { buildSeed, DEMO_ACCOUNTS } from '../data/mock/seed.js';
import { PERIOD_STATUS } from '../domain/model.js';
import { ERROR } from '../domain/rules.js';
import { currentPeriod, monthDays } from '../domain/dates.js';

let snapshot = null;

function saveSnapshot() {
  try {
    snapshot = window.localStorage.getItem(__testing.STORAGE_KEY);
  } catch (err) {
    snapshot = null;
  }
}

function restoreSnapshot() {
  try {
    if (snapshot === null) window.localStorage.removeItem(__testing.STORAGE_KEY);
    else window.localStorage.setItem(__testing.STORAGE_KEY, snapshot);
  } catch (err) {
    /* private mode: nothing to restore */
  }
}

/** A clean database and a fresh adapter for one test. */
function freshAdapter() {
  save(buildSeed());
  return createMockAdapter();
}

async function signInAs(adapter, email) {
  const link = await adapter.requestMagicLink(email);
  return adapter.consumeMagicLink(link.token);
}

const FREELANCER = DEMO_ACCOUNTS.find((a) => a.role === 'freelancer').email;
const APPROVER = DEMO_ACCOUNTS.find((a) => a.role === 'approver').email;

/** Three weekdays of the current month, so entries always fall in the period. */
function threeWeekdays() {
  const now = currentPeriod();
  return monthDays(now.year, now.month)
    .filter((d) => !d.weekend)
    .slice(0, 3)
    .map((d) => ({ date: d.date, hours: 8 }));
}

describe('Sign in — spec section 4/F1', () => {
  it('issues a link for a known address', async () => {
    saveSnapshot();
    const adapter = freshAdapter();
    const link = await adapter.requestMagicLink(FREELANCER);
    assert.ok(link.token, 'a token is returned by the mock');
    assert.equal(link.delivery, 'on_screen');
    restoreSnapshot();
  });

  it('refuses an address with no account — there is no signup', async () => {
    saveSnapshot();
    const adapter = freshAdapter();
    await assert.throws(() => adapter.requestMagicLink('nobody@example.com'),
      ERROR.UNKNOWN_EMAIL);
    restoreSnapshot();
  });

  it('is case-insensitive about the address', async () => {
    saveSnapshot();
    const adapter = freshAdapter();
    const link = await adapter.requestMagicLink(FREELANCER.toUpperCase());
    assert.ok(link.token);
    restoreSnapshot();
  });

  it('burns the link after one use', async () => {
    saveSnapshot();
    const adapter = freshAdapter();
    const link = await adapter.requestMagicLink(FREELANCER);
    await adapter.consumeMagicLink(link.token);
    await assert.throws(() => adapter.consumeMagicLink(link.token), ERROR.LINK_ALREADY_USED);
    restoreSnapshot();
  });

  it('refuses a token that was never issued', async () => {
    saveSnapshot();
    const adapter = freshAdapter();
    await assert.throws(() => adapter.consumeMagicLink('not-a-token'), ERROR.LINK_INVALID);
    restoreSnapshot();
  });

  it('sends ops to the admin panel rather than this UI — spec section 2', async () => {
    saveSnapshot();
    const adapter = freshAdapter();
    await assert.throws(() => adapter.requestMagicLink('ops@example.com'),
      ERROR.NOT_AUTHORISED);
    restoreSnapshot();
  });
});

describe('The loop — submit, approve, and the numbers match', () => {
  it('carries the submitted total through to the approver unchanged', async () => {
    saveSnapshot();
    const adapter = freshAdapter();

    await signInAs(adapter, FREELANCER);
    const assignments = await adapter.listAssignments();
    const now = currentPeriod();
    const opened = await adapter.openPeriod(assignments[0].id, now.year, now.month);

    await adapter.saveDraft(opened.period.id, threeWeekdays());
    const submitted = await adapter.submitPeriod(opened.period.id);

    assert.equal(submitted.period.status, PERIOD_STATUS.SUBMITTED);
    assert.equal(submitted.summary.total_hours, 24);
    assert.equal(submitted.summary.client_total, 240000, '24h at 100.00');
    assert.equal(submitted.summary.freelancer_net, 223200, '24h at 93.00');

    await adapter.signOut();
    await signInAs(adapter, APPROVER);

    const inbox = await adapter.listAwaitingDecision();
    assert.equal(inbox.length, 1, 'one period awaits a decision');
    assert.equal(
      inbox[0].summary.total_hours,
      submitted.summary.total_hours,
      'the approver sees the number that was submitted',
    );
    assert.equal(inbox[0].summary.client_total, submitted.summary.client_total);

    const approved = await adapter.approvePeriod(inbox[0].period.id);
    assert.equal(approved.period.status, PERIOD_STATUS.APPROVED);
    assert.equal(approved.summary.client_total, submitted.summary.client_total,
      'approving must not change the amount');

    restoreSnapshot();
  });

  it('writes the approved figures into the audit payload', async () => {
    saveSnapshot();
    const adapter = freshAdapter();

    await signInAs(adapter, FREELANCER);
    const assignments = await adapter.listAssignments();
    const now = currentPeriod();
    const opened = await adapter.openPeriod(assignments[0].id, now.year, now.month);
    await adapter.saveDraft(opened.period.id, threeWeekdays());
    await adapter.submitPeriod(opened.period.id);

    await adapter.signOut();
    await signInAs(adapter, APPROVER);
    const inbox = await adapter.listAwaitingDecision();
    await adapter.approvePeriod(inbox[0].period.id);

    const events = await adapter.listAuditEvents(assignments[0].id);
    const approval = events.find((e) => e.action === 'period.approved'
      && e.object_id === opened.period.id);
    assert.ok(approval, 'an approval event was written');
    assert.equal(approval.payload_json.total_hours, 24);
    assert.equal(approval.payload_json.client_total, 240000);

    restoreSnapshot();
  });
});

describe('Locking — nothing is editable once submitted', () => {
  it('refuses a draft save after submission', async () => {
    saveSnapshot();
    const adapter = freshAdapter();
    await signInAs(adapter, FREELANCER);
    const assignments = await adapter.listAssignments();
    const now = currentPeriod();
    const opened = await adapter.openPeriod(assignments[0].id, now.year, now.month);
    await adapter.saveDraft(opened.period.id, threeWeekdays());
    await adapter.submitPeriod(opened.period.id);

    await assert.throws(
      () => adapter.saveDraft(opened.period.id, [{ date: threeWeekdays()[0].date, hours: 1 }]),
      ERROR.PERIOD_LOCKED,
    );
    restoreSnapshot();
  });

  it('refuses a second submission of the same period', async () => {
    saveSnapshot();
    const adapter = freshAdapter();
    await signInAs(adapter, FREELANCER);
    const assignments = await adapter.listAssignments();
    const now = currentPeriod();
    const opened = await adapter.openPeriod(assignments[0].id, now.year, now.month);
    await adapter.saveDraft(opened.period.id, threeWeekdays());
    await adapter.submitPeriod(opened.period.id);
    await assert.throws(() => adapter.submitPeriod(opened.period.id), ERROR.ILLEGAL_TRANSITION);
    restoreSnapshot();
  });

  it('does not let a freelancer approve their own period', async () => {
    saveSnapshot();
    const adapter = freshAdapter();
    await signInAs(adapter, FREELANCER);
    const assignments = await adapter.listAssignments();
    const now = currentPeriod();
    const opened = await adapter.openPeriod(assignments[0].id, now.year, now.month);
    await adapter.saveDraft(opened.period.id, threeWeekdays());
    await adapter.submitPeriod(opened.period.id);
    await assert.throws(() => adapter.approvePeriod(opened.period.id), ERROR.NOT_AUTHORISED);
    restoreSnapshot();
  });
});

describe('Rejection — the decided version survives', () => {
  it('keeps the rejected version and hands back a pre-filled successor', async () => {
    saveSnapshot();
    const adapter = freshAdapter();

    await signInAs(adapter, FREELANCER);
    const assignments = await adapter.listAssignments();
    const now = currentPeriod();
    const opened = await adapter.openPeriod(assignments[0].id, now.year, now.month);
    await adapter.saveDraft(opened.period.id, threeWeekdays());
    await adapter.submitPeriod(opened.period.id);

    await adapter.signOut();
    await signInAs(adapter, APPROVER);
    const successor = await adapter.rejectPeriod(opened.period.id, 'de 12e was een halve dag');

    assert.equal(successor.period.version, 2);
    assert.equal(successor.period.status, PERIOD_STATUS.DRAFT);
    assert.equal(successor.period.supersedes_id, opened.period.id);
    assert.equal(successor.entries.length, 3, 'the successor is pre-filled');
    assert.equal(successor.summary.total_hours, 24);

    const original = await adapter.getPeriod(opened.period.id);
    assert.equal(original.period.status, PERIOD_STATUS.REJECTED,
      'the rejected version keeps its status');
    assert.equal(original.entries.length, 3, 'and keeps its numbers');
    assert.equal(original.period.rejection_comment, 'de 12e was een halve dag');

    restoreSnapshot();
  });

  it('requires a comment', async () => {
    saveSnapshot();
    const adapter = freshAdapter();
    await signInAs(adapter, FREELANCER);
    const assignments = await adapter.listAssignments();
    const now = currentPeriod();
    const opened = await adapter.openPeriod(assignments[0].id, now.year, now.month);
    await adapter.saveDraft(opened.period.id, threeWeekdays());
    await adapter.submitPeriod(opened.period.id);
    await adapter.signOut();
    await signInAs(adapter, APPROVER);
    await assert.throws(() => adapter.rejectPeriod(opened.period.id, ''), ERROR.COMMENT_REQUIRED);
    restoreSnapshot();
  });

  it('lets the corrected version be submitted and approved', async () => {
    saveSnapshot();
    const adapter = freshAdapter();

    await signInAs(adapter, FREELANCER);
    const assignments = await adapter.listAssignments();
    const now = currentPeriod();
    const opened = await adapter.openPeriod(assignments[0].id, now.year, now.month);
    await adapter.saveDraft(opened.period.id, threeWeekdays());
    await adapter.submitPeriod(opened.period.id);

    await adapter.signOut();
    await signInAs(adapter, APPROVER);
    const successor = await adapter.rejectPeriod(opened.period.id, 'graag corrigeren');

    await adapter.signOut();
    await signInAs(adapter, FREELANCER);
    const corrected = threeWeekdays().map((e, i) => (i === 0 ? { ...e, hours: 4 } : e));
    await adapter.saveDraft(successor.period.id, corrected);
    const resubmitted = await adapter.submitPeriod(successor.period.id);
    assert.equal(resubmitted.summary.total_hours, 20);

    await adapter.signOut();
    await signInAs(adapter, APPROVER);
    const approved = await adapter.approvePeriod(successor.period.id);
    assert.equal(approved.period.status, PERIOD_STATUS.APPROVED);
    assert.equal(approved.summary.client_total, 200000, '20h at 100.00');

    restoreSnapshot();
  });
});

describe('Isolation — a party sees only their own assignment', () => {
  it('does not show one org an assignment it is not named on', async () => {
    saveSnapshot();
    const adapter = freshAdapter();

    // Add a second organisation, approver and assignment by hand: ops would do
    // this in the admin panel, and there is no UI for it in v1.
    const db = load();
    db.organizations.push({
      id: 'org_other', name: 'Andere B.V.', kvk_number: '0', vat_number: '0',
      billing_email: 'x@example.com', payment_terms_days: 30, created_at: new Date().toISOString(),
    });
    db.users.push({
      id: 'usr_other', email: 'other@example.com', name: 'Ander', role: 'approver',
      organization_id: 'org_other', outreach_consent: false, created_at: new Date().toISOString(),
    });
    save(db);

    const fresh = createMockAdapter();
    const link = await fresh.requestMagicLink('other@example.com');
    await fresh.consumeMagicLink(link.token);

    const visible = await fresh.listAssignments();
    assert.equal(visible.length, 0, 'a stranger sees nothing');

    await assert.throws(() => fresh.getAssignment('asg_001'), ERROR.NOT_AUTHORISED);

    restoreSnapshot();
  });
});

describe('Audit trail', () => {
  it('grows and never shrinks across a full loop', async () => {
    saveSnapshot();
    const adapter = freshAdapter();
    await signInAs(adapter, FREELANCER);
    const assignments = await adapter.listAssignments();

    const before = (await adapter.listAuditEvents(assignments[0].id)).length;

    const now = currentPeriod();
    const opened = await adapter.openPeriod(assignments[0].id, now.year, now.month);
    await adapter.saveDraft(opened.period.id, threeWeekdays());
    await adapter.submitPeriod(opened.period.id);
    await adapter.signOut();
    await signInAs(adapter, APPROVER);
    const inbox = await adapter.listAwaitingDecision();
    await adapter.rejectPeriod(inbox[0].period.id, 'graag corrigeren');

    const after = await adapter.listAuditEvents(assignments[0].id);
    assert.ok(after.length > before, 'events were appended');

    const actions = after.map((e) => e.action);
    assert.ok(actions.includes('period.draft_saved'));
    assert.ok(actions.includes('period.submitted'));
    assert.ok(actions.includes('period.rejected'));
    assert.ok(actions.includes('period.version_created'));

    restoreSnapshot();
  });
});
