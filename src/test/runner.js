/**
 * A test runner in eighty lines.
 *
 * There is no npm in this project, so there is no Vitest and no Jest. The
 * suite runs in the browser at /tests.html and is served by GitHub Pages
 * alongside the app, which means the deployed build can always be checked
 * against its own tests without installing anything.
 */

const suites = [];
let currentSuite = null;

export function describe(name, fn) {
  currentSuite = { name, tests: [] };
  suites.push(currentSuite);
  fn();
  currentSuite = null;
}

export function it(name, fn) {
  if (!currentSuite) throw new Error('it() outside describe()');
  currentSuite.tests.push({ name, fn });
}

class AssertionError extends Error {}

function stringify(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value instanceof Error) return value.name + ': ' + value.message;
  try {
    return JSON.stringify(value);
  } catch (err) {
    return String(value);
  }
}

export const assert = {
  ok(value, message) {
    if (!value) throw new AssertionError(message || 'expected truthy, got ' + stringify(value));
  },
  equal(actual, expected, message) {
    if (actual !== expected) {
      throw new AssertionError(
        (message ? message + ': ' : '') + 'expected ' + stringify(expected) + ', got ' + stringify(actual),
      );
    }
  },
  deepEqual(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
      throw new AssertionError((message ? message + ': ' : '') + 'expected ' + b + ', got ' + a);
    }
  },
  /** Asserts the call throws, and (optionally) with a specific domain code. */
  async throws(fn, code, message) {
    let threw = null;
    try {
      await fn();
    } catch (err) {
      threw = err;
    }
    if (!threw) throw new AssertionError((message ? message + ': ' : '') + 'expected a throw');
    if (code && threw.code !== code) {
      throw new AssertionError(
        (message ? message + ': ' : '') + 'expected code ' + code + ', got ' + (threw.code || threw.message),
      );
    }
    return threw;
  },
};

/**
 * A test that never settles would otherwise hang the page and, in CI, the job.
 * Report it as a failure instead and carry on with the rest of the suite.
 */
const TEST_TIMEOUT_MS = 20000;

function withTimeout(promise, name) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new AssertionError('timed out after ' + TEST_TIMEOUT_MS + 'ms')),
      TEST_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * Run everything and report into `output`. Returns { passed, failed }.
 */
export async function run(output) {
  let passed = 0;
  let failed = 0;

  for (const suite of suites) {
    const section = document.createElement('section');
    section.className = 'suite';
    const heading = document.createElement('h2');
    heading.textContent = suite.name;
    section.appendChild(heading);
    const list = document.createElement('ul');
    section.appendChild(list);
    output.appendChild(section);

    for (const test of suite.tests) {
      const item = document.createElement('li');
      try {
        await withTimeout(Promise.resolve().then(test.fn), test.name);
        item.className = 'pass';
        item.textContent = 'PASS  ' + test.name;
        passed += 1;
      } catch (err) {
        item.className = 'fail';
        item.textContent = 'FAIL  ' + test.name + ' — ' + (err && err.message ? err.message : String(err));
        failed += 1;
      }
      list.appendChild(item);
    }
  }

  return { passed, failed };
}
