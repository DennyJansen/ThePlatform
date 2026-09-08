-- =====================================================================
-- Migration 004 — one agreed rate, two fees
-- Run after 003-signup.sql.
--
-- The platform is the middle man, with a contract on each side. There is a
-- single agreed rate — what the freelancer and the company shake hands on —
-- and the fees point outward from it:
--
--              freelancer fee 2.00        client fee 5.00
--         93.00  <-------------  95.00  ------------->  100.00
--   what the freelancer         the agreed          what the company
--        invoices                 rate                is invoiced
--
-- Replaces the old shape, which stored client_rate and freelancer_rate as two
-- independent columns with the spread implied between them. Two stored numbers
-- that must differ by a fee is a pair that can drift; one number and two fees
-- cannot. 95.00 is never invoiced by anybody — it is the anchor both sides
-- recognise, and the two rates that touch money are derived from it.
-- =====================================================================

/* ---------------- the board goes first ----------------
 *
 * project_board selects projects.freelancer_rate_per_hour, and Postgres
 * refuses to drop a column a view depends on:
 *
 *   ERROR: cannot drop column freelancer_rate_per_hour of table projects
 *          because other objects depend on it
 *   DETAIL: view project_board depends on column freelancer_rate_per_hour
 *
 * So the view comes down before anything is dropped and goes back up at the
 * bottom, over the new columns. `drop ... cascade` would also get past the
 * error and is worse: it would silently take anything else that had come to
 * depend on the view along with it.
 *
 * Note which way the safety net runs here. The view dependency is tracked, so
 * this failed loudly. The three FUNCTIONS that read the same columns are not
 * tracked at all — they kept compiling and would have failed on first call.
 * See section 2 and 2b of 006-adapter-gaps.sql.
 */
drop view if exists project_board;

/* ---------------- assignments ---------------- */

alter table assignments
  add column if not exists agreed_rate_per_hour int,
  add column if not exists client_fee_per_hour  int;

-- Backfill from the old columns: the agreed rate was the freelancer's rate,
-- and the client fee was the spread that sat above it.
update assignments
   set agreed_rate_per_hour = coalesce(agreed_rate_per_hour, freelancer_rate_per_hour),
       client_fee_per_hour  = coalesce(client_fee_per_hour,
                                       client_rate_per_hour - freelancer_rate_per_hour)
 where agreed_rate_per_hour is null or client_fee_per_hour is null;

alter table assignments
  alter column agreed_rate_per_hour set not null,
  alter column client_fee_per_hour  set not null;

alter table assignments drop constraint if exists rates_coherent;
alter table assignments
  add constraint rates_coherent check (
    agreed_rate_per_hour > 0
    and client_fee_per_hour >= 0
    and freelancer_fee_per_hour >= 0
    -- A freelancer fee above the agreed rate would invoice a negative amount.
    and freelancer_fee_per_hour <= agreed_rate_per_hour
  );

alter table assignments
  drop column if exists client_rate_per_hour,
  drop column if exists freelancer_rate_per_hour;

/* ---------------- projects ---------------- */

alter table projects
  add column if not exists agreed_rate_per_hour int;

update projects
   set agreed_rate_per_hour = coalesce(agreed_rate_per_hour, freelancer_rate_per_hour)
 where agreed_rate_per_hour is null;

alter table projects
  alter column agreed_rate_per_hour set not null;

alter table projects drop constraint if exists spread_is_non_negative;
alter table projects drop constraint if exists projects_client_rate_per_hour_check;
alter table projects
  add constraint agreed_rate_in_range
  check (agreed_rate_per_hour between 2000 and 50000);

alter table projects
  drop column if exists client_rate_per_hour,
  drop column if exists freelancer_rate_per_hour;

/* ---------------- the board ----------------
 *
 * The view no longer exists to conceal anything. A posting carries one rate
 * that both sides are meant to see, and the platform's fees are not
 * confidential either — a freelancer and a company may compare what each pays.
 *
 * It is kept because it is the one door a freelancer has onto projects, and
 * the place a genuinely company-only column would have to be omitted from if
 * one is ever added. It is scaffolding now, not a control.
 *
 * The matching `drop view` is further up, before the column drops — see the
 * note there for why it cannot live here.
 */
create view project_board
with (security_invoker = off) as
  select id, organization_id, title, description,
         agreed_rate_per_hour,
         indicative_hours_per_week, start_date, duration_months,
         location, remote_policy, status, published_at
  from projects
  where status = 'open';

revoke all on project_board from public;
grant select on project_board to authenticated;
