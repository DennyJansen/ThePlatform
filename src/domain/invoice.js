/**
 * Building the documents a settled month produces. Pure functions.
 *
 * This is the part that must be right regardless of where the PDF is
 * eventually rendered — and it should NOT be rendered here. Spec §9 step 4
 * puts invoice generation server-side, and it belongs there: a browser that
 * can mint invoice numbers can mint two invoices with the same number.
 * `buildInvoiceSet` therefore takes its numbers as an argument and refuses to
 * invent them.
 *
 * Three documents, not the two spec §3 listed. The €2/hour fee is ex VAT,
 * which makes it a supply from the platform to the freelancer rather than a
 * discount on their rate, and a self-billed invoice is the freelancer's own
 * sales invoice — the platform's fee has no business on it. See
 * docs/open-items.md item 2.
 *
 *   1. platform   -> client       hours x client rate        + VAT
 *   2. freelancer -> platform     hours x freelancer rate    + VAT   (self-billed)
 *   3. platform   -> freelancer   hours x fee                + VAT
 *
 * Documents 2 and 3 are netted when the money moves. They are not netted
 * before VAT, and they are not one document.
 */

import { INVOICE_DIRECTION } from './model.js';
import {
  VAT_RATE_BP, lineTotalCents, vatCents, round2, formatHours,
} from './money.js';
import { formatMonth, addDays } from './dates.js';

export const INVOICE_ERROR = Object.freeze({
  NOT_APPROVED: 'error.invoice_not_approved',
  NO_HOURS: 'error.no_hours',
  NUMBER_REQUIRED: 'error.invoice_number_required',
  PARTY_INCOMPLETE: 'error.invoice_party_incomplete',
});

class InvoiceError extends Error {
  constructor(code, message, details = {}) {
    super(message || code);
    this.name = 'InvoiceError';
    this.code = code;
    this.details = details;
  }
}

/**
 * A party on an invoice. Dutch law wants the issuer's name, address, KvK and
 * BTW number on every invoice, so a party missing them is refused rather than
 * rendered with blanks — a document that looks like an invoice and is not
 * valid is worse than no document.
 *
 * `requireVat` is false for the freelancer only in the case where they are
 * genuinely not VAT-registered, which is not a case this platform supports
 * yet: the whole fee model assumes both sides charge VAT.
 */
function assertParty(party, label) {
  if (!party || !party.name || !party.kvk_number || !party.vat_number) {
    throw new InvoiceError(
      INVOICE_ERROR.PARTY_INCOMPLETE,
      label + ' is missing name, KvK or VAT number',
      { party: label },
    );
  }
  return {
    name: party.name,
    kvk_number: party.kvk_number,
    vat_number: party.vat_number,
    address: party.address || null,
    email: party.billing_email || party.email || null,
  };
}

function assertNumber(numbers, key) {
  const value = numbers && numbers[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvoiceError(
      INVOICE_ERROR.NUMBER_REQUIRED,
      'No invoice number supplied for ' + key,
      { direction: key },
    );
  }
  return value.trim();
}

/**
 * One document. `lines` are ex VAT; VAT is charged once on the subtotal, never
 * per line and summed, so the total here and the total on the confirmation
 * screen are arrived at the same way.
 */
function buildDocument({
  direction, number, issueDate, dueDate, seller, buyer, lines, vatRateBp, notes,
}) {
  const subtotal = lines.reduce((sum, line) => sum + line.amount, 0);
  const vat = vatCents(subtotal, vatRateBp);

  return {
    direction,
    number,
    issue_date: issueDate,
    due_date: dueDate,
    seller,
    buyer,
    lines,
    subtotal,
    vat_rate_bp: vatRateBp,
    vat_amount: vat,
    total: subtotal + vat,
    notes: notes || null,
    pdf: null,
  };
}

function periodLabel(period, locale) {
  return formatMonth(period.year, period.month, locale);
}

/**
 * Build all three documents for an approved period.
 *
 * @param {Object} input
 * @param {Object} input.period        must be `approved`
 * @param {number} input.hours         the approved total
 * @param {Object} input.assignment    carries all three rates
 * @param {Object} input.organization  the client
 * @param {Object} input.freelancer    name, kvk_number, vat_number
 * @param {Object} input.platform      the platform's own company details
 * @param {Object} input.numbers       { to_client, self_billed_to_freelancer,
 *                                       platform_fee_to_freelancer }
 * @param {string} input.issueDate     ISO date
 * @param {string} [input.locale]      for the period label on the line
 */
export function buildInvoiceSet(input) {
  const {
    period, hours, assignment, organization, freelancer, platform,
    numbers, issueDate, locale = 'nl-NL', vatRateBp = VAT_RATE_BP,
  } = input;

  if (!period || period.status !== 'approved') {
    throw new InvoiceError(
      INVOICE_ERROR.NOT_APPROVED,
      'Only an approved period may be invoiced',
      { status: period && period.status },
    );
  }
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new InvoiceError(INVOICE_ERROR.NO_HOURS, 'Nothing to invoice');
  }

  const quantity = round2(hours);
  const label = periodLabel(period, locale);
  const hoursText = formatHours(quantity, locale);

  const platformParty = assertParty(platform, 'platform');
  const clientParty = assertParty(organization, 'client');
  const freelancerParty = assertParty(freelancer, 'freelancer');

  const clientTerms = Number.isInteger(organization.payment_terms_days)
    ? organization.payment_terms_days
    : 30;

  /* 1. Platform -> client. */
  const toClient = buildDocument({
    direction: INVOICE_DIRECTION.TO_CLIENT,
    number: assertNumber(numbers, 'to_client'),
    issueDate,
    dueDate: addDays(issueDate + 'T00:00:00.000Z', clientTerms).slice(0, 10),
    seller: platformParty,
    buyer: clientParty,
    vatRateBp,
    lines: [{
      description: assignment.title + ' — ' + label + ' (' + freelancer.name + ')',
      quantity,
      unit: 'uur',
      unit_price: assignment.client_rate_per_hour,
      amount: lineTotalCents(quantity, assignment.client_rate_per_hour),
    }],
    notes: hoursText + ' uur, goedgekeurd door de opdrachtgever.',
  });

  /* 2. Freelancer -> platform, issued by the platform in their name.
   *
   * The self-billing note is not decoration: EU VAT rules allow an invoice to
   * be raised by the customer only where that is agreed in advance and the
   * document says so. Spec §8.1 is the clause this line depends on. */
  const selfBilled = buildDocument({
    direction: INVOICE_DIRECTION.SELF_BILLED_TO_FREELANCER,
    number: assertNumber(numbers, 'self_billed_to_freelancer'),
    issueDate,
    dueDate: null,
    seller: freelancerParty,
    buyer: platformParty,
    vatRateBp,
    lines: [{
      description: assignment.title + ' — ' + label,
      quantity,
      unit: 'uur',
      unit_price: assignment.freelancer_rate_per_hour,
      amount: lineTotalCents(quantity, assignment.freelancer_rate_per_hour),
    }],
    notes: 'Self-billing: deze factuur is namens ' + freelancer.name
      + ' opgesteld door ' + platformParty.name + '.',
  });

  /* 3. Platform -> freelancer. The fee, as its own supply. */
  const platformFee = buildDocument({
    direction: INVOICE_DIRECTION.PLATFORM_FEE_TO_FREELANCER,
    number: assertNumber(numbers, 'platform_fee_to_freelancer'),
    issueDate,
    dueDate: null,
    seller: platformParty,
    buyer: freelancerParty,
    vatRateBp,
    lines: [{
      description: 'Bemiddelingsvergoeding — ' + label,
      quantity,
      unit: 'uur',
      unit_price: assignment.freelancer_fee_per_hour,
      amount: lineTotalCents(quantity, assignment.freelancer_fee_per_hour),
    }],
    notes: 'Verrekend met factuur ' + selfBilled.number + '.',
  });

  return [toClient, selfBilled, platformFee];
}

/**
 * What actually moves between bank accounts once documents 2 and 3 are netted.
 * Kept separate from the documents because netting is a settlement decision,
 * not a VAT one — each document stands on its own for the tax return.
 */
export function settlement(documents) {
  const selfBilled = documents.find(
    (d) => d.direction === INVOICE_DIRECTION.SELF_BILLED_TO_FREELANCER,
  );
  const fee = documents.find(
    (d) => d.direction === INVOICE_DIRECTION.PLATFORM_FEE_TO_FREELANCER,
  );
  const toClient = documents.find((d) => d.direction === INVOICE_DIRECTION.TO_CLIENT);

  return {
    client_pays: toClient ? toClient.total : 0,
    freelancer_receives: (selfBilled ? selfBilled.total : 0) - (fee ? fee.total : 0),
    platform_margin_ex_vat: (toClient ? toClient.subtotal : 0)
      - (selfBilled ? selfBilled.subtotal : 0)
      + (fee ? fee.subtotal : 0),
  };
}

/**
 * Invoice numbering, as a pure function so the sequence rule is visible and
 * testable rather than buried in whichever function happens to insert a row.
 *
 * NOT SETTLED — see docs/open-items.md. The hard part is document 2: a
 * self-billed invoice carries the FREELANCER's number sequence, not the
 * platform's, and a freelancer who also invoices other clients directly has a
 * sequence of their own that this platform does not control. Issuing
 * `2026-0001` in their name while they have already used it is a real problem
 * and not one the code can decide.
 *
 * The format below is a placeholder with a per-issuer prefix, deliberately
 * ugly enough that nobody mistakes it for a decision.
 */
export function formatInvoiceNumber({ prefix, year, sequence }) {
  return prefix + '-' + year + '-' + String(sequence).padStart(4, '0');
}

export { InvoiceError };
