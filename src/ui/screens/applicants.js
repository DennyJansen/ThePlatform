/**
 * M7 — the applications for one project, and the decisions on them.
 *
 * Three decisions live here: invite to a screening call, reject with a reason,
 * hire. Hiring does not produce a live assignment — it produces a PENDING one
 * that ops has to finish. Spec §8 lists nine contract clauses the invoicing
 * side of the system assumes exist, and after a half-hour video call none of
 * them do. The dialog says so rather than implying the deal is done.
 *
 * A rejection carries a reason for the same reason §4/C1 requires one on a
 * timesheet: a decision someone has to live with should come with a sentence
 * explaining it.
 */

import { el, clear, append, focusHeading, announce } from '../dom.js';
import { t, tError, getIntlLocale } from '../../i18n/index.js';
import {
  notice, emptyState, labelBadge, confirmDialog, definitionList,
} from '../components/ui.js';
import { formatMoney } from '../../domain/money.js';
import { formatDate, formatDateTime, todayIso } from '../../domain/dates.js';
import { MAX_SCREENING_SLOTS } from '../../domain/marketplace.js';

function formatSlot(slot, locale) {
  return slot ? formatDateTime(slot + ':00', locale) : '';
}

export async function renderApplicants(container, { adapter, projectId }) {
  await load();

  async function load() {
    clear(container);
    append(container, el('p', { class: 'loading' }, t('common.loading')));
    try {
      draw(await adapter.listApplicationsForProject(projectId));
    } catch (err) {
      clear(container);
      append(container, notice('error', null, tError(err)));
    }
  }

  function draw(view) {
    const locale = getIntlLocale();
    const { project, applications } = view;
    clear(container);

    const crumb = el('p', { class: 'crumb' }, el('a', {
      href: '#/company/projects', class: 'link',
    }, '← ' + t('company.projects_title')));

    if (applications.length === 0) {
      append(container, [
        crumb,
        el('h1', { class: 'screen__title' }, t('applicants.title', { title: project.title })),
        emptyState(t('applicants.empty_title'), t('applicants.empty_body')),
      ]);
      focusHeading(container);
      return;
    }

    /* ---------------- Decisions ---------------- */

    async function invite(application) {
      const manager = el('input', {
        class: 'input', id: 'inv-manager', type: 'text', autocomplete: 'off',
        placeholder: t('invite.manager_placeholder'),
      });
      const note = el('textarea', {
        class: 'input input--area', id: 'inv-note', rows: '3',
        placeholder: t('invite.note_placeholder'),
      });

      // Three datetime-local inputs. Deliberately not a calendar widget: this
      // records an agreement, it does not manage anyone's diary.
      const slotInputs = [];
      for (let i = 0; i < MAX_SCREENING_SLOTS; i += 1) {
        slotInputs.push(el('input', {
          class: 'input',
          type: 'datetime-local',
          min: todayIso() + 'T00:00',
          'aria-label': t('invite.slots') + ' ' + (i + 1),
        }));
      }

      const result = await confirmDialog({
        title: t('invite.title'),
        lead: t('invite.lead'),
        confirmLabel: t('invite.send'),
        body: el('div', {}, [
          el('div', { class: 'field' }, [
            el('label', { class: 'label', for: 'inv-manager' }, t('invite.manager')),
            manager,
          ]),
          el('div', { class: 'field' }, [
            el('span', { class: 'label' }, t('invite.slots')),
            el('div', { class: 'slots' }, slotInputs),
          ]),
          el('div', { class: 'field' }, [
            el('label', { class: 'label', for: 'inv-note' }, t('invite.note')),
            note,
          ]),
        ]),
        onConfirm: async () => {
          try {
            return await adapter.inviteToScreening(application.id, {
              hiring_manager_name: manager.value,
              screening_note: note.value,
              slots: slotInputs.map((s) => s.value).filter(Boolean),
            });
          } catch (err) {
            const wrapped = new Error(tError(err));
            wrapped.userMessage = tError(err);
            throw wrapped;
          }
        },
      });

      if (result) {
        announce(t('appstatus.screening'));
        draw(result);
      }
    }

    async function reject(application) {
      const reason = el('textarea', {
        class: 'input input--area', id: 'rej-reason', rows: '4',
        placeholder: t('reject.reason_placeholder'),
      });

      const result = await confirmDialog({
        title: t('reject.title'),
        lead: t('reject.lead'),
        danger: true,
        confirmLabel: t('reject.send'),
        body: el('div', { class: 'field' }, [
          el('label', { class: 'label', for: 'rej-reason' }, t('reject.reason')),
          reason,
        ]),
        onConfirm: async () => {
          try {
            return await adapter.rejectApplication(application.id, reason.value);
          } catch (err) {
            const wrapped = new Error(tError(err));
            wrapped.userMessage = tError(err);
            throw wrapped;
          }
        },
      });

      if (result) {
        announce(t('appstatus.rejected'));
        draw(result);
      }
    }

    async function hire(application) {
      const result = await confirmDialog({
        title: t('hire.title'),
        lead: t('hire.body', { name: application.freelancer.name }),
        confirmLabel: t('hire.confirm'),
        onConfirm: async () => {
          try {
            return await adapter.hireApplicant(application.id);
          } catch (err) {
            const wrapped = new Error(tError(err));
            wrapped.userMessage = tError(err);
            throw wrapped;
          }
        },
      });

      if (result) {
        announce(t('hire.done'));
        await load();
      }
    }

    /* ---------------- Render ---------------- */

    append(container, [
      crumb,
      el('h1', { class: 'screen__title' }, t('applicants.title', { title: project.title })),

      el('ul', { class: 'card-list' }, applications.map((a) => {
        const profile = a.profile || {};
        const decidable = a.status === 'submitted' || a.status === 'screening';

        return el('li', { class: 'card card--applicant' }, [
          el('div', { class: 'card__body' }, [
            el('div', { class: 'card__head' }, [
              el('h2', { class: 'card__title' }, a.freelancer.name),
              labelBadge('appstatus', a.status),
            ]),
            el('p', { class: 'card__org' }, profile.headline || ''),
            el('p', { class: 'card__meta' }, [
              t('apps.applied_on', { date: formatDate(a.created_at, locale) }),
              profile.years_experience ? [
                el('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
                t('applicants.experience', { n: String(profile.years_experience) }),
              ] : null,
              a.proposed_rate_per_hour ? [
                el('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
                t('applicants.asks', {
                  amount: formatMoney(a.proposed_rate_per_hour, locale),
                }),
              ] : null,
            ]),

            Array.isArray(profile.skills) && profile.skills.length
              ? el('ul', { class: 'tags' }, profile.skills.map((s) => el('li', { class: 'tag' }, s)))
              : null,

            el('details', { class: 'applicant__more' }, [
              el('summary', t('applicants.motivation')),
              el('p', { class: 'prose__body' }, a.motivation),
              profile.bio
                ? el('div', {}, [
                  el('h3', { class: 'section__title' }, t('applicants.profile')),
                  el('p', { class: 'prose__body' }, profile.bio),
                  definitionList([
                    profile.location ? [t('profile.location'), profile.location] : null,
                    profile.available_from
                      ? [t('profile.available'), formatDate(profile.available_from, locale)]
                      : null,
                    Array.isArray(profile.languages) && profile.languages.length
                      ? [t('profile.languages'), profile.languages.join(', ')]
                      : null,
                    profile.website_url
                      ? [t('profile.website'), el('a', {
                        class: 'link',
                        href: profile.website_url,
                        rel: 'noopener noreferrer',
                        target: '_blank',
                      }, profile.website_url)]
                      : null,
                  ]),
                ])
                : null,
            ]),

            a.status === 'screening'
              ? notice('info', t('screening.title'), t('screening.manager', {
                name: a.hiring_manager_name || '',
              }), el('p', { class: 'slot-confirmed' }, a.screening_confirmed_slot
                ? t('screening.confirmed', {
                  when: formatSlot(a.screening_confirmed_slot, locale),
                })
                : t('screening.awaiting')))
              : null,

            a.status === 'rejected' && a.decision_reason
              ? el('blockquote', { class: 'quote' }, a.decision_reason)
              : null,
          ]),

          decidable
            ? el('div', { class: 'card__actions' }, [
              el('button', {
                type: 'button', class: 'btn btn--ghost btn--sm', onclick: () => reject(a),
              }, t('applicants.reject')),
              a.status === 'submitted'
                ? el('button', {
                  type: 'button', class: 'btn btn--primary btn--sm', onclick: () => invite(a),
                }, t('applicants.invite'))
                : el('button', {
                  type: 'button', class: 'btn btn--primary btn--sm', onclick: () => hire(a),
                }, t('applicants.hire')),
            ])
            : null,
        ]);
      })),
    ]);

    focusHeading(container);
  }
}
