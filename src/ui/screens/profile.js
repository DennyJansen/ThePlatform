/**
 * M4 — the freelancer's structured profile.
 *
 * Spec §1 excluded profiles; the marketplace decision brought them back, and
 * §6's obligation came with them. Two things on this screen carry that weight:
 *
 *  - The lead says plainly who can see this and when. A freelancer filling in
 *    a form has a right to know it is not going into a searchable database.
 *  - The outreach consent switch is off by default and stays the freelancer's
 *    to flip. Until they do, a company sees this profile only through an
 *    application the freelancer chose to send. That rule is enforced in
 *    marketplace.js, not here — this is just where it is explained.
 */

import { el, clear, append, focusHeading, announce } from '../dom.js';
import { t, tError, getIntlLocale } from '../../i18n/index.js';
import { notice, textField } from '../components/ui.js';
import { formatMoney, parseRateToCents } from '../../domain/money.js';
import { MAX_SKILLS } from '../../domain/marketplace.js';

export async function renderProfile(container, { adapter }) {
  clear(container);
  append(container, el('p', { class: 'loading' }, t('common.loading')));

  let state;
  try {
    state = await adapter.getMyProfile();
  } catch (err) {
    clear(container);
    append(container, notice('error', null, tError(err)));
    return;
  }

  draw(state);

  function draw(current) {
    const locale = getIntlLocale();
    const p = current.profile || {};
    clear(container);

    const headline = textField({
      id: 'p-headline',
      label: t('profile.headline'),
      value: p.headline,
      placeholder: t('profile.headline_placeholder'),
    });
    const bio = textField({
      id: 'p-bio',
      label: t('profile.bio'),
      value: p.bio,
      placeholder: t('profile.bio_placeholder'),
      multiline: true,
      rows: 6,
    });
    const skills = textField({
      id: 'p-skills',
      label: t('profile.skills'),
      value: Array.isArray(p.skills) ? p.skills.join(', ') : '',
      help: t('profile.skills_help', { n: String(MAX_SKILLS) }),
    });
    const years = textField({
      id: 'p-years',
      label: t('profile.years'),
      value: p.years_experience,
      type: 'number',
      inputmode: 'numeric',
      min: '0',
      max: '60',
    });
    const rate = textField({
      id: 'p-rate',
      label: t('profile.rate'),
      value: p.rate_expectation_per_hour
        ? (p.rate_expectation_per_hour / 100).toFixed(2).replace('.', ',')
        : '',
      inputmode: 'decimal',
    });
    const available = textField({
      id: 'p-available',
      label: t('profile.available'),
      value: p.available_from,
      type: 'date',
    });
    const location = textField({
      id: 'p-location',
      label: t('profile.location'),
      value: p.location,
    });
    const languages = textField({
      id: 'p-languages',
      label: t('profile.languages'),
      value: Array.isArray(p.languages) ? p.languages.join(', ') : '',
    });
    const website = textField({
      id: 'p-website',
      label: t('profile.website'),
      value: p.website_url,
      type: 'url',
    });

    const statusSlot = el('div', { class: 'status-slot' });

    async function save() {
      const cents = parseRateToCents(rate.input.value);
      if (Number.isNaN(cents)) {
        clear(statusSlot);
        append(statusSlot, el('span', { class: 'form__error-inline' },
          t('error.rate_out_of_range')));
        return;
      }
      try {
        const updated = await adapter.saveMyProfile({
          headline: headline.input.value,
          bio: bio.input.value,
          skills: skills.input.value,
          languages: languages.input.value,
          years_experience: years.input.value,
          rate_expectation_per_hour: cents,
          available_from: available.input.value,
          location: location.input.value,
          website_url: website.input.value,
        });
        announce(t('profile.saved'));
        draw(updated);
      } catch (err) {
        clear(statusSlot);
        append(statusSlot, el('span', { class: 'form__error-inline' }, tError(err)));
      }
    }

    const consentBox = el('input', {
      type: 'checkbox',
      id: 'p-consent',
      checked: current.outreach_consent ? true : null,
      onchange: async () => {
        try {
          const updated = await adapter.setOutreachConsent(consentBox.checked);
          current.outreach_consent = updated.outreach_consent;
        } catch (err) {
          consentBox.checked = !consentBox.checked;
          clear(statusSlot);
          append(statusSlot, el('span', { class: 'form__error-inline' }, tError(err)));
        }
      },
    });

    append(container, [
      el('h1', { class: 'screen__title' }, t('profile.title')),
      el('p', { class: 'lead' }, t('profile.lead')),

      current.complete ? null : notice('warn', null, t('profile.incomplete')),

      el('div', { class: 'form form--profile' }, [
        headline.field,
        bio.field,
        skills.field,
        el('div', { class: 'field-row' }, [years.field, rate.field]),
        el('div', { class: 'field-row' }, [available.field, location.field]),
        el('div', { class: 'field-row' }, [languages.field, website.field]),
      ]),

      el('section', { class: 'consent' }, [
        el('h2', { class: 'section__title' }, t('profile.consent_title')),
        el('label', { class: 'consent__row', for: 'p-consent' }, [
          consentBox,
          el('span', t('profile.consent_label')),
        ]),
        el('p', { class: 'field__help' }, t('profile.consent_help')),
      ]),

      el('div', { class: 'actions' }, [
        statusSlot,
        el('div', { class: 'actions__buttons' }, [
          el('button', {
            type: 'button',
            class: 'btn btn--primary',
            onclick: () => save(),
          }, t('profile.save')),
        ]),
      ]),
    ]);

    // The rate expectation is the one figure a freelancer may want to sanity
    // check against what the board shows, so echo it back formatted.
    if (p.rate_expectation_per_hour) {
      append(rate.field, el('p', { class: 'field__help' },
        formatMoney(p.rate_expectation_per_hour, locale)));
    }

    focusHeading(container);
  }
}
