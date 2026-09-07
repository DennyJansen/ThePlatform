/**
 * Invoice construction.
 *
 * The tests that carry weight:
 *
 *  - three documents, not two, and the fee is never a line on the self-billed
 *    invoice. That is the whole point of the "ex VAT" answer.
 *  - the numbers on the documents equal the numbers on the confirmation screen
 *    the freelancer already agreed to. If those two ever disagree, the system
 *    has failed at the one thing spec §3 says it exists to do.
 *  - a party missing its KvK or BTW number produces no document at all.
 */

import { describe, it, assert } from './runner.js';

import { INVOICE_DIRECTION } from '../domain/model.js';
import {
  INVOICE_ERROR, buildInvoiceSet, settlement, formatInvoiceNumber,
} from '../domain/invoice.js';
import { computeFees, vatCents } from '../domain/money.js';

/* ------------------------------------------------------------------ */

const ASSIGNMENT = Object.freeze({
  id: 'asg_1',
  title: 'Interim werkvoorbereider',
  client_rate_per_hour: 10000,
  freelancer_rate_per_hour: 9500,
  freelancer_fee_per_hour: 200,
});

const PERIOD = Object.freeze({
  id: 'per_1', assignment_id: 'asg_1', year: 2026, month: 9, status: 'approved',
});

const PLATFORM = Object.freeze({
  name: 'Densen B.V.',
  kvk_number: '90000001',
  vat_number: 'NL800000001B01',
  address: 'Postbus 1, Amersfoort',
  billing_email: 'facturen@densen.nl',
});

const CLIENT = Object.freeze({
  name: 'Meridiaan Bouwgroep B.V.',
  kvk_number: '84213977',
  vat_number: 'NL863412955B01',
  billing_email: 'crediteuren@meridiaanbouw.nl',
  payment_terms_days: 30,
});

const FREELANCER = Object.freeze({
  name: 'Sanne de Vries',
  kvk_number: '77000123',
  vat_number: 'NL001234567B01',
  email: 'sanne@example.com',
});

const NUMBERS = Object.freeze({
  to_client: 'PF-2026-0001',
  self_billed_to_freelancer: 'SV-2026-0007',
  platform_fee_to_freelancer: 'PF-2026-0002',
});

function build(overrides = {}) {
  return buildInvoiceSet({
    period: PERIOD,
    hours: 168,
    assignment: ASSIGNMENT,
    organization: CLIENT,
    freelancer: FREELANCER,
    platform: PLATFORM,
    numbers: NUMBERS,
    issueDate: '2026-10-01',
    ...overrides,
  });
}

const byDirection = (docs, direction) => docs.find((d) => d.direction === direction);

/* ------------------------------------------------------------------ */

describe('Invoices — three documents, because the fee is a supply', () => {
  it('produces exactly three, one per direction', () => {
    const docs = build();
    assert.equal(docs.length, 3);
    assert.deepEqual(docs.map((d) => d.direction), [
      INVOICE_DIRECTION.TO_CLIENT,
      INVOICE_DIRECTION.SELF_BILLED_TO_FREELANCER,
      INVOICE_DIRECTION.PLATFORM_FEE_TO_FREELANCER,
    ]);
  });

  it('never puts the platform fee on the freelancer’s own invoice', () => {
    const selfBilled = byDirection(build(), INVOICE_DIRECTION.SELF_BILLED_TO_FREELANCER);
    assert.equal(selfBilled.lines.length, 1, 'one line: the hours, at their rate');
    assert.equal(selfBilled.subtotal, 1596000, '168h at 95.00, undiminished');
    assert.ok(selfBilled.lines.every((l) => l.amount > 0),
      'a negative line here would understate the freelancer’s turnover');
  });

  it('bills the fee from the platform to the freelancer, with its own VAT', () => {
    const fee = byDirection(build(), INVOICE_DIRECTION.PLATFORM_FEE_TO_FREELANCER);
    assert.equal(fee.seller.name, PLATFORM.name);
    assert.equal(fee.buyer.name, FREELANCER.name);
    assert.equal(fee.subtotal, 33600, '168h at 2.00');
    assert.equal(fee.vat_amount, 7056);
    assert.equal(fee.total, 40656);
  });

  it('sells hours from the freelancer to the platform, not the other way round', () => {
    const selfBilled = byDirection(build(), INVOICE_DIRECTION.SELF_BILLED_TO_FREELANCER);
    assert.equal(selfBilled.seller.name, FREELANCER.name);
    assert.equal(selfBilled.buyer.name, PLATFORM.name);
    assert.ok(/self-billing/i.test(selfBilled.notes),
      'EU VAT rules require the document to say it was raised by the customer');
  });

  it('bills the client at the client rate and nobody else’s', () => {
    const toClient = byDirection(build(), INVOICE_DIRECTION.TO_CLIENT);
    assert.equal(toClient.seller.name, PLATFORM.name);
    assert.equal(toClient.buyer.name, CLIENT.name);
    assert.equal(toClient.subtotal, 1680000, '168h at 100.00');
    assert.equal(toClient.total, 2032800);
    assert.equal(toClient.due_date, '2026-10-31', '30 day terms from the issue date');
  });
});

describe('Invoices — the numbers match what was approved', () => {
  it('agrees with computeFees on every figure', () => {
    const fees = computeFees(ASSIGNMENT, 168);
    const docs = build();

    assert.equal(byDirection(docs, INVOICE_DIRECTION.TO_CLIENT).subtotal,
      fees.client_total);
    assert.equal(byDirection(docs, INVOICE_DIRECTION.TO_CLIENT).total,
      fees.client_total_incl);
    assert.equal(byDirection(docs, INVOICE_DIRECTION.SELF_BILLED_TO_FREELANCER).total,
      fees.freelancer_gross_incl);
    assert.equal(byDirection(docs, INVOICE_DIRECTION.PLATFORM_FEE_TO_FREELANCER).total,
      fees.freelancer_fee_incl);
  });

  it('nets to the cash figure the freelancer was shown before submitting', () => {
    const fees = computeFees(ASSIGNMENT, 168);
    const money = settlement(build());
    assert.equal(money.freelancer_receives, fees.freelancer_cash,
      'the confirmation screen and the invoices must not disagree');
    assert.equal(money.client_pays, fees.client_total_incl);
  });

  it('keeps the platform margin at the ex-VAT figure from spec §3', () => {
    const money = settlement(build());
    assert.equal(money.platform_margin_ex_vat, 168 * 700, '7.00 an hour');
  });

  it('charges VAT once on the subtotal', () => {
    for (const hours of [1, 7.25, 168, 173.75]) {
      const docs = build({ hours });
      for (const doc of docs) {
        assert.equal(doc.vat_amount, vatCents(doc.subtotal),
          doc.direction + ' at ' + hours + ' hours');
        assert.equal(doc.total, doc.subtotal + doc.vat_amount);
      }
    }
  });
});

describe('Invoices — refusals', () => {
  it('will not invoice a period that was not approved', async () => {
    for (const status of ['draft', 'submitted', 'rejected', 'invoiced', 'paid']) {
      await assert.throws(
        () => build({ period: { ...PERIOD, status } }),
        INVOICE_ERROR.NOT_APPROVED,
        status + ' must not be invoiceable',
      );
    }
  });

  it('will not invoice nothing', async () => {
    await assert.throws(() => build({ hours: 0 }), INVOICE_ERROR.NO_HOURS);
    await assert.throws(() => build({ hours: -5 }), INVOICE_ERROR.NO_HOURS);
  });

  it('refuses a party without a KvK or VAT number', async () => {
    await assert.throws(
      () => build({ platform: { ...PLATFORM, vat_number: '' } }),
      INVOICE_ERROR.PARTY_INCOMPLETE,
      'an invoice without the issuer’s BTW number is not a valid invoice',
    );
    await assert.throws(
      () => build({ freelancer: { ...FREELANCER, kvk_number: '' } }),
      INVOICE_ERROR.PARTY_INCOMPLETE,
    );
    await assert.throws(
      () => build({ organization: { ...CLIENT, name: '' } }),
      INVOICE_ERROR.PARTY_INCOMPLETE,
    );
  });

  it('refuses to invent an invoice number', async () => {
    await assert.throws(
      () => build({ numbers: { ...NUMBERS, self_billed_to_freelancer: '' } }),
      INVOICE_ERROR.NUMBER_REQUIRED,
      'a browser that can mint numbers can mint two invoices with the same one',
    );
    await assert.throws(() => build({ numbers: {} }), INVOICE_ERROR.NUMBER_REQUIRED);
  });
});

describe('Invoices — numbering', () => {
  it('formats a padded, per-issuer sequence', () => {
    assert.equal(
      formatInvoiceNumber({ prefix: 'PF', year: 2026, sequence: 7 }),
      'PF-2026-0007',
    );
    assert.equal(
      formatInvoiceNumber({ prefix: 'SV', year: 2026, sequence: 1234 }),
      'SV-2026-1234',
    );
  });

  it('carries a different sequence on the self-billed document', () => {
    const docs = build();
    const selfBilled = byDirection(docs, INVOICE_DIRECTION.SELF_BILLED_TO_FREELANCER);
    const toClient = byDirection(docs, INVOICE_DIRECTION.TO_CLIENT);
    // Not a preference: a self-billed invoice is the freelancer's own sales
    // invoice and belongs to their sequence, not the platform's. Whose
    // sequence, and how to avoid colliding with invoices they raise
    // themselves, is unresolved. See docs/open-items.md.
    assert.ok(!selfBilled.number.startsWith('PF-'),
      'the self-billed invoice must not use the platform’s sequence');
    assert.ok(toClient.number.startsWith('PF-'));
  });
});
