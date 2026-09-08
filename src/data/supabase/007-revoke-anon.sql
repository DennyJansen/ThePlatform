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

-- These are helpers the policies call, not endpoints. They run inside a
-- policy as the definer regardless of who the caller is, so revoking the
-- caller's EXECUTE does not break the policies that use them — it only stops
-- them being called directly over the API to probe for rows.
revoke all on function is_ops()                                         from anon;
revoke all on function is_party_to(uuid)                                from anon;
revoke all on function is_company_admin_for(uuid)                       from anon;
revoke all on function current_app_user()                               from anon;

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
 *   -- expect 404 from PostgREST: the function is no longer in anon's schema
 */
