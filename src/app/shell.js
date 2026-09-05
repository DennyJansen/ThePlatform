/**
 * The frame around every screen: header, role-appropriate navigation, locale
 * switch, sign out, and the demo banner.
 *
 * Spec section 4 says "no tab bar" and that email is the real interface. The
 * navigation here is deliberately thin - two links for a freelancer, two for
 * an approver - and exists so that someone who lands from an email can reach
 * the one other page they might want without going back to their inbox.
 */

import { el, clear, append } from '../ui/dom.js';
import { t, getLocale, setLocale } from '../i18n/index.js';
import { CONFIG } from '../config.js';
import { ROLE } from '../domain/model.js';
import { navigate, currentRoute } from './router.js';

function navLink(href, label) {
  const active = (currentRoute() || '').startsWith(href);
  return el('a', {
    class: 'nav__link' + (active ? ' is-active' : ''),
    href: '#' + href,
    'aria-current': active ? 'page' : null,
  }, label);
}

function localeSwitch(onChange) {
  const locale = getLocale();
  return el('div', { class: 'locale', role: 'group', 'aria-label': t('common.language') },
    CONFIG.locales.map((code) => el('button', {
      type: 'button',
      class: 'locale__btn' + (code === locale ? ' is-active' : ''),
      'aria-pressed': code === locale ? 'true' : 'false',
      onclick: () => {
        if (code === locale) return;
        setLocale(code);
        if (onChange) onChange();
      },
    }, code.toUpperCase())));
}

/**
 * The demo banner. It is not decoration: someone will eventually open this
 * link and assume it is the real system, and the honest thing is to say on
 * every page that nothing here leaves the browser.
 */
function demoBanner(adapter, onReset) {
  if (!adapter.isMock) return null;
  const persistent = typeof adapter.isPersistent === 'function' ? adapter.isPersistent() : true;

  return el('div', { class: 'demo-banner' }, [
    el('div', { class: 'demo-banner__text' }, [
      el('strong', t('demo.title')),
      ' ',
      el('span', t('demo.body')),
      persistent ? null : el('p', { class: 'demo-banner__warn' }, t('demo.storage_warning')),
    ]),
    el('button', {
      type: 'button',
      class: 'btn btn--ghost btn--sm',
      onclick: async () => {
        if (!window.confirm(t('demo.reset_confirm'))) return;
        await adapter.resetDemoData();
        if (onReset) onReset();
      },
    }, t('demo.reset')),
  ]);
}

/**
 * Render the shell into #app and return the element screens render into.
 *
 * @param {Object} options
 * @param {Object} options.adapter
 * @param {Object|null} options.session
 * @param {() => void} options.onRerender  re-run the current route
 * @param {() => void} options.onSignOut
 */
export function renderShell({ adapter, session, onRerender, onSignOut }) {
  const root = document.getElementById('app');
  clear(root);

  // Spec §4 says "no tab bar", and this is still not one — but the
  // marketplace added a second thing a freelancer comes here to do, so their
  // navigation now has two groups rather than one list. Hours first: that is
  // the obligation. Finding work is the errand.
  const links = [];
  if (session) {
    if (session.role === ROLE.FREELANCER) {
      links.push(navLink('/period', t('nav.current_period')));
      links.push(navLink('/history', t('nav.history')));
      links.push(el('span', { class: 'nav__divider', 'aria-hidden': 'true' }));
      links.push(navLink('/board', t('nav.board')));
      links.push(navLink('/applications', t('nav.applications')));
      links.push(navLink('/profile', t('nav.profile')));
    } else if (session.role === ROLE.APPROVER) {
      links.push(navLink('/inbox', t('nav.inbox')));
      links.push(navLink('/assignment', t('nav.assignment')));
    } else if (session.role === ROLE.COMPANY_ADMIN) {
      links.push(navLink('/company/projects', t('nav.company_projects')));
    }
  }

  const header = el('header', { class: 'topbar' }, [
    el('div', { class: 'topbar__inner' }, [
      el('a', {
        class: 'brand',
        href: session ? '#/' : '#/signin',
      }, [
        el('span', { class: 'brand__mark', 'aria-hidden': 'true' }, '◰'),
        el('span', { class: 'brand__name' }, t('app.name')),
        adapter.isMock ? el('span', { class: 'brand__tag' }, t('demo.badge')) : null,
      ]),

      links.length
        ? el('nav', { class: 'nav', 'aria-label': t('app.name') }, links)
        : null,

      el('div', { class: 'topbar__right' }, [
        localeSwitch(onRerender),
        session
          ? el('div', { class: 'account' }, [
            el('span', { class: 'account__name' }, t('nav.signed_in_as', { name: session.name })),
            el('button', {
              type: 'button',
              class: 'btn btn--ghost btn--sm',
              onclick: onSignOut,
            }, t('nav.signout')),
          ])
          : null,
      ]),
    ]),
  ]);

  const main = el('main', { class: 'main', id: 'main', tabindex: '-1' });

  append(root, [
    el('a', { class: 'skip-link', href: '#main' }, t('app.skip_to_content')),
    header,
    demoBanner(adapter, () => navigate('/signin')),
    main,
    el('footer', { class: 'footer' }, [
      el('span', 'v' + CONFIG.version),
      CONFIG.adminUrl
        ? el('a', { href: CONFIG.adminUrl, rel: 'noopener' }, 'ops')
        : null,
    ]),
    el('div', {
      id: 'live-region',
      class: 'visually-hidden',
      role: 'status',
      'aria-live': 'polite',
    }),
  ]);

  return main;
}
