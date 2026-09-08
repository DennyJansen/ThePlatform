# From demo to something a placement can run on

The mock adapter is a walkthrough. This is the work between it and a system the
first real placement can go through.

Nothing in `src/ui/` changes. The migration is: create the database, implement
the adapter methods, flip one flag in `src/config.js`.

---

## 1. Create the project and the schema

1. Create a Supabase project in an EU region — the data is Dutch personal and
   financial data and there is no reason for it to leave the EU.
2. Run `src/data/supabase/schema.sql` in the SQL editor, once, whole.
   Then, **in order, no skipping**:
   `002-marketplace.sql` (projects, applications, profiles, the
   `project_board` view), `003-signup.sql` (self-service sign-up),
   `004-agreed-rate.sql` (one agreed rate, two fees),
   `005-membership-and-kvk.sql` (organisation membership, KvK on both sides),
   `006-adapter-gaps.sql` (what writing the adapter turned up).

   Read the warning at the top of 003 before running it: sign-up metadata
   comes from the browser, and the role clamp in that trigger is what stops
   someone signing themselves up as ops.

   **006 is not optional and it is not cleanup.** Among other things it
   repairs `hire_applicant`, which has referenced three columns that 004
   dropped ever since 004 was written. Running 001–005 and stopping gives you
   a database where hiring fails on the first attempt with "column does not
   exist". Nothing warns you: a plpgsql body is not checked until it runs.

### Expect the first run to fail somewhere

Everything in this directory was written against the schema rather than
against a running Postgres. Nothing here has ever been executed. The failures
to expect are the boring kind — a column order, a missing cast, an enum value
added in the same transaction it is used in (Postgres refuses that; if
`alter type ... add value` bites, run it in its own statement first).

Work through them in order and keep the fixes in the migration files rather
than in the SQL editor, or the next environment starts from the same place
this one did.

The file creates the tables, the constraints that encode the spec's rules, the
row-level security policies, and three security-definer functions —
`submit_period`, `approve_period`, `reject_period` — which are the *only* way a
period changes status.

Read the RLS section before running it. The important shape:

- **Reads** are scoped by `is_party_to(assignment_id)`: a freelancer sees their
  own assignment, an approver sees the one they are named on within their own
  organisation, ops sees everything.
- **Writes** have exactly one permissive policy, `write_draft_entries`, which
  lets a freelancer edit `time_entries` *only while the period is `draft`*.
- There is **no** insert/update/delete policy on `timesheet_periods`,
  `invoices` or `audit_events`. With RLS enabled and no policy, every direct
  write from a browser is refused. Absence is the policy.

Verify it before trusting it. In the SQL editor, impersonating a freelancer:

```sql
-- should return 0 rows, not an error and not someone else's assignment
select * from assignments where freelancer_id <> auth.uid();

-- should be refused
update timesheet_periods set status = 'approved' where id = '<a period id>';

-- should be refused
delete from audit_events;
```

## 2. Seed the first assignment

There is no ops UI in v1, by design (spec §1). Use the table editor:

1. Create the user in **Authentication → Users** (invite by email), then insert
   the matching `app_users` row with the same `id` and the right `role`.
   The `id` must equal `auth.users.id` — that is what makes `auth.uid()` work.
2. Insert the client `organizations` row.
3. Insert the `assignments` row. Rates are **integer cents**: €95.00/hour is
   `9500`. Set `agreed_rate_per_hour` and the two fees; the invoiced rates are
   derived. The `rates_coherent` constraint refuses an incoherent set.
4. Leave `auto_approve_enabled` false (spec §7).

## 3. The adapter

`src/data/supabase/supabaseAdapter.js` is written. All 35 port methods, against
a pinned CDN build of supabase-js — there is no bundler:

```js
const { createClient } = await import(
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
```

It has never talked to a database. Read it as a first draft that has been
checked for internal consistency and nothing else.

The shape, if you are changing it:

| Port method | Implementation |
|---|---|
| `requestMagicLink` | `auth.signInWithOtp`, `shouldCreateUser: false` → `{ delivery: 'email' }` and **no token** |
| `consumeMagicLink` | not called — Supabase consumes the redirect before the app boots |
| `signUpFreelancer` / `signUpCompany` | `signInWithOtp` with `shouldCreateUser: true` and metadata the trigger reads |
| `getSession` / `signOut` | `auth.getSession()` / `auth.signOut()` |
| `listAssignments` / `getAssignment` | plain selects; RLS does the scoping |
| `openPeriod` | `rpc('open_period', …)` — there is no insert policy, by design |
| `getPeriod` / `listPeriods` | selects, joined into the `PeriodView` the mock returns |
| `saveDraft` | delete + insert on `time_entries`; the one direct browser write |
| `submitPeriod` / `approvePeriod` / `rejectPeriod` | `rpc(…)` into the definer functions |
| `listAuditEvents` | `rpc('audit_for_assignment')` — a join cannot read the other party's name |
| `listMyApplications` / `listApplicationsForProject` | `rpc(…)`, same reason |
| `setOutreachConsent` | `rpc('set_outreach_consent')` — no update policy on `app_users` |

Three things to keep right if you touch it:

- **Return the same shapes the mock does.** The screens depend on them. The
  `summary` field is built with `buildSubmissionSummary` from
  `src/domain/rules.js`, not recomputed, so the frontend and the SQL agree by
  construction rather than by coincidence. Totals go through `clientRate` for
  the same reason.
- **Map Postgres errors to domain codes.** The SQL functions raise
  `error.not_authorised`, `error.illegal_transition`, `error.no_hours`,
  `error.comment_required`. Those strings are already the `ERROR` codes in
  `rules.js`, so the mapping is: read `err.message`, and if it contains an
  `error.` code, wrap it in a `DomainError`. The UI translates it with no
  further work.
- **Never set a status directly.** One exception exists — project transitions,
  because `company_writes_own_projects` is a `for all` policy — and 006 adds a
  trigger so the database still decides which moves are legal. A test asserts
  there is exactly one such write in the file.

`src/test/supabase.js` checks that the adapter and the migrations agree about
what exists: every table, view and function named in the adapter is looked for
in the SQL. It cannot tell you whether a policy allows a read or whether a
function body compiles — only a real database can — but it catches the class of
mistake where the two files drift a week apart.

## 4. Flip the flag

```js
// src/config.js
backend: 'supabase',
supabase: {
  url: 'https://<project>.supabase.co',
  anonKey: '<the anon key>',
},
adminUrl: 'https://supabase.com/dashboard/project/<project>/editor',
```

The anon key is designed to be public and is safe in a public repository — it
grants nothing that RLS does not already allow. **A service-role key is not**,
and the CI job refuses to deploy if one is committed.

Set the Supabase project's **Site URL** and **Redirect URLs** to the Pages URL,
including the hash route the link should land on.

## 5. What is still missing after this

This gets the approval loop onto real infrastructure. It does not finish v1.
Remaining, in the spec's own order:

- ~~**Step 4 — invoices.**~~ **Struck.** The freelancer and the company each
  raise their own invoices in their own systems; the platform generates no
  documents and allocates no invoice numbers. See docs/open-items.md item 2b,
  including what this costs — §3's "same number by construction" becomes "same
  number if you copy it correctly".

  What remains of it is small: `invoiced` and `paid` stay as period statuses
  that ops sets against documents raised elsewhere, which is what §1 already
  said about payment. Wiring `approved → invoiced` is a one-line admin action,
  not a build step.
- **Step 5 — the seven emails.** An edge function plus a transactional sender.
  Seven. Adding an eighth means removing one.
- **Step 6 — additional charges.** The table and the separate approve/reject
  are already in the schema; the UI is not built.
- **The scheduled job for the approval window** (spec §7). Build it with
  `pg_cron`, ship it with `auto_approve_enabled` false. Enabling it is then a
  config change once the clause is in the signed terms.

## A note on what does not get built

Spec §1 names the ops console as the biggest scope risk in this build, and it
is right. One operator with one placement does not need bespoke internal
tooling. The Supabase table editor is the admin panel. When it stops being
enough, that will be obvious, and it will be obvious for a reason that can be
written down.
