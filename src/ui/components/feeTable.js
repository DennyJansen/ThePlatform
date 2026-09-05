/**
 * The money, laid out per audience.
 *
 * A freelancer confirming a submission must see what they will be paid; an
 * approver must see what their organisation will be invoiced. Neither needs to
 * see the platform's margin, so `showPlatform` is off unless ops is looking.
 * All figures are ex-VAT, and say so, because VAT treatment of the hourly
 * deduction is still an open item (spec section 10).
 */

import { el } from '../dom.js';
import { t, getIntlLocale } from '../../i18n/index.js';
import { formatMoney, formatHours } from '../../domain/money.js';

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

  return el('div', { class: 'fees' }, [
    el('table', { class: 'table fees__table' }, [
      el('caption', { class: 'visually-hidden' }, t('f2.confirm_your_invoice')),
      el('tbody', [
        row(t('f2.confirm_days'), String(summary.days_with_hours)),
        row(t('f2.confirm_hours'), formatHours(summary.total_hours, locale)),
        row(
          t('f2.confirm_gross', {
            rate: money(assignment.freelancer_rate_per_hour),
            hours: formatHours(summary.total_hours, locale),
          }),
          money(summary.freelancer_gross),
        ),
        row(
          t('f2.confirm_fee', { rate: money(assignment.freelancer_fee_per_hour) }),
          '−' + money(summary.freelancer_fee),
        ),
        row(t('f2.confirm_net'), money(summary.freelancer_net), { strong: true }),
      ]),
    ]),
    el('p', { class: 'fees__note' }, t('common.ex_vat')),
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
