// Integration tests with real DOM/CSS and deterministic API fixtures.
// npm install --no-save --package-lock=false playwright
// npx playwright install chromium
// node --test tests/echo-ui.browser.mjs
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = process.env.ECHO_PLAYWRIGHT_MODULE ? require(process.env.ECHO_PLAYWRIGHT_MODULE) : process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
  ? require(path.join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright'))
  : require('playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const classroom = '22222222-2222-2222-2222-222222222222';
let browser, server, origin;
const fixture = `<!doctype html><html data-theme="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/frontend/css/theme.css"><link rel="stylesheet" href="/frontend/css/chatbot.css"></head>
<body><main style="padding:32px;font-family:system-ui"><h1>CodeTracker</h1><p>Your classroom workspace</p><button id="outside">Classroom control</button></main>
<script src="/frontend/script/chatbot.js"></script></body></html>`;

before(async () => {
  server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (!pathname.startsWith('/frontend/')) {
        res.setHeader('Content-Type', 'text/html'); res.end(fixture); return;
      }
      const target = path.resolve(root, '.' + pathname);
      if (!target.startsWith(root)) { res.writeHead(403).end(); return; }
      res.setHeader('Content-Type', pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(await readFile(target));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.ECHO_CHROMIUM_PATH || undefined });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function setup(t, { viewport = { width: 1280, height: 900 }, storageBlocked = false } = {}) {
  const context = await browser.newContext({ viewport, permissions: ['clipboard-read', 'clipboard-write'] });
  t.after(() => context.close());
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await context.addInitScript(({ classroom, storageBlocked }) => {
    window.mock = { user: 'user-one', calls: [], mode: 'ok', status: 0 };
    window.CodeTrackerConfig = { features: { remoteChatHistory: false } };
    window.ApiClient = { async request(url, options = {}) {
      const state = window.mock;
      if (url === '/users/profile') {
        if (state.profileFailure) throw Object.assign(new Error('Unauthorized'), { status: 401 });
        return { userId: state.user };
      }
      if (url === '/classrooms/me') return [{ classroomId: classroom, name: 'Programming 101' }];
      if (url === '/classrooms/join') return [];
      if (url !== '/chatbot') throw new Error('Unexpected endpoint ' + url);
      state.calls.push(JSON.parse(options.body));
      if (state.mode === 'pending') return new Promise((resolve, reject) => {
        state.resolve = resolve;
        options.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
      });
      if (state.status) throw Object.assign(new Error('Request failed'), { status: state.status });
      return { reply: 'Use **clear names** and `const`.\n```js\nconst answer = 42;\n```\n<img src=x onerror="window.injected=true">' };
    } };
    if (storageBlocked) {
      Storage.prototype.getItem = () => { throw new Error('blocked'); };
      Storage.prototype.setItem = () => { throw new Error('blocked'); };
      Storage.prototype.removeItem = () => { throw new Error('blocked'); };
    }
  }, { classroom, storageBlocked });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'No uncaught browser errors'));
  await page.goto(origin + '/dashboard/');
  await page.waitForFunction(() => window.CodeTrackerEcho);
  await page.locator('#chatbot-toggle').click();
  await page.waitForFunction(() => document.querySelector('#chatbot-classroom').options.length === 2);
  return { page, context };
}
async function send(page, message) {
  await page.locator('#chatbot-input').fill(message);
  await page.locator('#chatbot-send').click();
  await page.waitForFunction(() => !document.querySelector('#chatbot-input').disabled);
}
async function openHistory(page) { await page.locator('#chatbot-threads-toggle').click(); }

test('closed launcher default; text/code are safe and copyable; request contract unchanged', async t => {
  const { page } = await setup(t);
  await send(page, 'Help with code');
  const body = await page.evaluate(() => mock.calls[0]);
  assert.deepEqual(Object.keys(body).sort(), ['classroomId', 'history', 'message', 'timezone']);
  assert.equal(body.classroomId, null);
  assert.equal(body.history.length, 0);
  assert.equal(await page.locator('.bot-message pre code').textContent(), 'const answer = 42;\n');
  assert.equal(await page.locator('.bot-message img').count(), 0);
  await page.getByRole('button', { name: 'Copy code', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'const answer = 42;\n');
  await page.locator('#chatbot-minimize').click();
  assert.equal(await page.locator('#chatbot-window').getAttribute('aria-hidden'), 'true');
  await page.reload();
  assert.equal(await page.locator('#chatbot-window').getAttribute('aria-hidden'), 'true');
});

test('new threads retain older chats, support search/rename/delete, and survive reload', async t => {
  const { page } = await setup(t);
  await send(page, 'First topic');
  await page.locator('#chatbot-new-thread').click();
  await send(page, 'Second topic');
  assert.equal((await page.evaluate(() => mock.calls[1])).history.length, 0);
  await openHistory(page);
  assert.equal(await page.locator('.chatbot-thread-row').count(), 2);
  await page.locator('#chatbot-thread-search').fill('first');
  assert.equal(await page.locator('.chatbot-thread-row').count(), 1);
  await page.getByRole('button', { name: 'Rename conversation: First topic', exact: true }).click();
  await page.getByRole('textbox', { name: 'Conversation name' }).fill('Revision notes');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('#chatbot-thread-search').fill('');
  await page.locator('.chatbot-thread-select').filter({ hasText: 'Revision notes' }).click();
  await send(page, 'Follow up');
  const history = await page.evaluate(() => mock.calls[2].history);
  assert.equal(history[0].text, 'First topic');
  assert.ok(!history.some(t => t.text === 'Second topic'));
  await page.reload();
  await page.locator('#chatbot-toggle').click();
  await openHistory(page);
  assert.equal(await page.locator('.chatbot-thread-row').count(), 2);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete conversation: Second topic', exact: true }).click();
  assert.equal(await page.locator('.chatbot-thread-row').count(), 1);
});

test('classroom changes isolate histories and preserve per-thread drafts', async t => {
  const { page } = await setup(t);
  await send(page, 'Dashboard only');
  await page.locator('#chatbot-input').fill('Unsent dashboard draft');
  await page.locator('#chatbot-classroom').selectOption(classroom);
  assert.equal(await page.locator('.user-message').count(), 0);
  assert.equal(await page.locator('#chatbot-input').inputValue(), '');
  await send(page, 'Classroom only');
  const call = await page.evaluate(() => mock.calls[1]);
  assert.equal(call.classroomId, classroom);
  assert.equal(call.history.length, 0);
  await page.locator('#chatbot-classroom').selectOption('');
  assert.equal(await page.locator('#chatbot-input').inputValue(), 'Unsent dashboard draft');
  assert.match(await page.locator('#chatbot-messages').textContent(), /Dashboard only/);
  assert.doesNotMatch(await page.locator('#chatbot-messages').textContent(), /Classroom only/);
});

test('account changes never send or restore the prior account draft/history', async t => {
  const { page } = await setup(t);
  await send(page, 'Account one private message');
  await page.evaluate(() => { mock.user = 'user-two'; });
  await send(page, 'Do not send across accounts');
  assert.equal(await page.evaluate(() => mock.calls.length), 1);
  assert.equal(await page.locator('.user-message').count(), 0);
  await openHistory(page);
  assert.equal(await page.locator('.chatbot-thread-row').count(), 0);
  assert.equal(await page.evaluate(() => JSON.stringify(sessionStorage).includes('Account one private message')), false);
});

test('stop, retry and failed-turn filtering do not leak error responses into context', async t => {
  const { page } = await setup(t);
  await page.evaluate(() => { mock.mode = 'pending'; });
  await page.locator('#chatbot-input').fill('Please explain');
  await page.locator('#chatbot-send').click();
  await page.waitForFunction(() => mock.calls.length === 1);
  await page.locator('#chatbot-stop').click();
  await page.waitForFunction(() => !document.querySelector('#chatbot-input').disabled);
  assert.match(await page.locator('#chatbot-messages').textContent(), /Response stopped/);
  await page.locator('#chatbot-retry').click();
  assert.equal(await page.locator('#chatbot-input').inputValue(), 'Please explain');
  await page.evaluate(() => { mock.mode = 'ok'; });
  await page.locator('#chatbot-send').click();
  await page.waitForFunction(() => mock.calls.length === 2 && !document.querySelector('#chatbot-input').disabled);
  assert.equal(await page.evaluate(() => mock.calls[1].history.length), 0);
});

test('expired identity and revoked classroom access clear cached private threads', async t => {
  const { page } = await setup(t);
  await page.locator('#chatbot-classroom').selectOption(classroom);
  await send(page, 'Private classroom reply');
  await page.evaluate(() => { mock.status = 403; });
  await send(page, 'No longer authorized');
  assert.equal(await page.locator('.user-message').count(), 0);
  assert.match(await page.locator('#chatbot-status').textContent(), /Access denied/);
  await page.evaluate(() => { mock.status = 0; mock.profileFailure = true; });
  await send(page, 'Expired session');
  await openHistory(page);
  assert.equal(await page.locator('.chatbot-thread-row').count(), 0);
  assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith('ct_echo_history_')).length), 0);
});

test('blocked storage keeps in-memory threads usable', async t => {
  const { page } = await setup(t, { storageBlocked: true });
  await send(page, 'Memory-only message');
  await page.locator('#chatbot-new-thread').click();
  await send(page, 'Another message');
  await openHistory(page);
  assert.equal(await page.locator('.chatbot-thread-row').count(), 2);
  await page.locator('.chatbot-thread-select').filter({ hasText: 'Memory-only message' }).click();
  assert.match(await page.locator('#chatbot-messages').textContent(), /Memory-only message/);
});

test('offline sends preserve drafts; IME Enter does not submit', async t => {
  const { page, context } = await setup(t);
  await page.locator('#chatbot-input').fill('Keep this draft');
  await page.locator('#chatbot-input').dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  assert.equal(await page.evaluate(() => mock.calls.length), 0);
  await context.setOffline(true);
  await page.locator('#chatbot-send').click();
  assert.equal(await page.locator('#chatbot-input').inputValue(), 'Keep this draft');
  assert.equal(await page.evaluate(() => mock.calls.length), 0);
});

test('export downloads the current conversation', async t => {
  const { page } = await setup(t);
  await send(page, 'Export this');
  await openHistory(page);
  const download = page.waitForEvent('download');
  await page.locator('#chatbot-export').click();
  assert.equal((await download).suggestedFilename(), 'echo-conversation.md');
});

test('analyzer handoff uses real selected-file state and never auto-sends or re-runs analysis', async t => {
  const { page } = await setup(t);
  // Mount the existing analyzer's DOM contract and run its actual page script.
  await page.evaluate(() => {
    for (const id of ['repoStatus', 'resultsSection', 'summaryStats', 'codeContent', 'currentFileName', 'languageBadge',
      'errorList', 'errorCount', 'warningCount', 'fileList', 'backToClassBtn', 'supportedBadge', 'repoUrlDisplay', 'headerSubtitle']) {
      const el = document.createElement('div'); el.id = id; document.body.append(el);
    }
    const search = document.createElement('input'); search.id = 'fileSearch'; document.body.append(search);
    sessionStorage.setItem('pendingAnalysis', JSON.stringify({ repoUrl: 'https://github.com/example/demo' }));
    window.analyzerCalls = 0;
    window.CodeTrackerAnalyzer = { createClient: () => ({
      async startAnalysis() { window.analyzerCalls++; return { analysis_id: 'test-job' }; },
      async pollAnalysis() { return { files: [{ file_name: 'demo.py', language: 'python', code: 'print(value)', errors: [{ line: 1, message: 'Undefined name', source_line: 'print(value)' }], warnings: [] }] }; }
    }) };
  });
  await page.addScriptTag({ url: origin + '/frontend/script/syntax-analyzer.js' });
  await page.evaluate(() => document.dispatchEvent(new Event('DOMContentLoaded')));
  await page.locator('#chatbot-analyzer-context').waitFor({ state: 'visible' });
  await page.locator('#chatbot-analyzer-context').click();
  assert.match(await page.locator('#chatbot-input').inputValue(), /demo\.py.*\nLine 1: Undefined name/s);
  assert.equal(await page.evaluate(() => mock.calls.length), 0);
  assert.equal(await page.evaluate(() => analyzerCalls), 1);
});

for (const theme of ['dark', 'light']) {
  for (const [width, height] of [[1280, 900], [390, 844], [320, 568], [844, 390]]) {
    test(`${theme} layout fits ${width}x${height} and history remains usable`, async t => {
      const { page } = await setup(t, { viewport: { width, height } });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await send(page, 'Check the layout');
      const geometry = await page.evaluate(() => {
        const box = document.querySelector('#chatbot-window').getBoundingClientRect();
        const send = document.querySelector('#chatbot-send').getBoundingClientRect();
        const input = document.querySelector('#chatbot-input').getBoundingClientRect();
        return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, sendBottom: send.bottom, inputWidth: input.width,
          overflow: document.querySelector('#chatbot-window').scrollWidth - box.width };
      });
      assert.ok(geometry.x >= -1 && geometry.y >= -1 && geometry.right <= width + 1 && geometry.bottom <= height + 1, JSON.stringify(geometry));
      assert.ok(geometry.sendBottom <= height + 1 && geometry.inputWidth > 80, JSON.stringify(geometry));
      assert.ok(geometry.overflow < 2, JSON.stringify(geometry));
      if (process.env.ECHO_SCREENSHOTS) {
        await mkdir(process.env.ECHO_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.ECHO_SCREENSHOTS, `${theme}-${width}.png`) });
      }
      await openHistory(page);
      assert.equal(await page.locator('.chatbot-thread-select').count(), 1);
      await page.locator('.chatbot-thread-select').click();
    });
  }
}
