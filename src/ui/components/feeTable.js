/**
 * The money, laid out per audience.
 *
 * A freelancer confirming a submission must see what they will be paid; an
 * approver must see what their organisation will be invoiced. Neither needs to
 * see the platform's margin, so the platform table is ops-only.
 *
 * VAT: spec §8.9 / §10 asked how the per-hour deduction is treated. Answered —
 * the €2 is ex VAT, so it is a taxable supply from the platform to the
 * freelancer and carries 21% of its own. That makes two supplies, not one
 * netted amount, which is why the freelancer's table has two blocks and ends
 * on cash rather than on the ex-VAT net.
 */

import { el } from '../dom.js';
import { t, getIntlLocale } from '../../i18n/index.js';
import { formatMoney, formatHours, vatCents } from '../../domain/money.js';

function row(label, value, options = {}) {
  return el('tr', { class: options.strong ? 'fees__row fees__row--strong' : 'fees__row' }, [
    el('th', { scope: 'row' }, label),
    el('td', { class: 'num' }, value),
  ]);
}

/**
 * The freelancer's view: what the client is billed, and what lands in their
 * account after the per-hour deduction. Spec section 3's worked example.
 */
export function freelancerFeeTable(summary, assignment) {
  const locale = getIntlLocale();
  const money = (cents) => formatMoney(cents, locale);
  const vatPercent = (summary.vat_rate_bp || 2100) / 100;

  // Two supplies, shown as two blocks, because that is what they are: the
  // freelancer sells hours to the platform, the platform sells them an
  // intermediation service. VAT applies to each separately (spec §8.9), and
  // netting them before VAT would misstate both parties' turnover.
  //
  // The last line is cash, not the ex-VAT net. A freelancer checking a
  // confirmation wants to know what arrives in the bank; the €93 they "keep"
  // is only true after the VAT washes through their own return.
  return el('div', { class: 'fees' }, [
    el('table', { class: 'table fees__table' }, [
      el('caption', { class: 'visually-hidden' }, t('f2.confirm_your_invoice')),
      el('tbody', [
        row(t('f2.confirm_days'), String(summary.days_with_hours)),
        row(t('f2.confirm_hours'), formatHours(summary.total_hours, locale)),

        el('tr', { class: 'fees__section' }, [
          el('th', { scope: 'row', colspan: '2' }, t('f2.confirm_your_invoice')),
        ]),
        row(
          t('f2.confirm_gross', {
            rate: money(assignment.freelancer_rate_per_hour),
            hours: formatHours(summary.total_hours, locale),
          }),
          money(summary.freelancer_gross),
        ),
        row(t('f2.confirm_vat', { percent: String(vatPercent) }),
          money(summary.freelancer_gross_vat)),
        row(t('f2.confirm_incl'), money(summary.freelancer_gross_incl)),

        el('tr', { class: 'fees__section' }, [
          el('th', { scope: 'row', colspan: '2' }, t('f2.confirm_platform_invoice')),
        ]),
        row(
          t('f2.confirm_fee', { rate: money(assignment.freelancer_fee_per_hour) }),
          '−' + money(summary.freelancer_fee),
        ),
        row(t('f2.confirm_vat', { percent: String(vatPercent) }),
          '−' + money(summary.freelancer_fee_vat)),

        row(t('f2.confirm_cash'), money(summary.freelancer_cash), { strong: true }),
      ]),
    ]),
    el('p', { class: 'fees__note' }, t('f2.confirm_net_note', {
      amount: money(summary.freelancer_net),
    })),
  ]);
}

/** The approver's view: one number, the one their organisation is invoiced. */
export function clientFeeTable(summary) {
  const locale = getIntlLocale();
  return el('div', { class: 'fees' }, [
    el('table', { class: 'table fees__table' }, [
      el('caption', { class: 'visually-hidden' }, t('c1.total_to_invoice')),
      el('tbody', [
        row(t('f2.confirm_hours'), formatHours(summary.total_hours, locale)),
        summary.charges_total > 0
          ? row(t('f2.confirm_charges'), formatMoney(summary.charges_total, locale))
          : null,
        row(
          t('c1.total_to_invoice'),
          formatMoney(summary.client_total_with_charges, locale),
          { strong: true },
        ),
        // The client reclaims VAT, so the ex-VAT figure is the one that costs
        // them anything — but the invoice they pay says the gross amount, and
        // an approver comparing the two should not have to do the sum.
        row(
          t('f2.confirm_incl'),
          formatMoney(summary.client_total_incl
            + vatCents(summary.charges_total || 0), locale),
        ),
      ].filter(Boolean)),
    ]),
    el('p', { class: 'fees__note' }, t('common.ex_vat')),
  ]);
}

/** Ops only. Never rendered for a freelancer or an approver. */
export function platformFeeTable(summary) {
  const locale = getIntlLocale();
  const money = (cents) => formatMoney(cents, locale);
  return el('div', { class: 'fees' }, [
    el('table', { class: 'table fees__table' }, [
      el('caption', { class: 'visually-hidden' }, t('fee.platform_take')),
      el('tbody', [
        row(t('fee.client_total'), money(summary.client_total)),
        row(t('fee.freelancer_gross'), money(summary.freelancer_gross)),
        row(t('fee.freelancer_fee'), money(summary.freelancer_fee)),
        row(t('fee.freelancer_net'), money(summary.freelancer_net)),
        row(t('fee.platform_take'), money(summary.platform_take), { strong: true }),
      ]),
    ]),
  ]);
}
