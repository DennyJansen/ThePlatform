/**
 * Shared building blocks: status badges, notices, definition lists, and the
 * confirmation dialog. Everything here is presentational and takes already
 * translated strings, so the components never reach for t() themselves except
 * where the label is fixed by a status code.
 */

import { el, clear, append } from '../dom.js';
import { t } from '../../i18n/index.js';

/** A period status, rendered as a labelled badge. */
export function statusBadge(status) {
  return el('span', {
    class: 'badge badge--' + status,
    'data-status': status,
  }, t('status.' + status));
}

/**
 * The same badge for the marketplace's own status vocabularies.
 * `prefix` is the i18n namespace: 'projectstatus' or 'appstatus'.
 *
 * Colour is carried by the status value, which is shared across vocabularies
 * on purpose - a rejected application and a rejected timesheet should not look
 * like different kinds of bad news.
 */
export function labelBadge(prefix, value) {
  return el('span', {
    class: 'badge badge--' + value,
    'data-status': value,
  }, t(prefix + '.' + value));
}

/** A labelled text/number/date field. Returns { field, input }. */
export function textField(options) {
  const input = el(options.multiline ? 'textarea' : 'input', {
    id: options.id,
    name: options.id,
    class: 'input' + (options.multiline ? ' input--area' : ''),
    type: options.multiline ? null : (options.type || 'text'),
    rows: options.multiline ? String(options.rows || 4) : null,
    value: options.multiline ? null : (options.value === null
      || options.value === undefined ? '' : String(options.value)),
    placeholder: options.placeholder || null,
    inputmode: options.inputmode || null,
    min: options.min || null,
    max: options.max || null,
    autocomplete: 'off',
  });
  if (options.multiline) input.value = options.value || '';

  const field = el('div', { class: 'field' }, [
    el('label', { class: 'label', for: options.id }, options.label),
    input,
    options.help ? el('p', { class: 'field__help' }, options.help) : null,
  ]);
  return { field, input };
}

/** A labelled <select>. Returns { field, input }. */
export function selectField(options) {
  const input = el('select', { id: options.id, name: options.id, class: 'input' },
    options.options.map((o) => el('option', {
      value: o.value,
      selected: o.value === options.value ? true : null,
    }, o.label)));

  const field = el('div', { class: 'field' }, [
    el('label', { class: 'label', for: options.id }, options.label),
    input,
    options.help ? el('p', { class: 'field__help' }, options.help) : null,
  ]);
  return { field, input };
}

/**
 * A block of prose above a screen. `tone` drives colour only; the text has to
 * carry the meaning on its own for anyone who cannot see the colour.
 */
export function notice(tone, title, body, extra) {
  return el('div', { class: 'notice notice--' + tone, role: tone === 'error' ? 'alert' : 'status' }, [
    title ? el('p', { class: 'notice__title' }, title) : null,
    body ? el('p', { class: 'notice__body' }, body) : null,
    extra || null,
  ]);
}

/** Label/value pairs, the shape most of the read-only screens are made of. */
export function definitionList(pairs, options = {}) {
  return el('dl', { class: 'dl' + (options.class ? ' ' + options.class : '') },
    pairs.filter(Boolean).flatMap(([label, value, hint]) => [
      el('dt', label),
      el('dd', [
        value,
        hint ? el('span', { class: 'dl__hint' }, hint) : null,
      ]),
    ]));
}

/** A table with a caption that screen readers use to announce it. */
export function table(caption, headers, rows, options = {}) {
  return el('div', { class: 'table-wrap' }, [
    el('table', { class: 'table' + (options.class ? ' ' + options.class : '') }, [
      el('caption', { class: options.showCaption ? '' : 'visually-hidden' }, caption),
      el('thead', el('tr', headers.map((h) => el('th', {
        scope: 'col',
        class: h.numeric ? 'num' : null,
      }, h.label)))),
      el('tbody', rows),
    ]),
  ]);
}

/** Empty state that says what is expected and when. Spec section 4/C1. */
export function emptyState(title, body, action) {
  return el('div', { class: 'empty' }, [
    el('h2', { class: 'empty__title' }, title),
    el('p', { class: 'empty__body' }, body),
    action || null,
  ]);
}

export function spinner(label) {
  return el('p', { class: 'loading', role: 'status' }, label || t('common.loading'));
}

/**
 * A modal confirmation.
 *
 * Uses <dialog>, so focus trapping, Escape and the backdrop are the browser's
 * job rather than ours. Returns a promise that resolves with the value passed
 * to the confirming button, or null on cancel.
 *
 * `body` may be a node or an array of nodes. `danger` colours the primary
 * action for a destructive or irreversible step - submitting a period is
 * irreversible, so F2's confirmation uses it.
 */
export function confirmDialog({ title, lead, body, cancelLabel, confirmLabel, danger, onConfirm }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      dialog.close();
      window.setTimeout(() => dialog.remove(), 0);
    };

    const errorSlot = el('p', { class: 'dialog__error', role: 'alert', hidden: true });

    const confirmButton = el('button', {
      type: 'button',
      class: 'btn ' + (danger ? 'btn--danger' : 'btn--primary'),
      onclick: async () => {
        if (!onConfirm) return finish(true);
        confirmButton.disabled = true;
        errorSlot.hidden = true;
        try {
          const result = await onConfirm();
          finish(result === undefined ? true : result);
        } catch (err) {
          confirmButton.disabled = false;
          errorSlot.hidden = false;
          errorSlot.textContent = err && err.userMessage ? err.userMessage : t('error.unknown');
        }
        return undefined;
      },
    }, confirmLabel);

    const dialog = el('dialog', { class: 'dialog', 'aria-labelledby': 'dialog-title' }, [
      el('form', { method: 'dialog', class: 'dialog__form' }, [
        el('h2', { class: 'dialog__title', id: 'dialog-title' }, title),
        lead ? el('p', { class: 'dialog__lead' }, lead) : null,
        body ? el('div', { class: 'dialog__body' }, body) : null,
        errorSlot,
        el('div', { class: 'dialog__actions' }, [
          el('button', {
            type: 'button',
            class: 'btn btn--ghost',
            onclick: () => finish(null),
          }, cancelLabel || t('common.cancel')),
          confirmButton,
        ]),
      ]),
    ]);

    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(null);
    });

    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

/** Replace a container's contents with an error notice and a retry button. */
export function renderError(container, message, onRetry) {
  clear(container);
  append(container, notice('error', null, message,
    onRetry
      ? el('button', { type: 'button', class: 'btn btn--ghost', onclick: onRetry }, t('common.retry'))
      : null));
}
