/**
 * Application entry point. Wires the router, the session guard and the shell.
 *
 * The whole app is one document served statically; there is no build step and
 * no bundler, so this file is loaded as a module and everything it needs is
 * reached through plain relative imports.
 */

import { CONFIG } from './config.js';
import { initLocale, t, onLocaleChange } from './i18n/index.js';
import { getAdapter } from './data/index.js';
import { ROLE } from './domain/model.js';
import { route, fallback, navigate, resolve, start, currentRoute } from './app/router.js';
import { renderShell } from './app/shell.js';
import { el, append, clear } from './ui/dom.js';
import { notice, emptyState } from './ui/components/ui.js';

import { renderSignIn, renderTokenLanding } from './ui/screens/signin.js';
import { renderSignupChoice, renderSignupForm } from './ui/screens/signup.js';
import { renderFreelancerPeriod } from './ui/screens/freelancerPeriod.js';
import { renderHistory } from './ui/screens/history.js';
import { renderInbox, renderReview } from './ui/screens/approverReview.js';
import { renderAssignmentDetail } from './ui/screens/assignmentDetail.js';
import { renderBoard, renderProject } from './ui/screens/board.js';
import { renderApplications } from './ui/screens/applications.js';
import { renderProfile } from './ui/screens/profile.js';
import { renderCompanyProjects, renderProjectForm } from './ui/screens/companyProjects.js';
import { renderApplicants } from './ui/screens/applicants.js';

let adapter = null;
let session = null;

/**
 * Where a signed-in user belongs when they arrive at the root.
 *
 * A freelancer still lands on their current period rather than the project
 * board: someone with a live placement opens this app to enter hours, and the
 * marketplace is what they go looking for, not what they are interrupted by.
 */
function homeFor(user) {
  if (!user) return '/signin';
  if (user.role === ROLE.FREELANCER) return '/period';
  if (user.role === ROLE.APPROVER) return '/inbox';
  if (user.role === ROLE.COMPANY_ADMIN) return '/company/projects';
  return '/assignment';
}

async function refreshSession() {
  session = await adapter.getSession();
  return session;
}

/**
 * Draw the shell for the current session and hand the screen its container.
 * Called by every route so the header always reflects who is signed in.
 */
function frame() {
  return renderShell({
    adapter,
    session,
    onRerender: () => resolve(),
    onSignOut: async () => {
      await adapter.signOut();
      session = null;
      navigate('/signin');
      // If we were already on /signin the hash does not change, so redraw.
      if (currentRoute() === '/signin') resolve();
    },
  });
}

/**
 * Routes that require a session. Anyone arriving without one is sent to sign
 * in rather than shown an error, because the overwhelmingly likely cause is an
 * expired session on an emailed link, not an attack.
 */
function guarded(handler, roles) {
  return async (context) => {
    await refreshSession();
    if (!session) {
      navigate('/signin');
      return;
    }
    const main = frame();
    if (roles && !roles.includes(session.role)) {
      clear(main);
      append(main, notice('error', null, t('error.not_authorised')));
      return;
    }
    await handler(main, context);
  };
}

async function onSignedIn(newSession) {
  session = newSession;
  navigate(homeFor(session));
  // Landing on a token URL and then navigating leaves the token in history;
  // replace it so a back button cannot re-open a consumed link.
  window.history.replaceState(null, '', window.location.pathname + window.location.search
    + '#' + homeFor(session));
  await resolve();
}

function registerRoutes() {
  route('/', async () => {
    await refreshSession();
    navigate(homeFor(session), { replace: true });
  });

  route('/signin', async () => {
    await refreshSession();
    if (session) {
      navigate(homeFor(session), { replace: true });
      return;
    }
    const main = frame();
    renderSignIn(main, { adapter, onSignedIn });
  });

  route('/signup', async () => {
    await refreshSession();
    if (session) {
      navigate(homeFor(session), { replace: true });
      return;
    }
    renderSignupChoice(frame());
  });

  route('/signup/:kind', async ({ params }) => {
    await refreshSession();
    if (session) {
      navigate(homeFor(session), { replace: true });
      return;
    }
    if (params.kind !== 'freelancer' && params.kind !== 'company') {
      navigate('/signup', { replace: true });
      return;
    }
    renderSignupForm(frame(), { adapter, kind: params.kind, onSignedIn });
  });

  route('/signin/token/:token', async ({ params }) => {
    const main = frame();
    await renderTokenLanding(main, { adapter, token: params.token, onSignedIn });
  });

  route('/period', guarded((main) => renderFreelancerPeriod(main, {
    adapter, session,
  }), [ROLE.FREELANCER, ROLE.OPS]));

  route('/period/:id', guarded((main, { params }) => renderFreelancerPeriod(main, {
    adapter, session, periodId: params.id,
  }), [ROLE.FREELANCER, ROLE.OPS]));

  route('/history', guarded((main) => renderHistory(main, { adapter }),
    [ROLE.FREELANCER, ROLE.OPS]));

  route('/inbox', guarded((main) => renderInbox(main, { adapter }),
    [ROLE.APPROVER, ROLE.OPS]));

  route('/review/:id', guarded((main, { params }) => renderReview(main, {
    adapter, periodId: params.id,
  }), [ROLE.APPROVER, ROLE.OPS]));

  /* ---------------- Marketplace ---------------- */

  route('/board', guarded((main) => renderBoard(main, { adapter }),
    [ROLE.FREELANCER, ROLE.OPS]));

  route('/project/:id', guarded((main, { params }) => renderProject(main, {
    adapter, projectId: params.id,
  }), [ROLE.FREELANCER, ROLE.OPS]));

  route('/applications', guarded((main) => renderApplications(main, { adapter }),
    [ROLE.FREELANCER, ROLE.OPS]));

  route('/profile', guarded((main) => renderProfile(main, { adapter }),
    [ROLE.FREELANCER, ROLE.OPS]));

  route('/company/projects', guarded((main) => renderCompanyProjects(main, { adapter, session }),
    [ROLE.COMPANY_ADMIN, ROLE.OPS]));

  // '/company/project/new' resolves here too: the form treats the id 'new' as
  // "no project yet", so creating and editing are one screen and one route.
  route('/company/project/:id', guarded((main, { params }) => renderProjectForm(main, {
    adapter, projectId: params.id,
  }), [ROLE.COMPANY_ADMIN, ROLE.OPS]));

  route('/company/project/:id/applicants', guarded((main, { params }) => renderApplicants(main, {
    adapter, projectId: params.id,
  }), [ROLE.COMPANY_ADMIN, ROLE.OPS]));

  route('/assignment', guarded((main) => renderAssignmentDetail(main, { adapter })));

  route('/assignment/:id', guarded((main, { params }) => renderAssignmentDetail(main, {
    adapter, assignmentId: params.id,
  })));

  fallback(async () => {
    await refreshSession();
    const main = frame();
    clear(main);
    append(main, emptyState(
      t('error.not_found'),
      '',
      el('a', { class: 'btn btn--primary', href: '#' + homeFor(session) }, t('common.back')),
    ));
  });
}

async function boot() {
  const locale = initLocale();
  document.documentElement.lang = locale;
  document.title = t('app.name');
  onLocaleChange(() => { document.title = t('app.name'); });

  try {
    adapter = await getAdapter();
  } catch (err) {
    const root = document.getElementById('app');
    clear(root);
    append(root, el('div', { class: 'centred' }, el('div', { class: 'panel panel--narrow' },
      notice('error', 'Configuration error', err.message))));
    return;
  }

  registerRoutes();
  await start();
}

boot();

// Surfacing a failed render is better than a blank page with a console nobody
// is looking at. This is the last resort, not error handling.
window.addEventListener('unhandledrejection', (event) => {
  if (!CONFIG || CONFIG.backend !== 'mock') return;
  // eslint-disable-next-line no-console
  console.error('Unhandled rejection:', event.reason);
});
