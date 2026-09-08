-- =====================================================================
-- Migration 002 — marketplace
-- Run after 002a-enum-values.sql, once, whole.
--
-- Spec §1 put "Matching / search / freelancer profiles" under "Explicitly not
-- building", handled by Sourcer in a spreadsheet. That was reversed
-- deliberately. The constraints it was protecting did not go away, so they are
-- enforced here rather than assumed:
--
--   * A company's budget is never readable by a freelancer. Freelancers get no
--     select policy on `projects` at all — they read `project_board`, a view
--     with no budget column in it. There is nothing to forget to omit.
--
--     SUPERSEDED BY 004-agreed-rate.sql. A posting now carries a single agreed
--     rate that both sides are meant to see, and the platform's fees are not
--     confidential either. `project_board` survives, but it no longer exists
--     to conceal a column. Read 004 before reasoning about rates from here.
--   * A profile is readable by a company only through an application that
--     freelancer sent them, or if they opted in to being approached. That is
--     §6's "direct outreach requires opt-in", in SQL.
--   * indicative_hours_per_week lives on a pitch and never on an assignment. A
--     trigger enforces it, because a column that "should not" be copied
--     eventually is.
-- =====================================================================

create type project_status     as enum ('draft', 'open', 'closed', 'filled');
create type application_status as enum ('submitted', 'screening', 'hired', 'rejected', 'withdrawn');
create type remote_policy      as enum ('on_site', 'hybrid', 'remote');

-- The two enum values this file depends on — 'company_admin' on user_role and
-- 'pending' on assignment_state — are added by 002a-enum-values.sql, which
-- MUST have been run first, as its own statement.
--
-- They cannot live here. Postgres refuses to use a new enum value in the same
-- transaction that added it, and the constraint immediately below is such a
-- use. See the header of 002a for the exact error.
alter table app_users drop constraint if exists approver_has_org;
alter table app_users
  add constraint org_roles_have_org
  check (role not in ('approver', 'company_admin') or organization_id is not null);

-- Assignments gain a record of where they came from.
alter table assignments
  add column if not exists source_project_id     uuid,
  add column if not exists source_application_id uuid;

alter table assignments alter column approver_id drop not null;

-- An assignment may lack an approver only while it is pending.
alter table assignments
  add constraint active_needs_approver
  check (status <> 'active' or approver_id is not null);

-- ---------------------------------------------------------------------
-- Projects. Both rates stored; the freelancer rate is derived on write.
-- ---------------------------------------------------------------------
create table projects (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references organizations(id),
  created_by                uuid not null references app_users(id),
  title                     text not null check (length(btrim(title)) >= 3),
  description               text not null check (length(btrim(description)) >= 30),

  client_rate_per_hour      int not null check (client_rate_per_hour between 2000 and 50000),
  freelancer_rate_per_hour  int not null check (freelancer_rate_per_hour >= 0),

  -- COMPLIANCE §6. Commercial scope on a pitch, not a roster, and never copied
  -- onto an assignment. See trg_assignment_no_scope below.
  indicative_hours_per_week int check (indicative_hours_per_week between 1 and 40),

  start_date                date not null,
  duration_months           int check (duration_months between 1 and 36),
  location                  text,
  remote_policy             remote_policy not null default 'hybrid',
  status                    project_status not null default 'draft',
  created_at                timestamptz not null default now(),
  published_at              timestamptz,

  constraint spread_is_non_negative check (freelancer_rate_per_hour <= client_rate_per_hour)
);

create index on projects (organization_id, created_at desc);
create index on projects (status) where status = 'open';

-- ---------------------------------------------------------------------
-- Freelancer profiles. One per freelancer.
-- ---------------------------------------------------------------------
create table freelancer_profiles (
  user_id                   uuid primary key references app_users(id) on delete cascade,
  headline                  text,
  bio                       text,
  skills                    text[] not null default '{}',
  languages                 text[] not null default '{}',
  years_experience          int check (years_experience between 0 and 60),
  rate_expectation_per_hour int check (rate_expectation_per_hour >= 0),
  available_from            date,
  location                  text,
  cv_file                   text,
  website_url               text,
  updated_at                timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Applications, including the screening call.
-- ---------------------------------------------------------------------
create table applications (
  id                       uuid primary key default gen_random_uuid(),
  project_id               uuid not null references projects(id) on delete cascade,
  freelancer_id            uuid not null references app_users(id),
  organization_id          uuid not null references organizations(id),
  status                   application_status not null default 'submitted',
  motivation               text not null check (length(btrim(motivation)) >= 20),
  proposed_rate_per_hour   int check (proposed_rate_per_hour >= 0),

  hiring_manager_name      text,
  screening_note           text,
  screening_slots          text[] not null default '{}',
  screening_confirmed_slot text,

  created_at               timestamptz not null default now(),
  decided_at               timestamptz,
  decision_reason          text,

  constraint rejection_has_reason check (
    status <> 'rejected' or (decision_reason is not null and length(btrim(decision_reason)) >= 3)
  ),
  constraint screening_has_manager check (
    status <> 'screening' or hiring_manager_name is not null
  ),
  constraint confirmed_slot_was_offered check (
    screening_confirmed_slot is null or screening_confirmed_slot = any (screening_slots)
  )
);

-- One live application per freelancer per project. Withdrawing frees them to
-- apply again, which is why the index is partial rather than a plain unique.
create unique index one_live_application
  on applications (project_id, freelancer_id)
  where status <> 'withdrawn';

create index on applications (project_id, created_at);
create index on applications (freelancer_id, created_at desc);

-- ---------------------------------------------------------------------
-- COMPLIANCE §6, enforced rather than trusted.
--
-- Checks to_jsonb of the row rather than named columns, so it keeps working
-- if someone adds one of these columns later without reading this file.
-- ---------------------------------------------------------------------
create or replace function assignment_has_no_scope_fields() returns trigger
language plpgsql as $fn$
begin
  if to_jsonb(new) ? 'indicative_hours_per_week'
     or to_jsonb(new) ? 'expected_hours_per_week'
     or to_jsonb(new) ? 'schedule'
     or to_jsonb(new) ? 'core_hours'
     or to_jsonb(new) ? 'reports_to' then
    raise exception
      'assignments may not carry scheduling or expected-hours fields (Wet DBA, spec section 6)';
  end if;
  return new;
end $fn$;

create trigger trg_assignment_no_scope
  before insert or update on assignments
  for each row execute function assignment_has_no_scope_fields();

-- =====================================================================
-- Row level security
-- =====================================================================
alter table projects            enable row level security;
alter table applications        enable row level security;
alter table freelancer_profiles enable row level security;

create or replace function is_company_admin_for(org uuid) returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from app_users u
    where u.id = auth.uid()
      and (u.role = 'ops' or (u.role = 'company_admin' and u.organization_id = org))
  );
$fn$;

-- Projects: a company sees its own, in any status. Freelancers get NO policy
-- here — they read the board view below, which has no budget column to leak.
create policy company_reads_own_projects on projects for select
  using (is_company_admin_for(organization_id));

create policy company_writes_own_projects on projects for all
  using (is_company_admin_for(organization_id))
  with check (is_company_admin_for(organization_id));

-- The board. security_invoker is off, so it runs with the view owner's rights
-- and the projects policy above does not apply — which is the point. This is
-- the one door a freelancer has, and there is no budget behind it.
create view project_board
with (security_invoker = off) as
  select id, organization_id, title, description,
         freelancer_rate_per_hour,
         indicative_hours_per_week, start_date, duration_months,
         location, remote_policy, status, published_at
  from projects
  where status = 'open';

revoke all on project_board from public;
grant select on project_board to authenticated;

-- Applications: the freelancer who sent it, and the company it went to.
create policy read_own_applications on applications for select
  using (freelancer_id = auth.uid() or is_company_admin_for(organization_id));

create policy freelancer_creates_application on applications for insert
  with check (
    freelancer_id = auth.uid()
    and exists (
      select 1 from projects p
      where p.id = project_id
        and p.status = 'open'
        and p.organization_id = applications.organization_id
    )
  );

-- No update policy on applications. Every status change goes through the
-- security-definer functions below; absence is the policy.

-- Profiles: your own always; a company's only through an application you sent
-- them, or if you opted in to being approached. Spec §6, in one policy.
create policy read_profiles on freelancer_profiles for select
  using (
    user_id = auth.uid()
    or is_ops()
    or exists (
      select 1
      from app_users owner, app_users me
      where owner.id = freelancer_profiles.user_id
        and owner.outreach_consent = true
        and me.id = auth.uid()
        and me.role = 'company_admin'
    )
    or exists (
      select 1 from applications a
      where a.freelancer_id = freelancer_profiles.user_id
        and is_company_admin_for(a.organization_id)
    )
  );

create policy write_own_profile on freelancer_profiles for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- =====================================================================
-- Marketplace transitions
-- =====================================================================

create or replace function invite_to_screening(
  p_application uuid, p_manager text, p_note text, p_slots text[]
) returns applications
language plpgsql security definer set search_path = public as $fn$
declare app applications;
begin
  select * into app from applications where id = p_application for update;
  if not found then raise exception 'error.not_found'; end if;
  if not is_company_admin_for(app.organization_id) then
    raise exception 'error.not_authorised';
  end if;
  if app.status <> 'submitted' then raise exception 'error.illegal_transition'; end if;
  if p_manager is null or length(btrim(p_manager)) < 2 then
    raise exception 'error.hiring_manager_required';
  end if;
  if p_slots is null or array_length(p_slots, 1) is null then
    raise exception 'error.slot_required';
  end if;

  update applications
     set status = 'screening',
         hiring_manager_name = btrim(p_manager),
         screening_note = p_note,
         screening_slots = p_slots[1:3]
   where id = p_application
  returning * into app;

  perform log_audit(null, 'Application', p_application, 'application.invited',
    jsonb_build_object('hiring_manager', btrim(p_manager)));
  return app;
end $fn$;

create or replace function confirm_screening_slot(p_application uuid, p_slot text)
returns applications
language plpgsql security definer set search_path = public as $fn$
declare app applications;
begin
  select * into app from applications where id = p_application for update;
  if not found then raise exception 'error.not_found'; end if;
  if app.freelancer_id <> auth.uid() then raise exception 'error.not_authorised'; end if;
  if app.status <> 'screening' then raise exception 'error.illegal_transition'; end if;
  if p_slot is null or not (p_slot = any (app.screening_slots)) then
    raise exception 'error.slot_not_offered';
  end if;

  update applications set screening_confirmed_slot = p_slot
   where id = p_application
  returning * into app;

  perform log_audit(null, 'Application', p_application,
    'application.screening_confirmed', jsonb_build_object('slot', p_slot));
  return app;
end $fn$;

create or replace function reject_application(p_application uuid, p_reason text)
returns applications
language plpgsql security definer set search_path = public as $fn$
declare app applications;
begin
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'error.reason_required';
  end if;

  select * into app from applications where id = p_application for update;
  if not found then raise exception 'error.not_found'; end if;
  if not is_company_admin_for(app.organization_id) then
    raise exception 'error.not_authorised';
  end if;
  if app.status not in ('submitted', 'screening') then
    raise exception 'error.illegal_transition';
  end if;

  update applications
     set status = 'rejected', decided_at = now(), decision_reason = btrim(p_reason)
   where id = p_application
  returning * into app;

  perform log_audit(null, 'Application', p_application, 'application.rejected',
    jsonb_build_object('reason', btrim(p_reason)));
  return app;
end $fn$;

create or replace function withdraw_application(p_application uuid) returns applications
language plpgsql security definer set search_path = public as $fn$
declare app applications;
begin
  select * into app from applications where id = p_application for update;
  if not found then raise exception 'error.not_found'; end if;
  if app.freelancer_id <> auth.uid() then raise exception 'error.not_authorised'; end if;
  if app.status not in ('submitted', 'screening') then
    raise exception 'error.illegal_transition';
  end if;

  update applications set status = 'withdrawn', decided_at = now()
   where id = p_application
  returning * into app;

  perform log_audit(null, 'Application', p_application, 'application.withdrawn', '{}'::jsonb);
  return app;
end $fn$;

/*
 * Hire. Produces a PENDING assignment and marks the project filled.
 *
 * Pending, not active. A screening call is an agreement in principle; spec §8
 * lists nine contract clauses the invoicing side assumes exist, and after a
 * half-hour video call none of them do. Ops sets the final rates, names the
 * approver and uploads the signed agreement — and only then may it go active,
 * which the active_needs_approver constraint enforces.
 *
 * indicative_hours_per_week is absent from the insert on purpose, and the
 * trigger above makes that absence permanent.
 */
create or replace function hire_applicant(p_application uuid) returns assignments
language plpgsql security definer set search_path = public as $fn$
declare
  app applications;
  prj projects;
  asg assignments;
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

  insert into assignments (
    title, freelancer_id, organization_id, approver_id,
    client_rate_per_hour, freelancer_rate_per_hour, freelancer_fee_per_hour,
    hour_increment, start_date, status, approval_window_days,
    auto_approve_enabled, source_project_id, source_application_id
  ) values (
    prj.title, app.freelancer_id, prj.organization_id, null,
    prj.client_rate_per_hour,
    coalesce(app.proposed_rate_per_hour, prj.freelancer_rate_per_hour),
    200, 0.25, prj.start_date, 'pending', 5, false, prj.id, app.id
  ) returning * into asg;

  update projects set status = 'filled' where id = prj.id and status = 'open';

  perform log_audit(null, 'Application', p_application, 'application.hired',
    jsonb_build_object('assignment_id', asg.id));
  perform log_audit(asg.id, 'Assignment', asg.id, 'assignment.created_from_hire',
    jsonb_build_object('project_id', prj.id, 'application_id', app.id, 'status', 'pending'));
  return asg;
end $fn$;

revoke all on function invite_to_screening(uuid, text, text, text[]) from public;
revoke all on function confirm_screening_slot(uuid, text)            from public;
revoke all on function reject_application(uuid, text)                from public;
revoke all on function withdraw_application(uuid)                    from public;
revoke all on function hire_applicant(uuid)                          from public;

grant execute on function invite_to_screening(uuid, text, text, text[]) to authenticated;
grant execute on function confirm_screening_slot(uuid, text)            to authenticated;
grant execute on function reject_application(uuid, text)                to authenticated;
grant execute on function withdraw_application(uuid)                    to authenticated;
grant execute on function hire_applicant(uuid)                          to authenticated;
