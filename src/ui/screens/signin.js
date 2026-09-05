/**
 * F1 - Sign in. Spec section 4.
 *
 * Email field, one button, magic link. Valid 24h, single use. No passwords and
 * no account creation: accounts are made by ops when an assignment is set up,
 * so an unrecognised address is told so plainly rather than being offered a
 * signup path that does not exist.
 *
 * The mock adapter has no mail server, so it hands the link back and this
 * screen prints it. Against Supabase the same call returns delivery:'email'
 * and no token, and the "check your email" panel is all the user sees. Both
 * branches are here so the migration does not touch this file.
 */

import { el, clear, append, focusHeading } from '../dom.js';
import { t } from '../../i18n/index.js';
import { tError } from '../../i18n/index.js';
import { notice } from '../components/ui.js';
import { DEMO_ACCOUNTS } from '../../data/mock/seed.js';
import { navigate } from '../../app/router.js';

export function renderSignIn(container, { adapter, onSignedIn }) {
  clear(container);

  const errorSlot = el('div', { class: 'form__error', role: 'alert', hidden: true });
  const panel = el('div', { class: 'panel panel--narrow' });

  const emailInput = el('input', {
    type: 'email',
    id: 'signin-email',
    name: 'email',
    class: 'input',
    required: true,
    autocomplete: 'email',
    autocapitalize: 'off',
    spellcheck: 'false',
    placeholder: t('signin.email_placeholder'),
  });

  const submitButton = el('button', { type: 'submit', class: 'btn btn--primary btn--block' },
    t('signin.submit'));

  async function requestLink(email) {
    errorSlot.hidden = true;
    submitButton.disabled = true;
    submitButton.textContent = t('signin.sending');
    try {
      const result = await adapter.requestMagicLink(email);
      renderSent(email, result);
    } catch (err) {
      errorSlot.hidden = false;
      errorSlot.textContent = tError(err);
      emailInput.focus();
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = t('signin.submit');
    }
  }

  function renderSent(email, result) {
    clear(panel);
    append(panel, [
      el('h1', { class: 'panel__title' }, t('signin.sent_title')),
      el('p', { class: 'panel__lead' }, t('signin.sent_body', { email })),

      // Mock only: the link the user would have received by email.
      result.delivery === 'on_screen'
        ? notice('info', t('signin.mock_title'), t('signin.mock_body'),
          el('button', {
            type: 'button',
            class: 'btn btn--primary',
            onclick: () => consume(result.token),
          }, t('signin.open_link')))
        : null,

      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--block',
        onclick: () => renderForm(),
      }, t('signin.back_to_signin')),
    ]);
    focusHeading(panel);
  }

  async function consume(token) {
    try {
      const session = await adapter.consumeMagicLink(token);
      await onSignedIn(session);
    } catch (err) {
      renderForm();
      errorSlot.hidden = false;
      errorSlot.textContent = tError(err);
    }
  }

  function renderForm() {
    clear(panel);
    append(panel, [
      el('h1', { class: 'panel__title' }, t('signin.title')),
      el('p', { class: 'panel__lead' }, t('signin.lead')),

      el('form', {
        class: 'form',
        novalidate: true,
        onsubmit: (event) => {
          event.preventDefault();
          const email = emailInput.value.trim();
          if (!email) {
            emailInput.focus();
            return;
          }
          requestLink(email);
        },
      }, [
        el('label', { class: 'label', for: 'signin-email' }, t('signin.email_label')),
        emailInput,
        errorSlot,
        submitButton,
      ]),

      // Demo affordance. Hidden entirely once a real backend is connected,
      // because these accounts will not exist.
      adapter.isMock
        ? el('div', { class: 'demo-accounts' }, [
          el('h2', { class: 'demo-accounts__title' }, t('signin.demo_title')),
          el('p', { class: 'demo-accounts__body' }, t('signin.demo_body')),
          el('div', { class: 'demo-accounts__row' }, DEMO_ACCOUNTS.map((account) => el('button', {
            type: 'button',
            class: 'btn btn--ghost',
            onclick: () => requestLink(account.email),
          }, account.role === 'freelancer'
            ? t('signin.demo_freelancer')
            : t('signin.demo_approver')))),
        ])
        : null,
    ]);
    focusHeading(panel);
    emailInput.focus();
  }

  renderForm();
  append(container, el('div', { class: 'centred' }, panel));
}

/**
 * The landing route for a magic link: #/signin/token/<token>. Consumes the
 * token and either signs in or explains why it did not work, without ever
 * leaving the token in the address bar afterwards.
 */
export async function renderTokenLanding(container, { adapter, token, onSignedIn }) {
  clear(container);
  append(container, el('div', { class: 'centred' },
    el('div', { class: 'panel panel--narrow' }, el('p', { class: 'loading' }, t('common.loading')))));

  try {
    const session = await adapter.consumeMagicLink(token);
    await onSignedIn(session);
  } catch (err) {
    clear(container);
    append(container, el('div', { class: 'centred' }, el('div', { class: 'panel panel--narrow' }, [
      el('h1', { class: 'panel__title' }, t('signin.title')),
      notice('error', null, tError(err)),
      el('button', {
        type: 'button',
        class: 'btn btn--primary btn--block',
        onclick: () => navigate('/signin'),
      }, t('signin.back_to_signin')),
    ])));
  }
}
