/**
 * F2 - Freelancer: current period. Spec section 4.
 *
 * The default landing page for a freelancer, and the only screen in v1 where
 * anything is typed. Header, entry grid, running total, one primary action.
 *
 * Two behaviours here are load-bearing rather than cosmetic:
 *
 *  - The confirmation step shows total hours and the resulting invoice amount
 *    before commit. Submitting is irreversible; the number on the screen is
 *    the number that gets invoiced, so it is shown before, not after.
 *  - After submit the grid becomes read-only with no edit affordance. Not a
 *    disabled button - the button is gone. A disabled Submit invites someone
 *    to look for the way around it.
 */

import { el, clear, append, focusHeading, announce } from '../dom.js';
import { t, tError, getIntlLocale } from '../../i18n/index.js';
import { statusBadge, notice, confirmDialog } from '../components/ui.js';
import { entryGrid } from '../components/entryGrid.js';
import { freelancerFeeTable } from '../components/feeTable.js';
import { formatMonth, formatDateTime, currentPeriod } from '../../domain/dates.js';
import { formatMoney, DEFAULT_HOUR_INCREMENT } from '../../domain/money.js';
import { PERIOD_STATUS } from '../../domain/model.js';
import { isEditable } from '../../domain/rules.js';
import { navigate } from '../../app/router.js';

/**
 * Unsaved-changes guard.
 *
 * A month of hours is twenty-odd numbers typed by hand. Losing them to a
 * stray refresh or a closed tab is the kind of small disaster that makes
 * someone go back to emailing a spreadsheet, so the browser is asked to
 * confirm. One listener, registered only while there is something to lose.
 */
const unsavedGuard = {
  handler: null,
  arm() {
    if (this.handler) return;
    this.handler = (event) => {
      event.preventDefault();
      // Browsers ignore custom text now and show their own wording; returning
      // a value is still what triggers the prompt.
      event.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', this.handler);
  },
  disarm() {
    if (!this.handler) return;
    window.removeEventListener('beforeunload', this.handler);
    this.handler = null;
  },
};

function periodHeader(view) {
  const locale = getIntlLocale();
  const { assignment, organization, period } = view;

  return el('div', { class: 'period-head' }, [
    el('div', { class: 'period-head__main' }, [
      el('p', { class: 'period-head__client' }, organization ? organization.name : ''),
      el('h1', { class: 'period-head__title period-head__title--month' }, [
        formatMonth(period.year, period.month, locale),
      ]),
      el('p', { class: 'period-head__meta' }, [
        assignment.title,
        el('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
        t('period.rate_unit', {
          amount: formatMoney(assignment.freelancer_rate_per_hour, locale),
        }),
        period.version > 1
          ? [
            el('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
            t('common.version', { n: period.version }),
          ]
          : null,
      ]),
    ]),
    el('div', { class: 'period-head__status' }, statusBadge(period.status)),
  ]);
}

export async function renderFreelancerPeriod(container, { adapter, session, periodId }) {
  clear(container);
  append(container, el('p', { class: 'loading' }, t('common.loading')));

  let view;
  try {
    if (periodId) {
      view = await adapter.getPeriod(periodId);
    } else {
      // Only an active assignment opens a period. A hire on the marketplace
      // creates a pending one, and ops has to settle the rates and the
      // agreement before anything can be billed against it.
      const assignments = (await adapter.listAssignments())
        .filter((a) => a.status === 'active');
      if (assignments.length === 0) {
        clear(container);
        append(container, notice('info', null, t('f2.no_assignment')));
        return;
      }
      const now = currentPeriod();
      view = await adapter.openPeriod(assignments[0].id, now.year, now.month);
    }
  } catch (err) {
    clear(container);
    append(container, notice('error', null, tError(err)));
    return;
  }

  draw(view);

  function draw(current) {
    const locale = getIntlLocale();
    const editable = isEditable(current.period);
    const increment = current.assignment.hour_increment || DEFAULT_HOUR_INCREMENT;

    // Every redraw starts from persisted state, so nothing is pending yet.
    unsavedGuard.disarm();
    clear(container);

    const statusSlot = el('div', { class: 'status-slot' });
    const grid = entryGrid({
      period: current.period,
      assignment: current.assignment,
      entries: current.entries,
      readOnly: !editable,
      onDirty: () => {
        if (!editable) return;
        unsavedGuard.arm();
        clear(statusSlot);
        append(statusSlot, el('span', { class: 'muted' }, t('f2.unsaved')));
      },
    });

    /* ---- Actions ---- */

    async function saveDraft(options = {}) {
      const updated = await adapter.saveDraft(current.period.id, grid.getEntries());
      current = updated;
      unsavedGuard.disarm();
      if (!options.quiet) {
        clear(statusSlot);
        append(statusSlot, el('span', { class: 'muted' },
          t('f2.saved', { time: formatDateTime(new Date().toISOString(), locale).split(' ').pop() })));
        announce(t('f2.saved', { time: '' }));
      }
      return updated;
    }

    async function submit() {
      // Persist first, then confirm against what the server actually holds -
      // never against what the inputs say. The number in the dialog has to be
      // the number that was stored, or the confirmation is theatre.
      let saved;
      try {
        saved = await saveDraft({ quiet: true });
      } catch (err) {
        return showError(err);
      }

      const summary = saved.summary;
      const confirmed = await confirmDialog({
        title: t('f2.confirm_title'),
        lead: t('f2.confirm_lead'),
        danger: true,
        confirmLabel: t('f2.confirm_commit'),
        body: freelancerFeeTable(summary, saved.assignment),
        onConfirm: async () => {
          try {
            return await adapter.submitPeriod(saved.period.id);
          } catch (err) {
            const wrapped = new Error(tError(err));
            wrapped.userMessage = tError(err);
            throw wrapped;
          }
        },
      });

      if (confirmed && confirmed.period) {
        current = confirmed;
        announce(t('status.submitted'));
        draw(current);
      }
      return undefined;
    }

    function showError(err) {
      clear(statusSlot);
      append(statusSlot, el('span', { class: 'form__error-inline' }, tError(err)));
      return undefined;
    }

    /* ---- Notices above the grid ---- */

    const banners = [];

    if (current.period.status === PERIOD_STATUS.SUBMITTED) {
      banners.push(notice('info', t('f2.locked_title'), t('f2.locked_body')));
    }

    // A rejected predecessor: show the approver's comment at the top and let
    // the freelancer correct the pre-filled successor. Spec section 4/F2.
    const rejectedPredecessor = current.history
      .filter((h) => h.status === PERIOD_STATUS.REJECTED)
      .sort((a, b) => b.version - a.version)[0];

    if (editable && rejectedPredecessor && rejectedPredecessor.rejection_comment) {
      banners.push(notice(
        'warn',
        t('f2.rejected_title', { name: current.approver ? current.approver.name : '' }),
        t('f2.rejected_body'),
        el('blockquote', { class: 'quote' }, rejectedPredecessor.rejection_comment),
      ));
    }

    if (current.period.status === PERIOD_STATUS.REJECTED && current.period.rejection_comment) {
      banners.push(notice(
        'warn',
        t('f2.rejected_title', { name: current.approver ? current.approver.name : '' }),
        null,
        el('blockquote', { class: 'quote' }, current.period.rejection_comment),
      ));
    }

    /* ---- Assemble ---- */

    append(container, [
      periodHeader(current),
      banners,
      editable ? el('p', { class: 'hint' }, t('grid.hours_help', { increment: String(increment) })) : null,
      grid.node,
      el('div', { class: 'actions' }, [
        statusSlot,
        editable
          ? el('div', { class: 'actions__buttons' }, [
            el('button', {
              type: 'button',
              class: 'btn btn--ghost',
              onclick: () => saveDraft().catch(showError),
            }, t('f2.save_draft')),
            el('button', {
              type: 'button',
              class: 'btn btn--primary',
              onclick: () => submit(),
            }, t('f2.submit')),
          ])
          // No edit affordance once submitted. Spec section 4/F2.
          : el('a', { class: 'btn btn--ghost', href: '#/history' }, t('nav.history')),
      ]),
    ]);

    focusHeading(container);
  }
}

/** F3 links land here with an explicit period id. */
export function renderPeriodById(container, deps) {
  return renderFreelancerPeriod(container, deps);
}

export { navigate };
