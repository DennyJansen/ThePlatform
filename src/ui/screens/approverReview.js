/**
 * C1 - Client: approval view. Spec section 4.
 *
 * The landing page for an approver, empty eleven days out of twelve. The empty
 * state says what is expected and when, not "no data" - because for most of
 * the month that empty screen IS the product, and it should reassure rather
 * than look broken.
 *
 * The period renders through the same components as F2, read-only, plus the
 * decision controls. Approve-all or reject-with-a-reason; no partial approval
 * of hours in v1.
 *
 * Charges are decided separately from hours (spec section 4/C1) so a disputed
 * parking claim cannot hold up a month of approved work. The charges section
 * lands with step 6 of the build sequence; the separation is already in the
 * data model and in the adapter, so adding the UI does not disturb this file.
 */

import { el, clear, append, focusHeading, announce } from '../dom.js';
import { t, tError, getIntlLocale } from '../../i18n/index.js';
import { statusBadge, notice, confirmDialog, emptyState, definitionList } from '../components/ui.js';
import { entryGrid } from '../components/entryGrid.js';
import { clientFeeTable } from '../components/feeTable.js';
import { formatMonth, formatDate, formatDateTime } from '../../domain/dates.js';
import { formatMoney, formatHours, clientRate } from '../../domain/money.js';
import { navigate } from '../../app/router.js';

/* ------------------------------------------------------------------ *
 * Inbox
 * ------------------------------------------------------------------ */

export async function renderInbox(container, { adapter }) {
  clear(container);
  append(container, el('p', { class: 'loading' }, t('common.loading')));

  let pending;
  let assignments;
  try {
    pending = await adapter.listAwaitingDecision();
    assignments = await adapter.listAssignments();
  } catch (err) {
    clear(container);
    append(container, notice('error', null, tError(err)));
    return;
  }

  const locale = getIntlLocale();
  clear(container);

  if (pending.length === 0) {
    const freelancerName = assignments.length > 0 ? assignments[0].freelancer_name : null;
    append(container, [
      el('h1', { class: 'screen__title' }, t('c1.title')),
      emptyState(
        t('c1.empty_title'),
        freelancerName
          ? t('c1.empty_body', { name: freelancerName })
          : t('c1.empty_body_generic'),
        assignments.length > 0
          ? el('a', {
            class: 'btn btn--ghost',
            href: '#/assignment/' + encodeURIComponent(assignments[0].id),
          }, t('c2.title'))
          : null,
      ),
    ]);
    focusHeading(container);
    return;
  }

  // One submitted period is the normal case; the list handles more without
  // becoming a dashboard.
  if (pending.length === 1) {
    navigate('/review/' + encodeURIComponent(pending[0].period.id), { replace: true });
    return;
  }

  append(container, [
    el('h1', { class: 'screen__title' }, t('c1.title')),
    el('ul', { class: 'card-list' }, pending.map((view) => el('li', { class: 'card' }, [
      el('a', {
        class: 'card__link',
        href: '#/review/' + encodeURIComponent(view.period.id),
      }, [
        el('span', { class: 'card__title card__title--month' },
          formatMonth(view.period.year, view.period.month, locale)),
        el('span', { class: 'card__meta' }, [
          view.freelancer ? view.freelancer.name : '',
          el('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
          formatHours(view.summary.total_hours, locale) + ' ' + t('common.hours_short'),
          el('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
          formatMoney(view.summary.client_total_with_charges, locale),
        ]),
      ]),
    ]))),
  ]);
  focusHeading(container);
}

/* ------------------------------------------------------------------ *
 * Review
 * ------------------------------------------------------------------ */

export async function renderReview(container, { adapter, periodId }) {
  clear(container);
  append(container, el('p', { class: 'loading' }, t('common.loading')));

  let view;
  try {
    view = await adapter.getPeriod(periodId);
  } catch (err) {
    clear(container);
    append(container, notice('error', null, tError(err)));
    return;
  }

  draw(view);

  function draw(current) {
    const locale = getIntlLocale();
    const decidable = current.period.status === 'submitted';
    clear(container);

    const grid = entryGrid({
      period: current.period,
      assignment: current.assignment,
      entries: current.entries,
      readOnly: true,
    });

    async function approve() {
      const result = await confirmDialog({
        title: t('c1.approve_confirm_title'),
        lead: t('c1.approve_confirm_body', {
          hours: formatHours(current.summary.total_hours, locale),
          amount: formatMoney(current.summary.client_total_with_charges, locale),
          org: current.organization ? current.organization.name : '',
        }),
        confirmLabel: t('c1.approve_confirm_commit'),
        onConfirm: async () => {
          try {
            return await adapter.approvePeriod(current.period.id);
          } catch (err) {
            const wrapped = new Error(tError(err));
            wrapped.userMessage = tError(err);
            throw wrapped;
          }
        },
      });
      if (result && result.period) {
        announce(t('c1.approved_body'));
        draw(result);
      }
    }

    async function reject() {
      const comment = el('textarea', {
        class: 'input input--area',
        id: 'reject-comment',
        rows: '4',
        required: true,
        placeholder: t('c1.reject_comment_placeholder'),
      });

      const result = await confirmDialog({
        title: t('c1.reject_title'),
        lead: t('c1.reject_lead'),
        danger: true,
        confirmLabel: t('c1.reject_commit'),
        body: el('div', { class: 'field' }, [
          el('label', { class: 'label', for: 'reject-comment' }, t('c1.reject_comment_label')),
          comment,
        ]),
        onConfirm: async () => {
          try {
            // Returns the successor draft; the approver does not follow it,
            // so only the decision is reported back here.
            await adapter.rejectPeriod(current.period.id, comment.value);
            return await adapter.getPeriod(current.period.id);
          } catch (err) {
            const wrapped = new Error(tError(err));
            wrapped.userMessage = tError(err);
            throw wrapped;
          }
        },
      });

      if (result && result.period) {
        announce(t('c1.rejected_body'));
        draw(result);
      }
    }

    const decided = current.period.status === 'approved' || current.period.status === 'rejected';

    append(container, [
      el('div', { class: 'period-head' }, [
        el('div', { class: 'period-head__main' }, [
          el('p', { class: 'period-head__client' },
            current.freelancer ? current.freelancer.name : ''),
          el('h1', { class: 'period-head__title period-head__title--month' },
            formatMonth(current.period.year, current.period.month, locale)),
          el('p', { class: 'period-head__meta' }, [
            current.assignment.title,
            current.period.submitted_at
              ? [
                el('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
                t('c1.submitted_at', {
                  date: formatDateTime(current.period.submitted_at, locale),
                }),
              ]
              : null,
            current.period.version > 1
              ? [
                el('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
                t('common.version', { n: current.period.version }),
              ]
              : null,
          ]),
        ]),
        el('div', { class: 'period-head__status' }, statusBadge(current.period.status)),
      ]),

      decided
        ? notice(
          current.period.status === 'approved' ? 'success' : 'warn',
          t('c1.decided_title'),
          current.period.status === 'approved' ? t('c1.approved_body') : t('c1.rejected_body'),
          current.period.rejection_comment
            ? el('blockquote', { class: 'quote' }, current.period.rejection_comment)
            : null,
        )
        : null,

      // Spec section 7: a due date is only shown when something happens on it.
      // auto_approve_enabled is false in v1, so this stays hidden by design.
      decidable && current.due_date && current.due_date_is_binding
        ? el('p', { class: 'hint' }, t('c1.due_hint', {
          date: formatDate(current.due_date, locale),
        }))
        : null,

      el('div', { class: 'review__grid' }, [
        el('section', { class: 'review__days' }, [
          el('h2', { class: 'section__title' }, t('c1.breakdown')),
          grid.node,
        ]),
        el('aside', { class: 'review__summary' }, [
          el('h2', { class: 'section__title' }, t('c1.total_to_invoice')),
          clientFeeTable(current.summary),
          definitionList([
            [t('period.rate'), t('period.rate_unit_ex_vat', {
              amount: formatMoney(clientRate(current.assignment.agreed_rate_per_hour,
                current.assignment.client_fee_per_hour), locale),
            })],
          ]),
        ]),
      ]),

      decidable
        ? el('div', { class: 'actions actions--end' }, [
          el('button', {
            type: 'button',
            class: 'btn btn--ghost',
            onclick: () => reject(),
          }, t('c1.reject')),
          el('button', {
            type: 'button',
            class: 'btn btn--primary',
            onclick: () => approve(),
          }, t('c1.approve')),
        ])
        : el('div', { class: 'actions actions--end' }, [
          el('a', { class: 'btn btn--ghost', href: '#/inbox' }, t('common.back')),
        ]),
    ]);

    focusHeading(container);
  }
}
