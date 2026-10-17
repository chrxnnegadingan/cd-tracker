# Echo with persistent Supabase conversations

This package replaces the earlier tab-session-only delivery. Sent messages and successful
AI replies are stored in your Supabase PostgreSQL database through your Spring Boot backend.
Sign into the same CodeTracker account on another device to reopen them. Logout clears local
caches; it does not delete saved conversations. Unsent drafts stay in the current browser tab.

The implementation and patches are ready. Your Supabase project has not been changed and
neither repository has been pushed or deployed from here. Follow the deployment order below.

## Architecture and account ownership

Your existing GitHub/CodeTracker login is preserved. The authenticated Java AuthPrincipal's
userId owns each thread. This uses public.users.user_id, not Supabase auth.users/auth.uid().
The browser calls your existing backend API. The backend uses its existing DB_URL,
DB_USERNAME and DB_PASSWORD to connect to Supabase PostgreSQL. No Supabase JavaScript SDK,
Supabase Auth migration or browser service-role key is required.

New public.echo_threads and public.echo_messages tables store account/thread ownership,
classroom context, titles, timestamps, ordered messages and request identifiers. Every
read/send/rename checks ownership and current classroom access. Owner deletion remains
allowed after class access is lost. The SQL enables RLS and revokes direct Data API access
from anon/authenticated/public. The trusted JDBC backend connects as the table owner or an
appropriately authorized server-only role. Do not add browser policies based on auth.uid()
for this custom-login application.

## What the user sees

- The small launcher stays closed by default; the prior UI/theme/mobile improvements remain.
- Conversations opens the account's chats for the selected classroom context.
- All my classrooms has its own conversation scope; choose the same individual classroom
  to reopen a conversation previously started there.
- Latest saved history is restored after authentication, including on a fresh browser/device.
- New conversation preserves earlier chats. Rename, delete, paginated history and full-chat
  Markdown export operate on database records.
- Search filters the conversation titles already loaded. Use Load older conversations for more.
- Successful question/reply pairs are committed together. AI failures do not leave half-saved
  turns. Error notices and unsent drafts are local UI state.
- A repeated requestId returns the saved answer without running the AI or appending messages again.
- Overlapping requests for one conversation are rejected while a reply is processing. A
  two-minute lease permits recovery after a crashed request. Different threads can run independently.
- Stop cancels the browser's wait. Server work may finish and save a reply. Reopen the chat
  before retrying; the same request identifier is reused by the retry control in that session.
- Deleting a thread removes its messages. Deleting its CodeTracker user cascades to saved chats.
- Backend context and permissions are refreshed for every new reply; stored history never grants access.
- Legacy clients without threadId retain the original stateless POST behavior. The new UI
  always creates/selects a saved thread before sending.
- Old tab-only conversations are not silently uploaded as trusted history. Export important old
  chats before updating; only conversations sent through this version become account-saved.

## Deploy in this order

### 1. Apply the SQL in Supabase

Open the Supabase project used by your backend, open SQL Editor, and run the complete file:

`supabase/migrations/20261017_echo_history.sql`

The ZIP also includes a top-level copy named `supabase-echo-history.sql`. It is safe to rerun
for this schema version. It adds two tables and an index; it does not modify existing
classrooms, submissions, grades or announcement tables. It references the existing
public.users(user_id) table. Use the same project, not a new unrelated Supabase project.

### 2. Apply and deploy the backend patch

Use the backend patch appropriate to your starting point, build with Java 21, and deploy
with your existing environment settings. New endpoints:

| Method | Path after /api | Purpose |
| --- | --- | --- |
| POST | /chatbot/threads | Create a thread; client UUID supports safe network retry |
| GET | /chatbot/threads | Account/context list, page and size |
| GET | /chatbot/threads/{id}/messages | Ordered history with beforePosition cursor |
| PATCH | /chatbot/threads/{id} | Rename |
| DELETE | /chatbot/threads/{id} | Delete thread and messages |
| POST | /chatbot | Existing chat endpoint, now also accepts threadId and requestId |

The new chat path reads prior turns from the database. Supplied browser history is ignored
for persisted threads. No database connection or row lock is held during the Gemini request.

If your existing backend already uses Supabase, keep its working database configuration.
If you need to configure it, get the JDBC connection details from Supabase Connect. For
Spring/Hibernate, use the Session pooler (port 5432) or the supported direct connection,
with sslmode=require. Existing variable names remain DB_URL, DB_USERNAME and DB_PASSWORD.
Keep passwords and Gemini keys in backend environment secrets, not committed files.

### 3. Apply and deploy the frontend patch

The new runtime-config.js enables remoteChatHistory. Deploy it only after the SQL and
backend endpoints are available. If history cannot load, the UI preserves the draft and
blocks sending instead of pretending a temporary conversation was saved to the account.
Account theme sync remains disabled, as its API has not been added.

## Choose the correct patch set

The ZIP contains two alternatives. Use exactly one for each repository.

| Your current files | Patch directory |
| --- | --- |
| Original GitHub revisions, no first upgrade applied | cumulative/ |
| You applied the complete first echo-chatbot-upgrade.zip delivery | from-first-delivery/ |

Original bases inspected: frontend ad79e508ac3f47cab40506e78552affa3944333a and backend
88c1e2e326513f4cb6e4efb14bea763848c85a91. Updated teammate changes can cause conflicts;
--check must pass before applying. Full replacements are also included under edited-files,
but patches are preferred to avoid overwriting unrelated work.

## VS Code commands, Windows PowerShell

Extract the ZIP. Set $echoBundle to the folder containing cumulative and from-first-delivery.
Start with a clean working tree; save unfinished work before switching branches.

```powershell
$echoBundle = "$HOME\Downloads\echo-supabase-upgrade"
cd "C:\path\to\cd-tracker"
git status
git switch main
git pull --ff-only origin main
git switch -c echo-persistent-history
# Use cumulative if the first delivery has NOT been applied.
git apply --check "$echoBundle\cumulative\frontend.patch"
git apply "$echoBundle\cumulative\frontend.patch"
```

If your first delivery is applied on your current branch, stay on that branch, create a
new branch from it with git switch -c echo-persistent-history, and use
from-first-delivery/frontend.patch instead. Do not switch to main if doing so discards
that starting point. If git status reports unfinished changes, save them first; a local
stash is one option: git stash push -u -m "before-persistent-history". Later use git stash
apply and keep the stash until the restored work is checked. Do not force a failed patch.

In the separate backend repository:

```powershell
cd "C:\path\to\codetracker"
git status
git switch main
git pull --ff-only origin main
git switch -c echo-persistent-history
git apply --check "$echoBundle\cumulative\backend.patch"
git apply "$echoBundle\cumulative\backend.patch"
```

Use from-first-delivery/backend.patch if that first guide patch is already applied.
If you have no local checkout, clone the two repositories first:

```powershell
git clone https://github.com/dexxf/cd-tracker.git
git clone https://github.com/Qycx1/codetracker.git
```

Run the SQL before deploying the backend, then deploy the frontend. Applying a local
patch does not update the hosted website until your normal deployment runs.

## Run checks

Frontend root (Node plus optional test-only dependencies):

```powershell
node --test tests/*.test.mjs
npm install --no-save --package-lock=false jsdom playwright
node --test tests/echo-state.dom.mjs
npx playwright install chromium
node --test tests/echo-ui.browser.mjs
```

Backend root with Java 21:

```powershell
.\mvnw.cmd "-Dtest=*Test,!ApplicationTests" test
```

The production ApplicationTests context smoke test requires the normal database/OAuth/Redis
configuration and is excluded above. The targeted tests use H2 and mocked integrations.
Optional PostgreSQL migration check, also from backend root:

```powershell
npm install --no-save --package-lock=false @electric-sql/pglite
node --test tests/supabase-migration.test.mjs
```

Do not commit node_modules. There are no new production npm dependencies. For a local
static UI server use py -m http.server 5500 --bind 127.0.0.1 from the frontend root;
login still requires matching backend CORS/OAuth/cookie settings. Start your configured
local backend with .\mvnw.cmd spring-boot:run. No new secrets are required.

## Validation and practical limits

- Frontend regression suite: 59 passed.
- DOM integration suite: 17 passed, including fresh-device restoration, saved rename/delete,
  unavailable history, blocked browser storage, account isolation, pagination and full export.
- Backend suite: 51 passed, including 9 new JPA persistence/ownership/retry tests.
- PostgreSQL SQL migration: 1 passed, including rerun, RLS, denied Data API roles, uniqueness
  and cascade deletion.
- Java 21 compilation and whitespace/syntax checks passed.
- Cumulative and incremental patches were checked against their respective base files.
- Chromium cannot launch in this environment because its local IPC sockets are blocked.
  Browser tests are included, but rendered visual/mobile-keyboard checks are not claimed.
- Your live Supabase project, actual OAuth accounts and live Gemini deployment were not accessed.
  Database tests use H2 and embedded PostgreSQL, not your production database.

Before merging, log in on device A, send a message, close/log out, then sign in on device B
with the same account and classroom context. Confirm the conversation returns. Repeat with
a different account and verify it cannot see that history. Check rename/delete, more than
100 messages, a failed request, the syntax analyzer draft handoff and normal class submissions.

## UI upgrades carried forward

| Aesthetic | Logic | Functionality |
| --- | --- | --- |
| 48 px closed launcher | Account-owned database history | Reopen across devices/logins |
| Compact desktop window | Server-authoritative conversation context | New/switch conversations |
| Shared light/dark colors | Classroom permission checks on reads and sends | Rename and delete saved chats |
| Cleaner toolbar and spacing | Atomic turn saving and duplicate-request protection | Search loaded titles and paginate history |
| Mobile safe-area/keyboard CSS | Stale-response guards and offline draft preservation | Full-thread export and copy code/replies |
| Safe readable code blocks | Bounded AI context with durable stored messages | Stop/retry and selected analyzer findings draft |

## Original feature inventory

## Existing features, preserved

### Interface and input

1. Echo on dashboard, instructor classroom, student classroom and syntax analyzer pages.
2. Floating launcher; open, close, minimize, maximize, desktop resize and saved dimensions.
3. Hide launcher and reveal control; Alt+Shift+E opens Echo; Escape closes it/history.
4. Auto-growing textarea, Enter to send, Shift+Enter for a newline, 2000-character limit.
5. Message author/time labels, basic bold formatting and thinking status.
6. Shared light/dark theme, mobile/safe-area CSS, reduced-motion support and labeled controls.
7. New conversation and confirmed clear controls, previously replacing the single current chat.
8. Session-scoped history separated by authenticated user and classroom, with storage guards.
9. Student/instructor prompt suggestions and Quick help that does not require a generated reply.

### Classroom and AI behavior

10. Classroom selector and all-accessible-classrooms mode; current classroom is inferred only on classroom pages.
11. Gemini-backed responses through the authenticated backend; shared API-client session refresh/retry.
12. Follow-up context: up to ten previous non-failed messages, each capped at 2000 characters.
13. Backend classroom access checks and role-specific context: students' own records and instructors' authorized class records.
14. Activity titles, instructions, lifecycle states, deadlines, maximum points and required next steps.
15. Repository-link status; distinction between PENDING, SUBMITTED and GRADED.
16. Submission status, captured work metadata, scores and instructor feedback available in verified context.
17. Instructor progress summaries, missing submissions and work awaiting grading.
18. Announcement text and attachment counts. Attachment contents are not read.
19. Work checklists, priorities, feedback explanations, study plans and general coding/Git guidance.
20. Browser timezone supplied to the backend for relative-date/deadline explanations.
21. Language matching, including Filipino/Taglish, instructed by the backend prompt.
22. Read-only assistant: no autonomous submitting, grading, class edits, repository reading or code execution.
23. Bounded local history, per-request timeout/abort, online/offline notices, and distinct session/permission/rate-limit/server/network errors.
24. Account/page-lifecycle guards and back/forward-cache handling.

The original revisions had dormant remote-history controls. This upgrade implements their backend APIs and enables account history. Browser-only theme selection continues to work.

## Further UI edits

Another AI can refine the visual styles in a separate branch. Require it to preserve DOM
IDs, integration hooks, threadId/requestId, account and classroom isolation, backend checks
and the test suites. Review the diff before merging and avoid simultaneous edits to the
same files.

## Official setup references

- Supabase Spring Boot/JDBC: https://supabase.com/docs/guides/getting-started/quickstarts/spring-boot
- Securing database access: https://supabase.com/docs/guides/database/secure-data
- Row-level security: https://supabase.com/docs/guides/database/postgres/row-level-security
