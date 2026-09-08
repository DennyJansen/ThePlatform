-- =====================================================================
-- Migration 005 — organisation membership, and KvK on both sides
-- Run after 004-agreed-rate.sql.
--
-- Closes a hole opened by matching organisations on KvK number. KvK numbers
-- are published on every company's own website. Without this, anyone who can
-- read a competitor's footer could sign up, be silently added to their
-- organisation, and read their projects and applicants.
--
-- Matching on KvK is right for deciding WHICH organisation someone claims.
-- It is not evidence that they work there. An existing member decides that.
-- =====================================================================

create type membership_status as enum ('pending', 'active', 'declined');

alter table app_users
  add column if not exists membership_status  membership_status not null default 'active',
  add column if not exists membership_decided_at timestamptz,
  add column if not exists membership_decided_by uuid references app_users(id),
  -- A freelancer on this platform is a registered business — they invoice, so
  -- they have a KvK number. Collected on both sides now so the Handelsregister
  -- check can happen at the door. See src/data/kvk.js.
  add column if not exists kvk_number         text,
  add column if not exists kvk_verified_at    timestamptz,
  add column if not exists kvk_sbi_codes      text[],
  -- Set when a registration's SBI codes say it places people for a living.
  -- A flag, never an automatic refusal — see the note in kvk.js about false
  -- positives on genuine ZZP interim managers.
  add column if not exists kvk_agency_flag    boolean not null default false;

create index if not exists app_users_pending_idx
  on app_users (organization_id)
  where membership_status = 'pending';

-- Existing accounts keep working: the column defaults to active, so nobody is
-- locked out by a migration.
alter table app_users
  add constraint freelancers_have_no_membership check (
    role <> 'freelancer' or membership_status = 'active'
  );

-- ---------------------------------------------------------------------
-- The gate.
--
-- is_company_admin_for is what every projects, applications and profiles
-- policy already routes through, so adding the membership test here closes
-- the hole everywhere at once rather than policy by policy.
-- ---------------------------------------------------------------------
create or replace function is_company_admin_for(org uuid) returns boolean
language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from app_users u
    where u.id = auth.uid()
      and (
        u.role = 'ops'
        or (u.role = 'company_admin'
            and u.organization_id = org
            and u.membership_status = 'active')
      )
  );
$fn$;

-- ---------------------------------------------------------------------
-- Sign-up: first in is active, everyone after waits.
-- ---------------------------------------------------------------------
create or replace function handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  meta      jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  want_role text  := meta ->> 'role';
  safe_role user_role;
  kvk       text  := regexp_replace(coalesce(meta ->> 'kvk_number', ''), '[^0-9]', '', 'g');
  org       organizations;
  joined    boolean := false;
begin
  -- The clamp. Anything that is not a self-service role becomes a freelancer;
  -- ops and approver are assigned by ops, never claimed by a signer-up.
  safe_role := case
    when want_role = 'company_admin' then 'company_admin'::user_role
    else 'freelancer'::user_role
  end;

  if kvk !~ '^\d{8}$' then
    raise exception 'error.kvk_invalid';
  end if;

  if safe_role = 'company_admin' then
    select * into org from organizations where kvk_number = kvk;
    joined := found;

    if not joined then
      insert into organizations (name, kvk_number, vat_number, website,
                                 billing_email, payment_terms_days)
      values (
        coalesce(nullif(btrim(meta ->> 'company_name'), ''), 'Onbekend'),
        kvk,
        nullif(btrim(meta ->> 'vat_number'), ''),
        nullif(btrim(meta ->> 'website'), ''),
        new.email,
        30
      )
      returning * into org;
    end if;
  end if;

  insert into app_users (
    id, email, name, role, organization_id, kvk_number,
    membership_status, outreach_consent
  )
  values (
    new.id,
    new.email,
    coalesce(nullif(btrim(meta ->> 'name'), ''), split_part(new.email, '@', 1)),
    safe_role,
    case when safe_role = 'company_admin' then org.id else null end,
    kvk,
    -- Joining an organisation that already exists means waiting for one of
    -- its members. Creating it, or being a freelancer, does not.
    case when joined then 'pending'::membership_status else 'active'::membership_status end,
    coalesce((meta -> 'outreach_consent')::text = 'true', false)
  )
  on conflict (id) do nothing;

  return new;
end $fn$;

-- ---------------------------------------------------------------------
-- Deciding a request.
--
-- An active admin of the same organisation, and never yourself. The
-- self-approval check looks obvious written down and is exactly the one that
-- gets left out, at which point the whole mechanism is decoration.
-- ---------------------------------------------------------------------
create or replace function decide_member(p_member uuid, p_decision text)
returns app_users
language plpgsql security definer set search_path = public as $fn$
declare member app_users;
begin
  if p_decision not in ('active', 'declined') then
    raise exception 'error.illegal_transition';
  end if;
  if p_member = auth.uid() then
    raise exception 'error.not_authorised';
  end if;

  select * into member from app_users where id = p_member for update;
  if not found then raise exception 'error.not_found'; end if;
  if not is_company_admin_for(member.organization_id) then
    raise exception 'error.not_authorised';
  end if;
  if member.membership_status <> 'pending' then
    raise exception 'error.illegal_transition';
  end if;

  update app_users
     set membership_status = p_decision::membership_status,
         membership_decided_at = now(),
         membership_decided_by = auth.uid()
   where id = p_member
  returning * into member;

  perform log_audit(null, 'User', p_member,
    case when p_decision = 'active'
      then 'organization.member_approved'
      else 'organization.member_declined' end,
    jsonb_build_object('organization_id', member.organization_id));
  return member;
end $fn$;

revoke all on function decide_member(uuid, text) from public;
grant execute on function decide_member(uuid, text) to authenticated;

-- An active admin may read the pending members of their own organisation, so
-- the approve screen has something to show. Nobody else can enumerate them.
create policy read_org_members on app_users for select
  using (
    id = auth.uid()
    or is_ops()
    or (organization_id is not null and is_company_admin_for(organization_id))
  );

drop policy if exists read_own_user on app_users;

-- ---------------------------------------------------------------------
-- Profile access follows the reason it was granted.
--
-- A company that rejected someone in March should not still be reading their
-- CV in November. Only a LIVE application keeps a profile open — submitted,
-- screening, or hired. Rejected and withdrawn end it.
-- ---------------------------------------------------------------------
create or replace function is_live_application(status application_status)
returns boolean language sql immutable as $fn$
  select status in ('submitted', 'screening', 'hired');
$fn$;

drop policy if exists read_profiles on freelancer_profiles;

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
        and me.membership_status = 'active'
    )
    or exists (
      select 1 from applications a
      where a.freelancer_id = freelancer_profiles.user_id
        and is_live_application(a.status)
        and is_company_admin_for(a.organization_id)
    )
  );

-- ---------------------------------------------------------------------
-- Answered from spec §10: the fixed fee is a listing fee, paid by the
-- company when it opens an assignment.
-- ---------------------------------------------------------------------
alter table assignments
  add column if not exists fixed_fee_charged_at timestamptz;

update assignments set fixed_fee_payer = 'client' where fixed_fee_payer is null;
