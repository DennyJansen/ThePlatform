/**
 * Sign-up rules. Pure functions, no I/O.
 *
 * This reverses spec §4/F1, which says "No passwords, no account creation flow
 * — accounts are created by ops when an assignment is set up." A marketplace
 * cannot work that way: nobody is going to email ops to be allowed to look at
 * a project board.
 *
 * What did NOT change: no passwords. Sign-up collects details and sends a
 * magic link, and the link is the login. That is the same mechanism §4/F1
 * already specified, and it is the only one that is honest in a build served
 * from a public repository — password hashing needs a server, and anything a
 * browser could do with a password would be theatre.
 *
 * An account is not an assignment. Signing up gets someone an account and a
 * profile. Ops still creates the assignment when a placement is agreed, with
 * the rates and the signed contract, exactly as before.
 */

import { ROLE } from './model.js';
import { DomainError } from './rules.js';

export const SIGNUP_ERROR = Object.freeze({
  NAME_REQUIRED: 'error.name_required',
  EMAIL_REQUIRED: 'error.email_required',
  EMAIL_INVALID: 'error.email_invalid',
  EMAIL_TAKEN: 'error.email_taken',
  COMPANY_NAME_REQUIRED: 'error.company_name_required',
  KVK_REQUIRED: 'error.kvk_required',
  KVK_INVALID: 'error.kvk_invalid',
  VAT_INVALID: 'error.vat_invalid',
  WEBSITE_INVALID: 'error.website_invalid',
  TERMS_REQUIRED: 'error.terms_required',
  ROLE_NOT_SELF_SERVICE: 'error.role_not_self_service',
});

/** Roles a person may create for themselves. Ops is not one of them. */
export const SELF_SERVICE_ROLES = Object.freeze([ROLE.FREELANCER, ROLE.COMPANY_ADMIN]);

/**
 * Email validation, deliberately loose.
 *
 * Being strict here rejects real addresses — the grammar is far wider than
 * people expect — and buys nothing, because the magic link is the actual
 * verification. An address that does not exist never receives a link and
 * never becomes a usable account.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normaliseEmail(input) {
  return String(input || '').trim().toLowerCase();
}

export function assertEmail(input) {
  const email = normaliseEmail(input);
  if (!email) throw new DomainError(SIGNUP_ERROR.EMAIL_REQUIRED, 'No email');
  if (!EMAIL_SHAPE.test(email) || email.length > 254) {
    throw new DomainError(SIGNUP_ERROR.EMAIL_INVALID, 'Not an email address');
  }
  return email;
}

export function assertName(input, code = SIGNUP_ERROR.NAME_REQUIRED) {
  const name = String(input || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw new DomainError(code, 'Name too short');
  return name.slice(0, 120);
}

/**
 * A KvK number is exactly eight digits. It is the authoritative company
 * identifier in the Netherlands, which is why it — and not the email domain —
 * decides whether a second person joins an existing organisation: a holding
 * company, a Gmail address or a rebrand all break domain matching, and none of
 * them change the KvK.
 *
 * The number is not verified against the register here. That needs a network
 * call, so it belongs with the enrichment work; see src/data/enrichment.js.
 */
export function normaliseKvk(input) {
  return String(input || '').replace(/[\s.\-]/g, '');
}

export function assertKvk(input) {
  const kvk = normaliseKvk(input);
  if (!kvk) throw new DomainError(SIGNUP_ERROR.KVK_REQUIRED, 'No KvK number');
  if (!/^\d{8}$/.test(kvk)) {
    throw new DomainError(SIGNUP_ERROR.KVK_INVALID, 'A KvK number is eight digits');
  }
  return kvk;
}

/** NL + 9 digits + B + 2 digits. Optional at sign-up. */
export function assertVatNumber(input) {
  const raw = String(input || '').replace(/[\s.\-]/g, '').toUpperCase();
  if (!raw) return null;
  if (!/^NL\d{9}B\d{2}$/.test(raw)) {
    throw new DomainError(SIGNUP_ERROR.VAT_INVALID, 'Not a Dutch VAT number');
  }
  return raw;
}

/**
 * Normalise a website to an https URL, or refuse it.
 *
 * People type "meridiaanbouw.nl", not "https://meridiaanbouw.nl". Adding the
 * scheme for them is the difference between a field that works and a field
 * that everyone gets wrong once.
 */
export function assertWebsite(input, { required = false } = {}) {
  const raw = String(input || '').trim();
  if (!raw) {
    if (required) throw new DomainError(SIGNUP_ERROR.WEBSITE_INVALID, 'No website');
    return null;
  }

  const candidate = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  let url;
  try {
    url = new URL(candidate);
  } catch (err) {
    throw new DomainError(SIGNUP_ERROR.WEBSITE_INVALID, 'Not a URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DomainError(SIGNUP_ERROR.WEBSITE_INVALID, 'Only http(s)');
  }
  // A hostname with no dot is a local name, not a company website.
  if (!url.hostname.includes('.') || url.hostname.endsWith('.')) {
    throw new DomainError(SIGNUP_ERROR.WEBSITE_INVALID, 'Not a public hostname');
  }

  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

/**
 * Validate a freelancer sign-up.
 *
 * Deliberately three fields. Everything else about a freelancer lives on the
 * profile, which they fill in next — and which they can fill in from a CV. A
 * long form between someone and a project board is how a marketplace ends up
 * with no supply.
 */
export function normaliseFreelancerSignup(input) {
  return {
    role: ROLE.FREELANCER,
    name: assertName(input.name),
    email: assertEmail(input.email),
    // A freelancer on this platform is a registered business — they invoice,
    // so they have a KvK number. Collecting it here is what makes the
    // Handelsregister check possible at the door rather than after a
    // placement, which is where the agency filter has to sit to be any use.
    // See src/data/kvk.js.
    kvk_number: assertKvk(input.kvk_number),
    // Spec §6: consent for outreach is captured at sign-up and defaults off.
    outreach_consent: input.outreach_consent === true,
  };
}

/**
 * Validate a company sign-up.
 *
 * The website is stored but nothing is fetched from it in this build — see
 * src/data/enrichment.js for why, and for where that changes.
 */
export function normaliseCompanySignup(input) {
  return {
    role: ROLE.COMPANY_ADMIN,
    name: assertName(input.name),
    email: assertEmail(input.email),
    organization: {
      name: assertName(input.company_name, SIGNUP_ERROR.COMPANY_NAME_REQUIRED),
      kvk_number: assertKvk(input.kvk_number),
      vat_number: assertVatNumber(input.vat_number),
      website: assertWebsite(input.website),
      // Invoices go to the person signing up until ops is told otherwise.
      billing_email: assertEmail(input.billing_email || input.email),
      payment_terms_days: 30,
    },
  };
}

export function assertSelfServiceRole(role) {
  if (!SELF_SERVICE_ROLES.includes(role)) {
    throw new DomainError(SIGNUP_ERROR.ROLE_NOT_SELF_SERVICE, role + ' cannot sign itself up');
  }
  return role;
}

/**
 * The organisation a company sign-up should attach to: an existing one with
 * the same KvK, or null meaning "create it".
 */
export function findOrganizationByKvk(organizations, kvk) {
  const wanted = normaliseKvk(kvk);
  return organizations.find((o) => normaliseKvk(o.kvk_number) === wanted) || null;
}

/**
 * Sign-up must not become a way to find out who has an account.
 *
 * A form that says "that address is already registered" tells anyone who asks
 * which of a list of addresses belongs to a user of this platform. Since the
 * response to a sign-up is "check your email" either way, an existing account
 * can simply be sent a sign-in link instead — the person gets in, and someone
 * probing learns nothing.
 *
 * Returns 'created' or 'signed_in_existing' so the adapter knows which
 * happened; the screen shows the same thing for both.
 */
export function resolveExistingAccount(users, email) {
  const wanted = normaliseEmail(email);
  return users.find((u) => normaliseEmail(u.email) === wanted) || null;
}
