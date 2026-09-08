-- =====================================================================
-- Migration 006 — the gaps writing the adapter exposed
-- Run after 005-membership-and-kvk.sql.
--
-- Writing supabaseAdapter.js against 001–005 turned up things the earlier
-- migrations assume rather than provide. Each one below is a call the adapter
-- has to make and could not. They are grouped in one migration because they
-- were all found the same way, and because none of them is useful alone.
--
-- One of them is a straight bug: 004 dropped the columns hire_applicant
-- writes to and did not update the function, so hiring has been broken since
-- that migration was written. Nobody noticed because none of these have ever
-- been run.
--
-- THE PATTERN WORTH SEEING. The v1 policies were written for the timesheet
-- flows, where every reader is a party to the assignment. The marketplace
-- reads across that boundary — a company reading an applicant's name, a
-- freelancer reading the title of a project they may not see — and RLS on its
-- own cannot express "you may read this row because of a relationship
-- elsewhere". Hence the security-definer readers here. Each one is narrow on
-- purpose: it takes the smallest argument that identifies the relationship,
-- checks it, and returns only the columns the screen needs. A general
-- "read anything" definer would defeat the whole design.
-- =====================================================================

/* ---------------------------------------------------------------------
 * 1. open_period
 *
 * The adapter has to be able to open a month. Nothing could: there is no
 * insert policy on timesheet_periods, which is correct — a browser that can
 * insert a period can insert one with any status — so the row has to come
 * from a definer function.
 *
 * Auto-creating on first view keeps a freelancer off an empty screen on the
 * first of the month. The row is still audited as an opening, so the history
 * does not silently gain periods nobody asked for.
 * ------------------------------------------------------------------- */
create or replace function open_period(p_assignment uuid, p_year int, p_month int)
returns timesheet_periods
language plpgsql security definer set search_path = public as $fn$
declare
  asg assignments;
  per timesheet_periods;
begin
  if p_month < 1 or p_month > 12 then raise exception 'error.not_found'; end if;

  select * into asg from assignments where id = p_assignment;
  if not found then raise exception 'error.not_found'; end if;
  if not is_party_to(p_assignment) then raise exception 'error.not_authorised'; end if;

  -- A hire creates a PENDING assignment. Ops still has to set the final
  -- rates, name an approver and upload the signed agreement, so there is
  -- nothing legitimate to bill against yet.
  if asg.status = 'pending' then raise exception 'error.assignment_not_active'; end if;

  select * into per from timesheet_periods
   where assignment_id = p_assignment and year = p_year and month = p_month
   order by version desc limit 1;
  if found then return per; end if;

  insert into timesheet_periods (assignment_id, year, month, version, status)
  values (p_assignment, p_year, p_month, 1, 'draft')
  returning * into per;

  perform log_audit(p_assignment, 'TimesheetPeriod', per.id, 'period.opened',
    jsonb_build_object('year', p_year, 'month', p_month));
  return per;
end $fn$;

revoke all on function open_period(uuid, int, int) from public;
grant execute on function open_period(uuid, int, int) to authenticated;

/* ---------------------------------------------------------------------
 * 2. hire_applicant, repaired
 *
 * 004 dropped assignments.client_rate_per_hour, freelancer_rate_per_hour and
 * projects.freelancer_rate_per_hour. This function, written in 002, still
 * inserts into all three. It would fail on the first hire with "column does
 * not exist".
 *
 * The lesson is not "someone was careless". It is that a migration which
 * changes a column set has to grep the functions, because Postgres will not
 * tell you: a plpgsql body is not checked until it runs, and this one had
 * never run.
 *
 * The rate written onto the assignment is the applicant's proposed rate when
 * they named one, otherwise the project's — the same rule as before, on the
 * agreed rate instead of the freelancer rate. That number IS the agreed rate:
 * it is what the two sides shook hands on, and the fees point outward from it.
 * ------------------------------------------------------------------- */
create or replace function hire_applicant(p_application uuid) returns assignments
language plpgsql security definer set search_path = public as $fn$
declare
  app applications;
  prj projects;
  asg assignments;
  agreed int;
begin
  select * into app from applications where id = p_application for update;
  if not found then raise exception 'error.not_found'; end if;
  if not is_company_admin_for(app.organization_id) then
    raise exception 'error.not_authorised';
  end if;
  if app.status <> 'screening' then raise exception 'error.illegal_transition'; end if;

  select * into prj from projects where id = app.project_id for update;

  update applications set status = 'hired', decided_at = now()
   where id = p_application
  returning * into app;

  agreed := coalesce(app.proposed_rate_per_hour, prj.agreed_rate_per_hour);

  -- indicative_hours_per_week is absent from this insert on purpose, and
  -- trg_assignment_no_scope makes that absence permanent. COMPLIANCE §6.
  insert into assignments (
    title, freelancer_id, organization_id, approver_id,
    agreed_rate_per_hour, client_fee_per_hour, freelancer_fee_per_hour,
    hour_increment, start_date, status, approval_window_days,
    auto_approve_enabled, source_project_id, source_application_id
  ) values (
    prj.title, app.freelancer_id, prj.organization_id, null,
    agreed, 500, 200,
    0.25, prj.start_date, 'pending', 5, false, prj.id, app.id
  ) returning * into asg;

  update projects set status = 'filled' where id = prj.id and status = 'open';

  perform log_audit(null, 'Application', p_application, 'application.hired',
    jsonb_build_object('assignment_id', asg.id));
  perform log_audit(asg.id, 'Assignment', asg.id, 'assignment.created_from_hire',
    jsonb_build_object('project_id', prj.id, 'application_id', app.id, 'status', 'pending'));
  return asg;
end $fn$;

/* ---------------------------------------------------------------------
 * 2b. submit_period and approve_period, repaired
 *
 * The same breakage as hire_applicant, and worse, because these two are the
 * approval loop itself. Both build their audit payload from
 * asg.client_rate_per_hour and asg.freelancer_rate_per_hour, which 004
 * dropped. Every submit and every approve would have failed at runtime with:
 *
 *   ERROR: record "asg" has no field "client_rate_per_hour"
 *
 * Found by grepping for the dropped columns rather than by running anything,
 * which is the only way it could have been found: a plpgsql body is opaque to
 * the dependency tracker, so DROP COLUMN succeeds and says nothing. The view
 * project_board, by contrast, IS tracked — 004 could not drop the column out
 * from under it, which is why that one failed loudly and these did not.
 *
 * The arithmetic moves to the agreed rate with the fees pointing outward:
 *   client_total   = hours × (agreed + client fee)
 *   freelancer_net = hours × (agreed − freelancer fee)
 * The bodies are otherwise unchanged from schema.sql.
 * ------------------------------------------------------------------- */
create or replace function submit_period(p_period uuid) returns timesheet_periods
language plpgsql security definer set search_path = public as $fn$
declare
  per timesheet_periods;
  asg assignments;
  total numeric;
begin
  select * into per from timesheet_periods where id = p_period for update;
  if not found then raise exception 'error.not_found'; end if;
  select * into asg from assignments where id = per.assignment_id;

  if asg.freelancer_id <> auth.uid() and not is_ops() then
    raise exception 'error.not_authorised';
  end if;
  if per.status <> 'draft' then
    raise exception 'error.illegal_transition';
  end if;

  select coalesce(sum(hours), 0) into total from time_entries where period_id = p_period;
  if total <= 0 then raise exception 'error.no_hours'; end if;

  update timesheet_periods
     set status = 'submitted', submitted_at = now()
   where id = p_period
  returning * into per;

  perform log_audit(asg.id, 'TimesheetPeriod', p_period, 'period.submitted',
    jsonb_build_object(
      'version', per.version,
      'total_hours', total,
      'client_total', round(total * (asg.agreed_rate_per_hour + asg.client_fee_per_hour)),
      'freelancer_net', round(total * (asg.agreed_rate_per_hour - asg.freelancer_fee_per_hour))
    ));
  return per;
end $fn$;

create or replace function approve_period(p_period uuid) returns timesheet_periods
language plpgsql security definer set search_path = public as $fn$
declare
  per timesheet_periods;
  asg assignments;
  total numeric;
begin
  select * into per from timesheet_periods where id = p_period for update;
  if not found then raise exception 'error.not_found'; end if;
  select * into asg from assignments where id = per.assignment_id;

  if not (is_ops() or (asg.approver_id = auth.uid()
      and asg.organization_id = (select organization_id from app_users where id = auth.uid()))) then
    raise exception 'error.not_authorised';
  end if;
  if per.status <> 'submitted' then raise exception 'error.illegal_transition'; end if;

  select coalesce(sum(hours), 0) into total from time_entries where period_id = p_period;

  update timesheet_periods
     set status = 'approved', decided_at = now(), decided_by = auth.uid()
   where id = p_period
  returning * into per;

  perform log_audit(asg.id, 'TimesheetPeriod', p_period, 'period.approved',
    jsonb_build_object(
      'version', per.version,
      'total_hours', total,
      'client_total', round(total * (asg.agreed_rate_per_hour + asg.client_fee_per_hour)),
      'freelancer_net', round(total * (asg.agreed_rate_per_hour - asg.freelancer_fee_per_hour))
    ));
  return per;
end $fn$;

/* ---------------------------------------------------------------------
 * 3. set_outreach_consent
 *
 * There is no update policy on app_users, and there should not be a general
 * one: `for update using (id = auth.uid())` would let anybody set their own
 * `role` to ops, or their own membership_status to active, which is exactly
 * the hole 005 was written to close.
 *
 * Postgres RLS cannot restrict an update to one column. A function can.
 * ------------------------------------------------------------------- */
create or replace function set_outreach_consent(p_consent boolean) returns app_users
language plpgsql security definer set search_path = public as $fn$
declare u app_users;
begin
  if auth.uid() is null then raise exception 'error.not_authorised'; end if;
  update app_users set outreach_consent = coalesce(p_consent, false)
   where id = auth.uid()
  returning * into u;
  if not found then raise exception 'error.not_found'; end if;
  return u;
end $fn$;

revoke all on function set_outreach_consent(boolean) from public;
grant execute on function set_outreach_consent(boolean) to authenticated;

/* ---------------------------------------------------------------------
 * 4. audit_for_assignment
 *
 * The audit trail shows who did what. Reading the actor's name means reading
 * app_users, and read_org_members only opens your own row and your own
 * organisation's — so a freelancer would see every approver action attributed
 * to "onbekend".
 *
 * The name is not a leak: it is the name of the person on the other side of
 * an assignment you are a party to, which every screen already shows. But it
 * has to come from somewhere with the rights to read it.
 * ------------------------------------------------------------------- */
create or replace function audit_for_assignment(p_assignment uuid)
returns table (
  id uuid, actor_id uuid, actor_name text, assignment_id uuid,
  object_type text, object_id uuid, action text,
  payload_json jsonb, created_at timestamptz
)
language sql stable security definer set search_path = public as $fn$
  select e.id, e.actor_id, coalesce(u.name, 'onbekend'), e.assignment_id,
         e.object_type, e.object_id, e.action, e.payload_json, e.created_at
    from audit_events e
    left join app_users u on u.id = e.actor_id
   where e.assignment_id = p_assignment
     and is_party_to(p_assignment)
   order by e.created_at desc;
$fn$;

revoke all on function audit_for_assignment(uuid) from public;
grant execute on function audit_for_assignment(uuid) to authenticated;

/* ---------------------------------------------------------------------
 * 5. my_applications
 *
 * A freelancer has no select policy on `projects` — by design, they read
 * `project_board`. But the board is open projects only, and an application
 * outlives the posting: once a project is filled or closed, the freelancer's
 * own application list would lose the title of the thing they applied for.
 *
 * PostgREST cannot embed a view across a foreign key, so this cannot be a
 * join in the client. It returns the same fields projectForFreelancer()
 * returns in the mock, and nothing else.
 * ------------------------------------------------------------------- */
create or replace function my_applications()
returns table (
  id uuid, project_id uuid, freelancer_id uuid, organization_id uuid,
  status application_status, motivation text, proposed_rate_per_hour int,
  hiring_manager_name text, screening_note text, screening_slots text[],
  screening_confirmed_slot text, created_at timestamptz, decided_at timestamptz,
  decision_reason text, project jsonb, organization_name text
)
language sql stable security definer set search_path = public as $fn$
  select a.id, a.project_id, a.freelancer_id, a.organization_id,
         a.status, a.motivation, a.proposed_rate_per_hour,
         a.hiring_manager_name, a.screening_note, a.screening_slots,
         a.screening_confirmed_slot, a.created_at, a.decided_at,
         a.decision_reason,
         jsonb_build_object(
           'id', p.id, 'title', p.title, 'description', p.description,
           'agreed_rate_per_hour', p.agreed_rate_per_hour,
           'indicative_hours_per_week', p.indicative_hours_per_week,
           'start_date', p.start_date, 'duration_months', p.duration_months,
           'location', p.location, 'remote_policy', p.remote_policy,
           'status', p.status, 'published_at', p.published_at
         ),
         o.name
    from applications a
    join projects p      on p.id = a.project_id
    join organizations o on o.id = a.organization_id
   where a.freelancer_id = auth.uid()
   order by a.created_at desc;
$fn$;

revoke all on function my_applications() from public;
grant execute on function my_applications() to authenticated;

/* ---------------------------------------------------------------------
 * 6. applications_for_project
 *
 * The mirror image. A company admin reading their applicants needs each
 * applicant's name and email, and freelancers have no organisation, so
 * read_org_members never matches them.
 *
 * The profile is joined here rather than returned unconditionally, and the
 * condition is the same one 005 put in read_profiles: only a LIVE application
 * opens a profile. A company that rejected someone in March gets a null here
 * in November, and that is the feature — not a missing row to work around.
 * ------------------------------------------------------------------- */
create or replace function applications_for_project(p_project uuid)
returns table (
  id uuid, project_id uuid, freelancer_id uuid, organization_id uuid,
  status application_status, motivation text, proposed_rate_per_hour int,
  hiring_manager_name text, screening_note text, screening_slots text[],
  screening_confirmed_slot text, created_at timestamptz, decided_at timestamptz,
  decision_reason text, freelancer jsonb, profile jsonb
)
language sql stable security definer set search_path = public as $fn$
  select a.id, a.project_id, a.freelancer_id, a.organization_id,
         a.status, a.motivation, a.proposed_rate_per_hour,
         a.hiring_manager_name, a.screening_note, a.screening_slots,
         a.screening_confirmed_slot, a.created_at, a.decided_at,
         a.decision_reason,
         jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email),
         case when is_live_application(a.status) then to_jsonb(f.*) else null end
    from applications a
    join projects p       on p.id = a.project_id
    join app_users u      on u.id = a.freelancer_id
    left join freelancer_profiles f on f.user_id = a.freelancer_id
   where a.project_id = p_project
     and is_company_admin_for(p.organization_id)
   order by a.created_at;
$fn$;

revoke all on function applications_for_project(uuid) from public;
grant execute on function applications_for_project(uuid) to authenticated;

/* ---------------------------------------------------------------------
 * 7. Project transitions, enforced
 *
 * company_writes_own_projects is a `for all` policy, so a company admin can
 * PATCH status directly to anything the enum allows — reopening a filled
 * project, or moving a draft straight to filled without ever publishing it.
 *
 * It is their own project, so this is not a confidentiality problem. It is a
 * consistency one: the mock refuses these transitions and the screens are
 * written as if they cannot happen. Two backends that disagree about what is
 * legal is the kind of difference that shows up as a bug report nobody can
 * reproduce.
 *
 * The allowed moves are the mock's, exactly:
 *   draft  -> open
 *   open   -> closed | filled
 *   closed -> open
 * ------------------------------------------------------------------- */
create or replace function project_transition_is_legal() returns trigger
language plpgsql as $fn$
begin
  if new.status = old.status then return new; end if;

  if not (
       (old.status = 'draft'  and new.status = 'open')
    or (old.status = 'open'   and new.status in ('closed', 'filled'))
    or (old.status = 'closed' and new.status = 'open')
  ) then
    raise exception 'error.illegal_transition';
  end if;

  if new.status = 'open' and new.published_at is null then
    new.published_at := now();
  end if;
  return new;
end $fn$;

drop trigger if exists trg_project_transition on projects;
create trigger trg_project_transition
  before update of status on projects
  for each row execute function project_transition_is_legal();

/* ---------------------------------------------------------------------
 * 8. A project may not be edited once it is live
 *
 * Same reasoning. The mock's assertCanManageProject allows edits at any
 * status, but changing the rate on a project people have already applied to
 * changes the terms under them. Left alone deliberately — flagged here rather
 * than fixed, because it is a product decision, not a defect, and guessing at
 * it in a migration is how a rule nobody agreed to ends up enforced in SQL.
 * ------------------------------------------------------------------- */
