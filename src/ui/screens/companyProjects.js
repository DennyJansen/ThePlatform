/**
 * M5 / M6 — a company's own projects, and the form that creates one.
 *
 * The form asks for the rate offered to the freelancer — the agreed rate, the
 * number both sides will recognise — and shows live what the company itself
 * will pay once the platform's fee is added. A company that understands both
 * numbers is less likely to argue about the invoice later.
 *
 * The freelancer's own fee is left out because it is not part of what this
 * form decides, not because it is confidential. The two parties may compare
 * fees freely.
 *
 * COMPLIANCE §6. The description field's help text asks for the work and the
 * outcome, not the working hours, and the scope field says in as many words
 * that it sets no hours and does not reach the assignment. A posting that
 * reads like a job advert with fixed hours is the most likely route by which
 * gezag gets reintroduced, and it arrives through this form.
 */

import { el, clear, append, focusHeading, announce } from '../dom.js';
import { t, tError, getIntlLocale } from '../../i18n/index.js';
import {
  notice, emptyState, labelBadge, textField, selectField,
} from '../components/ui.js';
import {
  formatMoney, parseRateToCents, clientRate, DEFAULT_CLIENT_FEE,
} from '../../domain/money.js';
import { formatDate, todayIso } from '../../domain/dates.js';
import { navigate } from '../../app/router.js';

/* ------------------------------------------------------------------ *
 * M5 — the company's project list
 * ------------------------------------------------------------------ */

export async function renderCompanyProjects(container, { adapter }) {
  await load();

  async function load() {
    clear(container);
    append(container, el('p', { class: 'loading' }, t('common.loading')));
    try {
      draw(await adapter.listCompanyProjects());
    } catch (err) {
      clear(container);
      append(container, notice('error', null, tError(err)));
    }
  }

  function draw(rows) {
    const locale = getIntlLocale();
    clear(container);

    const newButton = el('a', {
      class: 'btn btn--primary',
      href: '#/company/project/new',
    }, t('company.new_project'));

    if (rows.length === 0) {
      append(container, [
        el('h1', { class: 'screen__title' }, t('company.projects_title')),
        emptyState(t('company.empty_title'), t('company.empty_body'), newButton),
      ]);
      focusHeading(container);
      return;
    }

    async function transition(project, action) {
      try {
        await adapter.transitionProject(project.id, action);
        announce(t('projectstatus.' + (action === 'publish' ? 'open' : 'closed')));
        await load();
      } catch (err) {
        clear(container);
        append(container, notice('error', null, tError(err)));
      }
    }

    append(container, [
      el('div', { class: 'screen__head' }, [
        el('h1', { class: 'screen__title' }, t('company.projects_title')),
        newButton,
      ]),

      el('ul', { class: 'card-list' }, rows.map((p) => el('li', {
        class: 'card card--project',
      }, [
        el('div', { class: 'card__body' }, [
          el('div', { class: 'card__head' }, [
            el('h2', { class: 'card__title' }, p.title),
            labelBadge('projectstatus', p.status),
          ]),
          el('p', { class: 'card__meta' }, [
            formatMoney(p.agreed_rate_per_hour, locale) + ' / ' + t('common.hours_short'),
            el('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
            t('form.derived', {
              amount: formatMoney(clientRate(p.agreed_rate_per_hour,
                p.client_fee_per_hour), locale),
            }),
            el('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
            formatDate(p.start_date, locale),
          ]),
          el('p', { class: 'card__counts' }, [
            t('company.applicants_n', { n: String(p.application_count) }),
            p.new_count > 0
              ? el('span', { class: 'pill pill--new' }, t('company.new_n', {
                n: String(p.new_count),
              }))
              : null,
            p.screening_count > 0
              ? el('span', { class: 'pill' }, t('company.screening_n', {
                n: String(p.screening_count),
              }))
              : null,
          ]),
        ]),

        el('div', { class: 'card__actions' }, [
          el('a', {
            class: 'btn btn--ghost btn--sm',
            href: '#/company/project/' + encodeURIComponent(p.id) + '/applicants',
          }, t('company.view_applicants')),
          el('a', {
            class: 'btn btn--ghost btn--sm',
            href: '#/company/project/' + encodeURIComponent(p.id),
          }, t('company.edit')),
          p.status === 'draft' || p.status === 'closed'
            ? el('button', {
              type: 'button',
              class: 'btn btn--primary btn--sm',
              onclick: () => transition(p, 'publish'),
            }, t('company.publish'))
            : null,
          p.status === 'open'
            ? el('button', {
              type: 'button',
              class: 'btn btn--ghost btn--sm',
              onclick: () => transition(p, 'close'),
            }, t('company.close'))
            : null,
        ]),
      ]))),
    ]);

    focusHeading(container);
  }
}

/* ------------------------------------------------------------------ *
 * M6 — create or edit a project
 * ------------------------------------------------------------------ */

export async function renderProjectForm(container, { adapter, projectId }) {
  const editing = projectId && projectId !== 'new';
  let existing = null;

  clear(container);
  append(container, el('p', { class: 'loading' }, t('common.loading')));

  if (editing) {
    try {
      const view = await adapter.getProject(projectId);
      existing = view.project;
    } catch (err) {
      clear(container);
      append(container, notice('error', null, tError(err)));
      return;
    }
  }

  const locale = getIntlLocale();
  const p = existing || {};
  clear(container);

  const title = textField({
    id: 'f-title', label: t('form.title_label'), value: p.title,
  });
  const description = textField({
    id: 'f-description',
    label: t('form.description'),
    value: p.description,
    help: t('form.description_help'),
    multiline: true,
    rows: 8,
  });
  const agreedRate = textField({
    id: 'f-rate',
    label: t('form.rate'),
    value: p.agreed_rate_per_hour
      ? (p.agreed_rate_per_hour / 100).toFixed(2).replace('.', ',')
      : '',
    help: t('form.rate_help'),
    inputmode: 'decimal',
  });
  const start = textField({
    id: 'f-start', label: t('form.start'), value: p.start_date || todayIso(), type: 'date',
  });
  const duration = textField({
    id: 'f-duration',
    label: t('form.duration'),
    value: p.duration_months,
    type: 'number',
    inputmode: 'numeric',
    min: '1',
    max: '36',
  });
  const hours = textField({
    id: 'f-hours',
    label: t('form.hours'),
    value: p.indicative_hours_per_week,
    help: t('form.hours_help'),
    type: 'number',
    inputmode: 'numeric',
    min: '1',
    max: '40',
  });
  const location = textField({
    id: 'f-location', label: t('form.location'), value: p.location,
  });
  const remote = selectField({
    id: 'f-remote',
    label: t('form.remote'),
    value: p.remote_policy || 'hybrid',
    options: [
      { value: 'on_site', label: t('remote.on_site') },
      { value: 'hybrid', label: t('remote.hybrid') },
      { value: 'remote', label: t('remote.remote') },
    ],
  });

  // The live echo of what the freelancer will see. Recomputed from the same
  // function the adapter uses, so the preview cannot disagree with the record.
  const derived = el('p', { class: 'derived' });
  function refreshDerived() {
    const cents = parseRateToCents(agreedRate.input.value);
    derived.textContent = Number.isInteger(cents)
      ? t('form.derived', {
        amount: formatMoney(clientRate(cents, DEFAULT_CLIENT_FEE), locale),
      })
      : '';
  }
  agreedRate.input.addEventListener('input', refreshDerived);
  refreshDerived();
  append(agreedRate.field, derived);

  const statusSlot = el('div', { class: 'status-slot' });

  async function save(andPublish) {
    const cents = parseRateToCents(agreedRate.input.value);
    try {
      const view = await adapter.saveProject(editing ? projectId : null, {
        title: title.input.value,
        description: description.input.value,
        agreed_rate_per_hour: Number.isNaN(cents) ? null : cents,
        indicative_hours_per_week: hours.input.value,
        start_date: start.input.value,
        duration_months: duration.input.value,
        location: location.input.value,
        remote_policy: remote.input.value,
      });
      if (andPublish && view.project.status === 'draft') {
        await adapter.transitionProject(view.project.id, 'publish');
      }
      announce(t('common.save'));
      navigate('/company/projects');
    } catch (err) {
      clear(statusSlot);
      append(statusSlot, el('span', { class: 'form__error-inline' }, tError(err)));
    }
  }

  append(container, [
    el('p', { class: 'crumb' }, el('a', {
      href: '#/company/projects', class: 'link',
    }, '← ' + t('company.projects_title'))),

    el('h1', { class: 'screen__title' },
      editing ? t('form.edit_title') : t('form.new_title')),

    el('div', { class: 'form form--project' }, [
      title.field,
      description.field,
      el('div', { class: 'field-row' }, [agreedRate.field, start.field]),
      el('div', { class: 'field-row' }, [duration.field, hours.field]),
      el('div', { class: 'field-row' }, [location.field, remote.field]),
    ]),

    el('div', { class: 'actions' }, [
      statusSlot,
      el('div', { class: 'actions__buttons' }, [
        el('button', {
          type: 'button', class: 'btn btn--ghost', onclick: () => save(false),
        }, t('form.save')),
        el('button', {
          type: 'button', class: 'btn btn--primary', onclick: () => save(true),
        }, t('form.save_publish')),
      ]),
    ]),
  ]);

  focusHeading(container);
}
