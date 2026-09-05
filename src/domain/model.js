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
  ACTIVE: 'active',
  ENDED: 'ended',
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
});

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
