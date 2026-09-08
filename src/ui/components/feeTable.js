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
export function freelancerFeeTable(summary) {
  const locale = getIntlLocale();
  const money = (cents) => formatMoney(cents, locale);
  const vatPercent = (summary.vat_rate_bp || 2100) / 100;

  // The agreed rate, their own fee, what they invoice. The client fee is left
  // out because it is not part of this calculation, not because it is a
  // secret — the two parties are free to compare fees and the terms say what
  // each pays. This table answers one question: what do I invoice.
  return el('div', { class: 'fees' }, [
    el('table', { class: 'table fees__table' }, [
      el('caption', { class: 'visually-hidden' }, t('f2.confirm_your_invoice')),
      el('tbody', [
        row(t('f2.confirm_days'), String(summary.days_with_hours)),
        row(t('f2.confirm_hours'), formatHours(summary.total_hours, locale)),

        row(
          t('f2.confirm_agreed', {
            rate: money(summary.agreed_rate_per_hour),
            hours: formatHours(summary.total_hours, locale),
          }),
          money(summary.agreed_total),
        ),
        row(
          t('f2.confirm_fee', { rate: money(summary.freelancer_fee_per_hour) }),
          '−' + money(summary.freelancer_fee_total),
        ),
        row(t('f2.confirm_you_invoice'), money(summary.freelancer_total), { strong: true }),

        row(t('f2.confirm_vat', { percent: String(vatPercent) }),
          money(summary.freelancer_total_vat)),
        row(t('f2.confirm_incl'), money(summary.freelancer_total_incl), { strong: true }),
      ]),
    ]),
    el('p', { class: 'fees__note' }, t('f2.confirm_net_note')),
  ]);
}

/**
 * The approver's view: the agreed rate, their own fee, what they are invoiced.
 * The mirror image of the freelancer's table, and omits the freelancer's fee
 * for the same reason — it is not part of this sum, not because it is hidden.
 */
export function clientFeeTable(summary) {
  const locale = getIntlLocale();
  const money = (cents) => formatMoney(cents, locale);
  const vatPercent = (summary.vat_rate_bp || 2100) / 100;
  const chargesVat = vatCents(summary.charges_total || 0);

  return el('div', { class: 'fees' }, [
    el('table', { class: 'table fees__table' }, [
      el('caption', { class: 'visually-hidden' }, t('c1.total_to_invoice')),
      el('tbody', [
        row(t('f2.confirm_hours'), formatHours(summary.total_hours, locale)),
        row(
          t('f2.confirm_agreed', {
            rate: money(summary.agreed_rate_per_hour),
            hours: formatHours(summary.total_hours, locale),
          }),
          money(summary.agreed_total),
        ),
        row(
          t('c1.client_fee', { rate: money(summary.client_fee_per_hour) }),
          money(summary.client_fee_total),
        ),
        summary.charges_total > 0
          ? row(t('f2.confirm_charges'), money(summary.charges_total))
          : null,
        row(
          t('c1.total_to_invoice'),
          money(summary.client_total_with_charges),
          { strong: true },
        ),
        // The client reclaims VAT, so the ex-VAT figure is what it costs them —
        // but the invoice they pay says the gross amount, and an approver
        // comparing the two should not have to do the sum.
        row(t('f2.confirm_vat', { percent: String(vatPercent) }),
          money(summary.client_total_vat + chargesVat)),
        row(t('f2.confirm_incl'),
          money(summary.client_total_incl + chargesVat), { strong: true }),
      ].filter(Boolean)),
    ]),
    el('p', { class: 'fees__note' }, t('common.ex_vat')),
  ]);
}

/**
 * Ops only — the one view that sees both sides at once. Never rendered for a
 * freelancer or an approver.
 */
export function platformFeeTable(summary) {
  const locale = getIntlLocale();
  const money = (cents) => formatMoney(cents, locale);
  return el('div', { class: 'fees' }, [
    el('table', { class: 'table fees__table' }, [
      el('caption', { class: 'visually-hidden' }, t('fee.platform_take')),
      el('tbody', [
        row(t('fee.client_total'), money(summary.client_total)),
        row(t('fee.client_fee'), money(summary.client_fee_total)),
        row(t('fee.agreed_total'), money(summary.agreed_total)),
        row(t('fee.freelancer_fee'), money(summary.freelancer_fee_total)),
        row(t('fee.freelancer_total'), money(summary.freelancer_total)),
        row(t('fee.platform_take'), money(summary.platform_take), { strong: true }),
      ]),
    ]),
  ]);
}
