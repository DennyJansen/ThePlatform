-- =====================================================================
-- Migration 007 — take the anon role off everything it was never meant
-- to reach
-- Run after 006-adapter-gaps.sql.
--
-- FOUND BY PROBING THE LIVE DATABASE, not by reading. Every earlier file
-- said what it meant and every earlier file was wrong about whether it had
-- said it:
--
--   revoke all on project_board from public;
--   grant select on project_board to authenticated;
--
-- That reads as "authenticated only". It is not. Supabase ships
--
--   alter default privileges in schema public
--     grant all on tables to anon, authenticated, service_role;
--
-- so `create view project_board` immediately granted SELECT to `anon` in its
-- own right. `revoke ... from PUBLIC` removes the PUBLIC grant and leaves a
-- role-specific grant alone. The two are different things, and the one that
-- mattered was never touched.
--
-- WHY THIS ONE MATTERED. project_board is `security_invoker = off`: it runs
-- as its owner and does not apply the RLS on `projects`. That is deliberate —
-- it is the one door a freelancer has, and the policies deliberately give
-- freelancers no access to the table. But a door that bypasses RLS and is
-- open to `anon` is open to the internet, because the anon key ships inside a
-- public repository and is meant to. Empty today. The first published project
-- would have been world-readable, with its rate.
--
-- THE GENERAL SHAPE, which is the part worth carrying forward: on Supabase,
-- `revoke from public` is not a security statement. `anon` is a real,
-- separately-granted role and has to be named. Anything that bypasses RLS —
-- a security_invoker=off view, a security definer function — has to say so
-- explicitly.
--
-- Tables are deliberately not touched here. `anon` keeps its SELECT grant on
-- them and RLS returns nothing, which is the design working: PostgREST needs
-- the anon role to exist before a session does.
-- =====================================================================

/* ---------------- the one RLS bypass ---------------- */

revoke all on project_board from anon;

/* ---------------- functions ----------------
 *
 * None of these is callable without a session. open_period checks
 * is_party_to, the marketplace functions check is_company_admin_for, and
 * auth.uid() is null for anon, so each already refuses.
 *
 * Revoking anyway. "It happens to check" and "it cannot be called" are
 * different guarantees, and the second one survives someone editing the first
 * check without thinking about who is on the other end.
 */
revoke all on function submit_period(uuid)                              from anon;
revoke all on function approve_period(uuid)                             from anon;
revoke all on function reject_period(uuid, text)                        from anon;
revoke all on function open_period(uuid, int, int)                      from anon;
revoke all on function log_audit(uuid, text, uuid, text, jsonb)         from anon;

revoke all on function invite_to_screening(uuid, text, text, text[])    from anon;
revoke all on function confirm_screening_slot(uuid, text)               from anon;
revoke all on function reject_application(uuid, text)                   from anon;
revoke all on function withdraw_application(uuid)                       from anon;
revoke all on function hire_applicant(uuid)                             from anon;

revoke all on function decide_member(uuid, text)                        from anon;
revoke all on function set_outreach_consent(boolean)                    from anon;
revoke all on function audit_for_assignment(uuid)                       from anon;
revoke all on function my_applications()                                from anon;
revoke all on function applications_for_project(uuid)                   from anon;

/* ---------------- the helpers are deliberately left alone ----------------
 *
 * is_ops(), is_party_to(), is_company_admin_for(), current_app_user() and
 * is_live_application() stay callable by anon. That is a decision, not an
 * oversight, and the first draft of this file got it wrong in an instructive
 * way.
 *
 * The draft revoked them from anon. It had no effect, for the reason that is
 * the mirror image of the project_board bug above: Postgres grants EXECUTE on
 * every new function to PUBLIC by default. The eleven endpoint functions each
 * carry an explicit `revoke ... from public` in their own migration, so
 * naming anon finished the job. These five never did, so anon still reaches
 * them through PUBLIC.
 *
 *   project_board:  revoked from PUBLIC, needed anon named too.
 *   the helpers:    revoked from anon, needed PUBLIC named too.
 *
 * Both grants have to go. Which raises the question of whether they should.
 *
 * WHY THEY SHOULD NOT. An RLS policy expression is evaluated with the
 * privileges of the querying role, not the policy owner. Every policy on
 * projects, applications and freelancer_profiles calls is_company_admin_for;
 * read_profiles calls is_live_application. Revoking EXECUTE from PUBLIC would
 * therefore break those policies for `authenticated` as well, unless the same
 * migration grants it straight back — and for anon it would turn a clean
 * empty result into `permission denied for function`, on every table.
 *
 * What that buys: hiding two booleans that are false for anon by
 * construction, and a row of nulls from current_app_user(). Nothing else.
 * auth.uid() is null without a session, so each already answers "no".
 *
 * A worse trade than it looks at first glance, so it is not made. If it is
 * ever revisited, the working form is `revoke from public` AND `revoke from
 * anon` AND `grant execute to authenticated` — all three, or the policies
 * stop working for everybody.
 */

/* ---------------- verify ----------------
 *
 * Re-run these after applying. The first must be a permission error and not
 * an empty list, because an empty list is what a working policy and a missing
 * revoke look like from outside — which is precisely why this was not spotted
 * until the database existed.
 *
 *   curl "$URL/rest/v1/project_board?select=*" \
 *     -H "apikey: $ANON" -H "Authorization: Bearer $ANON"
 *   -- expect 401, code 42501, "permission denied for view project_board"
 *
 *   curl -X POST "$URL/rest/v1/rpc/open_period" \
 *     -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
 *     -H "Content-Type: application/json" \
 *     -d '{"p_assignment":"00000000-0000-0000-0000-000000000000",
 *          "p_year":2026,"p_month":9}'
 *   -- expect 401, code 42501, "permission denied for function open_period"
 *
 * Send the real argument names. A call with `{}` returns PGRST202 "searched
 * for the function without parameters", which is PostgREST failing to match
 * an overload and says nothing at all about privileges — it looks like proof
 * and is not.
 *
 * Tables must still answer 200 with an empty list, not an error. If
 * `projects` starts returning `permission denied for function
 * is_company_admin_for`, somebody revoked a helper from PUBLIC; read the
 * section above.
 */
