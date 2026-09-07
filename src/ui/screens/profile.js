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
import { extractProfile, looksLikeScannedDocument } from '../../domain/cv.js';
import { readDocument, ACCEPT_ATTRIBUTE, MAX_FILE_BYTES } from '../lib/readDocument.js';

/** Profile fields a CV can fill. Name and email are already on the account. */
const CV_FIELDS = ['headline', 'bio', 'skills', 'languages', 'years_experience',
  'location', 'website_url'];

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
    // Only the filename is kept in this build. The file itself needs real
    // storage; see docs/supabase-migration.md.
    let cvFileName = p.cv_file || null;
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
          cv_file: cvFileName,
        });
        announce(t('profile.saved'));
        draw(updated);
      } catch (err) {
        clear(statusSlot);
        append(statusSlot, el('span', { class: 'form__error-inline' }, tError(err)));
      }
    }

    /* ---- Filling the form from a CV ---- */

    const cvStatus = el('div', { class: 'cv__status', role: 'status' });
    const cvInput = el('input', {
      type: 'file',
      id: 'cv-file',
      class: 'cv__input',
      accept: ACCEPT_ATTRIBUTE,
      onchange: () => {
        const file = cvInput.files && cvInput.files[0];
        if (file) importCv(file);
      },
    });

    const byName = {
      headline, bio, skills, languages, years_experience: years, location, website_url: website,
    };

    /**
     * Prefill, mark, and stop. Nothing is saved: the freelancer presses Save
     * when they have read it. A profile that quietly contains a wrong skill is
     * worse than an empty one, because nobody knows to fix it.
     */
    function applyExtracted(fields) {
      const filled = [];
      for (const key of CV_FIELDS) {
        const value = fields[key];
        if (value === undefined || value === null || value === '') continue;
        const target = byName[key];
        if (!target) continue;
        target.input.value = Array.isArray(value) ? value.join(', ') : String(value);
        target.field.classList.add('is-from-cv');
        // Label suffix comes from a data attribute so the CSS can render it
        // without any string being built in the stylesheet.
        const label = target.field.querySelector('.label');
        if (label) label.dataset.fromCv = t('cv.from_cv');
        filled.push(t('profile.' + (key === 'years_experience' ? 'years'
          : key === 'website_url' ? 'website' : key)));
      }
      return filled;
    }

    async function importCv(file) {
      clear(cvStatus);
      append(cvStatus, el('p', { class: 'muted' }, t('cv.reading', { name: file.name })));

      let text;
      try {
        text = await readDocument(file);
      } catch (err) {
        clear(cvStatus);
        append(cvStatus, notice('error', null, tError(err)));
        cvInput.value = '';
        return;
      }

      const { fields, chars } = extractProfile(text);

      // An image-only PDF and a genuinely unhelpful CV need different answers.
      if (looksLikeScannedDocument(chars)) {
        clear(cvStatus);
        append(cvStatus, notice('warn', t('cv.scanned_title'), t('cv.scanned_body')));
        cvInput.value = '';
        return;
      }

      const filled = applyExtracted(fields);
      // The filename is kept; the file itself needs real storage, which
      // arrives with Supabase Storage. See docs/supabase-migration.md.
      if (byName.headline) cvFileName = file.name;

      clear(cvStatus);
      append(cvStatus, filled.length === 0
        ? notice('warn', t('cv.nothing_title'), t('cv.nothing_body'))
        : notice('success', t('cv.filled_title', { n: String(filled.length) }), null, [
          el('p', { class: 'cv__list' }, filled.join(' · ')),
          el('p', { class: 'cv__check' }, t('cv.check')),
        ]));

      announce(t('cv.filled_title', { n: String(filled.length) }));
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

      // Upload a CV, fill the form from it, then read what it filled in.
      el('section', { class: 'cv' }, [
        el('h2', { class: 'section__title' }, t('cv.title')),
        el('p', { class: 'field__help' }, t('cv.lead', {
          size: String(Math.round(MAX_FILE_BYTES / (1024 * 1024))),
        })),
        el('div', { class: 'cv__row' }, [
          el('label', { class: 'btn btn--ghost', for: 'cv-file' }, t('cv.choose')),
          cvInput,
          cvFileName ? el('span', { class: 'muted' }, cvFileName) : null,
        ]),
        cvStatus,
      ]),

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
