/**
 * F0 — Sign up. Freelancer or company.
 *
 * Reverses spec §4/F1's "no account creation flow", which a marketplace cannot
 * live with. What it does not reverse: no passwords. Sign-up collects details
 * and sends a magic link, and the link is the login — the same mechanism §4/F1
 * already specified.
 *
 * Two details here are decisions rather than layout:
 *
 *  - The freelancer form is three fields. Everything else lives on the profile,
 *    which they fill in next and can fill in from a CV. A long form between
 *    someone and a project board is how a marketplace ends up with no supply.
 *  - Outreach consent is captured here, off by default, in plain words. Spec §6
 *    requires opt-in for outreach based on profile data, and "captured at
 *    signup" is exactly where the spec says it belongs.
 */

import { el, clear, append, focusHeading } from '../dom.js';
import { t, tError } from '../../i18n/index.js';
import { notice, textField } from '../components/ui.js';
import { enrichmentIsAvailable } from '../../data/enrichment.js';
import { navigate } from '../../app/router.js';

/* ------------------------------------------------------------------ *
 * Choose a side
 * ------------------------------------------------------------------ */

export function renderSignupChoice(container) {
  clear(container);
  append(container, el('div', { class: 'centred' }, el('div', { class: 'panel panel--narrow' }, [
    el('h1', { class: 'panel__title' }, t('signup.title')),
    el('p', { class: 'panel__lead' }, t('signup.lead')),

    el('div', { class: 'choice' }, [
      el('a', { class: 'choice__card', href: '#/signup/freelancer' }, [
        el('span', { class: 'choice__title' }, t('signup.as_freelancer')),
        el('span', { class: 'choice__body' }, t('signup.as_freelancer_body')),
      ]),
      el('a', { class: 'choice__card', href: '#/signup/company' }, [
        el('span', { class: 'choice__title' }, t('signup.as_company')),
        el('span', { class: 'choice__body' }, t('signup.as_company_body')),
      ]),
    ]),

    el('p', { class: 'panel__foot' }, [
      t('signup.have_account'),
      ' ',
      el('a', { class: 'link', href: '#/signin' }, t('signin.title')),
    ]),
  ])));
  focusHeading(container);
}

/* ------------------------------------------------------------------ *
 * The forms
 * ------------------------------------------------------------------ */

export function renderSignupForm(container, { adapter, kind, onSignedIn }) {
  const isCompany = kind === 'company';
  const panel = el('div', { class: 'panel panel--narrow' });
  const errorSlot = el('div', { class: 'form__error', role: 'alert', hidden: true });

  /**
   * The "check your email" panel. Identical for a new account and an existing
   * one — see the note in mockAdapter.issueLink. Never says "that address is
   * already registered", because that answers a question nobody should be able
   * to ask a public form.
   */
  function renderSent(result) {
    clear(panel);
    append(panel, [
      el('h1', { class: 'panel__title' }, t('signin.sent_title')),
      el('p', { class: 'panel__lead' }, t('signin.sent_body', { email: result.email })),

      // Only ever set on the company path, and only when the KvK matched an
      // organisation that already existed.
      result.joined_existing && result.organization_name
        ? notice('info', null, t('signup.joined_existing', {
          company: result.organization_name,
        }))
        : null,

      result.delivery === 'on_screen'
        ? notice('info', t('signin.mock_title'), t('signin.mock_body'),
          el('button', {
            type: 'button',
            class: 'btn btn--primary',
            onclick: async () => {
              try {
                await onSignedIn(await adapter.consumeMagicLink(result.token));
              } catch (err) {
                errorSlot.hidden = false;
                errorSlot.textContent = tError(err);
              }
            },
          }, t('signin.open_link')))
        : null,

      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--block',
        onclick: () => navigate('/signin'),
      }, t('signin.title')),
    ]);
    focusHeading(panel);
  }

  function renderForm() {
    clear(panel);

    const name = textField({
      id: 'su-name',
      label: isCompany ? t('signup.your_name') : t('signup.name'),
      placeholder: t('signup.name_placeholder'),
    });
    const email = textField({
      id: 'su-email',
      label: isCompany ? t('signup.work_email') : t('signin.email_label'),
      type: 'email',
      placeholder: t('signin.email_placeholder'),
    });

    // Company-only fields.
    const companyName = textField({
      id: 'su-company', label: t('signup.company_name'),
    });
    const kvk = textField({
      id: 'su-kvk',
      label: t('signup.kvk'),
      help: t('signup.kvk_help'),
      inputmode: 'numeric',
    });
    const vat = textField({
      id: 'su-vat', label: t('signup.vat'), placeholder: 'NL123456789B01',
    });
    const website = textField({
      id: 'su-website',
      label: t('signup.website'),
      placeholder: 'bedrijf.nl',
      // Say what happens with it. Promising an auto-filled profile the build
      // cannot deliver is worse than asking someone to type four fields.
      help: enrichmentIsAvailable()
        ? t('signup.website_help_enriched')
        : t('signup.website_help_manual'),
    });

    // Spec §6. Off by default, and the label says what turning it on means.
    const consent = el('input', { type: 'checkbox', id: 'su-consent' });

    const submit = el('button', { type: 'submit', class: 'btn btn--primary btn--block' },
      t('signup.submit'));

    async function send(event) {
      event.preventDefault();
      errorSlot.hidden = true;
      submit.disabled = true;
      submit.textContent = t('signin.sending');

      try {
        const result = isCompany
          ? await adapter.signUpCompany({
            name: name.input.value,
            email: email.input.value,
            company_name: companyName.input.value,
            kvk_number: kvk.input.value,
            vat_number: vat.input.value,
            website: website.input.value,
          })
          : await adapter.signUpFreelancer({
            name: name.input.value,
            email: email.input.value,
            outreach_consent: consent.checked,
          });
        renderSent(result);
      } catch (err) {
        errorSlot.hidden = false;
        errorSlot.textContent = tError(err);
        focusHeading(panel);
      } finally {
        submit.disabled = false;
        submit.textContent = t('signup.submit');
      }
    }

    append(panel, [
      el('p', { class: 'crumb' },
        el('a', { class: 'link', href: '#/signup' }, '← ' + t('common.back'))),

      el('h1', { class: 'panel__title' },
        isCompany ? t('signup.company_title') : t('signup.freelancer_title')),
      el('p', { class: 'panel__lead' },
        isCompany ? t('signup.company_lead') : t('signup.freelancer_lead')),

      el('form', { class: 'form', novalidate: true, onsubmit: send }, [
        name.field,
        email.field,

        isCompany ? [
          el('hr', { class: 'rule' }),
          companyName.field,
          kvk.field,
          vat.field,
          website.field,
        ] : null,

        !isCompany
          ? el('div', { class: 'consent consent--inline' }, [
            el('label', { class: 'consent__row', for: 'su-consent' }, [
              consent,
              el('span', t('profile.consent_label')),
            ]),
            el('p', { class: 'field__help' }, t('profile.consent_help')),
          ])
          : null,

        errorSlot,
        submit,
        el('p', { class: 'panel__foot' }, t('signup.no_password')),
      ]),
    ]);

    focusHeading(panel);
    name.input.focus();
  }

  clear(container);
  renderForm();
  append(container, el('div', { class: 'centred' }, panel));
}
