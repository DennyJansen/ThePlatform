/**
 * M3 — the freelancer's applications, and the screening call.
 *
 * The screening step is where the company invites and the freelancer confirms.
 * There is no calendar integration and none planned: spec §5 says email is the
 * real interface, and scheduling is a product of its own. What this screen does
 * is make both sides agree on one recorded time, so nobody is comparing two
 * versions of when the call was.
 */

import { el, clear, append, focusHeading, announce } from '../dom.js';
import { t, tError, getIntlLocale } from '../../i18n/index.js';
import { notice, emptyState, labelBadge, confirmDialog } from '../components/ui.js';
import { formatMoney } from '../../domain/money.js';
import { formatDate, formatDateTime } from '../../domain/dates.js';

/** A proposed slot is "2026-10-07T10:00" — local wall time, no timezone. */
function formatSlot(slot, locale) {
  if (!slot) return '';
  return formatDateTime(slot + ':00', locale);
}

export async function renderApplications(container, { adapter }) {
  await load();

  async function load() {
    clear(container);
    append(container, el('p', { class: 'loading' }, t('common.loading')));
    try {
      draw(await adapter.listMyApplications());
    } catch (err) {
      clear(container);
      append(container, notice('error', null, tError(err)));
    }
  }

  function draw(rows) {
    const locale = getIntlLocale();
    clear(container);

    if (rows.length === 0) {
      append(container, [
        el('h1', { class: 'screen__title' }, t('apps.title')),
        emptyState(t('apps.empty_title'), t('apps.empty_body'),
          el('a', { class: 'btn btn--primary', href: '#/board' }, t('board.title'))),
      ]);
      focusHeading(container);
      return;
    }

    async function withdraw(application) {
      if (!window.confirm(t('apps.withdraw_confirm'))) return;
      try {
        draw(await adapter.withdrawApplication(application.id));
        announce(t('appstatus.withdrawn'));
      } catch (err) {
        clear(container);
        append(container, notice('error', null, tError(err)));
      }
    }

    async function confirmSlot(application) {
      const name = 'slot-' + application.id;
      const choices = el('div', { class: 'slots' }, application.screening_slots.map((slot, i) => (
        el('label', { class: 'slot' }, [
          el('input', {
            type: 'radio',
            name,
            value: slot,
            checked: i === 0 ? true : null,
          }),
          el('span', formatSlot(slot, locale)),
        ])
      )));

      const result = await confirmDialog({
        title: t('screening.title'),
        lead: t('screening.manager', { name: application.hiring_manager_name || '' }),
        confirmLabel: t('screening.confirm'),
        body: el('div', {}, [
          application.screening_note
            ? el('blockquote', { class: 'quote' }, application.screening_note)
            : null,
          el('p', { class: 'label' }, t('screening.pick_slot')),
          choices,
        ]),
        onConfirm: async () => {
          const picked = choices.querySelector('input:checked');
          try {
            return await adapter.confirmScreeningSlot(
              application.id,
              picked ? picked.value : null,
            );
          } catch (err) {
            const wrapped = new Error(tError(err));
            wrapped.userMessage = tError(err);
            throw wrapped;
          }
        },
      });

      if (result) {
        announce(t('screening.confirmed', { when: '' }));
        draw(result);
      }
    }

    append(container, [
      el('h1', { class: 'screen__title' }, t('apps.title')),
      el('ul', { class: 'card-list' }, rows.map((a) => {
        const canWithdraw = a.status === 'submitted' || a.status === 'screening';

        return el('li', { class: 'card card--application' }, [
          el('div', { class: 'card__body' }, [
            el('div', { class: 'card__head' }, [
              el('h2', { class: 'card__title' },
                a.project
                  ? el('a', {
                    class: 'link',
                    href: '#/project/' + encodeURIComponent(a.project_id),
                  }, a.project.title)
                  : t('common.none')),
              labelBadge('appstatus', a.status),
            ]),
            el('p', { class: 'card__org' }, a.organization_name || ''),
            el('p', { class: 'card__meta' }, [
              t('apps.applied_on', { date: formatDate(a.created_at, locale) }),
              a.proposed_rate_per_hour ? [
                el('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
                t('apps.your_rate', {
                  amount: formatMoney(a.proposed_rate_per_hour, locale),
                }),
              ] : null,
            ]),

            // The screening invitation, shown in full because it is the thing
            // the freelancer has to act on.
            a.status === 'screening'
              ? notice(
                'info',
                t('screening.title'),
                t('screening.manager', { name: a.hiring_manager_name || '' }),
                el('div', {}, [
                  a.screening_note
                    ? el('blockquote', { class: 'quote' }, a.screening_note)
                    : null,
                  a.screening_confirmed_slot
                    ? el('p', { class: 'slot-confirmed' }, t('screening.confirmed', {
                      when: formatSlot(a.screening_confirmed_slot, locale),
                    }))
                    : el('button', {
                      type: 'button',
                      class: 'btn btn--primary',
                      onclick: () => confirmSlot(a),
                    }, t('screening.pick_slot')),
                ]),
              )
              : null,

            a.status === 'rejected' && a.decision_reason
              ? notice('warn', null, null,
                el('blockquote', { class: 'quote' }, a.decision_reason))
              : null,

            a.status === 'hired'
              ? notice('success', null, t('hire.done'))
              : null,
          ]),

          canWithdraw
            ? el('div', { class: 'card__actions' }, [
              el('button', {
                type: 'button',
                class: 'btn btn--ghost btn--sm',
                onclick: () => withdraw(a),
              }, t('apps.withdraw')),
            ])
            : null,
        ]);
      })),
    ]);

    focusHeading(container);
  }
}
