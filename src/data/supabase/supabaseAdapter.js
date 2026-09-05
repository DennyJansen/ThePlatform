/**
 * Supabase implementation of the data port.
 *
 * NOT WIRED UP YET. This build ships with CONFIG.backend = 'mock'; setting it
 * to 'supabase' loads this file and it will refuse loudly rather than half
 * work. The skeleton is here because the shape of the migration is a decision,
 * not an afterthought, and writing it down now is what keeps the mock adapter
 * from growing habits Postgres cannot honour.
 *
 * The schema and every policy it depends on are in ./schema.sql.
 *
 * What changes when this becomes the adapter:
 *
 *   - requestMagicLink   -> supabase.auth.signInWithOtp. Returns delivery:'email'
 *                           and NO token; the sign-in screen already handles
 *                           that branch.
 *   - consumeMagicLink   -> handled by Supabase on the redirect, not by us.
 *   - saveDraft          -> direct upsert on time_entries. Safe: the RLS policy
 *                           write_draft_entries only permits it while the
 *                           period is draft and the caller is its freelancer.
 *   - submit/approve/reject -> rpc() calls into the security-definer functions.
 *                           The browser cannot change a status any other way.
 *   - listAuditEvents    -> plain select; RLS scopes it to the caller's
 *                           assignments, and nothing can write it but log_audit.
 *
 * The domain rules in src/domain/rules.js stay in the frontend for rendering -
 * to grey out a button before the round trip - but they stop being the
 * authority. The SQL functions are the authority, and they duplicate the checks
 * on purpose.
 */

import { DomainError } from '../../domain/rules.js';

const NOT_IMPLEMENTED = 'error.backend_not_implemented';

function pending(method) {
  return () => Promise.reject(new DomainError(
    NOT_IMPLEMENTED,
    'supabaseAdapter.' + method + ' is not implemented yet. See docs/supabase-migration.md.',
    { method },
  ));
}

/**
 * @param {{url: string, anonKey: string}} settings
 */
export async function createSupabaseAdapter(settings) {
  if (!settings || !settings.url || !settings.anonKey) {
    throw new Error(
      'CONFIG.backend is "supabase" but CONFIG.supabase.url / anonKey are empty. '
      + 'Set them in src/config.js, or switch back to backend: "mock".',
    );
  }

  // When this is implemented, load the client from a pinned CDN build and keep
  // it out of the bundle - there is no bundler in this project by design:
  //
  //   const { createClient } = await import(
  //     'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
  //   const sb = createClient(settings.url, settings.anonKey);

  return {
    isMock: false,
    isPersistent: () => true,

    requestMagicLink: pending('requestMagicLink'),
    consumeMagicLink: pending('consumeMagicLink'),
    getSession: pending('getSession'),
    signOut: pending('signOut'),

    listAssignments: pending('listAssignments'),
    getAssignment: pending('getAssignment'),

    openPeriod: pending('openPeriod'),
    getPeriod: pending('getPeriod'),
    listPeriods: pending('listPeriods'),
    listAwaitingDecision: pending('listAwaitingDecision'),

    saveDraft: pending('saveDraft'),
    submitPeriod: pending('submitPeriod'),
    approvePeriod: pending('approvePeriod'),
    rejectPeriod: pending('rejectPeriod'),

    listAuditEvents: pending('listAuditEvents'),

    /** No demo data to reset against a real database. */
    resetDemoData: () => Promise.resolve(),
  };
}
