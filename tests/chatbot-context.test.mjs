import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../frontend/script/chatbot.js', import.meta.url), 'utf8');
function scope(pathname, search = '') {
  const window = { location: { pathname, search } };
  vm.runInNewContext(source.replace('  function trimHistory(items)',
    '  window.testClassroomScope = getClassroomId;\n  function trimHistory(items)'), {
    window, URLSearchParams,
    document: { readyState: 'loading', addEventListener() {} },
    localStorage: { getItem() { throw new Error('Stale browser storage must not determine scope'); } },
  });
  return window.testClassroomScope();
}
const id = '22222222-2222-2222-2222-222222222222';
for (const path of ['/studentclass', '/studentclass/', '/studentclass/index.html',
  '/profclass', '/profclass/', '/profclass/index.html']) {
  test(`Echo uses the actual classroom URL on ${path}`, () => {
    assert.equal(scope(path, `?classroomId=${id}`), id);
    assert.equal(scope(path, `?id=${id}`), id);
  });
}
for (const path of ['/dashboard/', '/Syntax.html', '/onboarding/', '/studentclass-other/']) {
  test(`Echo does not silently use a stale or unrelated classroom on ${path}`, () => {
    assert.equal(scope(path, `?classroomId=${id}`), null);
  });
}
test('Missing or malformed classroom IDs cannot cause an invalid UUID request', () => {
  assert.equal(scope('/studentclass'), null);
  assert.equal(scope('/studentclass/', '?classroomId=undefined'), null);
});
