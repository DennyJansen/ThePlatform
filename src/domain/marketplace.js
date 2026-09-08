/**
 * Marketplace rules: projects, applications, screening, profiles.
 *
 * Pure functions, no I/O, no DOM — same contract as rules.js, and for the same
 * reason: the mock adapter and the Supabase edge functions must both call one
 * implementation rather than growing two that agree most of the time.
 *
 * This module exists because of a scope reversal. Spec §1 put "Matching /
 * search / freelancer profiles" under "Explicitly not building", handled by
 * Sourcer in a spreadsheet. That decision was overturned deliberately. The
 * constraints it was protecting did not go away, so they are enforced here
 * instead — see `assertProfileVisibleTo` and the rate split below.
 */

import {
  ROLE,
  MEMBERSHIP_STATUS,
  PROJECT_STATUS,
  PROJECT_TRANSITIONS,
  PROJECT_TRANSITION_RESULT,
  APPLICATION_STATUS,
  APPLICATION_TRANSITIONS,
  APPLICATION_TRANSITION_RESULT,
  APPLICATION_ACTOR,
  ALLOWED_PROJECT_FIELDS,
  ALLOWED_PROFILE_FIELDS,
} from './model.js';
import {
  MIN_AGREED_RATE,
  MAX_AGREED_RATE,
  DEFAULT_CLIENT_FEE,
  DEFAULT_FREELANCER_FEE,
} from './money.js';
import { DomainError } from './rules.js';

export const MARKET_ERROR = Object.freeze({
  NOT_AUTHORISED: 'error.not_authorised',
  NOT_FOUND: 'error.not_found',
  ILLEGAL_TRANSITION: 'error.illegal_transition',
  TITLE_REQUIRED: 'error.title_required',
  DESCRIPTION_REQUIRED: 'error.description_required',
  RATE_REQUIRED: 'error.rate_required',
  RATE_OUT_OF_RANGE: 'error.rate_out_of_range',
  START_DATE_REQUIRED: 'error.start_date_required',
  HOURS_INDICATION_INVALID: 'error.hours_indication_invalid',
  PROJECT_NOT_OPEN: 'error.project_not_open',
  ALREADY_APPLIED: 'error.already_applied',
  MOTIVATION_REQUIRED: 'error.motivation_required',
  PROFILE_INCOMPLETE: 'error.profile_incomplete',
  PROFILE_NOT_VISIBLE: 'error.profile_not_visible',
  SLOT_REQUIRED: 'error.slot_required',
  SLOT_NOT_OFFERED: 'error.slot_not_offered',
  HIRING_MANAGER_REQUIRED: 'error.hiring_manager_required',
  REASON_REQUIRED: 'error.reason_required',
  OWN_PROJECT: 'error.own_project',
  FORBIDDEN_FIELD: 'error.forbidden_field',
});

export const MAX_TITLE = 120;
export const MAX_DESCRIPTION = 4000;
export const MAX_MOTIVATION = 2000;
export const MAX_SKILLS = 12;
export const MAX_SCREENING_SLOTS = 3;
export const MAX_INDICATIVE_HOURS = 40;

/* ------------------------------------------------------------------ *
 * Authorisation
 * ------------------------------------------------------------------ */

/**
 * True when the user may act commercially for this organisation.
 *
 * Membership must be `active`. A pending member — someone who signed up with a
 * KvK number an organisation already uses — belongs to the organisation but
 * cannot yet see or do anything in it. KvK numbers are public, so matching on
 * one says which organisation a person claims; it does not say they work
 * there. An existing admin decides that.
 */
export function isCompanyAdminFor(user, organizationId) {
  if (!user) return false;
  if (user.role === ROLE.OPS) return true;
  return user.role === ROLE.COMPANY_ADMIN
    && !!user.organization_id
    && user.organization_id === organizationId
    && membershipIsActive(user);
}

/**
 * Membership defaults to active when the field is absent, so that accounts
 * created before this rule existed are not locked out by a missing column.
 */
export function membershipIsActive(user) {
  return !user || user.membership_status === undefined
    ? true
    : user.membership_status === MEMBERSHIP_STATUS.ACTIVE;
}

export function membershipIsPending(user) {
  return !!user && user.membership_status === MEMBERSHIP_STATUS.PENDING;
}

/** Throws unless an active admin of the same organisation is asking. */
export function assertCanManageMembers(user, organizationId) {
  if (!isCompanyAdminFor(user, organizationId)) {
    throw new DomainError(MARKET_ERROR.NOT_AUTHORISED, 'Not an active admin of this organisation');
  }
}

/**
 * Approving or declining someone's request to join.
 *
 * A member cannot decide their own request — the check looks obvious written
 * down and is exactly the one that gets left out, at which point the whole
 * mechanism is decoration.
 */
export function assertMemberDecision(actor, member, decision) {
  if (!member) throw new DomainError(MARKET_ERROR.NOT_FOUND, 'No such member');
  if (actor.id === member.id) {
    throw new DomainError(MARKET_ERROR.NOT_AUTHORISED, 'Nobody approves their own membership');
  }
  assertCanManageMembers(actor, member.organization_id);
  if (!membershipIsPending(member)) {
    throw new DomainError(MARKET_ERROR.ILLEGAL_TRANSITION, 'That request is already decided');
  }
  if (decision !== MEMBERSHIP_STATUS.ACTIVE && decision !== MEMBERSHIP_STATUS.DECLINED) {
    throw new DomainError(MARKET_ERROR.ILLEGAL_TRANSITION, 'Not a membership decision');
  }
  return decision;
}

export function assertCanManageProject(user, project) {
  if (!project) throw new DomainError(MARKET_ERROR.NOT_FOUND, 'No such project');
  if (!isCompanyAdminFor(user, project.organization_id)) {
    throw new DomainError(MARKET_ERROR.NOT_AUTHORISED, 'Not this project’s organisation');
  }
}

/** Only freelancers apply. Ops does not apply on anyone's behalf. */
export function assertCanApply(user) {
  if (!user || user.role !== ROLE.FREELANCER) {
    throw new DomainError(MARKET_ERROR.NOT_AUTHORISED, 'Only a freelancer can apply');
  }
}

/**
 * A project is visible on the board only while open, and never to the company
 * that posted it — a company browsing its own listing among the others is
 * confusing, and it has a better view of it on its own screen.
 */
export function isVisibleOnBoard(project, user) {
  if (!project || project.status !== PROJECT_STATUS.OPEN) return false;
  if (!user) return false;
  return user.role === ROLE.FREELANCER || user.role === ROLE.OPS;
}

/**
 * Application statuses during which a company may still read the applicant's
 * profile.
 *
 * `hired` is on the list because a placement is an ongoing relationship. The
 * two that are absent are the point: once an application is **rejected** or
 * **withdrawn**, the company's access to that profile ends. Access follows the
 * reason it was granted, and when the reason is gone so is the access.
 */
export const PROFILE_VISIBLE_STATUSES = Object.freeze([
  APPLICATION_STATUS.SUBMITTED,
  APPLICATION_STATUS.SCREENING,
  APPLICATION_STATUS.HIRED,
]);

/**
 * COMPLIANCE §6. A structured profile exists now, so this is the rule that
 * keeps it from becoming a searchable candidate database.
 *
 * A company may read a freelancer's profile only through a **live** application
 * that freelancer chose to send it. `outreach_consent` is the single exception,
 * and it is the freelancer's to grant — it is what §6 means by "direct outreach
 * based on profile data requires opt-in captured at signup".
 *
 * "Live" matters. A company that rejected someone in March should not still be
 * reading their CV in November: nothing about the rejection entitles them to
 * keep it, and a profile that stays readable forever after one application is
 * a candidate database assembled one refusal at a time.
 *
 * There is no company-facing profile search anywhere in this build. If one is
 * ever added, it must filter on outreach_consent and this function is where
 * that is enforced.
 */
export function assertProfileVisibleTo(viewer, profileOwner, applications = []) {
  if (!viewer) throw new DomainError(MARKET_ERROR.NOT_AUTHORISED, 'No session');
  if (viewer.role === ROLE.OPS) return;
  if (viewer.id === profileOwner.id) return;

  if (viewer.role !== ROLE.COMPANY_ADMIN) {
    throw new DomainError(MARKET_ERROR.NOT_AUTHORISED, 'Profiles are not public');
  }
  if (profileOwner.outreach_consent === true) return;

  const live = applications.some((a) => a.freelancer_id === profileOwner.id
    && PROFILE_VISIBLE_STATUSES.includes(a.status));
  if (!live) {
    throw new DomainError(
      MARKET_ERROR.PROFILE_NOT_VISIBLE,
      'No live application from this freelancer, and no opt-in to being contacted',
    );
  }
}

/* ------------------------------------------------------------------ *
 * Projects
 * ------------------------------------------------------------------ */

export function assertNoForbiddenProjectFields(project) {
  for (const key of Object.keys(project)) {
    if (!ALLOWED_PROJECT_FIELDS.includes(key)) {
      throw new DomainError(MARKET_ERROR.FORBIDDEN_FIELD, 'Project may not carry ' + key, {
        field: key,
      });
    }
  }
}

/**
 * Validate and normalise a project posting.
 *
 * The company states the rate it is offering the freelancer — the agreed rate,
 * the number both sides will recognise. What the company itself pays (agreed +
 * client fee) and what the freelancer invoices (agreed − freelancer fee) are
 * derived from it wherever they are needed, never stored twice and never
 * typed. One stored number cannot drift out of step with itself.
 */
export function normaliseProject(input) {
  const title = String(input.title || '').trim();
  if (title.length < 3) {
    throw new DomainError(MARKET_ERROR.TITLE_REQUIRED, 'A project needs a title');
  }

  const description = String(input.description || '').trim();
  if (description.length < 30) {
    throw new DomainError(
      MARKET_ERROR.DESCRIPTION_REQUIRED,
      'A project needs a description a freelancer can decide on',
    );
  }

  const agreedRate = input.agreed_rate_per_hour;
  if (agreedRate === null || agreedRate === undefined || Number.isNaN(agreedRate)) {
    throw new DomainError(MARKET_ERROR.RATE_REQUIRED, 'A project needs an hourly rate');
  }
  if (!Number.isInteger(agreedRate) || agreedRate < MIN_AGREED_RATE || agreedRate > MAX_AGREED_RATE) {
    throw new DomainError(MARKET_ERROR.RATE_OUT_OF_RANGE, 'Rate is outside the accepted range', {
      min: MIN_AGREED_RATE, max: MAX_AGREED_RATE,
    });
  }

  if (!input.start_date || !/^\d{4}-\d{2}-\d{2}$/.test(input.start_date)) {
    throw new DomainError(MARKET_ERROR.START_DATE_REQUIRED, 'A project needs a start date');
  }

  let hours = input.indicative_hours_per_week;
  if (hours === '' || hours === null || hours === undefined) {
    hours = null;
  } else {
    hours = Number(hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_INDICATIVE_HOURS) {
      throw new DomainError(
        MARKET_ERROR.HOURS_INDICATION_INVALID,
        'Indicative scope must be between 1 and ' + MAX_INDICATIVE_HOURS + ' hours',
      );
    }
    hours = Math.round(hours);
  }

  let duration = input.duration_months;
  duration = duration === '' || duration === null || duration === undefined
    ? null
    : Math.max(1, Math.min(36, Math.round(Number(duration) || 0))) || null;

  return {
    title: title.slice(0, MAX_TITLE),
    description: description.slice(0, MAX_DESCRIPTION),
    agreed_rate_per_hour: agreedRate,
    indicative_hours_per_week: hours,
    start_date: input.start_date,
    duration_months: duration,
    location: String(input.location || '').trim().slice(0, 120) || null,
    remote_policy: ['on_site', 'hybrid', 'remote'].includes(input.remote_policy)
      ? input.remote_policy
      : 'hybrid',
  };
}

export function canTransitionProject(project, action) {
  const allowed = PROJECT_TRANSITIONS[project && project.status] || [];
  return allowed.includes(action);
}

export function assertProjectTransition(project, action) {
  if (!project) throw new DomainError(MARKET_ERROR.NOT_FOUND, 'No such project');
  if (!canTransitionProject(project, action)) {
    throw new DomainError(
      MARKET_ERROR.ILLEGAL_TRANSITION,
      'Cannot ' + action + ' a project that is ' + project.status,
      { from: project.status, action },
    );
  }
  return PROJECT_TRANSITION_RESULT[action];
}

/**
 * What a freelancer is handed for a project.
 *
 * This used to strip the client's budget, back when a posting carried two
 * rates. It no longer does: a posting carries one agreed rate, which both
 * sides are meant to see and negotiate on, and the fees are not confidential
 * either — a freelancer and a company may compare what each pays.
 *
 * The function stays because `created_by` is an internal reference rather than
 * something a posting means to publish, and because the moment a posting does
 * acquire a genuinely company-only field, this is where it gets removed — in
 * the data layer, not in whichever template happens to render it.
 */
export function projectForFreelancer(project) {
  if (!project) return null;
  const { created_by: _author, ...visible } = project;
  return visible;
}

/* ------------------------------------------------------------------ *
 * Profiles
 * ------------------------------------------------------------------ */

export function assertNoForbiddenProfileFields(profile) {
  for (const key of Object.keys(profile)) {
    if (!ALLOWED_PROFILE_FIELDS.includes(key)) {
      throw new DomainError(MARKET_ERROR.FORBIDDEN_FIELD, 'Profile may not carry ' + key, {
        field: key,
      });
    }
  }
}

export function normaliseProfile(input) {
  const headline = String(input.headline || '').trim();
  const bio = String(input.bio || '').trim();

  const skills = (Array.isArray(input.skills) ? input.skills : String(input.skills || '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, MAX_SKILLS);

  const languages = (Array.isArray(input.languages)
    ? input.languages
    : String(input.languages || '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, 6);

  let years = input.years_experience;
  years = years === '' || years === null || years === undefined
    ? null
    : Math.max(0, Math.min(60, Math.round(Number(years) || 0)));

  return {
    headline: headline.slice(0, 120),
    bio: bio.slice(0, 2000),
    skills,
    languages,
    years_experience: years,
    rate_expectation_per_hour: Number.isInteger(input.rate_expectation_per_hour)
      ? input.rate_expectation_per_hour
      : null,
    available_from: /^\d{4}-\d{2}-\d{2}$/.test(input.available_from || '')
      ? input.available_from
      : null,
    location: String(input.location || '').trim().slice(0, 120) || null,
    cv_file: input.cv_file || null,
    website_url: String(input.website_url || '').trim().slice(0, 300) || null,
  };
}

/**
 * Enough of a profile to be worth sending to a company. Kept low on purpose:
 * a wall of required fields before anyone can apply is how a marketplace ends
 * up with no supply.
 */
export function profileIsComplete(profile) {
  return !!profile
    && String(profile.headline || '').trim().length >= 3
    && String(profile.bio || '').trim().length >= 40
    && Array.isArray(profile.skills)
    && profile.skills.length >= 1;
}

export function assertProfileComplete(profile) {
  if (!profileIsComplete(profile)) {
    throw new DomainError(
      MARKET_ERROR.PROFILE_INCOMPLETE,
      'Complete your profile before applying',
    );
  }
}

/* ------------------------------------------------------------------ *
 * Applications
 * ------------------------------------------------------------------ */

export function canTransitionApplication(application, action) {
  const allowed = APPLICATION_TRANSITIONS[application && application.status] || [];
  return allowed.includes(action);
}

/**
 * Throws unless `action` is legal in the application's current status AND is
 * being fired by the side that owns it. A company cannot withdraw someone's
 * application; a freelancer cannot hire themselves.
 */
export function assertApplicationTransition(application, action, actorSide) {
  if (!application) throw new DomainError(MARKET_ERROR.NOT_FOUND, 'No such application');
  if (!canTransitionApplication(application, action)) {
    throw new DomainError(
      MARKET_ERROR.ILLEGAL_TRANSITION,
      'Cannot ' + action + ' an application that is ' + application.status,
      { from: application.status, action },
    );
  }
  if (APPLICATION_ACTOR[action] !== actorSide) {
    throw new DomainError(MARKET_ERROR.NOT_AUTHORISED, action + ' is not yours to fire');
  }
  return APPLICATION_TRANSITION_RESULT[action];
}

export function normaliseApplication(input) {
  const motivation = String(input.motivation || '').trim();
  if (motivation.length < 20) {
    throw new DomainError(
      MARKET_ERROR.MOTIVATION_REQUIRED,
      'Say something about why this project fits',
    );
  }
  return {
    motivation: motivation.slice(0, MAX_MOTIVATION),
    proposed_rate_per_hour: Number.isInteger(input.proposed_rate_per_hour)
      ? input.proposed_rate_per_hour
      : null,
  };
}

/** One application per freelancer per project. Reapplying is not a feature. */
export function assertNotAlreadyApplied(applications, projectId, freelancerId) {
  const existing = applications.find((a) => a.project_id === projectId
    && a.freelancer_id === freelancerId
    && a.status !== APPLICATION_STATUS.WITHDRAWN);
  if (existing) {
    throw new DomainError(MARKET_ERROR.ALREADY_APPLIED, 'Already applied to this project');
  }
}

export function assertProjectOpen(project) {
  if (!project) throw new DomainError(MARKET_ERROR.NOT_FOUND, 'No such project');
  if (project.status !== PROJECT_STATUS.OPEN) {
    throw new DomainError(MARKET_ERROR.PROJECT_NOT_OPEN, 'This project is no longer open');
  }
}

/* ------------------------------------------------------------------ *
 * Screening
 * ------------------------------------------------------------------ */

/**
 * The screening invitation. The company names the hiring manager who will take
 * the call and offers up to three slots; the freelancer picks one.
 *
 * No calendar integration, and none planned. Spec §5 is explicit that email is
 * the real interface, and a scheduling system is a product of its own. This
 * records what was agreed so that both sides and the audit trail have the same
 * version of it.
 */
export function normaliseScreeningInvite(input) {
  const manager = String(input.hiring_manager_name || '').trim();
  if (manager.length < 2) {
    throw new DomainError(
      MARKET_ERROR.HIRING_MANAGER_REQUIRED,
      'Name the person who will take the call',
    );
  }

  const slots = (Array.isArray(input.slots) ? input.slots : [])
    .map((s) => String(s || '').trim())
    .filter((s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s))
    .slice(0, MAX_SCREENING_SLOTS);

  if (slots.length === 0) {
    throw new DomainError(MARKET_ERROR.SLOT_REQUIRED, 'Offer at least one time');
  }

  return {
    hiring_manager_name: manager.slice(0, 120),
    screening_note: String(input.screening_note || '').trim().slice(0, 1000) || null,
    screening_slots: slots,
    screening_confirmed_slot: null,
  };
}

/** The freelancer picks one of the offered slots. Not a free-text time. */
export function assertSlotOffered(application, slot) {
  const offered = application.screening_slots || [];
  if (!slot) throw new DomainError(MARKET_ERROR.SLOT_REQUIRED, 'Pick a time');
  if (!offered.includes(slot)) {
    throw new DomainError(MARKET_ERROR.SLOT_NOT_OFFERED, 'That time was not offered');
  }
  return slot;
}

/** A rejection carries a reason, for the same reason §4/C1 requires one. */
export function assertRejectionReason(reason) {
  if (typeof reason !== 'string' || reason.trim().length < 3) {
    throw new DomainError(MARKET_ERROR.REASON_REQUIRED, 'Give a reason');
  }
  return reason.trim().slice(0, 1000);
}

/* ------------------------------------------------------------------ *
 * Hire → Assignment
 * ------------------------------------------------------------------ */

/**
 * The assignment a hire produces.
 *
 * It is created `pending`, not `active`: at this point two people have had a
 * call and agreed in principle. Spec §8 lists nine contract clauses the rest
 * of the system assumes exist, and none of them do yet. Ops sets the final
 * rates, uploads the signed agreement, names the approver, and only then
 * activates it. Until that happens no period opens and nothing is invoiced.
 *
 * COMPLIANCE §6: `indicative_hours_per_week` is deliberately NOT copied from
 * the project. On a pitch it is commercial scoping; on a live assignment it
 * would be an expected-hours field. A test asserts its absence here.
 */
export function buildAssignmentFromHire(project, application, newId, now = new Date()) {
  return {
    id: newId,
    title: project.title,
    freelancer_id: application.freelancer_id,
    organization_id: project.organization_id,
    // Ops names the approver when activating. The hiring manager who took the
    // screening call is a lead, not necessarily who signs off hours.
    approver_id: null,
    // The rate that was actually agreed: what the freelancer asked for if they
    // proposed one, otherwise what the posting offered. The two fees are
    // platform terms and are applied to it, not negotiated per hire.
    agreed_rate_per_hour: application.proposed_rate_per_hour
      || project.agreed_rate_per_hour,
    client_fee_per_hour: DEFAULT_CLIENT_FEE,
    freelancer_fee_per_hour: DEFAULT_FREELANCER_FEE,
    fixed_fee_amount: null,
    fixed_fee_payer: null,
    hour_increment: 0.25,
    start_date: project.start_date,
    end_date: null,
    status: 'pending',
    contract_pdf: null,
    approval_window_days: 5,
    auto_approve_enabled: false,
    source_project_id: project.id,
    source_application_id: application.id,
    created_at: now.toISOString(),
  };
}
