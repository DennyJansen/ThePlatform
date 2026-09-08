/**
 * Supabase implementation of the data port.
 *
 * NOT YET RUN AGAINST A REAL DATABASE. Neither this file nor the six
 * migrations it depends on have been executed. Both were written from the same
 * schema, which means the first push will find mistakes in one or the other.
 * Expect a short fix loop rather than a clean start; read
 * docs/supabase-migration.md before you begin.
 *
 * Writing this file is what turned up 006-adapter-gaps.sql — six calls the
 * adapter had to make and could not, including a hire path that 004 had
 * silently broken. That is the useful part of writing a second adapter: the
 * first one can quietly assume things the schema never promised.
 *
 * Three rules this file follows, and the reasons matter more than the code:
 *
 * 1. **The database is the authority, not this file.** Every status change
 *    goes through an RPC into a security-definer function. Nothing here does
 *    `update ... set status`, because a browser that can set a status can set
 *    any status. The domain rules are still imported — to reject obvious
 *    nonsense before a round trip, and to keep the two backends refusing the
 *    same things — but they decide nothing that matters.
 *
 * 2. **The shapes match the mock exactly.** Screens were written against
 *    `PeriodView` and friends; if this returns something subtly different the
 *    bugs land in the UI, weeks later, in whichever screen nobody re-tested.
 *    `summary` is built with `buildSubmissionSummary` and totals with
 *    `clientRate`, so the two backends cannot disagree on arithmetic.
 *
 * 3. **RLS refusals are not errors to paper over.** An empty result where a
 *    row was expected usually means a policy did its job. Where that is the
 *    likely cause the code says so rather than inventing a fallback.
 */

import { DomainError, ERROR, buildSubmissionSummary } from '../../domain/rules.js';
import {
  MARKET_ERROR,
  normaliseProject,
  normaliseProfile,
  normaliseApplication,
  normaliseScreeningInvite,
  assertRejectionReason,
  profileIsComplete,
} from '../../domain/marketplace.js';
import { clientRate } from '../../domain/money.js';
import { addDays, periodKey } from '../../domain/dates.js';

const SUPABASE_VERSION = '2.45.4';
const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@'
  + SUPABASE_VERSION + '/+esm';

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/**
 * Turn whatever PostgREST hands back into a DomainError the UI can translate.
 *
 * The SQL functions `raise exception 'error.not_authorised'` and similar, and
 * those strings are already the codes in rules.js and marketplace.js — so the
 * mapping is mostly "find the code in the message". Anything else is mapped by
 * SQLSTATE, and what is left becomes the caller's fallback rather than leaking
 * a Postgres message into a screen.
 */
function toDomainError(error, fallback = ERROR.NOT_FOUND) {
  if (!error) return new DomainError(fallback, 'Unknown failure');

  const message = String(error.message || error.error_description || '');
  const embedded = message.match(/error\.[a-z_]+/);
  if (embedded) return new DomainError(embedded[0], message);

  // 42501 is insufficient_privilege: an RLS policy refused the write.
  // PGRST116 is "no rows returned" from .single(), which under RLS usually
  // means the row exists but the caller may not see it. Both are the same
  // thing to a user: you cannot do that.
  if (error.code === '42501') return new DomainError(ERROR.NOT_AUTHORISED, message);
  if (error.code === 'PGRST116') return new DomainError(ERROR.NOT_FOUND, message);
  if (error.code === '23505') return new DomainError(MARKET_ERROR.ALREADY_APPLIED, message);

  return new DomainError(fallback, message);
}

/** Unwrap a PostgREST result, throwing a DomainError on failure. */
function unwrap(result, fallback) {
  if (result.error) throw toDomainError(result.error, fallback);
  return result.data;
}

/**
 * `numeric` comes back from PostgREST as a string. Hours are used in
 * arithmetic everywhere downstream, so coerce at the boundary rather than
 * discovering '7.25' + '8' === '7.258' in a total three screens later.
 */
function hoursOf(rows) {
  return (rows || []).reduce((sum, r) => sum + Number(r.hours), 0);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------ *
 * Row shapes
 * ------------------------------------------------------------------ */

const ASSIGNMENT_COLUMNS = `
  id, title, freelancer_id, organization_id, approver_id,
  agreed_rate_per_hour, client_fee_per_hour, freelancer_fee_per_hour,
  fixed_fee_amount, fixed_fee_payer, fixed_fee_charged_at, hour_increment,
  start_date, end_date, status, contract_pdf,
  approval_window_days, auto_approve_enabled,
  source_project_id, source_application_id, created_at
`;

const PERIOD_COLUMNS = `
  id, assignment_id, year, month, version, supersedes_id, status,
  submitted_at, decided_at, decided_by, rejection_comment, created_at
`;

function toSession(row) {
  if (!row) return null;
  return {
    user_id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    organization_id: row.organization_id,
    membership_status: row.membership_status || 'active',
    issued_at: row.created_at,
    // Supabase manages token lifetime and refresh. There is no app-level
    // expiry to report, and inventing one here would be a second clock that
    // disagrees with the real one.
    expires_at: null,
  };
}

/* ------------------------------------------------------------------ */

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

  const { createClient } = await import(/* @vite-ignore */ SUPABASE_ESM);

  const sb = createClient(settings.url, settings.anonKey, {
    auth: {
      // Supabase returns its tokens in the URL fragment, and this app uses the
      // fragment for routing. detectSessionInUrl consumes them; the awaited
      // getSession below makes sure that has happened, and stripAuthFragment
      // clears what is left — otherwise a magic link lands the user on
      // "#access_token=..." and the router treats it as an unknown route.
      //
      // This is why createSupabaseAdapter is awaited in boot() before the
      // router is started. Do not move that.
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
      flowType: 'pkce',
    },
  });

  await sb.auth.getSession();
  stripAuthFragment();

  function stripAuthFragment() {
    const hash = window.location.hash || '';
    if (/access_token=|error_description=|type=(magiclink|recovery|signup)/.test(hash)) {
      window.history.replaceState(
        null, '', window.location.pathname + window.location.search + '#/',
      );
    }
  }

  /** The signed-in user's app_users row, or null. */
  async function me() {
    const { data: auth } = await sb.auth.getUser();
    if (!auth || !auth.user) return null;

    const { data, error } = await sb
      .from('app_users')
      .select('id, email, name, role, organization_id, membership_status, outreach_consent, created_at')
      .eq('id', auth.user.id)
      .maybeSingle();
    if (error) throw toDomainError(error);

    // A signed-in auth user with no app_users row means the sign-up trigger
    // did not fire — a broken migration, not a normal state. Say so, loudly,
    // rather than rendering an empty app and letting someone debug the UI.
    if (!data) {
      throw new DomainError(ERROR.NOT_AUTHORISED,
        'Signed in, but no app_users row exists. Check trg_new_auth_user in 003-signup.sql.');
    }
    return data;
  }

  async function requireMe() {
    const user = await me();
    if (!user) throw new DomainError(ERROR.NOT_AUTHORISED, 'No session');
    return user;
  }

  /**
   * Assemble the same object buildPeriodView returns in the mock. One place,
   * so F2 and C1 cannot drift apart on what "the period" means.
   */
  async function buildPeriodView(periodId) {
    const period = unwrap(await sb.from('timesheet_periods')
      .select(PERIOD_COLUMNS).eq('id', periodId).single());

    const assignment = unwrap(await sb.from('assignments')
      .select(ASSIGNMENT_COLUMNS).eq('id', period.assignment_id).single());

    const [organization, freelancer, approver, entries, charges, siblings] = await Promise.all([
      sb.from('organizations').select('*').eq('id', assignment.organization_id).maybeSingle(),
      sb.from('app_users').select('id, name, email').eq('id', assignment.freelancer_id).maybeSingle(),
      assignment.approver_id
        ? sb.from('app_users').select('id, name, email').eq('id', assignment.approver_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      sb.from('time_entries').select('date, hours').eq('period_id', periodId).order('date'),
      sb.from('additional_charges').select('*').eq('period_id', periodId),
      sb.from('timesheet_periods').select(PERIOD_COLUMNS)
        .eq('assignment_id', period.assignment_id)
        .eq('year', period.year).eq('month', period.month)
        .neq('id', periodId).order('version'),
    ]);

    const entryRows = (unwrap(entries) || [])
      .map((e) => ({ date: e.date, hours: Number(e.hours) }));

    const history = await Promise.all((unwrap(siblings) || []).map(async (p) => ({
      id: p.id,
      version: p.version,
      status: p.status,
      submitted_at: p.submitted_at,
      decided_at: p.decided_at,
      rejection_comment: p.rejection_comment,
      total_hours: hoursOf(unwrap(await sb.from('time_entries')
        .select('hours').eq('period_id', p.id))),
    })));

    const chargeRows = unwrap(charges) || [];

    return {
      period,
      assignment,
      organization: unwrap(organization),
      freelancer: unwrap(freelancer),
      approver: unwrap(approver),
      entries: entryRows,
      charges: chargeRows,
      history,
      summary: buildSubmissionSummary(period, entryRows, assignment, chargeRows),
      // Spec §7: only surface a due date when something happens on it.
      due_date: period.submitted_at && assignment.approval_window_days
        ? addDays(period.submitted_at, assignment.approval_window_days)
        : null,
      due_date_is_binding: !!assignment.auto_approve_enabled,
    };
  }

  /** Where the magic link should land. Must be an allowed Redirect URL. */
  function redirectTo() {
    return window.location.origin + window.location.pathname + '#/';
  }

  const adapter = {
    isMock: false,
    isPersistent: () => true,

    /* ---------------- Auth ---------------- */

    /**
     * Sign in. Returns delivery:'email' and NO token — the sign-in screen
     * branches on that and shows "check your email" without a link.
     *
     * `shouldCreateUser: false` so signing in cannot silently create an
     * account. Supabase's error for an unknown address is swallowed on
     * purpose: telling a public form whether an address is registered is the
     * enumeration oracle the mock adapter is careful to avoid, and it would be
     * strange to be careful there and careless here.
     */
    async requestMagicLink(email) {
      const address = String(email || '').trim().toLowerCase();
      await sb.auth.signInWithOtp({
        email: address,
        options: { shouldCreateUser: false, emailRedirectTo: redirectTo() },
      });
      return { delivery: 'email', email: address, token: null, expires_at: null };
    },

    /**
     * Not used by this backend — Supabase consumes the token on the redirect
     * and detectSessionInUrl has already run by the time the app boots. It
     * exists because the port declares it, and returns the session so a caller
     * that does invoke it gets something sensible rather than a throw.
     */
    async consumeMagicLink() {
      return toSession(await requireMe());
    },

    /**
     * Sign-up. The metadata in options.data is read by trg_new_auth_user,
     * which creates the app_users row and, for a company, the organisation.
     *
     * That trigger CLAMPS `role`. This metadata is written by a browser, so a
     * signer-up can put "ops" in it; the clamp is the only thing between a
     * public sign-up form and privilege escalation. See the warning at the top
     * of 003-signup.sql before changing either side.
     */
    async signUpFreelancer(input) {
      const address = String(input.email || '').trim().toLowerCase();
      const { error } = await sb.auth.signInWithOtp({
        email: address,
        options: {
          shouldCreateUser: true,
          emailRedirectTo: redirectTo(),
          data: {
            role: 'freelancer',
            name: input.name,
            kvk_number: input.kvk_number,
            outreach_consent: input.outreach_consent === true,
          },
        },
      });
      if (error) throw toDomainError(error);
      return {
        delivery: 'email', email: address, token: null, expires_at: null,
        joined_existing: false, organization_name: null,
      };
    },

    async signUpCompany(input) {
      const address = String(input.email || '').trim().toLowerCase();
      const org = input.organization || input;
      const { error } = await sb.auth.signInWithOtp({
        email: address,
        options: {
          shouldCreateUser: true,
          emailRedirectTo: redirectTo(),
          data: {
            role: 'company_admin',
            name: input.name,
            company_name: org.name || input.company_name,
            kvk_number: org.kvk_number || input.kvk_number,
            vat_number: org.vat_number || input.vat_number,
            website: org.website || input.website,
          },
        },
      });
      if (error) throw toDomainError(error);
      // Whether they joined an existing organisation is decided by the
      // trigger, after this returns — and saying so here would leak whether a
      // given KvK number is already on the platform. They find out on their
      // first sign-in, from membership_status.
      return {
        delivery: 'email', email: address, token: null, expires_at: null,
        joined_existing: false, organization_name: null,
      };
    },

    async getSession() {
      const { data: auth } = await sb.auth.getSession();
      if (!auth || !auth.session) return null;
      return toSession(await me());
    },

    async signOut() {
      const { error } = await sb.auth.signOut();
      if (error) throw toDomainError(error);
    },

    /* ---------------- Membership ---------------- */

    async listPendingMembers() {
      const user = await requireMe();
      if (!user.organization_id) return [];
      return unwrap(await sb.from('app_users')
        .select('id, name, email, created_at')
        .eq('organization_id', user.organization_id)
        .eq('membership_status', 'pending')
        .order('created_at')) || [];
    },

    /** decision: 'active' to let them in, 'declined' to refuse. */
    async decideMember(memberId, decision) {
      unwrap(await sb.rpc('decide_member', {
        p_member: memberId, p_decision: decision,
      }), MARKET_ERROR.NOT_AUTHORISED);
      return adapter.listPendingMembers();
    },

    /* ---------------- Assignments ---------------- */

    async listAssignments() {
      // RLS scopes this to assignments the caller is a party to, so there is
      // no role filter here — and there should not be one. A filter in the
      // client would look like the security boundary without being it.
      const rows = unwrap(await sb.from('assignments')
        .select(ASSIGNMENT_COLUMNS
          + ', organizations(name)'
          + ', app_users!assignments_freelancer_id_fkey(name)')
        .order('created_at', { ascending: false })) || [];

      return Promise.all(rows.map(async (a) => {
        const settled = unwrap(await sb.from('timesheet_periods')
          .select('id').eq('assignment_id', a.id)
          .in('status', ['approved', 'invoiced', 'paid'])) || [];

        let hours = 0;
        for (const period of settled) {
          hours += hoursOf(unwrap(await sb.from('time_entries')
            .select('hours').eq('period_id', period.id)));
        }
        const total = round2(hours);

        return {
          ...a,
          organization_name: a.organizations ? a.organizations.name : null,
          freelancer_name: a.app_users ? a.app_users.name : null,
          hours_to_date: total,
          spend_to_date: Math.round(
            total * clientRate(a.agreed_rate_per_hour, a.client_fee_per_hour),
          ),
        };
      }));
    },

    async getAssignment(id) {
      const assignment = unwrap(await sb.from('assignments')
        .select(ASSIGNMENT_COLUMNS).eq('id', id).single());

      const [organization, freelancer, approver] = await Promise.all([
        sb.from('organizations').select('*').eq('id', assignment.organization_id).maybeSingle(),
        sb.from('app_users').select('id, name, email').eq('id', assignment.freelancer_id).maybeSingle(),
        assignment.approver_id
          ? sb.from('app_users').select('id, name, email').eq('id', assignment.approver_id).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);

      return {
        ...assignment,
        organization: unwrap(organization),
        freelancer: unwrap(freelancer),
        approver: unwrap(approver),
      };
    },

    /* ---------------- Periods ---------------- */

    /**
     * The current version of one month, creating it if ops has not opened it.
     *
     * There is no insert policy on timesheet_periods and there must not be
     * one, so the row comes from open_period() — see 006-adapter-gaps.sql.
     */
    async openPeriod(assignmentId, year, month) {
      const period = unwrap(await sb.rpc('open_period', {
        p_assignment: assignmentId, p_year: year, p_month: month,
      }));
      return buildPeriodView(period.id);
    },

    getPeriod(periodId) {
      return buildPeriodView(periodId);
    },

    /**
     * Reverse-chronological list of months for F3 and C2. One row per month,
     * showing the version that counts, with earlier versions summarised.
     */
    async listPeriods(assignmentId) {
      const assignment = unwrap(await sb.from('assignments')
        .select('agreed_rate_per_hour, client_fee_per_hour')
        .eq('id', assignmentId).single());

      const rows = unwrap(await sb.from('timesheet_periods')
        .select(PERIOD_COLUMNS).eq('assignment_id', assignmentId)
        .order('version', { ascending: false })) || [];

      // Highest version per month wins; the rest are counted, not shown.
      const byMonth = new Map();
      for (const p of rows) {
        const key = periodKey(p.year, p.month);
        if (!byMonth.has(key)) byMonth.set(key, { live: p, versions: 0 });
        byMonth.get(key).versions += 1;
      }

      const months = [...byMonth.entries()].sort((a, b) => b[0] - a[0]);

      return Promise.all(months.map(async ([, { live, versions }]) => {
        const hours = round2(hoursOf(unwrap(await sb.from('time_entries')
          .select('hours').eq('period_id', live.id))));
        const invoice = unwrap(await sb.from('invoices')
          .select('pdf').eq('period_id', live.id).limit(1));

        return {
          period_id: live.id,
          year: live.year,
          month: live.month,
          version: live.version,
          versions,
          status: live.status,
          submitted_at: live.submitted_at,
          decided_at: live.decided_at,
          rejection_comment: live.rejection_comment,
          total_hours: hours,
          client_total: Math.round(hours * clientRate(
            assignment.agreed_rate_per_hour, assignment.client_fee_per_hour,
          )),
          invoice_pdf: invoice && invoice[0] ? invoice[0].pdf : null,
        };
      }));
    },

    async listAwaitingDecision() {
      // read_own_periods already limits this to assignments the caller
      // approves for, so "submitted" is the whole filter.
      const rows = unwrap(await sb.from('timesheet_periods')
        .select('id').eq('status', 'submitted')
        .order('submitted_at')) || [];
      return Promise.all(rows.map((p) => buildPeriodView(p.id)));
    },

    /* ---------------- Transitions ---------------- */

    /**
     * The one write a browser is allowed to make directly.
     *
     * write_draft_entries permits it only while the period is `draft` and the
     * caller is its freelancer, which is safe in a way that letting the same
     * browser set a status never would be. Delete-then-insert rather than a
     * diff: the policy re-checks on every row, so a locked period rejects the
     * delete and nothing is lost.
     */
    async saveDraft(periodId, entries) {
      const del = await sb.from('time_entries').delete().eq('period_id', periodId);
      if (del.error) throw toDomainError(del.error, ERROR.PERIOD_LOCKED);

      const rows = (entries || [])
        .filter((e) => Number(e.hours) > 0)
        .map((e) => ({ period_id: periodId, date: e.date, hours: e.hours }));

      if (rows.length > 0) {
        const ins = await sb.from('time_entries').insert(rows);
        if (ins.error) throw toDomainError(ins.error, ERROR.PERIOD_LOCKED);
      }
      return buildPeriodView(periodId);
    },

    async submitPeriod(periodId) {
      unwrap(await sb.rpc('submit_period', { p_period: periodId }));
      return buildPeriodView(periodId);
    },

    async approvePeriod(periodId) {
      unwrap(await sb.rpc('approve_period', { p_period: periodId }));
      return buildPeriodView(periodId);
    },

    /**
     * Rejection never mutates a row; reject_period inserts a successor draft
     * pre-filled with the same hours, and returns it. The freelancer lands on
     * the new version with the comment attached, which is the whole point.
     */
    async rejectPeriod(periodId, comment) {
      const successor = unwrap(await sb.rpc('reject_period', {
        p_period: periodId, p_comment: comment,
      }));
      return buildPeriodView(successor.id);
    },

    /* ---------------- Audit ---------------- */

    /**
     * Via a definer function, not a join: the actor of an approval is in the
     * client's organisation, and read_org_members would hide their name from
     * the freelancer. See note 4 in 006-adapter-gaps.sql.
     */
    async listAuditEvents(assignmentId) {
      return unwrap(await sb.rpc('audit_for_assignment', {
        p_assignment: assignmentId,
      })) || [];
    },

    /* ---------------- Marketplace: projects ---------------- */

    /**
     * Reads project_board, never projects. Freelancers have no select policy
     * on the table at all — the view is the one door.
     */
    async listOpenProjects() {
      const user = await requireMe();
      const rows = unwrap(await sb.from('project_board')
        .select('*, organizations(name)')
        .order('published_at', { ascending: false })) || [];

      const mine = unwrap(await sb.from('applications')
        .select('project_id').eq('freelancer_id', user.id)
        .neq('status', 'withdrawn')) || [];
      const applied = new Set(mine.map((a) => a.project_id));

      return rows.map((p) => ({
        ...p,
        organization_name: p.organizations ? p.organizations.name : null,
        has_applied: applied.has(p.id),
      }));
    },

    async getProject(projectId) {
      const user = await requireMe();

      // A company reads its own row from `projects`, at any status. Everyone
      // else gets the board view, which is open projects only — so a
      // freelancer following a link to a closed project gets not_found, the
      // same answer the mock gives.
      let project = null;
      let isOwner = false;

      const owned = await sb.from('projects').select('*').eq('id', projectId).maybeSingle();
      if (!owned.error && owned.data) {
        project = owned.data;
        isOwner = true;
      } else {
        project = unwrap(await sb.from('project_board')
          .select('*').eq('id', projectId).single(), MARKET_ERROR.NOT_FOUND);
      }

      const [organization, mine, count] = await Promise.all([
        sb.from('organizations').select('*').eq('id', project.organization_id).maybeSingle(),
        sb.from('applications').select('*').eq('project_id', projectId)
          .eq('freelancer_id', user.id).neq('status', 'withdrawn').maybeSingle(),
        isOwner
          ? sb.from('applications').select('id', { count: 'exact', head: true })
            .eq('project_id', projectId)
          : Promise.resolve({ count: null, error: null }),
      ]);

      return {
        project,
        organization: unwrap(organization),
        is_owner: isOwner,
        my_application: unwrap(mine),
        application_count: count.error ? null : count.count,
      };
    },

    /** Every project belonging to the caller's organisation, any status. */
    async listCompanyProjects() {
      const rows = unwrap(await sb.from('projects')
        .select('*').order('created_at', { ascending: false })) || [];

      return Promise.all(rows.map(async (p) => {
        const apps = unwrap(await sb.from('applications')
          .select('status').eq('project_id', p.id)) || [];
        return {
          ...p,
          application_count: apps.length,
          new_count: apps.filter((a) => a.status === 'submitted').length,
          screening_count: apps.filter((a) => a.status === 'screening').length,
        };
      }));
    },

    /**
     * normaliseProject runs here as well as in the mock so the two backends
     * refuse the same input with the same code. The table constraints are the
     * real guard; this one just gives a better message than a 23514.
     */
    async saveProject(projectId, input) {
      const user = await requireMe();
      const fields = normaliseProject(input);

      const saved = projectId
        ? unwrap(await sb.from('projects').update(fields).eq('id', projectId)
          .select('id').single(), MARKET_ERROR.NOT_AUTHORISED)
        : unwrap(await sb.from('projects').insert({
          ...fields,
          organization_id: user.organization_id,
          created_by: user.id,
          status: 'draft',
        }).select('id').single(), MARKET_ERROR.NOT_AUTHORISED);

      return adapter.getProject(saved.id);
    },

    /**
     * publish | close | fill.
     *
     * The legality of the move is enforced by trg_project_transition, added
     * in 006 — company_writes_own_projects is a `for all` policy, so without
     * that trigger a company could PATCH any status onto its own project and
     * the two backends would disagree about what is possible.
     */
    async transitionProject(projectId, action) {
      const next = { publish: 'open', close: 'closed', fill: 'filled' }[action];
      if (!next) {
        throw new DomainError(MARKET_ERROR.ILLEGAL_TRANSITION, 'Unknown action ' + action);
      }
      unwrap(await sb.from('projects').update({ status: next })
        .eq('id', projectId).select('id').single(), MARKET_ERROR.ILLEGAL_TRANSITION);
      return adapter.getProject(projectId);
    },

    /* ---------------- Marketplace: profile ---------------- */

    async getMyProfile() {
      const user = await requireMe();
      const profile = unwrap(await sb.from('freelancer_profiles')
        .select('*').eq('user_id', user.id).maybeSingle());

      return {
        profile,
        complete: profileIsComplete(profile),
        outreach_consent: !!user.outreach_consent,
      };
    },

    async saveMyProfile(input) {
      const user = await requireMe();
      unwrap(await sb.from('freelancer_profiles').upsert({
        user_id: user.id,
        ...normaliseProfile(input),
        updated_at: new Date().toISOString(),
      }), MARKET_ERROR.NOT_AUTHORISED);
      return adapter.getMyProfile();
    },

    /**
     * Via a function, not an update. There is no update policy on app_users
     * and a general one would let anybody set their own role — see note 3 in
     * 006-adapter-gaps.sql.
     */
    async setOutreachConsent(consent) {
      unwrap(await sb.rpc('set_outreach_consent', { p_consent: !!consent }));
      return adapter.getMyProfile();
    },

    /* ---------------- Marketplace: applications ---------------- */

    async applyToProject(projectId, input) {
      const user = await requireMe();
      const fields = normaliseApplication(input);

      const project = unwrap(await sb.from('project_board')
        .select('organization_id').eq('id', projectId).single(),
      MARKET_ERROR.PROJECT_NOT_OPEN);

      const created = unwrap(await sb.from('applications').insert({
        project_id: projectId,
        freelancer_id: user.id,
        organization_id: project.organization_id,
        ...fields,
      }).select('id').single(), MARKET_ERROR.NOT_AUTHORISED);

      return { id: created.id };
    },

    /**
     * Via a definer function. A freelancer has no select policy on `projects`
     * — they read the board — and the board is open projects only, so a plain
     * join would blank the title of anything they applied to that has since
     * been filled. See note 5 in 006-adapter-gaps.sql.
     */
    async listMyApplications() {
      return unwrap(await sb.rpc('my_applications')) || [];
    },

    /**
     * The applicants for one project, each with the profile that came with the
     * application.
     *
     * A null `profile` on a rejected or withdrawn row is the rule working, not
     * a missing record: 005 keeps a profile open only while an application is
     * live. Do not add a fallback that fetches it another way.
     */
    async listApplicationsForProject(projectId) {
      const project = unwrap(await sb.from('projects')
        .select('*').eq('id', projectId).single(), MARKET_ERROR.NOT_AUTHORISED);

      const applications = unwrap(await sb.rpc('applications_for_project', {
        p_project: projectId,
      })) || [];

      return { project, applications };
    },

    async withdrawApplication(applicationId) {
      unwrap(await sb.rpc('withdraw_application', { p_application: applicationId }));
      return adapter.listMyApplications();
    },

    async inviteToScreening(applicationId, input) {
      const fields = normaliseScreeningInvite(input);
      const updated = unwrap(await sb.rpc('invite_to_screening', {
        p_application: applicationId,
        p_manager: fields.hiring_manager_name,
        p_note: fields.screening_note,
        p_slots: fields.screening_slots,
      }));
      return adapter.listApplicationsForProject(updated.project_id);
    },

    /** Freelancer picks one of the offered times. */
    async confirmScreeningSlot(applicationId, slot) {
      unwrap(await sb.rpc('confirm_screening_slot', {
        p_application: applicationId, p_slot: slot,
      }));
      return adapter.listMyApplications();
    },

    async rejectApplication(applicationId, reason) {
      const updated = unwrap(await sb.rpc('reject_application', {
        p_application: applicationId, p_reason: assertRejectionReason(reason),
      }));
      return adapter.listApplicationsForProject(updated.project_id);
    },

    /**
     * Hire. Produces a PENDING assignment and marks the project filled.
     *
     * Pending, not active: a screening call is an agreement in principle, and
     * spec §8 lists nine contract clauses the rest of the system assumes
     * exist. Ops sets the final rates, names the approver and uploads the
     * signed agreement before anything can be billed against it — which
     * active_needs_approver enforces rather than trusts.
     */
    async hireApplicant(applicationId) {
      const assignment = unwrap(await sb.rpc('hire_applicant', {
        p_application: applicationId,
      }));
      return {
        project_id: assignment.source_project_id,
        assignment_id: assignment.id,
      };
    },

    /* ---------------- Demo controls ---------------- */

    /** There is no demo data to reset against a real database. */
    resetDemoData: () => Promise.resolve(),
  };

  return adapter;
}
