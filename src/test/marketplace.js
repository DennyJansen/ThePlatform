/**
 * Marketplace tests.
 *
 * Two things here are worth more than the rest and are tested hardest:
 *
 *  1. A posting carries exactly one rate. Two stored rates that must differ by
 *     a fee are a pair that can drift, and once they have, nobody can say what
 *     was agreed. Not a confidentiality rule — the fees are open — an
 *     integrity one.
 *  2. `indicative_hours_per_week` must never reach an Assignment. On a pitch it
 *     is commercial scope; on a live assignment it is an expected-hours field,
 *     which spec §6 forbids. The hire path is the one route by which it could
 *     travel, so that route has its own test.
 */

import { describe, it, assert } from './runner.js';

import {
  ROLE, PROJECT_STATUS, APPLICATION_STATUS, APPLICATION_TRANSITIONS,
  FORBIDDEN_ASSIGNMENT_FIELDS, ALLOWED_PROJECT_FIELDS, ALLOWED_PROFILE_FIELDS,
} from '../domain/model.js';
import {
  MARKET_ERROR, MAX_SKILLS,
  assertApplicationTransition, assertCanApply, assertCanManageProject,
  assertNotAlreadyApplied, assertProfileComplete, assertProfileVisibleTo,
  assertProjectOpen, assertProjectTransition, assertRejectionReason,
  assertSlotOffered, buildAssignmentFromHire, isCompanyAdminFor,
  normaliseApplication, normaliseProfile, normaliseProject,
  normaliseScreeningInvite, profileIsComplete, projectForFreelancer,
  assertNoForbiddenProjectFields, assertNoForbiddenProfileFields,
} from '../domain/marketplace.js';
import {
  clientRate, freelancerRate, parseRateToCents,
  MIN_AGREED_RATE, MAX_AGREED_RATE, DEFAULT_CLIENT_FEE, DEFAULT_FREELANCER_FEE,
} from '../domain/money.js';
import { createMockAdapter } from '../data/mock/mockAdapter.js';
import { save, __testing } from '../data/mock/store.js';
import { buildSeed } from '../data/mock/seed.js';

/* ------------------------------------------------------------------ */

const VALID_PROJECT = Object.freeze({
  title: 'Werkvoorbereider utiliteitsbouw',
  description: 'Een omschrijving die lang genoeg is om een beslissing op te nemen, '
    + 'met genoeg detail over het werk.',
  agreed_rate_per_hour: 9500,
  indicative_hours_per_week: 32,
  start_date: '2026-10-01',
  duration_months: 6,
  location: 'Utrecht',
  remote_policy: 'hybrid',
});

const COMPANY = { id: 'usr_c', role: ROLE.COMPANY_ADMIN, organization_id: 'org_1' };
const OTHER_COMPANY = { id: 'usr_c2', role: ROLE.COMPANY_ADMIN, organization_id: 'org_2' };
const FREELANCER = { id: 'usr_f', role: ROLE.FREELANCER, organization_id: null };
const APPROVER = { id: 'usr_a', role: ROLE.APPROVER, organization_id: 'org_1' };

/* ------------------------------------------------------------------ */

describe('Marketplace — one rate on a posting', () => {
  it('stores exactly one rate, and derives the other two', () => {
    const p = normaliseProject(VALID_PROJECT);
    assert.equal(p.agreed_rate_per_hour, 9500);
    assert.equal(p.client_rate_per_hour, undefined,
      'a posting stores no client rate — it is derived when needed');
    assert.equal(p.freelancer_rate_per_hour, undefined);

    assert.equal(clientRate(p.agreed_rate_per_hour, DEFAULT_CLIENT_FEE), 10000);
    assert.equal(freelancerRate(p.agreed_rate_per_hour, DEFAULT_FREELANCER_FEE), 9300);
  });

  it('shows a freelancer the agreed rate, and no internal reference', () => {
    const stored = { id: 'prj_1', ...normaliseProject(VALID_PROJECT), created_by: 'usr_c' };
    const shown = projectForFreelancer(stored);
    assert.equal(shown.agreed_rate_per_hour, 9500, 'the agreed rate is theirs to see');
    assert.equal(shown.created_by, undefined, 'the author is not');
  });

  it('never lets one stored rate drift from another, because there is only one', () => {
    const p = normaliseProject(VALID_PROJECT);
    const rateFields = Object.keys(p).filter((k) => /_rate_per_hour$/.test(k));
    assert.deepEqual(rateFields, ['agreed_rate_per_hour'],
      'two stored rates that must differ by a fee are a pair that can drift');
  });

  it('parses a rate typed as euros', () => {
    assert.equal(parseRateToCents('95'), 9500);
    assert.equal(parseRateToCents('95,50'), 9550);
    assert.equal(parseRateToCents('95.50'), 9550);
    assert.equal(parseRateToCents('€ 95,50'), 9550);
    assert.equal(parseRateToCents(''), null);
    assert.ok(Number.isNaN(parseRateToCents('vijfennegentig')));
    assert.ok(Number.isNaN(parseRateToCents('-95')));
  });
});

describe('Marketplace — project validation', () => {
  it('requires a title, a description a person can decide on, and a rate', async () => {
    await assert.throws(() => normaliseProject({ ...VALID_PROJECT, title: 'ab' }),
      MARKET_ERROR.TITLE_REQUIRED);
    await assert.throws(() => normaliseProject({ ...VALID_PROJECT, description: 'te kort' }),
      MARKET_ERROR.DESCRIPTION_REQUIRED);
    await assert.throws(() => normaliseProject({ ...VALID_PROJECT, agreed_rate_per_hour: null }),
      MARKET_ERROR.RATE_REQUIRED);
    await assert.throws(() => normaliseProject({ ...VALID_PROJECT, start_date: '' }),
      MARKET_ERROR.START_DATE_REQUIRED);
  });

  it('bounds the rate', async () => {
    await assert.throws(
      () => normaliseProject({ ...VALID_PROJECT, agreed_rate_per_hour: MIN_AGREED_RATE - 1 }),
      MARKET_ERROR.RATE_OUT_OF_RANGE,
    );
    await assert.throws(
      () => normaliseProject({ ...VALID_PROJECT, agreed_rate_per_hour: MAX_AGREED_RATE + 1 }),
      MARKET_ERROR.RATE_OUT_OF_RANGE,
    );
  });

  it('treats indicative scope as optional and bounded', () => {
    assert.equal(normaliseProject({ ...VALID_PROJECT, indicative_hours_per_week: '' })
      .indicative_hours_per_week, null);
    assert.equal(normaliseProject({ ...VALID_PROJECT, indicative_hours_per_week: 24 })
      .indicative_hours_per_week, 24);
  });

  it('refuses a scope beyond a full week', async () => {
    await assert.throws(
      () => normaliseProject({ ...VALID_PROJECT, indicative_hours_per_week: 60 }),
      MARKET_ERROR.HOURS_INDICATION_INVALID,
    );
  });

  it('refuses a field outside the allow-list', async () => {
    await assert.throws(
      () => assertNoForbiddenProjectFields({ ...VALID_PROJECT, core_hours: '09:00-17:00' }),
      MARKET_ERROR.FORBIDDEN_FIELD,
    );
  });

  it('allows exactly the documented project fields', () => {
    for (const key of Object.keys(normaliseProject(VALID_PROJECT))) {
      assert.ok(ALLOWED_PROJECT_FIELDS.includes(key), key + ' is not on the allow-list');
    }
  });

  it('follows the project transition table', async () => {
    assert.equal(assertProjectTransition({ status: 'draft' }, 'publish'), PROJECT_STATUS.OPEN);
    assert.equal(assertProjectTransition({ status: 'open' }, 'close'), PROJECT_STATUS.CLOSED);
    assert.equal(assertProjectTransition({ status: 'closed' }, 'publish'), PROJECT_STATUS.OPEN);
    await assert.throws(() => assertProjectTransition({ status: 'filled' }, 'publish'),
      MARKET_ERROR.ILLEGAL_TRANSITION);
    await assert.throws(() => assertProjectTransition({ status: 'draft' }, 'close'),
      MARKET_ERROR.ILLEGAL_TRANSITION);
  });
});

describe('Marketplace — who may do what', () => {
  it('binds a company admin to their own organisation', () => {
    assert.ok(isCompanyAdminFor(COMPANY, 'org_1'));
    assert.ok(!isCompanyAdminFor(COMPANY, 'org_2'));
    assert.ok(!isCompanyAdminFor(FREELANCER, 'org_1'));
    assert.ok(!isCompanyAdminFor(APPROVER, 'org_1'), 'an approver has no commercial authority');
  });

  it('does not let one company manage another company’s project', async () => {
    const project = { id: 'p', organization_id: 'org_1', status: 'open' };
    assertCanManageProject(COMPANY, project);
    await assert.throws(() => assertCanManageProject(OTHER_COMPANY, project),
      MARKET_ERROR.NOT_AUTHORISED);
    await assert.throws(() => assertCanManageProject(FREELANCER, project),
      MARKET_ERROR.NOT_AUTHORISED);
  });

  it('lets only a freelancer apply', async () => {
    assertCanApply(FREELANCER);
    await assert.throws(() => assertCanApply(COMPANY), MARKET_ERROR.NOT_AUTHORISED);
    await assert.throws(() => assertCanApply(APPROVER), MARKET_ERROR.NOT_AUTHORISED);
    await assert.throws(() => assertCanApply(null), MARKET_ERROR.NOT_AUTHORISED);
  });

  it('refuses an application to a project that is not open', async () => {
    await assert.throws(() => assertProjectOpen({ status: 'draft' }),
      MARKET_ERROR.PROJECT_NOT_OPEN);
    await assert.throws(() => assertProjectOpen({ status: 'filled' }),
      MARKET_ERROR.PROJECT_NOT_OPEN);
  });

  it('allows one application per project, and reapplying after a withdrawal', async () => {
    const existing = [{ project_id: 'p1', freelancer_id: 'usr_f', status: 'submitted' }];
    await assert.throws(() => assertNotAlreadyApplied(existing, 'p1', 'usr_f'),
      MARKET_ERROR.ALREADY_APPLIED);
    assertNotAlreadyApplied(existing, 'p2', 'usr_f');
    assertNotAlreadyApplied(
      [{ project_id: 'p1', freelancer_id: 'usr_f', status: 'withdrawn' }],
      'p1', 'usr_f',
    );
  });
});

describe('Compliance §6 — profiles do not become a candidate database', () => {
  const owner = { id: 'usr_f', outreach_consent: false };
  const consenting = { id: 'usr_f2', outreach_consent: true };

  it('hides a profile from a company the freelancer has not applied to', async () => {
    await assert.throws(() => assertProfileVisibleTo(COMPANY, owner, []),
      MARKET_ERROR.PROFILE_NOT_VISIBLE);
  });

  it('shows it once they have applied to that organisation', () => {
    assertProfileVisibleTo(COMPANY, owner, [{ freelancer_id: 'usr_f' }]);
  });

  it('shows it when the freelancer opted in to being approached', () => {
    assertProfileVisibleTo(COMPANY, consenting, []);
  });

  it('never shows one freelancer another freelancer’s profile', async () => {
    await assert.throws(() => assertProfileVisibleTo(FREELANCER, consenting, []),
      MARKET_ERROR.NOT_AUTHORISED);
  });

  it('lets a freelancer see their own', () => {
    assertProfileVisibleTo({ id: 'usr_f', role: ROLE.FREELANCER }, owner, []);
  });

  it('refuses a profile field outside the allow-list', async () => {
    await assert.throws(
      () => assertNoForbiddenProfileFields({ headline: 'x', current_employer: 'y' }),
      MARKET_ERROR.FORBIDDEN_FIELD,
    );
  });

  it('normalises skills to a bounded list', () => {
    const many = Array.from({ length: 30 }, (_, i) => 'skill' + i).join(',');
    const p = normaliseProfile({ headline: 'x', bio: 'y', skills: many });
    assert.equal(p.skills.length, MAX_SKILLS);
    for (const key of Object.keys(p)) {
      assert.ok(ALLOWED_PROFILE_FIELDS.includes(key), key + ' is not on the allow-list');
    }
  });

  it('requires enough of a profile to be worth sending', async () => {
    assert.ok(!profileIsComplete(null));
    assert.ok(!profileIsComplete({ headline: 'x', bio: 'short', skills: [] }));
    assert.ok(profileIsComplete({
      headline: 'Werkvoorbereider',
      bio: 'Een omschrijving die lang genoeg is om iets over te zeggen.',
      skills: ['Werkvoorbereiding'],
    }));
    await assert.throws(() => assertProfileComplete({ headline: 'x' }),
      MARKET_ERROR.PROFILE_INCOMPLETE);
  });
});

describe('Marketplace — the application state machine', () => {
  it('matches the documented table', () => {
    assert.deepEqual(APPLICATION_TRANSITIONS.submitted, ['invite', 'reject', 'withdraw']);
    assert.deepEqual(APPLICATION_TRANSITIONS.screening, ['hire', 'reject', 'withdraw']);
    assert.deepEqual(APPLICATION_TRANSITIONS.hired, []);
    assert.deepEqual(APPLICATION_TRANSITIONS.rejected, []);
    assert.deepEqual(APPLICATION_TRANSITIONS.withdrawn, []);
  });

  it('goes to a screening call before a hire, never straight there', async () => {
    assert.equal(
      assertApplicationTransition({ status: 'submitted' }, 'invite', 'company'),
      APPLICATION_STATUS.SCREENING,
    );
    await assert.throws(
      () => assertApplicationTransition({ status: 'submitted' }, 'hire', 'company'),
      MARKET_ERROR.ILLEGAL_TRANSITION,
      'hiring without a screening call must be refused',
    );
    assert.equal(
      assertApplicationTransition({ status: 'screening' }, 'hire', 'company'),
      APPLICATION_STATUS.HIRED,
    );
  });

  it('gives each side only its own transitions', async () => {
    await assert.throws(
      () => assertApplicationTransition({ status: 'screening' }, 'hire', 'freelancer'),
      MARKET_ERROR.NOT_AUTHORISED,
      'a freelancer cannot hire themselves',
    );
    await assert.throws(
      () => assertApplicationTransition({ status: 'submitted' }, 'withdraw', 'company'),
      MARKET_ERROR.NOT_AUTHORISED,
      'a company cannot withdraw someone’s application',
    );
  });

  it('does not reopen a decided application', async () => {
    for (const status of ['hired', 'rejected', 'withdrawn']) {
      await assert.throws(
        () => assertApplicationTransition({ status }, 'invite', 'company'),
        MARKET_ERROR.ILLEGAL_TRANSITION,
      );
    }
  });

  it('requires a motivation with something in it', async () => {
    await assert.throws(() => normaliseApplication({ motivation: 'kort' }),
      MARKET_ERROR.MOTIVATION_REQUIRED);
    const ok = normaliseApplication({
      motivation: 'Dit is een motivatie die lang genoeg is.',
      proposed_rate_per_hour: 9500,
    });
    assert.equal(ok.proposed_rate_per_hour, 9500);
  });

  it('requires a reason on a rejection', async () => {
    await assert.throws(() => assertRejectionReason(''), MARKET_ERROR.REASON_REQUIRED);
    await assert.throws(() => assertRejectionReason('  '), MARKET_ERROR.REASON_REQUIRED);
    assert.equal(assertRejectionReason('  te weinig ervaring  '), 'te weinig ervaring');
  });
});

describe('Marketplace — the screening call', () => {
  it('needs a named person and at least one time', async () => {
    await assert.throws(
      () => normaliseScreeningInvite({ hiring_manager_name: '', slots: ['2026-10-01T10:00'] }),
      MARKET_ERROR.HIRING_MANAGER_REQUIRED,
    );
    await assert.throws(
      () => normaliseScreeningInvite({ hiring_manager_name: 'Marieke Vos', slots: [] }),
      MARKET_ERROR.SLOT_REQUIRED,
    );
  });

  it('keeps at most three slots and drops malformed ones', () => {
    const invite = normaliseScreeningInvite({
      hiring_manager_name: 'Marieke Vos',
      slots: ['2026-10-01T10:00', 'donderdagmiddag', '2026-10-02T14:00',
        '2026-10-03T09:00', '2026-10-04T09:00'],
    });
    assert.equal(invite.screening_slots.length, 3);
    assert.ok(!invite.screening_slots.includes('donderdagmiddag'));
    assert.equal(invite.screening_confirmed_slot, null);
  });

  it('only accepts a slot that was actually offered', async () => {
    const application = { screening_slots: ['2026-10-01T10:00', '2026-10-02T14:00'] };
    assert.equal(assertSlotOffered(application, '2026-10-02T14:00'), '2026-10-02T14:00');
    await assert.throws(() => assertSlotOffered(application, '2026-10-03T09:00'),
      MARKET_ERROR.SLOT_NOT_OFFERED);
    await assert.throws(() => assertSlotOffered(application, null),
      MARKET_ERROR.SLOT_REQUIRED);
  });
});

describe('Compliance §6 — a hire must not carry scope onto the assignment', () => {
  const project = {
    id: 'prj_1',
    organization_id: 'org_1',
    title: 'Werkvoorbereider',
    agreed_rate_per_hour: 9500,
    indicative_hours_per_week: 32,
    start_date: '2026-10-01',
  };
  const application = { id: 'app_1', freelancer_id: 'usr_f', proposed_rate_per_hour: null };
  const assignment = buildAssignmentFromHire(project, application, 'asg_new');

  it('drops indicative_hours_per_week entirely', () => {
    assert.equal(assignment.indicative_hours_per_week, undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(assignment, 'indicative_hours_per_week'),
      'scope from the pitch reached the assignment — this is a Wet DBA regression');
  });

  it('carries none of the forbidden assignment fields', () => {
    for (const field of FORBIDDEN_ASSIGNMENT_FIELDS) {
      assert.ok(!Object.prototype.hasOwnProperty.call(assignment, field),
        field + ' must never appear on an assignment');
    }
  });

  it('creates it pending, with no approver and no contract', () => {
    assert.equal(assignment.status, 'pending');
    assert.equal(assignment.approver_id, null, 'ops names the approver, not the hiring manager');
    assert.equal(assignment.contract_pdf, null);
    assert.equal(assignment.auto_approve_enabled, false);
  });

  it('keeps both rates, and prefers the rate that was actually negotiated', () => {
    assert.equal(assignment.agreed_rate_per_hour, 9500, 'the rate that was agreed');
    assert.equal(assignment.client_fee_per_hour, DEFAULT_CLIENT_FEE);
    assert.equal(assignment.freelancer_fee_per_hour, DEFAULT_FREELANCER_FEE);
    assert.equal(clientRate(assignment.agreed_rate_per_hour,
      assignment.client_fee_per_hour), 10000, 'the company is invoiced 100');
    assert.equal(freelancerRate(assignment.agreed_rate_per_hour,
      assignment.freelancer_fee_per_hour), 9300, 'the freelancer invoices 93');

    const negotiated = buildAssignmentFromHire(
      project, { ...application, proposed_rate_per_hour: 9700 }, 'asg_2',
    );
    assert.equal(negotiated.agreed_rate_per_hour, 9700,
      'a rate the freelancer proposed becomes the agreed rate');
  });

  it('records where it came from', () => {
    assert.equal(assignment.source_project_id, 'prj_1');
    assert.equal(assignment.source_application_id, 'app_1');
  });
});

/* ------------------------------------------------------------------ *
 * End to end, against the mock adapter
 * ------------------------------------------------------------------ */

let snapshot = null;
function saveSnapshot() {
  try { snapshot = window.localStorage.getItem(__testing.STORAGE_KEY); } catch (e) { snapshot = null; }
}
function restoreSnapshot() {
  try {
    if (snapshot === null) window.localStorage.removeItem(__testing.STORAGE_KEY);
    else window.localStorage.setItem(__testing.STORAGE_KEY, snapshot);
  } catch (e) { /* private mode */ }
}
function freshAdapter() {
  save(buildSeed());
  return createMockAdapter();
}
async function signInAs(adapter, email) {
  await adapter.signOut().catch(() => {});
  const link = await adapter.requestMagicLink(email);
  return adapter.consumeMagicLink(link.token);
}

const F = 'freelancer@example.com';
const C1 = 'company@example.com';
const C2 = 'company2@example.com';

describe('Marketplace loop — apply, screen, hire', () => {
  it('hands a freelancer the agreed rate and no internal reference', async () => {
    saveSnapshot();
    const a = freshAdapter();
    await signInAs(a, F);

    const board = await a.listOpenProjects();
    assert.ok(board.length > 0, 'the board has something on it');
    for (const row of board) {
      assert.equal(row.created_by, undefined, 'an internal reference reached the board');
      assert.ok(row.agreed_rate_per_hour > 0, 'the agreed rate is shown');
    }

    const view = await a.getProject(board[0].id);
    assert.equal(view.project.created_by, undefined, 'an internal reference reached detail');
    assert.ok(view.project.agreed_rate_per_hour > 0);

    restoreSnapshot();
  });

  it('hides drafts from the board and shows them to their owner', async () => {
    saveSnapshot();
    const a = freshAdapter();

    await signInAs(a, F);
    const board = await a.listOpenProjects();
    assert.ok(!board.some((p) => p.id === 'prj_004'), 'a draft was published to the board');
    await assert.throws(() => a.getProject('prj_004'), MARKET_ERROR.NOT_FOUND);

    await signInAs(a, C2);
    const own = await a.listCompanyProjects();
    assert.ok(own.some((p) => p.id === 'prj_004'), 'the owner cannot see their own draft');

    restoreSnapshot();
  });

  it('shows a company only its own projects', async () => {
    saveSnapshot();
    const a = freshAdapter();

    await signInAs(a, C1);
    const mine = await a.listCompanyProjects();
    assert.ok(mine.length > 0);
    assert.ok(mine.every((p) => p.organization_id === 'org_client'));
    await assert.throws(() => a.listApplicationsForProject('prj_003'),
      MARKET_ERROR.NOT_AUTHORISED, 'one company read another’s applications');

    restoreSnapshot();
  });

  it('runs application → screening → hire and lands on a pending assignment', async () => {
    saveSnapshot();
    const a = freshAdapter();

    await signInAs(a, F);
    const applied = await a.applyToProject('prj_001', {
      motivation: 'Vier vergelijkbare renovatieprojecten begeleid, per de startdatum beschikbaar.',
      proposed_rate_per_hour: 9500,
    });

    await assert.throws(() => a.applyToProject('prj_001', {
      motivation: 'Nog een keer, wat niet zou moeten kunnen.',
    }), MARKET_ERROR.ALREADY_APPLIED);

    await signInAs(a, C1);
    const inbox = await a.listApplicationsForProject('prj_001');
    assert.equal(inbox.applications.length, 1);
    assert.equal(inbox.applications[0].status, APPLICATION_STATUS.SUBMITTED);
    assert.ok(inbox.applications[0].profile, 'the profile came with the application');

    const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const invited = await a.inviteToScreening(applied.id, {
      hiring_manager_name: 'Marieke Vos',
      screening_note: 'Half uur videobellen.',
      slots: [day + 'T10:00', day + 'T14:00'],
    });
    assert.equal(invited.applications[0].status, APPLICATION_STATUS.SCREENING);

    await signInAs(a, F);
    const confirmed = await a.confirmScreeningSlot(applied.id, day + 'T14:00');
    assert.equal(
      confirmed.find((x) => x.id === applied.id).screening_confirmed_slot,
      day + 'T14:00',
    );
    await assert.throws(() => a.confirmScreeningSlot(applied.id, day + 'T09:00'),
      MARKET_ERROR.SLOT_NOT_OFFERED);

    await signInAs(a, C1);
    const hired = await a.hireApplicant(applied.id);
    assert.ok(hired.assignment_id, 'a hire produced an assignment');

    await signInAs(a, F);
    const assignments = await a.listAssignments();
    const pending = assignments.find((x) => x.id === hired.assignment_id);
    assert.equal(pending.status, 'pending');
    assert.ok(!Object.prototype.hasOwnProperty.call(pending, 'indicative_hours_per_week'),
      'scope from the pitch reached the assignment');
    await assert.throws(() => a.openPeriod(pending.id, 2026, 10), 'error.assignment_not_active');

    restoreSnapshot();
  });

  it('refuses to hire someone who was never screened', async () => {
    saveSnapshot();
    const a = freshAdapter();

    await signInAs(a, F);
    const applied = await a.applyToProject('prj_001', {
      motivation: 'Een motivatie die lang genoeg is om te versturen.',
    });

    await signInAs(a, C1);
    await assert.throws(() => a.hireApplicant(applied.id), MARKET_ERROR.ILLEGAL_TRANSITION);

    restoreSnapshot();
  });

  it('requires a complete profile before an application can be sent', async () => {
    saveSnapshot();
    const a = freshAdapter();

    await signInAs(a, F);
    await a.saveMyProfile({ headline: 'x', bio: '', skills: '' });
    await assert.throws(() => a.applyToProject('prj_001', {
      motivation: 'Een motivatie die lang genoeg is om te versturen.',
    }), MARKET_ERROR.PROFILE_INCOMPLETE);

    restoreSnapshot();
  });

  it('lets a freelancer withdraw, and a company not', async () => {
    saveSnapshot();
    const a = freshAdapter();

    await signInAs(a, F);
    const applied = await a.applyToProject('prj_001', {
      motivation: 'Een motivatie die lang genoeg is om te versturen.',
    });
    const after = await a.withdrawApplication(applied.id);
    assert.equal(after.find((x) => x.id === applied.id).status, APPLICATION_STATUS.WITHDRAWN);

    // Withdrawn frees the freelancer to apply again.
    const again = await a.applyToProject('prj_001', {
      motivation: 'Toch weer beschikbaar, met dezelfde motivatie als eerder.',
    });
    assert.ok(again.id);

    await signInAs(a, C1);
    await assert.throws(() => a.withdrawApplication(again.id), MARKET_ERROR.NOT_AUTHORISED);

    restoreSnapshot();
  });

  it('marks the project filled when someone is hired', async () => {
    saveSnapshot();
    const a = freshAdapter();

    await signInAs(a, F);
    const applied = await a.applyToProject('prj_001', {
      motivation: 'Een motivatie die lang genoeg is om te versturen.',
    });

    await signInAs(a, C1);
    const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await a.inviteToScreening(applied.id, {
      hiring_manager_name: 'Marieke Vos',
      slots: [day + 'T10:00'],
    });
    await a.hireApplicant(applied.id);

    const own = await a.listCompanyProjects();
    assert.equal(own.find((p) => p.id === 'prj_001').status, PROJECT_STATUS.FILLED);

    await signInAs(a, F);
    const board = await a.listOpenProjects();
    assert.ok(!board.some((p) => p.id === 'prj_001'), 'a filled project stayed on the board');

    restoreSnapshot();
  });

  it('publishes and closes a project through the company screens', async () => {
    saveSnapshot();
    const a = freshAdapter();
    await signInAs(a, C2);

    const created = await a.saveProject(null, VALID_PROJECT);
    assert.equal(created.project.status, PROJECT_STATUS.DRAFT, 'a new project starts as a draft');
    assert.equal(created.project.agreed_rate_per_hour, 9500);

    const published = await a.transitionProject(created.project.id, 'publish');
    assert.equal(published.project.status, PROJECT_STATUS.OPEN);
    assert.ok(published.project.published_at);

    const closed = await a.transitionProject(created.project.id, 'close');
    assert.equal(closed.project.status, PROJECT_STATUS.CLOSED);

    restoreSnapshot();
  });

  it('does not let a freelancer post a project', async () => {
    saveSnapshot();
    const a = freshAdapter();
    await signInAs(a, F);
    await assert.throws(() => a.saveProject(null, VALID_PROJECT), MARKET_ERROR.NOT_AUTHORISED);
    restoreSnapshot();
  });
});
