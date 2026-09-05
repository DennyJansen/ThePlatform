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
3. Insert the `assignments` row. Rates are **integer cents**: €100.00/hour is
   `10000`. The `rates_coherent` constraint refuses an incoherent set.
4. Leave `auto_approve_enabled` false (spec §7).

## 3. Implement the adapter

`src/data/supabase/supabaseAdapter.js` is a skeleton whose every method
currently rejects with `error.backend_not_implemented`. The file header lists
the mapping. In short:

| Port method | Implementation |
|---|---|
| `requestMagicLink` | `auth.signInWithOtp({ email })` → return `{ delivery: 'email' }` and **no token** |
| `consumeMagicLink` | not called — Supabase handles the redirect; `getSession` picks it up |
| `getSession` / `signOut` | `auth.getSession()` / `auth.signOut()` |
| `listAssignments` / `getAssignment` | plain selects; RLS does the scoping |
| `openPeriod` / `getPeriod` / `listPeriods` | selects, joined into the same `PeriodView` shape the mock returns |
| `listAwaitingDecision` | select where `status = 'submitted'` |
| `saveDraft` | delete + insert on `time_entries` in one transaction |
| `submitPeriod` / `approvePeriod` / `rejectPeriod` | `rpc('submit_period', …)` etc. |
| `listAuditEvents` | plain select |

Two things to get right:

- **Return the same `PeriodView` shape.** The screens depend on it. The
  `summary` field must be built with `buildSubmissionSummary` from
  `src/domain/rules.js`, not recomputed, so the frontend and the SQL agree by
  construction rather than by coincidence.
- **Map Postgres errors to domain codes.** The SQL functions raise
  `error.not_authorised`, `error.illegal_transition`, `error.no_hours`,
  `error.comment_required`. Those strings are already the `ERROR` codes in
  `rules.js`, so the mapping is: read `err.message`, and if it starts with
  `error.`, wrap it in a `DomainError` with that code. The UI then translates it
  with no further work.

The client loads from a pinned CDN build — there is no bundler:

```js
const { createClient } = await import(
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
```

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

- **Step 4 — invoices, both directions, as PDFs.** Needs the VAT treatment of
  the €2/hour deduction answered first (spec §8.9, §10). Generate in an edge
  function, store in Supabase Storage, never in the browser.
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
