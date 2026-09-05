/**
 * DOM helpers. Deliberately tiny.
 *
 * There is no framework here and no build step, which is a decision, not a
 * shortcut: the whole app has to be served as static files from GitHub Pages,
 * and a project this size does not need a virtual DOM to render six screens.
 *
 * The one rule everything else follows: text goes in through textContent.
 * `innerHTML` appears nowhere in this codebase. A client name, a rejection
 * comment and an email address are all attacker-controlled the moment there is
 * a real database behind them.
 */

/**
 * Create an element.
 *   el('p', 'hello')
 *   el('button', { class: 'btn', onclick: fn }, 'Save')
 *   el('div', { class: 'row' }, [child, child])
 */
export function el(tag, attrsOrChildren, maybeChildren) {
  const node = document.createElement(tag);
  let attrs = attrsOrChildren;
  let children = maybeChildren;

  const looksLikeChildren = Array.isArray(attrsOrChildren)
    || typeof attrsOrChildren === 'string'
    || typeof attrsOrChildren === 'number'
    || attrsOrChildren instanceof Node;

  if (looksLikeChildren) {
    attrs = null;
    children = attrsOrChildren;
  }

  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2), value);
      } else if (key === 'dataset') {
        Object.assign(node.dataset, value);
      } else if (key === 'class') {
        node.className = value;
      } else if (key === 'text') {
        node.textContent = String(value);
      } else if (value === true) {
        node.setAttribute(key, '');
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }

  append(node, children);
  return node;
}

export function append(parent, children) {
  if (children === null || children === undefined || children === false) return parent;
  if (Array.isArray(children)) {
    for (const child of children) append(parent, child);
    return parent;
  }
  if (children instanceof Node) {
    parent.appendChild(children);
    return parent;
  }
  parent.appendChild(document.createTextNode(String(children)));
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function replace(node, children) {
  clear(node);
  append(node, children);
  return node;
}

export function qs(selector, root = document) {
  return root.querySelector(selector);
}

/**
 * Move focus to a heading after a route change so a screen reader announces
 * the new screen. Without this a single-page app is silent to anyone not
 * looking at it.
 */
export function focusHeading(container) {
  const heading = container.querySelector('h1, h2, [data-autofocus]');
  if (!heading) return;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: false });
}

/** A live region announcement that does not steal focus. */
export function announce(message) {
  const region = document.getElementById('live-region');
  if (!region) return;
  region.textContent = '';
  // A tick of delay, otherwise repeated identical messages are not re-read.
  window.setTimeout(() => { region.textContent = message; }, 50);
}
