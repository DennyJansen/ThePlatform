/**
 * M1 / M2 — the project board and one project, for a freelancer.
 *
 * This is the marketplace screen spec §1 declined to build. It exists now by a
 * deliberate reversal.
 *
 * A posting carries one rate: the agreed rate. The detail view shows it and,
 * beneath it, what the freelancer would actually invoice after the €2/hour
 * platform fee — both, because the first is the number they negotiate on and
 * the second is the number that reaches their bank. Finding out about the fee
 * at submission time rather than before applying is the kind of surprise that
 * loses you a freelancer.
 */

import { el, clear, append, focusHeading, announce } from '../dom.js';
import { t, tError, getIntlLocale } from '../../i18n/index.js';
import {
  notice, emptyState, confirmDialog, labelBadge, definitionList,
} from '../components/ui.js';
import {
  formatMoney, parseRateToCents, freelancerRate, DEFAULT_FREELANCER_FEE,
} from '../../domain/money.js';
import { formatDate as fmtDate } from '../../domain/dates.js';
import { navigate } from '../../app/router.js';

const REMOTE_KEYS = { on_site: 'remote.on_site', hybrid: 'remote.hybrid', remote: 'remote.remote' };

/* ------------------------------------------------------------------ *
 * M1 — the board
 * ------------------------------------------------------------------ */

export async function renderBoard(container, { adapter }) {
  clear(container);
  append(container, el('p', { class: 'loading' }, t('common.loading')));

  let projects;
  try {
    projects = await adapter.listOpenProjects();
  } catch (err) {
    clear(container);
    append(container, notice('error', null, tError(err)));
    return;
  }

  const locale = getIntlLocale();
  clear(container);

  if (projects.length === 0) {
    append(container, [
      el('h1', { class: 'screen__title' }, t('board.title')),
      emptyState(t('board.empty_title'), t('board.empty_body')),
    ]);
    focusHeading(container);
    return;
  }

  append(container, [
    el('h1', { class: 'screen__title' }, t('board.title')),
    el('ul', { class: 'card-list' }, projects.map((p) => el('li', {
      class: 'card card--project',
    }, [
      el('a', { class: 'card__link', href: '#/project/' + encodeURIComponent(p.id) }, [
        el('span', { class: 'card__head' }, [
          el('span', { class: 'card__title' }, p.title),
          p.has_applied ? labelBadge('appstatus', 'submitted') : null,
        ]),
        el('span', { class: 'card__org' }, p.organization_name || ''),
        el('span', { class: 'card__meta' }, [
          el('strong', t('board.rate_from', {
            amount: formatMoney(p.agreed_rate_per_hour, locale),
          })),
          el('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
          t(REMOTE_KEYS[p.remote_policy] || 'remote.hybrid'),
          p.location ? [
            el('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
            p.location,
          ] : null,
          p.indicative_hours_per_week ? [
            el('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
            t('board.scope', { hours: String(p.indicative_hours_per_week) }),
          ] : null,
        ]),
      ]),
    ]))),
  ]);

  focusHeading(container);
}

/* ------------------------------------------------------------------ *
 * M2 — one project, and applying to it
 * ------------------------------------------------------------------ */

export async function renderProject(container, { adapter, projectId }) {
  clear(container);
  append(container, el('p', { class: 'loading' }, t('common.loading')));

  let view;
  let profileState;
  try {
    view = await adapter.getProject(projectId);
    profileState = await adapter.getMyProfile();
  } catch (err) {
    clear(container);
    append(container, notice('error', null, tError(err)));
    return;
  }

  draw(view, profileState);

  function draw(current, profile) {
    const locale = getIntlLocale();
    const p = current.project;
    const applied = !!current.my_application;
    const open = p.status === 'open';

    clear(container);

    async function apply() {
      const motivation = el('textarea', {
        class: 'input input--area',
        id: 'apply-motivation',
        rows: '6',
        placeholder: t('apply.motivation_placeholder'),
      });
      const rate = el('input', {
        class: 'input',
        id: 'apply-rate',
        type: 'text',
        inputmode: 'decimal',
        autocomplete: 'off',
        placeholder: formatMoney(p.agreed_rate_per_hour, locale),
      });

      const result = await confirmDialog({
        title: t('apply.title'),
        lead: t('apply.lead'),
        confirmLabel: t('apply.submit'),
        body: el('div', {}, [
          el('div', { class: 'field' }, [
            el('label', { class: 'label', for: 'apply-motivation' }, t('apply.motivation')),
            motivation,
          ]),
          el('div', { class: 'field' }, [
            el('label', { class: 'label', for: 'apply-rate' }, t('apply.rate')),
            rate,
            el('p', { class: 'field__help' }, t('apply.rate_help', {
              amount: formatMoney(p.agreed_rate_per_hour, locale),
            })),
          ]),
        ]),
        onConfirm: async () => {
          const cents = parseRateToCents(rate.value);
          if (Number.isNaN(cents)) {
            const bad = new Error('rate');
            bad.userMessage = t('error.rate_out_of_range');
            throw bad;
          }
          try {
            return await adapter.applyToProject(p.id, {
              motivation: motivation.value,
              proposed_rate_per_hour: cents,
            });
          } catch (err) {
            const wrapped = new Error(tError(err));
            wrapped.userMessage = tError(err);
            throw wrapped;
          }
        },
      });

      if (result) {
        announce(t('apply.sent'));
        navigate('/applications');
      }
    }

    const canApply = open && !applied && profile.complete;

    append(container, [
      el('p', { class: 'crumb' }, el('a', { href: '#/board', class: 'link' }, '← ' + t('board.title'))),

      el('div', { class: 'period-head' }, [
        el('div', { class: 'period-head__main' }, [
          el('p', { class: 'period-head__client' },
            current.organization ? current.organization.name : ''),
          el('h1', { class: 'period-head__title' }, p.title),
          el('p', { class: 'period-head__meta' }, [
            el('strong', t('board.rate_from', {
              amount: formatMoney(p.agreed_rate_per_hour, locale),
            })),
            el('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
            t(REMOTE_KEYS[p.remote_policy] || 'remote.hybrid'),
          ]),
        ]),
        el('div', { class: 'period-head__status' }, labelBadge('projectstatus', p.status)),
      ]),

      applied ? notice('info', null, t('project.already_applied'),
        el('a', { class: 'btn btn--ghost', href: '#/applications' }, t('apps.title'))) : null,

      !open ? notice('warn', null, t('project.closed_notice')) : null,

      open && !applied && !profile.complete
        ? notice('warn', null, t('project.profile_first'),
          el('a', { class: 'btn btn--primary', href: '#/profile' }, t('project.to_profile')))
        : null,

      el('section', { class: 'prose' }, [
        el('h2', { class: 'section__title' }, t('project.about')),
        // Preserved line breaks, inserted as text nodes. Never innerHTML:
        // this string was typed by a company into a public form.
        el('p', { class: 'prose__body' }, p.description),
      ]),

      definitionList([
        [t('project.start'), fmtDate(p.start_date, locale)],
        p.duration_months
          ? [t('project.duration'), t('board.duration', { months: String(p.duration_months) })]
          : null,
        p.location ? [t('project.location'), p.location] : null,
        // COMPLIANCE §6: an indication of size on a pitch, labelled as such,
        // and explicitly not a roster. It is never copied onto the assignment.
        p.indicative_hours_per_week
          ? [t('project.scope'), t('board.scope', {
            hours: String(p.indicative_hours_per_week),
          }), t('project.scope_note')]
          : null,
        // The agreed rate, then what they would actually invoice after the
        // platform's fee. Both, because the first is the number they negotiate
        // on and the second is the number that reaches their bank — and being
        // shown only one of those is how a freelancer feels misled later.
        [t('project.agreed_rate'), formatMoney(p.agreed_rate_per_hour, locale)],
        [t('project.your_rate'),
          formatMoney(freelancerRate(p.agreed_rate_per_hour, DEFAULT_FREELANCER_FEE), locale),
          t('project.fee_note', { fee: formatMoney(DEFAULT_FREELANCER_FEE, locale) })],
      ], { class: 'dl--split' }),

      canApply
        ? el('div', { class: 'actions actions--end' }, [
          el('button', {
            type: 'button',
            class: 'btn btn--primary',
            onclick: () => apply(),
          }, t('project.apply')),
        ])
        : null,
    ]);

    focusHeading(container);
  }
}
