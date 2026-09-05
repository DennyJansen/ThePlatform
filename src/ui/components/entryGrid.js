/**
 * The hour entry grid. Spec section 4/F2.
 *
 * One row per calendar day of the month. Date, weekday, hours field. Weekends
 * de-emphasised but enterable. Running total, prominent.
 *
 * COMPLIANCE, spec section 6: hours per day and nothing else. No start time,
 * no end time, no break field, no location, no activity description. If a
 * future change adds a column here, it is a Wet DBA regression - see
 * docs/compliance.md before touching this file.
 *
 * Read-only mode renders the same rows without inputs, which is what C1 uses.
 * The approver and the freelancer look at one component, so they cannot end up
 * looking at two different totals.
 */

import { el } from '../dom.js';
import { t, getIntlLocale } from '../../i18n/index.js';
import { monthDays, formatWeekday, withinAssignment } from '../../domain/dates.js';
import { formatHours, parseHours, quantiseHours, round2, DEFAULT_HOUR_INCREMENT } from '../../domain/money.js';

/**
 * @param {Object} options
 * @param {Object} options.period      the TimesheetPeriod
 * @param {Object} options.assignment  for the date window and hour increment
 * @param {Array}  options.entries     [{date, hours}]
 * @param {boolean} options.readOnly
 * @param {(total: number) => void} [options.onTotalChange]
 * @param {() => void} [options.onDirty]
 */
export function entryGrid({ period, assignment, entries, readOnly, onTotalChange, onDirty }) {
  const locale = getIntlLocale();
  const increment = assignment.hour_increment || DEFAULT_HOUR_INCREMENT;
  const byDate = new Map(entries.map((e) => [e.date, e.hours]));
  const inputs = new Map();

  const totalCell = el('td', { class: 'num grid__total-value' }, formatHours(0, locale));

  function currentTotal() {
    let total = 0;
    if (readOnly) {
      for (const hours of byDate.values()) total += hours;
      return round2(total);
    }
    for (const input of inputs.values()) {
      const parsed = parseHours(input.value);
      if (Number.isFinite(parsed) && parsed > 0) total += quantiseHours(parsed, increment);
    }
    return round2(total);
  }

  function refreshTotal() {
    const total = currentTotal();
    totalCell.textContent = formatHours(total, locale);
    if (onTotalChange) onTotalChange(total);
  }

  const rows = monthDays(period.year, period.month).map((day) => {
    const inWindow = withinAssignment(day.date, assignment);
    const hours = byDate.get(day.date);

    const classes = ['grid__row'];
    if (day.weekend) classes.push('grid__row--weekend');
    if (!inWindow) classes.push('grid__row--outside');

    let valueCell;
    if (readOnly || !inWindow) {
      valueCell = el('td', { class: 'num' },
        hours ? formatHours(hours, locale) : el('span', { class: 'muted' }, t('common.none')));
    } else {
      const input = el('input', {
        type: 'text',
        inputmode: 'decimal',
        autocomplete: 'off',
        class: 'grid__input',
        // The visible date column is the label for sighted users; screen
        // reader users need it spelled out on the field itself.
        'aria-label': day.date + ' — ' + t('grid.hours'),
        value: hours ? formatHours(hours, locale) : '',
        oninput: () => {
          input.classList.remove('is-invalid');
          refreshTotal();
          if (onDirty) onDirty();
        },
        onblur: () => {
          const parsed = parseHours(input.value);
          if (parsed === null) {
            input.value = '';
          } else if (!Number.isFinite(parsed) || parsed < 0 || parsed > 24) {
            input.classList.add('is-invalid');
          } else {
            input.classList.remove('is-invalid');
            input.value = parsed === 0 ? '' : formatHours(quantiseHours(parsed, increment), locale);
          }
          refreshTotal();
        },
      });
      inputs.set(day.date, input);
      valueCell = el('td', { class: 'num' }, input);
    }

    return el('tr', { class: classes.join(' ') }, [
      el('th', { scope: 'row', class: 'grid__date' }, String(day.day)),
      el('td', { class: 'grid__weekday' }, formatWeekday(day.date, locale)),
      valueCell,
    ]);
  });

  const node = el('div', { class: 'table-wrap grid' }, [
    el('table', { class: 'table grid__table' }, [
      el('caption', { class: 'visually-hidden' }, t('f2.title')),
      el('thead', el('tr', [
        el('th', { scope: 'col', class: 'grid__date' }, t('grid.date')),
        el('th', { scope: 'col' }, t('grid.weekday')),
        el('th', { scope: 'col', class: 'num' }, t('grid.hours')),
      ])),
      el('tbody', rows),
      el('tfoot', el('tr', { class: 'grid__total' }, [
        el('th', { scope: 'row', colspan: '2' }, t('grid.total_hours')),
        totalCell,
      ])),
    ]),
  ]);

  refreshTotal();

  return {
    node,

    /** Current contents as adapter input. Blank and zero days are dropped. */
    getEntries() {
      if (readOnly) return entries.slice();
      const out = [];
      for (const [date, input] of inputs.entries()) {
        const parsed = parseHours(input.value);
        if (parsed === null || !Number.isFinite(parsed) || parsed <= 0) continue;
        out.push({ date, hours: parsed });
      }
      return out;
    },

    /** True when every field holds something the domain will accept. */
    isValid() {
      if (readOnly) return true;
      for (const input of inputs.values()) {
        const parsed = parseHours(input.value);
        if (parsed === null) continue;
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 24) return false;
      }
      return true;
    },

    getTotal: currentTotal,

    /** Put the cursor on the first enterable day. */
    focusFirst() {
      const first = inputs.values().next();
      if (!first.done) first.value.focus();
    },
  };
}
