-- =====================================================================
-- Migration 003 — self-service sign-up
-- Run after 002-marketplace.sql.
--
-- Reverses spec §4/F1's "accounts are created by ops" for the marketplace
-- side. What it does not reverse: no passwords. Supabase sends a one-time
-- link; there is no password column anywhere in this schema, and there should
-- never be one.
--
-- READ THIS BEFORE CHANGING THE TRIGGER.
--
-- Sign-up metadata is written by the browser. `raw_user_meta_data` is
-- whatever the client put in `options.data`, which means a person signing up
-- can claim `"role": "ops"`. The trigger below clamps the role to the
-- self-service set and ignores anything else. That single CASE expression is
-- the difference between a sign-up form and a privilege escalation, and it is
-- the first thing to check if this file is ever edited.
-- =====================================================================

alter table organizations
  add column if not exists website text;

-- ---------------------------------------------------------------------
-- Turn a new auth user into an app_users row, and a company into an org.
--
-- Runs as the definer because auth.users triggers run before the new user has
-- a session, so auth.uid() is null here and RLS cannot be relied on.
-- ---------------------------------------------------------------------
create or replace function handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  meta      jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  want_role text  := meta ->> 'role';
  safe_role user_role;
  kvk       text  := regexp_replace(coalesce(meta ->> 'kvk_number', ''), '[^0-9]', '', 'g');
  org       organizations;
begin
  -- The clamp. Anything that is not a self-service role becomes a freelancer;
  -- ops and approver are assigned by ops, never claimed by a signer-up.
  safe_role := case
    when want_role = 'company_admin' then 'company_admin'::user_role
    else 'freelancer'::user_role
  end;

  if safe_role = 'company_admin' then
    if kvk !~ '^\d{8}$' then
      raise exception 'error.kvk_invalid';
    end if;

    -- KvK decides the organisation. A holding company's domain, a Gmail
    -- address or a rebrand all break email-domain matching; none of them
    -- change the KvK.
    select * into org from organizations where kvk_number = kvk;

    if not found then
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

  insert into app_users (id, email, name, role, organization_id, outreach_consent)
  values (
    new.id,
    new.email,
    coalesce(nullif(btrim(meta ->> 'name'), ''), split_part(new.email, '@', 1)),
    safe_role,
    case when safe_role = 'company_admin' then org.id else null end,
    -- Spec §6: opt-in. Only a real boolean true counts; a missing key, a
    -- string "true" and null all mean no.
    coalesce((meta -> 'outreach_consent')::text = 'true', false)
  )
  on conflict (id) do nothing;

  return new;
end $fn$;

drop trigger if exists trg_new_auth_user on auth.users;
create trigger trg_new_auth_user
  after insert on auth.users
  for each row execute function handle_new_auth_user();

-- ---------------------------------------------------------------------
-- A freelancer profile row exists as soon as the account does, so the profile
-- screen has something to load and the CV import has something to fill.
-- ---------------------------------------------------------------------
create or replace function handle_new_app_user() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.role = 'freelancer' then
    insert into freelancer_profiles (user_id) values (new.id)
    on conflict (user_id) do nothing;
  end if;
  return new;
end $fn$;

drop trigger if exists trg_new_app_user on app_users;
create trigger trg_new_app_user
  after insert on app_users
  for each row execute function handle_new_app_user();

-- ---------------------------------------------------------------------
-- A company admin may correct their own organisation's details. They may not
-- change its KvK number: that is the key other people were joined on, and
-- editing it silently moves an organisation out from under them.
-- ---------------------------------------------------------------------
create policy company_updates_own_org on organizations for update
  using (is_company_admin_for(id))
  with check (is_company_admin_for(id));

create or replace function organization_kvk_is_immutable() returns trigger
language plpgsql as $fn$
begin
  if new.kvk_number is distinct from old.kvk_number and not is_ops() then
    raise exception 'error.kvk_immutable';
  end if;
  return new;
end $fn$;

create trigger trg_org_kvk_immutable
  before update on organizations
  for each row execute function organization_kvk_is_immutable();

-- ---------------------------------------------------------------------
-- Verify before trusting. In the SQL editor, as an anonymous caller:
--
--   -- must NOT create an ops account
--   select handle_new_auth_user();  -- via a real signInWithOtp with
--                                   -- data: { role: 'ops' } from the browser,
--                                   -- then:
--   select role from app_users where email = '<that address>';
--   -- expect: freelancer
--
--   -- must refuse a company sign-up with a junk KvK
--   -- expect: error.kvk_invalid, and no orphan organisation left behind
--   select count(*) from organizations where name = 'Onbekend';
-- ---------------------------------------------------------------------
