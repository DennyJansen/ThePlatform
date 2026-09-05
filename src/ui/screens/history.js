/**
 * F3 - Freelancer: history. Spec section 4.
 *
 * "Reverse-chronological list of periods: month, hours, status, invoice PDF
 * link when available. Nothing else."
 *
 * Invoices arrive in step 4 of the build sequence, so the column renders an
 * honest "no invoice yet" rather than being hidden and reappearing later.
 * The version count is shown only where a month actually has more than one,
 * which is how a freelancer notices a correction without being told about
 * versioning as a concept.
 */

import { el, clear, append, focusHeading } from '../dom.js';
import { t, tError, getIntlLocale } from '../../i18n/index.js';
import { statusBadge, table, emptyState, notice } from '../components/ui.js';
import { formatMonth } from '../../domain/dates.js';
import { formatMoney, formatHours } from '../../domain/money.js';

export async function renderHistory(container, { adapter }) {
  clear(container);
  append(container, el('p', { class: 'loading' }, t('common.loading')));

  let assignments;
  let rows;
  try {
    assignments = await adapter.listAssignments();
    if (assignments.length === 0) {
      clear(container);
      append(container, notice('info', null, t('f2.no_assignment')));
      return;
    }
    rows = await adapter.listPeriods(assignments[0].id);
  } catch (err) {
    clear(container);
    append(container, notice('error', null, tError(err)));
    return;
  }

  const locale = getIntlLocale();
  clear(container);

  if (rows.length === 0) {
    append(container, [
      el('h1', { class: 'screen__title' }, t('f3.title')),
      emptyState(t('f3.title'), t('f3.empty')),
    ]);
    focusHeading(container);
    return;
  }

  const body = rows.map((row) => el('tr', [
    el('th', { scope: 'row' }, [
      el('a', {
        class: 'link',
        href: '#/period/' + encodeURIComponent(row.period_id),
      }, formatMonth(row.year, row.month, locale)),
      row.versions > 1
        ? el('span', { class: 'row-note' }, t('f3.versions', { n: row.versions }))
        : null,
    ]),
    el('td', { class: 'num' }, formatHours(row.total_hours, locale)),
    el('td', { class: 'num' }, formatMoney(row.client_total, locale)),
    el('td', statusBadge(row.status)),
    el('td', row.invoice_pdf
      ? el('a', { class: 'link', href: row.invoice_pdf, rel: 'noopener' }, t('f3.invoice'))
      : el('span', { class: 'muted' }, t('f3.no_invoice'))),
  ]));

  append(container, [
    el('h1', { class: 'screen__title' }, t('f3.title')),
    table(t('f3.title'), [
      { label: t('f3.month') },
      { label: t('f3.hours'), numeric: true },
      { label: t('f3.amount'), numeric: true },
      { label: t('f3.status') },
      { label: t('f3.invoice') },
    ], body),
  ]);

  focusHeading(container);
}
