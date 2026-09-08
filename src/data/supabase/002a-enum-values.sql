-- =====================================================================
-- Migration 002a — two enum values, on their own
-- Run after schema.sql and BEFORE 002-marketplace.sql.
--
-- These two lines lived at the top of 002 and could never have worked there.
--
-- Postgres will not let you USE a new enum value in the same transaction
-- that added it. The Supabase SQL editor runs each query as one transaction,
-- so 002 added 'company_admin' on one line and then referenced it eleven
-- lines later in a check constraint, which fails with:
--
--   ERROR: unsafe use of new value "company_admin" of enum type user_role
--   HINT:  New enum values must be committed before they can be used.
--
-- The same applies to the policies and the `language sql` function further
-- down 002 — function bodies are parsed at creation time, so a literal
-- 'company_admin' in one of them is a use, not just text.
--
-- Splitting them into their own file is the fix, because a separate run is a
-- separate transaction. There is no way to express "commit here" inside a
-- single editor query, and no clever ordering that avoids it: the constraint
-- genuinely needs the value the ALTER genuinely has to add first.
--
-- IF YOU ARE USING THE CLI instead of the editor, `supabase db push` applies
-- each file in its own transaction too, so the same split is what makes it
-- work there.
-- =====================================================================

-- app_users.role gains company_admin. Separate from approver on purpose: §2's
-- approver has one narrow power and the compliance story leans on that.
alter type user_role add value if not exists 'company_admin';

-- Assignments gain a pending state. A hire produces an agreement in
-- principle; ops sets the rates, names the approver and uploads the signed
-- contract before it can go active.
alter type assignment_state add value if not exists 'pending';
