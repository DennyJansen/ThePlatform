/**
 * The data port.
 *
 * Every screen talks to an object shaped like this and to nothing else. Two
 * implementations exist:
 *
 *   src/data/mock/mockAdapter.js      browser-local, ships on GitHub Pages
 *   src/data/supabase/supabaseAdapter.js  Postgres + RLS + edge functions
 *
 * The point of the port is that swapping one for the other is a one-line change
 * in src/data/index.js and touches no screen. If you find yourself widening
 * this interface to expose a table or a query, stop: the screens are supposed
 * to ask for outcomes ("submit this period"), not for rows.
 *
 * Every method returns a Promise. Every method may reject with a DomainError
 * carrying a code from rules.js ERROR. Nothing here throws synchronously.
 *
 * @typedef {Object} Session
 * @property {string} user_id
 * @property {string} email
 * @property {string} name
 * @property {'freelancer'|'approver'|'ops'} role
 * @property {string|null} organization_id
 * @property {string} issued_at
 * @property {string} expires_at
 *
 * @typedef {Object} PeriodView
 * @property {Object} period       the TimesheetPeriod row
 * @property {Object} assignment   the Assignment row, rates included
 * @property {Object} organization the client Organization
 * @property {Object} freelancer   the freelancer User
 * @property {Array}  entries      TimeEntry rows, date + hours only
 * @property {Array}  charges      AdditionalCharge rows (empty in this build)
 * @property {Array}  history      earlier versions of the same month
 * @property {Object} summary      output of rules.buildSubmissionSummary
 *
 * @typedef {Object} DataAdapter
 *
 * -- Auth (spec section 4/F1: magic link only, 24h, single use) --
 * @property {(email: string) => Promise<{token: string, expires_at: string, delivery: 'email'|'on_screen'}>} requestMagicLink
 * @property {(token: string) => Promise<Session>} consumeMagicLink
 * @property {() => Promise<Session|null>} getSession
 * @property {() => Promise<void>} signOut
 *
 * -- Assignments --
 * @property {() => Promise<Array>} listAssignments        for the signed-in user
 * @property {(id: string) => Promise<Object>} getAssignment
 *
 * -- Periods --
 * @property {(assignmentId: string, year: number, month: number) => Promise<PeriodView>} openPeriod
 * @property {(periodId: string) => Promise<PeriodView>} getPeriod
 * @property {(assignmentId: string) => Promise<Array>} listPeriods
 * @property {() => Promise<Array>} listAwaitingDecision   approver inbox
 *
 * -- Transitions. All of these are authority calls: the adapter, not the
 *    caller, decides whether they are legal. --
 * @property {(periodId: string, entries: Array<{date: string, hours: number}>) => Promise<PeriodView>} saveDraft
 * @property {(periodId: string) => Promise<PeriodView>} submitPeriod
 * @property {(periodId: string) => Promise<PeriodView>} approvePeriod
 * @property {(periodId: string, comment: string) => Promise<PeriodView>} rejectPeriod
 *
 * -- Audit (spec section 3: append only, no update, no delete, ever) --
 * @property {(assignmentId: string) => Promise<Array>} listAuditEvents
 *
 * -- Diagnostics, mock only. The Supabase adapter implements these as no-ops
 *    so that the demo controls can be hidden rather than special-cased. --
 * @property {boolean} isMock
 * @property {() => Promise<void>} resetDemoData
 */

/** Method names an adapter must implement to be accepted by the app. */
export const REQUIRED_METHODS = Object.freeze([
  'requestMagicLink',
  'consumeMagicLink',
  'getSession',
  'signOut',
  'listAssignments',
  'getAssignment',
  'openPeriod',
  'getPeriod',
  'listPeriods',
  'listAwaitingDecision',
  'saveDraft',
  'submitPeriod',
  'approvePeriod',
  'rejectPeriod',
  'listAuditEvents',
]);

/**
 * Fail loudly at startup rather than at the first click if an adapter is
 * incomplete. Cheap insurance while a second implementation is being written.
 */
export function assertImplementsAdapter(candidate, label = 'adapter') {
  const missing = REQUIRED_METHODS.filter((m) => typeof candidate[m] !== 'function');
  if (missing.length > 0) {
    throw new Error(label + ' is missing: ' + missing.join(', '));
  }
  return candidate;
}
