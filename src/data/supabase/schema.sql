-- =====================================================================
-- Freelance assignment platform - v1 schema
-- Target: Supabase (Postgres 15+), executed once in the SQL editor.
--
-- The frontend on GitHub Pages is untrusted. Everything that matters is
-- enforced here: who may read a row (RLS), and who may change a status
-- (security-definer functions, with direct writes revoked).
--
-- The rule this schema exists to guarantee, from the spec:
--   "the approved number and the invoiced number are the same number by
--    construction."
-- That is why time_entries cannot be written once a period leaves draft, and
-- why audit_events has no UPDATE or DELETE grant for anybody.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type user_role       as enum ('freelancer', 'approver', 'ops');
create type period_status   as enum ('draft', 'submitted', 'rejected', 'approved', 'invoiced', 'paid');
create type charge_status   as enum ('pending', 'approved', 'rejected');
create type assignment_state as enum ('active', 'ended');
create type invoice_direction as enum ('to_client', 'self_billed_to_freelancer');

-- ---------------------------------------------------------------------
-- Organizations
-- ---------------------------------------------------------------------
create table organizations (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  kvk_number         text,
  vat_number         text,
  billing_email      text not null,
  payment_terms_days int  not null default 30 check (payment_terms_days between 0 and 120),
  created_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Users. Mirrors auth.users; the id IS auth.uid().
-- Accounts are created by ops when an assignment is set up (spec section 4/F1),
-- so there is no self-signup path and no INSERT policy for end users.
-- ---------------------------------------------------------------------
create table app_users (
  id               uuid primary key references auth.users(id) on delete restrict,
  email            text not null unique,
  name             text not null,
  role             user_role not null,
  organization_id  uuid references organizations(id),
  -- Spec section 6: consent captured at signup, outreach not in v1 scope.
  outreach_consent boolean not null default false,
  created_at       timestamptz not null default now(),
  -- An approver belongs to a client org; a freelancer does not.
  constraint approver_has_org check (role <> 'approver' or organization_id is not null),
  constraint freelancer_has_no_org check (role <> 'freelancer' or organization_id is null)
);

-- ---------------------------------------------------------------------
-- Assignments. All money is integer cents.
-- ---------------------------------------------------------------------
create table assignments (
  id                       uuid primary key default gen_random_uuid(),
  title                    text not null,
  freelancer_id            uuid not null references app_users(id),
  organization_id          uuid not null references organizations(id),
  approver_id              uuid not null references app_users(id),

  client_rate_per_hour     int not null check (client_rate_per_hour >= 0),
  freelancer_rate_per_hour int not null check (freelancer_rate_per_hour >= 0),
  freelancer_fee_per_hour  int not null check (freelancer_fee_per_hour >= 0),
  fixed_fee_amount         int check (fixed_fee_amount >= 0),
  -- Spec section 10 open item: who pays the fixed fee. Null until decided.
  fixed_fee_payer          text check (fixed_fee_payer in ('client', 'freelancer')),

  -- Spec section 10 open item: hour rounding. 0.25 until the terms say otherwise.
  hour_increment           numeric(4,2) not null default 0.25 check (hour_increment > 0),

  start_date               date not null,
  end_date                 date,
  status                   assignment_state not null default 'active',
  contract_pdf             text,

  approval_window_days     int check (approval_window_days between 1 and 60),
  -- Spec section 7: build the field, ship it disabled.
  auto_approve_enabled     boolean not null default false,
  created_at               timestamptz not null default now(),

  -- The fee arithmetic of spec section 3, enforced rather than assumed.
  constraint rates_coherent check (
    freelancer_rate_per_hour <= client_rate_per_hour
    and freelancer_fee_per_hour <= freelancer_rate_per_hour
  ),
  constraint dates_ordered check (end_date is null or end_date >= start_date)
);

create index on assignments (freelancer_id);
create index on assignments (approver_id);
create index on assignments (organization_id);

-- ---------------------------------------------------------------------
-- Timesheet periods. One row per (assignment, month, version).
-- Rejection never mutates a row; it inserts a successor. Spec section 3.
-- ---------------------------------------------------------------------
create table timesheet_periods (
  id                 uuid primary key default gen_random_uuid(),
  assignment_id      uuid not null references assignments(id),
  year               int  not null check (year between 2020 and 2100),
  month              int  not null check (month between 1 and 12),
  version            int  not null default 1 check (version >= 1),
  supersedes_id      uuid references timesheet_periods(id),
  status             period_status not null default 'draft',
  submitted_at       timestamptz,
  decided_at         timestamptz,
  decided_by         uuid references app_users(id),
  rejection_comment  text,
  created_at         timestamptz not null default now(),

  unique (assignment_id, year, month, version),
  constraint rejection_has_comment check (
    status <> 'rejected' or (rejection_comment is not null and length(btrim(rejection_comment)) >= 3)
  ),
  constraint decided_has_decider check (
    status not in ('approved', 'rejected') or decided_by is not null
  )
);

create index on timesheet_periods (assignment_id, year desc, month desc, version desc);
create index on timesheet_periods (status) where status = 'submitted';

-- Only one live (non-superseded) version per month may sit in an open state.
create unique index one_open_version_per_month
  on timesheet_periods (assignment_id, year, month)
  where status in ('draft', 'submitted');

-- ---------------------------------------------------------------------
-- Time entries.
--
-- COMPLIANCE, spec section 6: hours per day only. No start_time, no end_time,
-- no break, no location, no activity. Adding a column here is a Wet DBA
-- regression and must be refused in code review. See docs/compliance.md.
-- ---------------------------------------------------------------------
create table time_entries (
  id         uuid primary key default gen_random_uuid(),
  period_id  uuid not null references timesheet_periods(id) on delete cascade,
  date       date not null,
  hours      numeric(5,2) not null check (hours > 0 and hours <= 24),
  unique (period_id, date)
);

create index on time_entries (period_id);

-- The date must belong to the period's own month. Cheap, and it catches an
-- entire class of client bug before it reaches an invoice.
create or replace function time_entry_date_matches_period() returns trigger
language plpgsql as $$
declare p record;
begin
  select year, month into p from timesheet_periods where id = new.period_id;
  if extract(year from new.date)::int <> p.year or extract(month from new.date)::int <> p.month then
    raise exception 'time_entries.date % is outside period %-%', new.date, p.year, p.month;
  end if;
  return new;
end $$;

create trigger trg_time_entry_date
  before insert or update on time_entries
  for each row execute function time_entry_date_matches_period();

-- ---------------------------------------------------------------------
-- Additional charges. Table exists now; the UI lands in a later build
-- (spec section 9, step 6).
-- ---------------------------------------------------------------------
create table additional_charges (
  id               uuid primary key default gen_random_uuid(),
  period_id        uuid not null references timesheet_periods(id) on delete cascade,
  description      text not null,
  amount_gross     int  not null check (amount_gross > 0),
  receipt_file     text,
  status           charge_status not null default 'pending',
  decision_comment text,
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Invoices. Populated by step 4; the table is here so the audit trail and
-- the history screens have a stable shape to reference.
-- ---------------------------------------------------------------------
create table invoices (
  id          uuid primary key default gen_random_uuid(),
  period_id   uuid not null references timesheet_periods(id),
  direction   invoice_direction not null,
  number      text not null unique,
  issue_date  date not null,
  lines       jsonb not null default '[]'::jsonb,
  subtotal    int not null,
  vat_amount  int not null,
  total       int not null,
  pdf         text,
  created_at  timestamptz not null default now(),
  unique (period_id, direction)
);

-- ---------------------------------------------------------------------
-- Audit events. APPEND ONLY. No update, no delete, ever. Spec section 3.
-- ---------------------------------------------------------------------
create table audit_events (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid references app_users(id),
  assignment_id uuid references assignments(id),
  object_type   text not null,
  object_id     uuid,
  action        text not null,
  payload_json  jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index on audit_events (assignment_id, created_at desc);

-- Belt and braces: even a superuser mistake is refused at the row level.
create rule audit_no_update as on update to audit_events do instead nothing;
create rule audit_no_delete as on delete to audit_events do instead nothing;

-- =====================================================================
-- Row level security
-- =====================================================================
alter table organizations      enable row level security;
alter table app_users          enable row level security;
alter table assignments        enable row level security;
alter table timesheet_periods  enable row level security;
alter table time_entries       enable row level security;
alter table additional_charges enable row level security;
alter table invoices           enable row level security;
alter table audit_events       enable row level security;

create or replace function current_app_user() returns app_users
language sql stable security definer set search_path = public as $$
  select * from app_users where id = auth.uid();
$$;

create or replace function is_ops() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'ops' from app_users where id = auth.uid()), false);
$$;

-- A user is a party to an assignment if they are its freelancer, or its named
-- approver within the matching organisation. Spec section 2.
create or replace function is_party_to(a_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from assignments a
    join app_users u on u.id = auth.uid()
    where a.id = a_id
      and (
        u.role = 'ops'
        or (u.role = 'freelancer' and a.freelancer_id = u.id)
        or (u.role = 'approver' and a.approver_id = u.id and a.organization_id = u.organization_id)
      )
  );
$$;

-- Read policies -------------------------------------------------------
create policy read_own_user on app_users for select
  using (id = auth.uid() or is_ops());

create policy read_own_org on organizations for select
  using (is_ops() or id = (select organization_id from app_users where id = auth.uid())
         or exists (select 1 from assignments a
                    where a.organization_id = organizations.id and is_party_to(a.id)));

create policy read_own_assignments on assignments for select
  using (is_party_to(id));

create policy read_own_periods on timesheet_periods for select
  using (is_party_to(assignment_id));

create policy read_own_entries on time_entries for select
  using (exists (select 1 from timesheet_periods p
                 where p.id = time_entries.period_id and is_party_to(p.assignment_id)));

create policy read_own_charges on additional_charges for select
  using (exists (select 1 from timesheet_periods p
                 where p.id = additional_charges.period_id and is_party_to(p.assignment_id)));

create policy read_own_invoices on invoices for select
  using (exists (select 1 from timesheet_periods p
                 where p.id = invoices.period_id and is_party_to(p.assignment_id)));

create policy read_own_audit on audit_events for select
  using (assignment_id is null and actor_id = auth.uid() or is_party_to(assignment_id));

-- Write policies ------------------------------------------------------
-- The freelancer may edit their own draft entries directly; everything else
-- goes through the security-definer functions below. This is the trust
-- boundary: the browser can type hours, it cannot change a status.
create policy write_draft_entries on time_entries for all
  using (
    exists (
      select 1 from timesheet_periods p
      join assignments a on a.id = p.assignment_id
      where p.id = time_entries.period_id
        and p.status = 'draft'
        and a.freelancer_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from timesheet_periods p
      join assignments a on a.id = p.assignment_id
      where p.id = time_entries.period_id
        and p.status = 'draft'
        and a.freelancer_id = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE policy exists for timesheet_periods, invoices or
-- audit_events. Absence is the policy: with RLS on and no permissive policy,
-- every direct write from the anon or authenticated role is refused.

-- =====================================================================
-- Transitions. The only way a period changes status.
-- =====================================================================

create or replace function log_audit(
  p_assignment uuid, p_object_type text, p_object_id uuid, p_action text, p_payload jsonb
) returns void
language sql security definer set search_path = public as $$
  insert into audit_events (actor_id, assignment_id, object_type, object_id, action, payload_json)
  values (auth.uid(), p_assignment, p_object_type, p_object_id, p_action, coalesce(p_payload, '{}'::jsonb));
$$;

create or replace function submit_period(p_period uuid) returns timesheet_periods
language plpgsql security definer set search_path = public as $$
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
      'client_total', round(total * asg.client_rate_per_hour),
      'freelancer_net', round(total * (asg.freelancer_rate_per_hour - asg.freelancer_fee_per_hour))
    ));
  return per;
end $$;

create or replace function approve_period(p_period uuid) returns timesheet_periods
language plpgsql security definer set search_path = public as $$
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
      'client_total', round(total * asg.client_rate_per_hour),
      'freelancer_net', round(total * (asg.freelancer_rate_per_hour - asg.freelancer_fee_per_hour))
    ));
  return per;
end $$;

-- Rejects the submitted version and returns the successor draft, pre-filled.
create or replace function reject_period(p_period uuid, p_comment text) returns timesheet_periods
language plpgsql security definer set search_path = public as $$
declare
  per timesheet_periods;
  asg assignments;
  successor timesheet_periods;
begin
  if p_comment is null or length(btrim(p_comment)) < 3 then
    raise exception 'error.comment_required';
  end if;

  select * into per from timesheet_periods where id = p_period for update;
  if not found then raise exception 'error.not_found'; end if;
  select * into asg from assignments where id = per.assignment_id;

  if not (is_ops() or (asg.approver_id = auth.uid()
      and asg.organization_id = (select organization_id from app_users where id = auth.uid()))) then
    raise exception 'error.not_authorised';
  end if;
  if per.status <> 'submitted' then raise exception 'error.illegal_transition'; end if;

  update timesheet_periods
     set status = 'rejected', decided_at = now(), decided_by = auth.uid(),
         rejection_comment = btrim(p_comment)
   where id = p_period
  returning * into per;

  perform log_audit(asg.id, 'TimesheetPeriod', p_period, 'period.rejected',
    jsonb_build_object('version', per.version, 'comment', btrim(p_comment)));

  insert into timesheet_periods (assignment_id, year, month, version, supersedes_id, status)
  values (per.assignment_id, per.year, per.month, per.version + 1, per.id, 'draft')
  returning * into successor;

  insert into time_entries (period_id, date, hours)
  select successor.id, date, hours from time_entries where period_id = per.id;

  perform log_audit(asg.id, 'TimesheetPeriod', successor.id, 'period.version_created',
    jsonb_build_object('version', successor.version, 'supersedes', per.id));

  return successor;
end $$;

revoke all on function submit_period(uuid)          from public;
revoke all on function approve_period(uuid)         from public;
revoke all on function reject_period(uuid, text)    from public;
revoke all on function log_audit(uuid, text, uuid, text, jsonb) from public;
grant execute on function submit_period(uuid)       to authenticated;
grant execute on function approve_period(uuid)      to authenticated;
grant execute on function reject_period(uuid, text) to authenticated;
