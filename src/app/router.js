/**
 * Hash router.
 *
 * Hash routing rather than the History API, because GitHub Pages serves a
 * project site from a subpath and has no rewrite rules: a deep link to
 * /repo/period would 404 before any JavaScript ran. With a hash, every URL is
 * the same document and deep links survive a refresh and a shared link. The
 * cost is an ugly URL, which is the right trade for a six-screen internal tool.
 */

const routes = [];
let notFound = null;
let onNavigate = null;
let currentPath = null;

/**
 * Register a route. `pattern` is a path with :params, e.g. '/review/:id'.
 * Handlers receive ({ params, query, path }).
 */
export function route(pattern, handler) {
  const names = [];
  const regexSource = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\/:(\w+)/g, (match, name) => {
      names.push(name);
      return '/([^/]+)';
    });
  routes.push({ regex: new RegExp('^' + regexSource + '$'), names, handler, pattern });
}

export function fallback(handler) {
  notFound = handler;
}

/** Called after every successful navigation, for things like closing menus. */
export function afterEach(handler) {
  onNavigate = handler;
}

function parse() {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [path, queryString] = raw.split('?');
  const query = {};
  if (queryString) {
    for (const [key, value] of new URLSearchParams(queryString)) query[key] = value;
  }
  return { path: path || '/', query };
}

export function currentRoute() {
  return currentPath;
}

export function navigate(path, options = {}) {
  if (options.replace) {
    const url = window.location.pathname + window.location.search + '#' + path;
    window.history.replaceState(null, '', url);
    resolve();
  } else {
    window.location.hash = path;
  }
}

/** Resolve the current URL against the route table. */
export async function resolve() {
  const { path, query } = parse();
  currentPath = path;

  for (const entry of routes) {
    const match = entry.regex.exec(path);
    if (!match) continue;
    const params = {};
    entry.names.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });
    await entry.handler({ params, query, path });
    if (onNavigate) onNavigate(path);
    return;
  }

  if (notFound) await notFound({ path, query });
  if (onNavigate) onNavigate(path);
}

export function start() {
  window.addEventListener('hashchange', () => { resolve(); });
  return resolve();
}
