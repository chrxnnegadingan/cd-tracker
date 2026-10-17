// Tests real chatbot/analyzer scripts in a DOM, with mocked transport only.
// npm install --no-save --package-lock=false jsdom
// node --test tests/echo-state.dom.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { JSDOM } = require(process.env.ECHO_JSDOM_MODULE || 'jsdom');
const source = readFileSync(new URL('../frontend/script/chatbot.js', import.meta.url), 'utf8');
const analyzerSource = readFileSync(new URL('../frontend/script/syntax-analyzer.js', import.meta.url), 'utf8');
const classroom = '22222222-2222-2222-2222-222222222222';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(condition) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await tick(); }
  assert.fail('Expected UI state did not arrive');
}

async function fixture(t, { stored = {}, blocked = false, path = '/dashboard/', server = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><button id="outside">Outside</button></body></html>', {
    url: 'https://example.test' + path, runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = dom.window;
  t.after(() => w.close());
  const errors = [];
  w.addEventListener('error', event => errors.push(event.message));
  t.after(() => assert.deepEqual(errors, []));
  const q = selector => w.document.querySelector(selector);
  const all = selector => [...w.document.querySelectorAll(selector)];
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.confirm = () => true;
  let clipboard = '';
  Object.defineProperty(w.navigator, 'clipboard', { value: { async writeText(text) { clipboard = text; } } });
  let exported = null;
  w.URL.createObjectURL = blob => { exported = blob; return 'blob:test'; };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () {};
  const mock = { user: 'user-one', calls: [], status: 0, mode: 'ok', profileFailure: false, profilePause: null };
  w.CodeTrackerConfig = { features: { remoteChatHistory: !!server } };
  w.ApiClient = { async request(url, options = {}) {
    if (url === '/users/profile') {
      if (mock.profilePause) await mock.profilePause;
      if (mock.profileFailure) throw Object.assign(new Error('Unauthorized'), { status: 401 });
      return { userId: mock.user };
    }
    if (url === '/classrooms/me') return [{ classroomId: classroom, name: 'Programming 101' }];
    if (url === '/classrooms/join') return [];
    if (server && url.startsWith('/chatbot/threads')) return server.request(mock.user, url, options);
    assert.equal(url, '/chatbot', 'No unsupported endpoint requests');
    mock.calls.push(JSON.parse(options.body));
    if (mock.mode === 'pending') return new Promise((resolve, reject) => {
      mock.resolve = resolve;
      options.signal.addEventListener('abort', () => reject(new w.DOMException('Stopped', 'AbortError')), { once: true });
    });
    if (mock.status) throw Object.assign(new Error('Request failed'), { status: mock.status });
    if (server) return server.chat(mock.user, JSON.parse(options.body));
    return { reply: '**Clear names** and `const`.\n```js\nconst answer = 42;\n```\n<img src=x onerror="window.injected=true">' };
  } };
  Object.entries(stored).forEach(([key, value]) => w.sessionStorage.setItem(key, value));
  if (blocked) {
    w.Storage.prototype.getItem = () => { throw new Error('blocked'); };
    w.Storage.prototype.setItem = () => { throw new Error('blocked'); };
    w.Storage.prototype.removeItem = () => { throw new Error('blocked'); };
  }
  w.eval(source);
  await until(() => w.CodeTrackerEcho && !q('#chatbot-threads-toggle').hidden);
  if (server) { await tick(); await tick(); }
  const input = value => { q('#chatbot-input').value = value; q('#chatbot-input').dispatchEvent(new w.Event('input')); };
  const send = async text => {
    input(text);
    q('#chatbot-input-area').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await until(() => !q('#chatbot-input').disabled);
  };
  const open = async () => {
    w.CodeTrackerEcho.open();
    await until(() => q('#chatbot-classroom').options.length === 2);
  };
  const scope = value => { q('#chatbot-classroom').value = value; q('#chatbot-classroom').dispatchEvent(new w.Event('change')); };
  return { w, q, all, mock, input, send, open, scope, clipboard: () => clipboard, exported: () => exported };
}

test('default stays closed; rendering escapes HTML, preserves code and copies safely', async t => {
  const f = await fixture(t);
  assert.equal(f.q('#chatbot-window').getAttribute('aria-hidden'), 'true');
  await f.open();
  await f.send('Help with code');
  assert.deepEqual(Object.keys(f.mock.calls[0]).sort(), ['classroomId', 'history', 'message', 'timezone']);
  assert.deepEqual(f.mock.calls[0].history, []);
  assert.equal(f.q('.bot-message pre code').textContent, 'const answer = 42;\n');
  assert.equal(f.q('.bot-message img'), null);
  f.q('[aria-label="Copy code"]').click(); await tick();
  assert.equal(f.clipboard(), 'const answer = 42;\n');
  f.q('#chatbot-minimize').click();
  assert.equal(f.q('#chatbot-window').getAttribute('aria-hidden'), 'true');
});

test('threads keep separate context, support rename/search/delete, and restore after reload', async t => {
  const f = await fixture(t); await f.open();
  await f.send('First topic');
  f.q('#chatbot-new-thread').click();
  await f.send('Second topic');
  assert.deepEqual(f.mock.calls[1].history, []);
  f.q('#chatbot-threads-toggle').click();
  assert.equal(f.all('.chatbot-thread-row').length, 2);
  f.q('#chatbot-thread-search').value = 'first';
  f.q('#chatbot-thread-search').dispatchEvent(new f.w.Event('input'));
  assert.equal(f.all('.chatbot-thread-row').length, 1);
  f.q('.chatbot-thread-rename').click();
  f.q('.chatbot-rename-form input').value = 'Revision notes';
  f.q('.chatbot-rename-form').dispatchEvent(new f.w.Event('submit', { cancelable: true }));
  f.q('#chatbot-thread-search').value = '';
  f.q('#chatbot-thread-search').dispatchEvent(new f.w.Event('input'));
  f.all('.chatbot-thread-select').find(el => el.textContent.includes('Revision notes')).click();
  await f.send('Follow up');
  assert.equal(f.mock.calls[2].history[0].text, 'First topic');
  assert.ok(!f.mock.calls[2].history.some(turn => turn.text === 'Second topic'));
  const reloaded = await fixture(t, { stored: { ...f.w.sessionStorage } });
  assert.match(reloaded.q('#chatbot-messages').textContent, /Follow up/);
  reloaded.q('#chatbot-threads-toggle').click();
  assert.equal(reloaded.all('.chatbot-thread-row').length, 2);
  reloaded.all('.chatbot-thread-delete').find(el => el.getAttribute('aria-label').includes('Second topic')).click();
  await tick();
  assert.equal(reloaded.all('.chatbot-thread-row').length, 1);
});

test('classroom histories and drafts are isolated; unsent new-chat draft survives reload', async t => {
  const f = await fixture(t); await f.open();
  await f.send('Dashboard private');
  f.input('Draft for dashboard');
  f.scope(classroom);
  assert.equal(f.all('.user-message').length, 0);
  assert.equal(f.q('#chatbot-input').value, '');
  await f.send('Classroom private');
  assert.equal(f.mock.calls[1].classroomId, classroom);
  assert.deepEqual(f.mock.calls[1].history, []);
  f.scope('');
  assert.equal(f.q('#chatbot-input').value, 'Draft for dashboard');
  assert.doesNotMatch(f.q('#chatbot-messages').textContent, /Classroom private/);
  f.q('#chatbot-new-thread').click();
  f.input('A new unsent topic');
  const reloaded = await fixture(t, { stored: { ...f.w.sessionStorage } });
  assert.equal(reloaded.q('#chatbot-input').value, 'A new unsent topic');
});

test('new account cannot receive old draft or cached conversations', async t => {
  const f = await fixture(t); await f.send('Private user one');
  f.mock.user = 'user-two';
  await f.send('Do not send');
  assert.equal(f.mock.calls.length, 1);
  assert.equal(f.all('.user-message').length, 0);
  assert.equal(f.all('.chatbot-thread-row').length, 0);
  assert.ok(!JSON.stringify(f.w.sessionStorage).includes('Private user one'));
});

test('Stop and retry exclude failed turns and avoid duplicate submissions', async t => {
  const f = await fixture(t);
  f.mock.mode = 'pending'; f.input('Explain this');
  const submit = () => f.q('#chatbot-input-area').dispatchEvent(new f.w.Event('submit', { cancelable: true }));
  submit(); submit();
  await until(() => f.mock.calls.length === 1);
  f.q('#chatbot-stop').click();
  await until(() => !f.q('#chatbot-input').disabled);
  assert.match(f.q('#chatbot-messages').textContent, /Response stopped/);
  f.q('#chatbot-retry').click();
  assert.equal(f.q('#chatbot-input').value, 'Explain this');
  f.mock.mode = 'ok'; submit();
  await until(() => f.mock.calls.length === 2 && !f.q('#chatbot-input').disabled);
  assert.deepEqual(f.mock.calls[1].history, []);
});

test('403 and 401 clear private view and session caches', async t => {
  const f = await fixture(t); await f.open(); f.scope(classroom);
  await f.send('Sensitive academic question');
  f.mock.status = 403; await f.send('Revoked access');
  assert.equal(f.all('.user-message').length, 0);
  assert.match(f.q('#chatbot-status').textContent, /Access denied/);
  f.mock.status = 0; f.mock.profileFailure = true;
  await f.send('Expired session');
  assert.equal(f.all('.chatbot-thread-row').length, 0);
  assert.equal(Object.keys(f.w.sessionStorage).filter(k => k.startsWith('ct_echo_history_')).length, 0);
});

test('blocked storage retains working in-memory conversations across context changes', async t => {
  const f = await fixture(t, { blocked: true }); await f.open();
  await f.send('Memory-only');
  f.scope(classroom); await f.send('Other context'); f.scope('');
  assert.match(f.q('#chatbot-messages').textContent, /Memory-only/);
  assert.doesNotMatch(f.q('#chatbot-messages').textContent, /Other context/);
});

test('offline and IME Enter keep the draft without sending', async t => {
  const f = await fixture(t); f.input('Keep draft');
  f.q('#chatbot-input').dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
  await tick(); assert.equal(f.mock.calls.length, 0);
  Object.defineProperty(f.w.navigator, 'onLine', { value: false });
  await f.send('Keep draft');
  assert.equal(f.mock.calls.length, 0);
  assert.equal(f.q('#chatbot-input').value, 'Keep draft');
});

test('export prepares only the current conversation', async t => {
  const f = await fixture(t); await f.send('Export this');
  f.q('#chatbot-threads-toggle').click(); f.q('#chatbot-export').click();
  assert.equal(f.exported().type, 'text/markdown;charset=utf-8');
  const reader = new f.w.FileReader();
  const text = new Promise(resolve => { reader.onload = () => resolve(reader.result); });
  reader.readAsText(f.exported());
  assert.match(await text, /Export this/);
});

test('real analyzer handoff prepares selected findings without an extra analysis or chat request', async t => {
  const f = await fixture(t);
  for (const id of ['repoStatus', 'resultsSection', 'summaryStats', 'codeContent', 'currentFileName', 'languageBadge',
    'errorList', 'errorCount', 'warningCount', 'fileList', 'backToClassBtn', 'supportedBadge', 'repoUrlDisplay', 'headerSubtitle']) {
    const el = f.w.document.createElement('div'); el.id = id; f.w.document.body.append(el);
  }
  const search = f.w.document.createElement('input'); search.id = 'fileSearch'; f.w.document.body.append(search);
  f.w.sessionStorage.setItem('pendingAnalysis', JSON.stringify({ repoUrl: 'https://github.com/example/demo' }));
  let runs = 0;
  f.w.CodeTrackerAnalyzer = { createClient: () => ({
    async startAnalysis() { runs++; return { analysis_id: 'job' }; },
    async pollAnalysis() { return { files: [{ file_name: 'demo.py', language: 'python', code: 'print(value)', errors: [{ line: 1, message: 'Undefined name', source_line: 'print(value)' }], warnings: [] }] }; }
  }) };
  f.w.eval(analyzerSource);
  f.w.document.dispatchEvent(new f.w.Event('DOMContentLoaded'));
  await until(() => !f.q('#chatbot-analyzer-context').hidden);
  f.q('#chatbot-analyzer-context').click();
  assert.match(f.q('#chatbot-input').value, /demo\.py.*\nLine 1: Undefined name/s);
  assert.equal(f.mock.calls.length, 0);
  assert.equal(runs, 1);
});

test('legacy single chat migrates once, corrupted storage is harmless, history is bounded', async t => {
  const key = 'ct_echo_history_user-one_v3_all';
  const f = await fixture(t, { stored: { ct_echo_account: 'user-one', [key]: JSON.stringify([{ role: 'user', text: 'Legacy message', timestamp: 1 }]) } });
  assert.match(f.q('#chatbot-messages').textContent, /Legacy message/);
  assert.equal(f.w.sessionStorage.getItem(key), null);
  for (let i = 0; i < 33; i++) { f.q('#chatbot-new-thread').click(); await f.send('Topic ' + i); }
  f.q('#chatbot-threads-toggle').click();
  assert.equal(f.all('.chatbot-thread-row').length, 30);
  const corrupted = await fixture(t, { stored: { ct_echo_account: 'user-one', [key + '_threads_v1']: '{bad-json' } });
  assert.equal(corrupted.all('.user-message').length, 0);
  await corrupted.send('Still works');
  assert.equal(corrupted.mock.calls.length, 1);
});

test('late profile completion after pagehide cannot restore private messages', async t => {
  const f = await fixture(t); await f.send('Private message');
  let release;
  f.mock.profilePause = new Promise(resolve => { release = resolve; });
  f.w.CodeTrackerEcho.open();
  f.w.dispatchEvent(new f.w.PageTransitionEvent('pagehide', { persisted: true }));
  release(); await tick(); await tick();
  assert.equal(f.all('.user-message').length, 0);
  assert.equal(f.all('.chatbot-thread-row').length, 0);
});

function persistentServer() {
  const rows = new Map();
  const server = {
    rows, unavailable: false,
    request(owner, path, options = {}) {
      if (server.unavailable) throw new Error('Database unavailable');
      const url = new URL(path, 'https://example.test');
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : {};
      if (url.pathname === '/chatbot/threads') {
        if (method === 'POST') {
          const thread = { ...body, owner, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] };
          rows.set(thread.threadId, thread); return thread;
        }
        const data = [...rows.values()].filter(t => t.owner === owner && (t.classroomId || null) === url.searchParams.get('classroomId'));
        return { data: data.reverse(), page: 0, hasMore: false };
      }
      const id = url.pathname.split('/')[3];
      const row = rows.get(id);
      if (!row || row.owner !== owner) throw Object.assign(new Error('Not found'), { status: 404 });
      if (method === 'PATCH') { row.title = body.title; return row; }
      if (method === 'DELETE') { rows.delete(id); return; }
      const before = Number(url.searchParams.get('beforePosition')) || Infinity;
      const all = row.messages.filter(m => m.position < before);
      const data = all.slice(-Number(url.searchParams.get('size') || 100));
      return { data, hasMore: data.length < all.length, nextBeforePosition: data[0]?.position };
    },
    chat(owner, body) {
      const thread = rows.get(body.threadId);
      assert.equal(thread.owner, owner);
      assert.ok(body.requestId);
      const replay = thread.messages.find(m => m.requestId === body.requestId && m.role === 'assistant');
      if (replay) return { reply: replay.content, threadId: thread.threadId };
      for (const [role, content] of [['user', body.message], ['assistant', 'Saved answer: ' + body.message]]) {
        thread.messages.push({ messageId: String(thread.messages.length + 1), requestId: body.requestId,
          role, content, position: thread.messages.length + 1, createdAt: new Date().toISOString() });
      }
      return { reply: 'Saved answer: ' + body.message, threadId: thread.threadId };
    }
  };
  return server;
}

test('persistent conversations restore on another device with completely empty browser storage', async t => {
  const server = persistentServer();
  const first = await fixture(t, { server });
  await first.send('Remember this conversation');
  assert.equal(server.rows.size, 1);
  first.w.sessionStorage.clear();
  const second = await fixture(t, { server });
  assert.match(second.q('#chatbot-messages').textContent, /Remember this conversation/);
  await second.send('Continue on device two');
  assert.equal(server.rows.size, 1);
  assert.equal([...server.rows.values()][0].messages.length, 4);
  second.q('#chatbot-new-thread').click(); await second.send('Another topic');
  assert.equal(server.rows.size, 2);
  const third = await fixture(t, { server });
  assert.match(third.q('#chatbot-messages').textContent, /Another topic/);
});

test('remote rename and deletion persist across fresh logins', async t => {
  const server = persistentServer();
  const first = await fixture(t, { server }); await first.send('Original name');
  first.q('#chatbot-threads-toggle').click(); await tick();
  first.q('.chatbot-thread-rename').click();
  first.q('.chatbot-rename-form input').value = 'Permanent name';
  first.q('.chatbot-rename-form').dispatchEvent(new first.w.Event('submit', { cancelable: true }));
  await tick();
  const second = await fixture(t, { server });
  second.q('#chatbot-threads-toggle').click(); await tick();
  assert.match(second.q('.chatbot-thread-select').textContent, /Permanent name/);
  second.q('.chatbot-thread-delete').click(); await tick();
  assert.equal(server.rows.size, 0);
  const third = await fixture(t, { server });
  assert.equal(third.all('.user-message').length, 0);
});

test('persistent storage failure keeps draft and never falls back to misleading local-only success', async t => {
  const server = persistentServer(); server.unavailable = true;
  const f = await fixture(t, { server });
  await f.send('Keep this unsaved draft');
  assert.equal(f.mock.calls.length, 0);
  assert.equal(server.rows.size, 0);
  assert.equal(f.q('#chatbot-input').value, 'Keep this unsaved draft');
  assert.match(f.q('#chatbot-status').textContent, /unavailable/);
});

test('persistent history works when browser storage is blocked and remains account scoped', async t => {
  const server = persistentServer();
  const first = await fixture(t, { server }); await first.send('Private saved message');
  const second = await fixture(t, { server, blocked: true });
  assert.match(second.q('#chatbot-messages').textContent, /Private saved message/);
  second.mock.user = 'someone-else';
  await second.send('Do not cross accounts');
  assert.equal(second.mock.calls.length, 0);
  assert.doesNotMatch(second.q('#chatbot-messages').textContent, /Private saved message/);
});

test('remote pagination loads older messages without losing recent turns and exports the whole thread', async t => {
  const server = persistentServer();
  const first = await fixture(t, { server }); await first.send('Original');
  const row = [...server.rows.values()][0];
  row.messages = Array.from({ length: 122 }, (_, i) => ({ messageId: String(i + 1), role: i % 2 ? 'assistant' : 'user',
    content: 'Message ' + (i + 1), position: i + 1, createdAt: new Date().toISOString() }));
  const second = await fixture(t, { server });
  assert.equal(second.all('.chat-message').length, 100);
  second.q('[data-load-older-messages]').click(); await tick(); await tick();
  assert.equal(second.all('.chat-message').length, 122);
  second.q('#chatbot-export').click(); await tick();
  const reader = new second.w.FileReader();
  const text = new Promise(resolve => { reader.onload = () => resolve(reader.result); });
  reader.readAsText(second.exported());
  const result = await text;
  assert.match(result, /Message 1\n/); assert.match(result, /Message 122/);
});
