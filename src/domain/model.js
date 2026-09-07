/**
 * Domain constants and the shapes described in v1-functional-spec.md §3.
 *
 * This module is pure data + pure functions. It must never import from
 * src/data/** or src/ui/**. Both the mock adapter and the future Supabase
 * adapter derive their behaviour from here, which is what keeps the two
 * implementations honest about being the same system.
 */

export const ROLE = Object.freeze({
  FREELANCER: 'freelancer',
  APPROVER: 'approver',
  OPS: 'ops',
  /**
   * Added with the marketplace. Posts and manages an organisation's projects
   * and decides on applications.
   *
   * Deliberately separate from `approver`: spec §2 gives the approver one
   * narrow power — approving hours on one named assignment — and the
   * compliance story leans on that narrowness. Commercial authority to pitch
   * work is a different thing. One person may hold both roles; the roles
   * themselves stay distinct.
   */
  COMPANY_ADMIN: 'company_admin',
});

export const PERIOD_STATUS = Object.freeze({
  DRAFT: 'draft',
  SUBMITTED: 'submitted',
  REJECTED: 'rejected',
  APPROVED: 'approved',
  INVOICED: 'invoiced',
  PAID: 'paid',
});

export const CHARGE_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
});

export const ASSIGNMENT_STATUS = Object.freeze({
  /**
   * Created by a hire, not yet contracted. Ops still has to set the final
   * rates and upload the signed agreement. A pending assignment opens no
   * period and can be invoiced against by nothing — spec §8 lists nine
   * clauses the code assumes exist, and none of them exist yet at this point.
   */
  PENDING: 'pending',
  ACTIVE: 'active',
  ENDED: 'ended',
});

/** A project pitched by a company on the marketplace. */
export const PROJECT_STATUS = Object.freeze({
  DRAFT: 'draft',
  OPEN: 'open',
  CLOSED: 'closed',
  FILLED: 'filled',
});

export const PROJECT_TRANSITIONS = Object.freeze({
  [PROJECT_STATUS.DRAFT]: Object.freeze(['publish']),
  [PROJECT_STATUS.OPEN]: Object.freeze(['close', 'fill']),
  [PROJECT_STATUS.CLOSED]: Object.freeze(['publish']),
  [PROJECT_STATUS.FILLED]: Object.freeze([]),
});

export const PROJECT_TRANSITION_RESULT = Object.freeze({
  publish: PROJECT_STATUS.OPEN,
  close: PROJECT_STATUS.CLOSED,
  fill: PROJECT_STATUS.FILLED,
});

/**
 * An application, and the screening call the company runs before hiring.
 *
 *   submitted ──invite──> screening ──hire──> hired
 *       │                     │
 *       ├──reject──> rejected ┘
 *       │
 *       └──withdraw──> withdrawn        (freelancer only)
 */
export const APPLICATION_STATUS = Object.freeze({
  SUBMITTED: 'submitted',
  SCREENING: 'screening',
  HIRED: 'hired',
  REJECTED: 'rejected',
  WITHDRAWN: 'withdrawn',
});

export const APPLICATION_TRANSITIONS = Object.freeze({
  [APPLICATION_STATUS.SUBMITTED]: Object.freeze(['invite', 'reject', 'withdraw']),
  [APPLICATION_STATUS.SCREENING]: Object.freeze(['hire', 'reject', 'withdraw']),
  [APPLICATION_STATUS.HIRED]: Object.freeze([]),
  [APPLICATION_STATUS.REJECTED]: Object.freeze([]),
  [APPLICATION_STATUS.WITHDRAWN]: Object.freeze([]),
});

export const APPLICATION_TRANSITION_RESULT = Object.freeze({
  invite: APPLICATION_STATUS.SCREENING,
  hire: APPLICATION_STATUS.HIRED,
  reject: APPLICATION_STATUS.REJECTED,
  withdraw: APPLICATION_STATUS.WITHDRAWN,
});

/** Which transitions belong to which side. Enforced in marketplace.js. */
export const APPLICATION_ACTOR = Object.freeze({
  invite: 'company',
  hire: 'company',
  reject: 'company',
  withdraw: 'freelancer',
});

export const INVOICE_DIRECTION = Object.freeze({
  TO_CLIENT: 'to_client',
  SELF_BILLED_TO_FREELANCER: 'self_billed_to_freelancer',
});

/** Every action name that may appear in an AuditEvent. Spec §3. */
export const AUDIT_ACTION = Object.freeze({
  MAGIC_LINK_REQUESTED: 'magic_link.requested',
  MAGIC_LINK_CONSUMED: 'magic_link.consumed',
  SIGNED_OUT: 'session.signed_out',
  PERIOD_OPENED: 'period.opened',
  PERIOD_DRAFT_SAVED: 'period.draft_saved',
  PERIOD_SUBMITTED: 'period.submitted',
  PERIOD_APPROVED: 'period.approved',
  PERIOD_REJECTED: 'period.rejected',
  PERIOD_VERSION_CREATED: 'period.version_created',

  PROJECT_CREATED: 'project.created',
  PROJECT_UPDATED: 'project.updated',
  PROJECT_PUBLISHED: 'project.published',
  PROJECT_CLOSED: 'project.closed',
  PROJECT_FILLED: 'project.filled',

  APPLICATION_SUBMITTED: 'application.submitted',
  APPLICATION_WITHDRAWN: 'application.withdrawn',
  APPLICATION_INVITED: 'application.invited',
  APPLICATION_SCREENING_CONFIRMED: 'application.screening_confirmed',
  APPLICATION_REJECTED: 'application.rejected',
  APPLICATION_HIRED: 'application.hired',

  PROFILE_UPDATED: 'profile.updated',
  PROFILE_IMPORTED_FROM_CV: 'profile.imported_from_cv',
  ASSIGNMENT_CREATED_FROM_HIRE: 'assignment.created_from_hire',

  ACCOUNT_CREATED: 'account.created',
  ORGANIZATION_CREATED: 'organization.created',
  ORGANIZATION_JOINED: 'organization.joined',
});

/**
 * Fields a Project posting may carry.
 *
 * COMPLIANCE — see docs/compliance.md, "Indicative scope on a posting".
 * `indicative_hours_per_week` is commercial scoping on a *pitch*, which is
 * ordinary in Dutch freelance contracting: nobody can decide whether to apply
 * without knowing the size of the engagement.
 *
 * It is fenced in three ways: it never copies onto an Assignment, nothing
 * validates submitted hours against it, and a test asserts both. The moment it
 * reaches a running assignment it stops being a scope estimate and becomes an
 * expected-hours field, which spec §6 forbids.
 */
export const ALLOWED_PROJECT_FIELDS = Object.freeze([
  'id', 'organization_id', 'created_by', 'title', 'description',
  'client_rate_per_hour', 'freelancer_rate_per_hour',
  'indicative_hours_per_week', 'start_date', 'duration_months',
  'location', 'remote_policy', 'status', 'created_at', 'published_at',
]);

/**
 * Fields an Assignment may never acquire, asserted by the test suite.
 * The first two are the ones the marketplace makes tempting to copy across.
 */
export const FORBIDDEN_ASSIGNMENT_FIELDS = Object.freeze([
  'indicative_hours_per_week', 'expected_hours_per_week', 'schedule',
  'roster', 'working_days', 'core_hours', 'reports_to',
]);

/**
 * A structured freelancer profile. Spec §1 excluded these; they were added
 * deliberately for the marketplace. §6 then applies: the profile is visible to
 * a company only through an application the freelancer chose to send, unless
 * `outreach_consent` is true. There is no company-facing profile search.
 */
export const ALLOWED_PROFILE_FIELDS = Object.freeze([
  'user_id', 'headline', 'bio', 'skills', 'years_experience',
  'rate_expectation_per_hour', 'available_from', 'location',
  'languages', 'cv_file', 'website_url', 'updated_at',
]);

/**
 * Statuses in which a period is editable by the freelancer.
 * Spec §3: "Nothing is editable once `submitted`."
 */
export const EDITABLE_STATUSES = Object.freeze([
  PERIOD_STATUS.DRAFT,
]);

/**
 * Statuses that carry a decision from the approver.
 */
export const DECIDED_STATUSES = Object.freeze([
  PERIOD_STATUS.APPROVED,
  PERIOD_STATUS.REJECTED,
]);

/**
 * The one and only legal transition table. Spec §3.
 *
 *   draft ──submit──> submitted ──approve──> approved ──invoice──> invoiced ──> paid
 *                         │
 *                         └──reject──> rejected ──(new version)──> draft
 *
 * `rejected` has no outgoing transition on the same row: a rejection never
 * mutates the submitted version, it creates a successor (see rules.js).
 */
export const TRANSITIONS = Object.freeze({
  [PERIOD_STATUS.DRAFT]: Object.freeze(['submit']),
  [PERIOD_STATUS.SUBMITTED]: Object.freeze(['approve', 'reject']),
  [PERIOD_STATUS.REJECTED]: Object.freeze([]),
  [PERIOD_STATUS.APPROVED]: Object.freeze(['invoice']),
  [PERIOD_STATUS.INVOICED]: Object.freeze(['mark_paid']),
  [PERIOD_STATUS.PAID]: Object.freeze([]),
});

export const TRANSITION_RESULT = Object.freeze({
  submit: PERIOD_STATUS.SUBMITTED,
  approve: PERIOD_STATUS.APPROVED,
  reject: PERIOD_STATUS.REJECTED,
  invoice: PERIOD_STATUS.INVOICED,
  mark_paid: PERIOD_STATUS.PAID,
});

/**
 * Fields a TimeEntry is permitted to carry.
 *
 * COMPLIANCE — spec §6. Hours per day only. No start time, no end time, no
 * break, no location, no activity description. Adding a field here is a
 * Wet DBA regression, not a usability improvement. See docs/compliance.md.
 */
export const ALLOWED_TIME_ENTRY_FIELDS = Object.freeze([
  'id', 'period_id', 'date', 'hours',
]);

/**
 * Fields that must never appear on a TimeEntry, asserted by the test suite.
 * Spec §6.
 */
export const FORBIDDEN_TIME_ENTRY_FIELDS = Object.freeze([
  'start_time', 'end_time', 'break_minutes', 'break', 'location',
  'clock_in', 'clock_out', 'activity', 'task', 'project_phase',
  'approved_by_manager', 'scheduled_hours', 'expected_hours',
]);
