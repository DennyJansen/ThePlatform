/**
 * C2 - Client: assignment detail. Spec section 4.
 *
 * "Freelancer name, dates, rate, contract PDF, hours-to-date, spend-to-date.
 * Read only. No budget-setting field, no scheduling, no 'assign work' action."
 *
 * COMPLIANCE, spec section 6: this screen is where a client-visible schedule
 * or an expected-hours field would feel natural to add. It must not acquire
 * one. Nothing here is editable by the client, by design.
 *
 * One deliberate deviation from the six-screen list: the audit trail is shown
 * at the bottom of this page as a collapsed section rather than as a seventh
 * screen. Spec section 2 puts the audit trail in the ops admin panel, and in
 * the Supabase build it will live there - but this build has no admin panel,
 * and an append-only log nobody can read is a log nobody can check. Deleting
 * the <details> block below removes it cleanly.
 */

import { el, clear, append, focusHeading } from '../dom.js';
import { t, tError, getIntlLocale } from '../../i18n/index.js';
import { definitionList, notice, table } from '../components/ui.js';
import { formatDate, formatDateTime } from '../../domain/dates.js';
import { formatMoney, formatHours } from '../../domain/money.js';

/**
 * Render an audit row's action using the payload it carries.
 *
 * Audit rows are history: a row written by an older build may not carry every
 * field the current label wants. Rather than showing a reader a literal
 * "{total_hours}", any placeholder the payload cannot fill is dropped along
 * with the fragment that trails it. An unknown action falls back to its raw
 * name, which is the honest thing for a log.
 */
function describeAction(event) {
  const key = 'action.' + event.action;
  const label = t(key, event.payload_json || {});
  if (label === key) return event.action;
  return label
    .replace(/,?\s*\{[a-z_]+\}[^,]*/gi, '')
    .replace(/\s+—\s*$/, '')
    .trim();
}

export async function renderAssignmentDetail(container, { adapter, assignmentId }) {
  clear(container);
  append(container, el('p', { class: 'loading' }, t('common.loading')));

  let assignment;
  let summaryRow;
  let audit = [];
  try {
    const list = await adapter.listAssignments();
    const target = assignmentId
      ? list.find((a) => a.id === assignmentId)
      : list[0];
    if (!target) {
      clear(container);
      append(container, notice('info', null, t('error.not_found')));
      return;
    }
    summaryRow = target;
    assignment = await adapter.getAssignment(target.id);
    audit = await adapter.listAuditEvents(target.id);
  } catch (err) {
    clear(container);
    append(container, notice('error', null, tError(err)));
    return;
  }

  const locale = getIntlLocale();
  clear(container);

  const term = [
    formatDate(assignment.start_date, locale),
    ' – ',
    assignment.end_date ? formatDate(assignment.end_date, locale) : t('c2.ongoing'),
  ].join('');

  append(container, [
    el('div', { class: 'period-head' }, [
      el('div', { class: 'period-head__main' }, [
        el('p', { class: 'period-head__client' },
          assignment.organization ? assignment.organization.name : ''),
        el('h1', { class: 'period-head__title' }, assignment.title),
      ]),
    ]),

    // A hire on the marketplace creates a pending assignment. Saying so here
    // is the difference between "the platform is slow" and "the platform is
    // waiting on a signature".
    assignment.status === 'pending'
      ? notice('warn', t('c2.pending_title'), t('c2.pending_body'))
      : null,

    definitionList([
      [t('period.freelancer'), assignment.freelancer ? assignment.freelancer.name : t('common.none')],
      [t('period.approver'), assignment.approver ? assignment.approver.name : t('common.none')],
      [t('c2.dates'), term],
      [t('period.rate'), t('period.rate_unit', {
        amount: formatMoney(assignment.client_rate_per_hour, locale),
      }), t('common.ex_vat')],
      [t('c2.contract'), assignment.contract_pdf
        ? el('a', { class: 'link', href: assignment.contract_pdf, rel: 'noopener' },
          t('c2.contract_download'))
        : el('span', { class: 'muted' }, t('c2.no_contract'))],
      // Spec section 10 leaves the payer of the fixed fee open. Saying so is
      // better than picking one and quietly showing it as settled.
      assignment.fixed_fee_amount
        ? [t('c2.fixed_fee'), formatMoney(assignment.fixed_fee_amount, locale),
          assignment.fixed_fee_payer ? null : t('c2.fixed_fee_undecided')]
        : null,
    ], { class: 'dl--split' }),

    el('div', { class: 'stats' }, [
      el('div', { class: 'stat' }, [
        el('span', { class: 'stat__label' }, t('c2.hours_to_date')),
        el('span', { class: 'stat__value' }, formatHours(summaryRow.hours_to_date, locale)),
      ]),
      el('div', { class: 'stat' }, [
        el('span', { class: 'stat__label' }, t('c2.spend_to_date')),
        el('span', { class: 'stat__value' }, formatMoney(summaryRow.spend_to_date, locale)),
      ]),
    ]),
    el('p', { class: 'hint' }, t('c2.settled_only')),

    // See the file header: audit trail lives here until ops has an admin panel.
    el('details', { class: 'audit' }, [
      el('summary', { class: 'audit__summary' }, t('audit.title')),
      el('p', { class: 'hint' }, t('audit.lead')),
      audit.length === 0
        ? el('p', { class: 'muted' }, t('audit.empty'))
        : table(t('audit.title'), [
          { label: t('audit.when') },
          { label: t('audit.actor') },
          { label: t('audit.what') },
        ], audit.map((event) => el('tr', [
          el('td', { class: 'audit__when' }, formatDateTime(event.created_at, locale)),
          el('td', event.actor_name),
          el('td', describeAction(event)),
        ]))),
    ]),
  ]);

  focusHeading(container);
}
