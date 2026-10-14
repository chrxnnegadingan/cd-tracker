import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../frontend/script/chatbot.js', import.meta.url), 'utf8');
function chatbotHelpers(pathname, search = '', currentClassroomId = null) {
  const window = { location: { pathname, search }, CodeTrackerCurrentClassroomId: currentClassroomId };
  vm.runInNewContext(source.replace('  function trimHistory(items)',
    '  window.testClassroomScope = getClassroomId;\n' +
    '  window.testCreateChatRequestBody = createChatRequestBody;\n' +
    '  function trimHistory(items)'), {
    window, URLSearchParams,
    document: { readyState: 'loading', addEventListener() {} },
    localStorage: { getItem() { throw new Error('Stale browser storage must not determine scope'); } },
  });
  return window;
}
function scope(pathname, search = '', currentClassroomId = null) {
  return chatbotHelpers(pathname, search, currentClassroomId).testClassroomScope();
}
const id = '22222222-2222-2222-2222-222222222222';
for (const path of ['/studentclass', '/studentclass/', '/studentclass/index.html',
  '/profclass', '/profclass/', '/profclass/index.html']) {
  test(`Echo uses the actual classroom URL on ${path}`, () => {
    assert.equal(scope(path, `?classroomId=${id}`), id);
    assert.equal(scope(path, `?id=${id}`), id);
  });
}
for (const path of ['/studentclass/', '/profclass/']) {
  test(`Echo uses the classroom resolved by the page on ${path}`, () => {
    assert.equal(scope(path, '', id), id);
  });
}
test('Echo follows the classroom page state when it differs from the URL', () => {
  const otherId = '33333333-3333-3333-3333-333333333333';
  assert.equal(scope('/profclass/', `?id=${otherId}`, id), id);
});
test('Both classroom pages publish their resolved context for Echo', () => {
  const professorPage = readFileSync(new URL('../frontend/script/profclass.js', import.meta.url), 'utf8');
  const studentPage = readFileSync(new URL('../frontend/script/studentclass.js', import.meta.url), 'utf8');
  assert.match(professorPage, /window\.CodeTrackerCurrentClassroomId\s*=\s*state\.classroomId/);
  assert.match(studentPage, /window\.CodeTrackerCurrentClassroomId\s*=\s*classroomId/);
});
for (const path of ['/dashboard/', '/Syntax.html', '/onboarding/', '/studentclass-other/']) {
  test(`Echo ignores classroom context on an unscoped page ${path}`, () => {
    assert.equal(scope(path, `?classroomId=${id}`, id), null);
  });
}
test('Missing or malformed classroom IDs cannot cause an invalid UUID request', () => {
  assert.equal(scope('/studentclass'), null);
  assert.equal(scope('/studentclass/', '?classroomId=undefined'), null);
  assert.equal(scope('/studentclass/', '', 'not-a-uuid'), null);
});
test('The chat request body carries the selected classroom UUID and dashboard null', () => {
  const classroomPage = chatbotHelpers('/profclass/', '', id);
  const dashboard = chatbotHelpers('/dashboard/', '', id);
  const bodyFor = (helpers, classroomId) => JSON.parse(JSON.stringify(
    helpers.testCreateChatRequestBody('hello', classroomId, 'Asia/Manila', [])
  ));
  assert.deepEqual(bodyFor(classroomPage, classroomPage.testClassroomScope()), {
    message: 'hello', classroomId: id, timezone: 'Asia/Manila', history: []
  });
  assert.deepEqual(bodyFor(dashboard, dashboard.testClassroomScope()), {
    message: 'hello', classroomId: null, timezone: 'Asia/Manila', history: []
  });
});
