(function initializeEchoChatbot() {
  "use strict";

  const INSTANCE_KEY = "__CODETRACKER_ECHO_INSTANCE_V6__";

  if (window[INSTANCE_KEY]) {
    window[INSTANCE_KEY].ensureAvailable?.();
    return;
  }

  const BOT_NAME = "Echo";
  const UI_VERSION = "6";
  const HISTORY_VERSION = 3;
  const HISTORY_LIMIT = 80;
  const HISTORY_CHARACTER_LIMIT = 160000;
  const MESSAGE_CHARACTER_LIMIT = 12000;
  const REQUEST_TIMEOUT_MS = 60000;
  const GUEST_HISTORY_KEY =
    `ct_echo_history_guest_v${HISTORY_VERSION}`;
  const LAYOUT_KEY = "ct_echo_layout_v4";
  const LEGACY_LAYOUT_KEYS = [
    "ct_echo_layout_v1",
    "ct_echo_layout_v2",
    "ct_echo_layout_v3"
  ];
  const COMPACT_VIEWPORT_WIDTH = 700;

  let publicApi = {
    ensureAvailable() {}
  };

  window[INSTANCE_KEY] = publicApi;

  function safeReadJson(key, fallback) {
    try {
      const value = JSON.parse(
        (key.startsWith("ct_echo_history_") ? sessionStorage : localStorage).getItem(key) || "null"
      );

      return value ?? fallback;
    } catch (_) {
      return fallback;
    }
  }

  function safeWriteJson(key, value) {
    try {
      (key.startsWith("ct_echo_history_") ? sessionStorage : localStorage).setItem(
        key,
        JSON.stringify(value)
      );

      return true;
    } catch (_) {
      return false;
    }
  }

  function safeRemove(key) {
    try {
      (key.startsWith("ct_echo_history_") ? sessionStorage : localStorage).removeItem(key);
    } catch (_) {
      // Storage can be unavailable in private browsers.
    }
  }

  function escapeKeyPart(value) {
    return String(value || "")
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 80);
  }

  function clamp(value, minimum, maximum) {
    return Math.min(
      Math.max(value, minimum),
      maximum
    );
  }

  function isFiniteNumber(value) {
    return (
      typeof value === "number" &&
      Number.isFinite(value)
    );
  }

  function whenReady(callback) {
    if (document.readyState === "loading") {
      document.addEventListener(
        "DOMContentLoaded",
        callback,
        {
          once: true
        }
      );
    } else {
      callback();
    }
  }

  function formatTime(timestamp) {
    try {
      return new Intl.DateTimeFormat(
        undefined,
        {
          hour: "numeric",
          minute: "2-digit"
        }
      ).format(new Date(timestamp));
    } catch (_) {
      return "";
    }
  }

  function getClassroomId() {
    // Only classroom pages may supply an implicit scope. Their page scripts
    // publish the resolved ID after initialization; storage is never consulted.
    if (!/\/(profclass|studentclass)(?:\/|$)/i.test(window.location.pathname)) return null;
    const params = new URLSearchParams(window.location.search);
    return normalizeClassroomId(window.CodeTrackerCurrentClassroomId)
      || normalizeClassroomId(params.get("classroomId") || params.get("id"));
  }

  function normalizeClassroomId(value) {
    const id = String(value || "").trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
      ? id : null;
  }

  function createChatRequestBody(message, classroomId, timezone, history) {
    return {
      message,
      classroomId: normalizeClassroomId(classroomId),
      timezone,
      history
    };
  }

  function trimHistory(items) {
    const normalized =
      Array.isArray(items)
        ? items
            .filter((item) => {
              return (
                item &&
                (
                  item.role === "user" ||
                  item.role === "assistant"
                ) &&
                typeof item.text === "string" &&
                item.text.trim()
              );
            })
            .map((item) => ({
              messageId:
                item.messageId || null,
              role: item.role,
              text: item.text.slice(
                0,
                MESSAGE_CHARACTER_LIMIT
              ),
              failed: item.failed === true,
              position:
                Number(item.position) || null,
              timestamp:
                Number(item.timestamp) ||
                Date.now()
            }))
        : [];

    let result =
      normalized.slice(-HISTORY_LIMIT);

    let characterCount =
      result.reduce(
        (total, item) =>
          total + item.text.length,
        0
      );

    while (
      result.length > 1 &&
      characterCount >
        HISTORY_CHARACTER_LIMIT
    ) {
      characterCount -=
        result[0].text.length;

      result.shift();
    }

    return result;
  }

  function persistHistory(key, items) {
    let candidate = trimHistory(items);

    while (candidate.length) {
      if (
        safeWriteJson(
          key,
          candidate
        )
      ) {
        return candidate;
      }

      candidate =
        candidate.slice(
          Math.max(
            1,
            Math.floor(
              candidate.length / 4
            )
          )
        );
    }

    safeRemove(key);

    return [];
  }

  function sanitizeLayout(value) {
    const layout = {};

    if (
      !value ||
      typeof value !== "object"
    ) {
      return layout;
    }

    if (isFiniteNumber(value.width)) {
      layout.width = clamp(
        value.width,
        310,
        1200
      );
    }

    if (isFiniteNumber(value.height)) {
      layout.height = clamp(
        value.height,
        360,
        1200
      );
    }

    layout.maximized =
      Boolean(value.maximized);

    layout.minimized =
      Boolean(value.minimized);

    return layout;
  }

  function isCompactViewport() {
    return window.matchMedia(
      `(max-width: ${COMPACT_VIEWPORT_WIDTH}px)`
    ).matches;
  }

  whenReady(() => {
    const existingContainer =
      document.getElementById(
        "chatbot-container"
      );

    if (
      existingContainer &&
      existingContainer.dataset.echoVersion !==
        UI_VERSION
    ) {
      existingContainer.remove();
    }

    if (
      !document.getElementById(
        "chatbot-container"
      )
    ) {
      document.body.insertAdjacentHTML(
        "beforeend",
        `
          <div
            id="chatbot-container"
            data-bot-name="${BOT_NAME}"
            data-echo-version="${UI_VERSION}"
          >
            <button
              id="chatbot-toggle"
              type="button"
              aria-label="Open ${BOT_NAME}"
              aria-expanded="false"
              aria-controls="chatbot-window"
              title="Open ${BOT_NAME}"
            >
              <span class="chatbot-toggle-content">
                <i
                  class="fas fa-robot"
                  aria-hidden="true"
                ></i>

                <span class="chatbot-toggle-label">
                  ${BOT_NAME}
                </span>
              </span>
            </button>

            <button
              id="chatbot-reveal"
              type="button"
              aria-label="Open ${BOT_NAME}"
              title="Open ${BOT_NAME}"
              hidden
            >
              <i
                class="fas fa-robot"
                aria-hidden="true"
              ></i>

              <span class="sr-only">
                Open ${BOT_NAME}
              </span>
            </button>

            <section
              id="chatbot-window"
              role="dialog"
              aria-modal="false"
              aria-label="${BOT_NAME} assistant"
              aria-hidden="true"
            >
              <header id="chatbot-header">
                <div class="chatbot-identity">
                  <span class="chatbot-avatar">
                    <i
                      class="fas fa-robot"
                      aria-hidden="true"
                    ></i>
                  </span>

                  <span
                    class="chatbot-identity-copy"
                  >
                    <strong>
                      ${BOT_NAME}
                    </strong>

                    <small>
                      CodeTracker assistant
                    </small>
                  </span>
                </div>

                <div
                  class="chatbot-header-actions"
                >
                  <button
                    id="chatbot-threads-toggle"
                    class="chatbot-icon-btn"
                    type="button"
                    aria-label="Open conversation history"
                    aria-controls="chatbot-threads-panel"
                    aria-expanded="false"
                    title="Conversations"
                  >
                    <i
                      class="fas fa-clock-rotate-left"
                      aria-hidden="true"
                    ></i>
                  </button>

                  <button
                    id="chatbot-new-thread"
                    class="chatbot-icon-btn"
                    type="button"
                    aria-label="Start a new conversation"
                    title="New conversation"
                  >
                    <i
                      class="fas fa-pen-to-square"
                      aria-hidden="true"
                    ></i>
                  </button>

                  <button
                    id="chatbot-clear"
                    class="chatbot-icon-btn"
                    type="button"
                    aria-label="Delete current conversation"
                    title="Delete conversation"
                  >
                    <i
                      class="fas fa-trash-can"
                      aria-hidden="true"
                    ></i>
                  </button>

                  <button
                    id="chatbot-hide-launcher"
                    class="chatbot-icon-btn"
                    type="button"
                    aria-label="Hide the Echo launcher"
                    title="Hide Echo launcher"
                  >
                    <i
                      class="fas fa-eye-slash"
                      aria-hidden="true"
                    ></i>
                  </button>

                  <button
                    id="chatbot-minimize"
                    class="chatbot-icon-btn"
                    type="button"
                    aria-label="Minimize ${BOT_NAME}"
                    title="Minimize"
                  >
                    <i
                      class="fas fa-minus"
                      aria-hidden="true"
                    ></i>
                  </button>

                  <button
                    id="chatbot-maximize"
                    class="chatbot-icon-btn"
                    type="button"
                    aria-label="Maximize ${BOT_NAME}"
                    title="Maximize"
                  >
                    <i
                      class="fas fa-expand"
                      aria-hidden="true"
                    ></i>
                  </button>

                  <button
                    id="chatbot-close"
                    class="chatbot-icon-btn"
                    type="button"
                    aria-label="Close ${BOT_NAME}"
                    title="Close"
                  >
                    <i
                      class="fas fa-xmark"
                      aria-hidden="true"
                    ></i>
                  </button>
                </div>
              </header>

              <aside
                id="chatbot-threads-panel"
                class="chatbot-threads-panel"
                aria-label="Echo conversations"
                aria-hidden="true"
                hidden
              >
                <div class="chatbot-threads-header">
                  <div>
                    <strong>Conversations</strong>
                    <small>Optional account history</small>
                  </div>

                  <button
                    id="chatbot-threads-close"
                    class="chatbot-icon-btn"
                    type="button"
                    aria-label="Close conversation history"
                    title="Close conversations"
                  >
                    <i class="fas fa-xmark" aria-hidden="true"></i>
                  </button>
                </div>

                <button
                  id="chatbot-threads-new"
                  class="chatbot-thread-new"
                  type="button"
                >
                  <i class="fas fa-plus" aria-hidden="true"></i>
                  <span>New conversation</span>
                </button>

                <div
                  id="chatbot-threads-list"
                  class="chatbot-threads-list"
                  role="list"
                ></div>

                <button
                  id="chatbot-threads-more"
                  class="chatbot-threads-more"
                  type="button"
                  hidden
                >
                  Load older conversations
                </button>
              </aside>

              <div class="chatbot-context-bar">
                <label for="chatbot-classroom">Answer about</label>
                <select id="chatbot-classroom" aria-label="Classroom context">
                  <option value="">All my classrooms</option>
                </select>
                <button id="chatbot-help" type="button">Quick help</button>
              </div>
              <aside id="chatbot-quick-help" class="chatbot-quick-help" hidden>
                <strong>Quick help</strong>
                <p>Choose a classroom above to focus your answers. Ask about pending work,
                  deadlines, scores, feedback or announcements.</p>
                <p><b>Student:</b> Open an activity, link/create a repository, commit and push
                  your work, then click Submit. PENDING is not yet submitted;
                  SUBMITTED is waiting for grading; GRADED has been reviewed.</p>
                <p><b>Instructor:</b> Create/publish activities, open submissions to review
                  and grade, and post classroom announcements. Manage Class is on the dashboard.</p>
                <p><b>Useful questions:</b> Ask for an unfinished-work checklist, your next priority,
                  a two-hour study plan, simple feedback explanations or a professor progress summary.</p>
                <p><b>Outside class:</b> Ask for coding explanations, Git help or a study plan.
                  Echo cannot read repository files or attachment contents, run code, or change records.</p>
                <p>New answers need internet and a valid session. Chat history is temporary
                  to this browser tab and is cleared on logout. Never paste passwords or tokens.</p>
              </aside>
              <div
                id="chatbot-status"
                class="chatbot-status"
                role="status"
                aria-live="polite"
              ></div>

              <div
                id="chatbot-messages"
                aria-live="polite"
                aria-label="Chat history"
              ></div>

              <form id="chatbot-input-area">
                <label
                  class="sr-only"
                  for="chatbot-input"
                >
                  Message ${BOT_NAME}
                </label>

                <textarea
                  id="chatbot-input"
                  rows="1"
                  maxlength="2000"
                  placeholder="Ask Echo something…"
                  autocomplete="off"
                ></textarea>

                <button
                  id="chatbot-send"
                  type="submit"
                  aria-label="Send message"
                >
                  <i
                    class="fas fa-paper-plane"
                    aria-hidden="true"
                  ></i>

                  <span>Send</span>
                </button>
              </form>

              <div
                class="chatbot-resize-hint"
                aria-hidden="true"
              >
                <i
                  class="fas fa-up-right-and-down-left-from-center"
                ></i>
              </div>
            </section>
          </div>
        `
      );
    }

    const elements = {
      classroom: document.getElementById("chatbot-classroom"),
      help: document.getElementById("chatbot-help"),
      quickHelp: document.getElementById("chatbot-quick-help"),
      container:
        document.getElementById(
          "chatbot-container"
        ),

      toggle:
        document.getElementById(
          "chatbot-toggle"
        ),

      reveal:
        document.getElementById(
          "chatbot-reveal"
        ),

      window:
        document.getElementById(
          "chatbot-window"
        ),

      header:
        document.getElementById(
          "chatbot-header"
        ),

      close:
        document.getElementById(
          "chatbot-close"
        ),

      clear:
        document.getElementById(
          "chatbot-clear"
        ),

      threadsToggle:
        document.getElementById(
          "chatbot-threads-toggle"
        ),

      newThread:
        document.getElementById(
          "chatbot-new-thread"
        ),

      threadsPanel:
        document.getElementById(
          "chatbot-threads-panel"
        ),

      threadsClose:
        document.getElementById(
          "chatbot-threads-close"
        ),

      threadsNew:
        document.getElementById(
          "chatbot-threads-new"
        ),

      threadsList:
        document.getElementById(
          "chatbot-threads-list"
        ),

      threadsMore:
        document.getElementById(
          "chatbot-threads-more"
        ),

      hideLauncher:
        document.getElementById(
          "chatbot-hide-launcher"
        ),

      minimize:
        document.getElementById(
          "chatbot-minimize"
        ),

      maximize:
        document.getElementById(
          "chatbot-maximize"
        ),

      messages:
        document.getElementById(
          "chatbot-messages"
        ),

      status:
        document.getElementById(
          "chatbot-status"
        ),

      form:
        document.getElementById(
          "chatbot-input-area"
        ),

      input:
        document.getElementById(
          "chatbot-input"
        ),

      send:
        document.getElementById(
          "chatbot-send"
        )
    };

    if (
      Object.values(elements).some(
        (element) => !element
      )
    ) {
      console.error(
        "Echo chatbot elements could not be initialized."
      );

      window[INSTANCE_KEY] = null;

      return;
    }

    const cleanupCallbacks = [];

    let historyKey =
      GUEST_HISTORY_KEY;

    let history = [];
    let authenticatedUser = null;
    let selectedClassroomId = getClassroomId();
    let scopeRevision = 0;
    let identityRequest = null;
    let classroomLoadRevision = 0;

    // Retire legacy persistent caches instead of sharing old academic replies
    // with the next person using this computer.
    try {
      Object.keys(localStorage).filter(key => key.startsWith("ct_echo_history_"))
        .forEach(key => localStorage.removeItem(key));
    } catch (_) { /* Storage may be blocked. */ }
    if (selectedClassroomId) {
      const option = document.createElement("option");
      option.value = selectedClassroomId;
      option.textContent = "Current classroom";
      elements.classroom.appendChild(option);
      elements.classroom.value = selectedClassroomId;
    }
    let historyBaseKey = GUEST_HISTORY_KEY;
    let activeThreadId = null;
    let threads = [];
    let threadPage = 0;
    let threadsHaveMore = false;
    let messagesHaveMore = false;
    let nextBeforePosition = null;
    let remoteHistoryEnabled = false;
    let threadsPanelOpen = false;
    let isLoadingThread = false;
    let isLoadingThreads = false;
    let isSending = false;
    let isOpen = false;
    let launcherSuppressed = false;
    let statusTimer = null;
    let closeTimer = null;
    let resizeSaveTimer = null;
    let activeRequestController = null;
    let resizeObserver = null;

    function addManagedEvent(
      target,
      type,
      listener,
      options
    ) {
      target.addEventListener(
        type,
        listener,
        options
      );

      cleanupCallbacks.push(() =>
        target.removeEventListener(
          type,
          listener,
          options
        )
      );
    }

    function focusSafely(element) {
      try {
        element?.focus({
          preventScroll: true
        });
      } catch (_) {
        element?.focus();
      }
    }

    function readHistory() {
      if (!authenticatedUser) return [];
      return trimHistory(
        safeReadJson(
          historyKey,
          []
        )
      );
    }

    function saveHistory() {
      if (!authenticatedUser) return;
      const persisted = persistHistory(
        historyKey,
        history
      );

      // Keep the browser cache bounded. A server-backed thread that the
      // user explicitly paged through may remain longer in memory.
      if (!remoteHistoryEnabled || !activeThreadId) {
        history = persisted;
      }
    }

    function getThreadHistoryKey(threadId) {
      return `${historyBaseKey}_thread_${escapeKeyPart(threadId)}`;
    }

    function getDraftHistoryKey() {
      return `${historyBaseKey}_draft`;
    }

    function extractResponseList(response) {
      if (Array.isArray(response)) {
        return response;
      }

      return Array.isArray(response?.data)
        ? response.data
        : [];
    }

    function normalizeThread(item) {
      const threadId = String(
        item?.threadId || item?.id || ""
      ).trim();

      if (!threadId) {
        return null;
      }

      return {
        threadId,
        classroomId:
          item?.classroomId || null,
        title:
          String(item?.title || "New conversation").trim() ||
          "New conversation",
        createdAt:
          item?.createdAt || null,
        updatedAt:
          item?.updatedAt || item?.createdAt || null
      };
    }

    function normalizeRemoteMessage(item) {
      const role =
        String(item?.role || "")
          .trim()
          .toLowerCase() === "user"
          ? "user"
          : "assistant";

      const text = String(
        item?.content || item?.text || ""
      ).trim();

      if (!text) {
        return null;
      }

      return {
        messageId:
          item?.messageId || item?.id || null,
        role,
        text: text.slice(0, MESSAGE_CHARACTER_LIMIT),
        position:
          Number(item?.position) || null,
        timestamp:
          Date.parse(item?.createdAt || "") || Date.now()
      };
    }

    function formatThreadDate(value) {
      const date = new Date(value || 0);
      if (Number.isNaN(date.getTime())) {
        return "";
      }

      try {
        return new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric"
        }).format(date);
      } catch (_) {
        return "";
      }
    }

    function updateConversationLabel() {
      const subtitle = elements.header.querySelector(
        ".chatbot-identity-copy small"
      );

      if (!subtitle) {
        return;
      }

      const current = threads.find(
        (thread) => thread.threadId === activeThreadId
      );

      subtitle.textContent = current
        ? current.title
        : "New conversation";
      subtitle.title = subtitle.textContent;
    }

    function renderThreadList() {
      elements.threadsList.replaceChildren();
      elements.threadsMore.hidden =
        !remoteHistoryEnabled || !threadsHaveMore;
      elements.threadsMore.disabled = isLoadingThreads;
      elements.threadsMore.textContent = isLoadingThreads
        ? "Loading…"
        : "Load older conversations";

      if (!threads.length) {
        const empty = document.createElement("p");
        empty.className = "chatbot-threads-empty";
        empty.textContent = "No saved conversations yet.";
        elements.threadsList.appendChild(empty);
        updateConversationLabel();
        return;
      }

      threads.forEach((thread) => {
        const row = document.createElement("div");
        row.className = "chatbot-thread-row";
        row.setAttribute("role", "listitem");

        if (thread.threadId === activeThreadId) {
          row.classList.add("is-active");
        }

        const select = document.createElement("button");
        select.type = "button";
        select.className = "chatbot-thread-select";
        select.dataset.threadId = thread.threadId;
        select.setAttribute(
          "aria-current",
          thread.threadId === activeThreadId ? "true" : "false"
        );

        const title = document.createElement("strong");
        title.textContent = thread.title;

        const meta = document.createElement("small");
        const context = thread.classroomId
          ? "Classroom"
          : "Dashboard";
        const date = formatThreadDate(thread.updatedAt);
        meta.textContent = date
          ? `${context} · ${date}`
          : context;

        select.append(title, meta);

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "chatbot-thread-delete";
        remove.dataset.deleteThreadId = thread.threadId;
        remove.setAttribute(
          "aria-label",
          `Delete conversation: ${thread.title}`
        );
        remove.title = "Delete conversation";
        remove.innerHTML =
          '<i class="fas fa-trash-can" aria-hidden="true"></i>';

        row.append(select, remove);
        elements.threadsList.appendChild(row);
      });

      updateConversationLabel();
    }

    function setThreadsPanel(open) {
      threadsPanelOpen = Boolean(open);
      elements.threadsPanel.hidden = !threadsPanelOpen;
      elements.threadsPanel.setAttribute(
        "aria-hidden",
        String(!threadsPanelOpen)
      );
      elements.threadsToggle.setAttribute(
        "aria-expanded",
        String(threadsPanelOpen)
      );
      elements.window.classList.toggle(
        "chatbot-threads-open",
        threadsPanelOpen
      );

      if (threadsPanelOpen) {
        renderThreadList();
        focusSafely(elements.threadsNew);
      }
    }

    function startNewConversation({ focus = true } = {}) {
      if (isSending) {
        return;
      }

      activeThreadId = null;
      messagesHaveMore = false;
      nextBeforePosition = null;
      historyKey = remoteHistoryEnabled
        ? getDraftHistoryKey()
        : historyBaseKey;
      history = [];
      saveHistory();
      renderHistory({ reload: false });
      renderThreadList();
      setThreadsPanel(false);

      if (focus) {
        focusSafely(elements.input);
      }
    }

    async function loadThreadMessages(
      threadId,
      {
        beforePosition = null,
        appendOlder = false
      } = {}
    ) {
      if (!threadId || isLoadingThread || isSending) {
        return;
      }

      isLoadingThread = true;
      setStatus(
        appendOlder
          ? "Loading older messages…"
          : "Loading conversation…"
      );

      try {
        const beforeQuery = beforePosition
          ? `&beforePosition=${encodeURIComponent(beforePosition)}`
          : "";
        const response = await window.ApiClient.request(
          `/chatbot/threads/${encodeURIComponent(threadId)}/messages?size=100${beforeQuery}`,
          {
            method: "GET",
            headers: { Accept: "application/json" }
          },
          {
            redirectOnUnauthorized: false,
            retryOnRefresh: true
          }
        );

        const loadedMessages = extractResponseList(response)
          .map(normalizeRemoteMessage)
          .filter(Boolean);
        const previousHeight = elements.messages.scrollHeight;

        activeThreadId = threadId;
        historyKey = getThreadHistoryKey(threadId);
        history = appendOlder
          ? [
              ...loadedMessages,
              ...history.filter(
                (existing) => !loadedMessages.some(
                  (loaded) =>
                    loaded.messageId &&
                    loaded.messageId === existing.messageId
                )
              )
            ]
          : loadedMessages;
        messagesHaveMore = response?.hasMore === true;
        nextBeforePosition =
          Number(response?.nextBeforePosition) || null;
        saveHistory();
        renderHistory({
          reload: false,
          scrollToBottom: !appendOlder
        });

        if (appendOlder) {
          elements.messages.scrollTop = Math.max(
            0,
            elements.messages.scrollHeight - previousHeight
          );
        }

        renderThreadList();
        if (!appendOlder) {
          setThreadsPanel(false);
        }
      } catch (error) {
        setStatus(
          "That conversation could not be loaded.",
          2200
        );
      } finally {
        isLoadingThread = false;
        if (!elements.status.textContent.includes("could not")) {
          setStatus("");
        }
      }
    }

    async function loadThreads({
      selectLatest = true,
      page = 0,
      append = false
    } = {}) {
      if (
        window.CodeTrackerConfig?.features?.remoteChatHistory !== true ||
        !window.ApiClient?.request || isLoadingThreads
      ) {
        return false;
      }

      isLoadingThreads = true;
      renderThreadList();

      try {
        const response = await window.ApiClient.request(
          `/chatbot/threads?page=${Math.max(0, page)}&size=50`,
          {
            method: "GET",
            headers: { Accept: "application/json" }
          },
          {
            redirectOnUnauthorized: false,
            retryOnRefresh: true
          }
        );

        const loadedThreads = extractResponseList(response)
          .map(normalizeThread)
          .filter(Boolean);
        threads = append
          ? [
              ...threads,
              ...loadedThreads.filter(
                (loaded) => !threads.some(
                  (existing) => existing.threadId === loaded.threadId
                )
              )
            ]
          : loadedThreads;
        threadPage = Number.isInteger(response?.page)
          ? response.page
          : Math.max(0, page);
        threadsHaveMore = response?.hasMore === true;
        remoteHistoryEnabled = true;
        renderThreadList();

        if (!selectLatest) {
          return true;
        }

        const selected = threads.find(
          (thread) => thread.threadId === activeThreadId
        ) || threads[0];

        if (selected) {
          await loadThreadMessages(selected.threadId);
        } else {
          startNewConversation({ focus: false });
        }

        return true;
      } catch (_) {
        if (!append) {
          remoteHistoryEnabled = false;
        }
        return false;
      } finally {
        isLoadingThreads = false;
        renderThreadList();
      }
    }

    function appendFormattedText(
      target,
      text
    ) {
      const parts =
        String(text || "").split(
          /(\*\*.*?\*\*)/g
        );

      parts.forEach((part) => {
        if (
          part.startsWith("**") &&
          part.endsWith("**") &&
          part.length > 4
        ) {
          const strong =
            document.createElement(
              "strong"
            );

          strong.textContent =
            part.slice(2, -2);

          target.appendChild(strong);
        } else {
          target.appendChild(
            document.createTextNode(part)
          );
        }
      });
    }

    function createWelcome() {
      const welcome =
        document.createElement("div");

      welcome.className =
        "chatbot-welcome";

      const icon =
        document.createElement("span");

      icon.className =
        "chatbot-welcome-icon";

      icon.innerHTML =
        '<i class="fas fa-robot" aria-hidden="true"></i>';

      const copy =
        document.createElement("div");

      const heading =
        document.createElement("strong");

      const description =
        document.createElement("p");

      heading.textContent =
        `Hi, I’m ${BOT_NAME}.`;

      description.textContent = "Ask about your activities, deadlines, submissions, feedback or announcements. Choose a classroom above, or ask about all your classes. Your chat stays in this tab's session.";
      const suggestions = document.createElement("div");
      suggestions.className = "chatbot-suggestions";
      const selectedRole = elements.classroom.selectedOptions?.[0]?.dataset.role;
      const prompts = selectedRole === "INSTRUCTOR" ? [
        "Summarize this classroom's progress.", "Who hasn't submitted anything yet?",
        "Which submissions are waiting for grading?", "Show my announcements"
      ] : [
        "Make me a checklist of my unfinished work.", "What should I work on first today?",
        "Which activities still need a repository?", "I already pushed my code. Am I finished?",
        "Explain my professor's feedback in simple words.", "Make a two-hour study plan for my pending activities."
      ];
      prompts.forEach(text => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = text;
        button.addEventListener("click", () => {
          elements.input.value = text;
          autoGrowInput();
          focusSafely(elements.input);
        });
        suggestions.appendChild(button);
      });
      copy.append(
        heading,
        description
      );
      copy.appendChild(suggestions);

      welcome.append(
        icon,
        copy
      );

      elements.messages.appendChild(
        welcome
      );
    }

    function renderMessage(
      item,
      {
        animate = false,
        temporary = false
      } = {}
    ) {
      const wrapper =
        document.createElement(
          "article"
        );

      wrapper.className =
        `chat-message ${
          item.role === "user"
            ? "user-message"
            : "bot-message"
        }`;

      if (animate) {
        wrapper.classList.add(
          "chat-message-animation"
        );
      }

      if (temporary) {
        wrapper.dataset.temporary =
          "true";
      }

      const bubble =
        document.createElement("div");

      bubble.className =
        "chat-message-bubble";

      appendFormattedText(
        bubble,
        item.text
      );

      const meta =
        document.createElement("div");

      meta.className =
        "chat-message-meta";

      meta.textContent =
        `${
          item.role === "user"
            ? "You"
            : BOT_NAME
        }${
          item.timestamp
            ? ` · ${formatTime(
                item.timestamp
              )}`
            : ""
        }`;

      wrapper.append(
        bubble,
        meta
      );

      elements.messages.appendChild(
        wrapper
      );

      elements.messages.scrollTop =
        elements.messages.scrollHeight;

      return wrapper;
    }

    function renderHistory({
      reload = true,
      scrollToBottom = true
    } = {}) {
      elements.messages.replaceChildren();

      if (reload) {
        history = readHistory();
      }

      if (remoteHistoryEnabled && activeThreadId && messagesHaveMore) {
        const older = document.createElement("button");
        older.type = "button";
        older.className = "chatbot-messages-more";
        older.dataset.loadOlderMessages = "true";
        older.disabled = isLoadingThread;
        older.textContent = isLoadingThread ? "Loading older messages…" : "Load older messages";
        elements.messages.appendChild(older);
      }

      if (!history.length) {
        createWelcome();
      }

      history.forEach((item) =>
        renderMessage(item)
      );

      // This control belongs to the chatbot instance.  Keeping it here also
      // means it is recreated whenever a thread is rendered, after any
      // messages returned by the paginated history endpoint.
      if (
        remoteHistoryEnabled &&
        activeThreadId &&
        messagesHaveMore
      ) {
        const older = document.createElement("button");
        older.type = "button";
        older.className = "chatbot-messages-more";
        older.dataset.loadOlderMessages = "true";
        older.disabled = isLoadingThread;
        older.textContent = isLoadingThread
          ? "Loading older messages…"
          : "Load older messages";
        elements.messages.appendChild(older);
      }

      if (scrollToBottom) {
        elements.messages.scrollTop =
          elements.messages.scrollHeight;
      }
    }

    function addPersistentMessage(
      text,
      role
    ) {
      const normalizedText =
        String(text || "")
          .trim()
          .slice(
            0,
            MESSAGE_CHARACTER_LIMIT
          );

      if (!normalizedText) {
        return null;
      }

      elements.messages
        .querySelector(
          ".chatbot-welcome"
        )
        ?.remove();

      const item = {
        role,
        text: normalizedText,
        timestamp: Date.now()
      };

      history.push(item);
      saveHistory();

      return renderMessage(
        item,
        {
          animate: true
        }
      );
    }

    function setStatus(
      message = "",
      timeout = 0
    ) {
      window.clearTimeout(
        statusTimer
      );

      elements.status.textContent =
        message;

      elements.status.classList.toggle(
        "is-visible",
        Boolean(message)
      );

      if (
        message &&
        timeout > 0
      ) {
        statusTimer =
          window.setTimeout(
            () => setStatus(""),
            timeout
          );
      }
    }

    function setSending(sending) {
      isSending = sending;
      elements.input.disabled = sending;
      elements.send.disabled = sending;
      elements.newThread.disabled = sending;
      elements.clear.disabled = sending;
      elements.threadsNew.disabled = sending;
      elements.classroom.disabled = sending;

      elements.send.classList.toggle(
        "is-loading",
        sending
      );
    }

    function autoGrowInput() {
      elements.input.style.height =
        "auto";

      elements.input.style.height =
        `${
          Math.min(
            elements.input.scrollHeight,
            120
          )
        }px`;
    }

    function getLayout() {
      return sanitizeLayout(
        safeReadJson(
          LAYOUT_KEY,
          {}
        )
      );
    }

    function saveLayout(patch) {
      safeWriteJson(
        LAYOUT_KEY,
        sanitizeLayout({
          ...getLayout(),
          ...patch
        })
      );
    }

    function migrateOldLayout() {
      const current = getLayout();

      if (
        Object.keys(current).length
      ) {
        LEGACY_LAYOUT_KEYS.forEach(
          safeRemove
        );

        return;
      }

      for (
        const key of
        LEGACY_LAYOUT_KEYS
      ) {
        const old =
          sanitizeLayout(
            safeReadJson(
              key,
              {}
            )
          );

        if (
          Object.keys(old).length
        ) {
          safeWriteJson(
            LAYOUT_KEY,
            old
          );

          break;
        }
      }

      LEGACY_LAYOUT_KEYS.forEach(
        safeRemove
      );
    }

    function clampWindowToViewport() {
      if (
        elements.window.classList.contains(
          "chatbot-maximized"
        )
      ) {
        return;
      }

      if (isCompactViewport()) {
        elements.window.style.removeProperty(
          "width"
        );

        elements.window.style.removeProperty(
          "height"
        );

        return;
      }

      const viewportWidth =
        window.visualViewport?.width ||
        window.innerWidth;

      const viewportHeight =
        window.visualViewport?.height ||
        window.innerHeight;

      const availableWidth =
        Math.max(
          310,
          viewportWidth - 36
        );

      const availableHeight =
        Math.max(
          360,
          viewportHeight - 36
        );

      const width =
        clamp(
          elements.window.offsetWidth ||
            520,
          310,
          availableWidth
        );

      const height =
        clamp(
          elements.window.offsetHeight ||
            680,
          360,
          availableHeight
        );

      elements.window.style.width =
        `${width}px`;

      elements.window.style.height =
        `${height}px`;
    }

    function updateWindowControls() {
      const isMinimized =
        elements.window.classList.contains(
          "chatbot-minimized"
        );

      const isMaximized =
        elements.window.classList.contains(
          "chatbot-maximized"
        );

      const minimizeIcon =
        elements.minimize.querySelector(
          "i"
        );

      const maximizeIcon =
        elements.maximize.querySelector(
          "i"
        );

      elements.minimize.setAttribute(
        "aria-label",
        isMinimized
          ? `Restore ${BOT_NAME}`
          : `Minimize ${BOT_NAME}`
      );

      elements.minimize.title =
        isMinimized
          ? "Restore"
          : "Minimize";

      if (minimizeIcon) {
        minimizeIcon.className =
          isMinimized
            ? "fas fa-window-restore"
            : "fas fa-minus";
      }

      elements.maximize.setAttribute(
        "aria-label",
        isMaximized
          ? `Restore ${BOT_NAME} window size`
          : `Maximize ${BOT_NAME}`
      );

      elements.maximize.title =
        isMaximized
          ? "Restore size"
          : "Maximize";

      if (maximizeIcon) {
        maximizeIcon.className =
          isMaximized
            ? "fas fa-compress"
            : "fas fa-expand";
      }
    }

    function applySavedLayout() {
      migrateOldLayout();

      const layout = getLayout();

      if (!isCompactViewport()) {
        if (
          isFiniteNumber(
            layout.width
          )
        ) {
          elements.window.style.width =
            `${layout.width}px`;
        }

        if (
          isFiniteNumber(
            layout.height
          )
        ) {
          elements.window.style.height =
            `${layout.height}px`;
        }
      }

      elements.window.classList.toggle(
        "chatbot-maximized",
        false
      );

      elements.window.classList.toggle(
        "chatbot-minimized",
        false
      );

      updateWindowControls();

      window.requestAnimationFrame(
        clampWindowToViewport
      );
    }

    function animateLauncherOut() {
      elements.toggle.classList.remove(
        "chatbot-launcher-entering"
      );

      elements.toggle.classList.add(
        "chatbot-launcher-exiting"
      );

      window.setTimeout(() => {
        if (!isOpen) return;
        elements.toggle.classList.remove(
          "chatbot-launcher-exiting"
        );

        elements.toggle.classList.add(
          "chatbot-toggle-hidden"
        );
      }, 180);
    }

    function animateLauncherIn() {
      elements.toggle.hidden = false;

      elements.toggle.classList.remove(
        "chatbot-toggle-hidden",
        "chatbot-launcher-exiting"
      );

      void elements.toggle.offsetWidth;

      elements.toggle.classList.add(
        "chatbot-launcher-entering"
      );

      window.setTimeout(() => {
        elements.toggle.classList.remove(
          "chatbot-launcher-entering"
        );
      }, 280);
    }

    function openChatbot() {
      window.clearTimeout(closeTimer);

      launcherSuppressed = false;
      elements.reveal.hidden = true;
      elements.toggle.hidden = false;
      isOpen = true;

      elements.window.classList.remove(
        "chatbot-closing"
      );

      elements.window.classList.add(
        "chatbot-open"
      );

      elements.window.setAttribute(
        "aria-hidden",
        "false"
      );

      elements.toggle.setAttribute(
        "aria-expanded",
        "true"
      );

      animateLauncherOut();
      clampWindowToViewport();
      void refreshClassroomChoices();

      window.setTimeout(() => {
        if (
          elements.window.classList.contains(
            "chatbot-minimized"
          )
        ) {
          focusSafely(
            elements.minimize
          );
        } else {
          focusSafely(
            elements.input
          );
        }
      }, 180);
    }

    function closeChatbot({
      restoreFocus = true
    } = {}) {
      if (!isOpen) {
        return;
      }

      isOpen = false;
      setThreadsPanel(false);

      elements.window.classList.add(
        "chatbot-closing"
      );

      elements.window.classList.remove(
        "chatbot-open"
      );

      elements.window.setAttribute(
        "aria-hidden",
        "true"
      );

      elements.toggle.setAttribute(
        "aria-expanded",
        "false"
      );

      window.clearTimeout(
        closeTimer
      );

      closeTimer =
        window.setTimeout(() => {
          elements.window.classList.remove(
            "chatbot-closing"
          );
        }, 240);

      if (launcherSuppressed) {
        elements.toggle.hidden = true;

        elements.toggle.classList.add(
          "chatbot-toggle-hidden"
        );

        elements.reveal.hidden = false;

        if (restoreFocus) {
          focusSafely(
            elements.reveal
          );
        }
      } else {
        animateLauncherIn();

        if (restoreFocus) {
          window.setTimeout(
            () =>
              focusSafely(
                elements.toggle
              ),
            220
          );
        }
      }
    }

    function hideLauncher() {
      launcherSuppressed = true;

      closeChatbot({
        restoreFocus: false
      });

      window.setTimeout(() => {
        if (!launcherSuppressed) return;
        elements.toggle.hidden = true;
        elements.reveal.hidden = false;

        focusSafely(
          elements.reveal
        );
      }, 210);
    }

    function revealAndOpen() {
      launcherSuppressed = false;
      elements.reveal.hidden = true;
      elements.toggle.hidden = false;

      elements.toggle.classList.add(
        "chatbot-toggle-hidden"
      );

      openChatbot();
    }

    function toggleMinimize() {
      // Minimize back to the small launcher; do not leave a wide header over class content.
      closeChatbot();
    }

    function toggleMaximize() {
      const willMaximize =
        !elements.window.classList.contains(
          "chatbot-maximized"
        );

      elements.window.classList.toggle(
        "chatbot-maximized",
        willMaximize
      );

      elements.window.classList.remove(
        "chatbot-minimized"
      );

      saveLayout({
        maximized: willMaximize,
        minimized: false
      });

      updateWindowControls();

      if (!willMaximize) {
        clampWindowToViewport();
      }

      focusSafely(
        elements.input
      );
    }

    async function confirmAction(
      message,
      options
    ) {
      if (window.AppDialog?.confirm) {
        return window.AppDialog.confirm(
          message,
          options
        );
      }

      return window.confirm(message);
    }

    async function deleteThread(threadId, { ask = true } = {}) {
      const thread = threads.find(
        (item) => item.threadId === threadId
      );

      if (!threadId || !remoteHistoryEnabled || isSending) {
        return false;
      }

      if (ask) {
        const confirmed = await confirmAction(
          `Delete “${thread?.title || "this conversation"}”? This cannot be undone.`,
          {
            title: "Delete conversation",
            confirmText: "Delete",
            cancelText: "Keep conversation",
            danger: true
          }
        );

        if (!confirmed) {
          return false;
        }
      }

      try {
        await window.ApiClient.request(
          `/chatbot/threads/${encodeURIComponent(threadId)}`,
          { method: "DELETE" },
          {
            redirectOnUnauthorized: false,
            retryOnRefresh: true
          }
        );

        safeRemove(getThreadHistoryKey(threadId));
        threads = threads.filter(
          (item) => item.threadId !== threadId
        );

        if (activeThreadId === threadId) {
          startNewConversation({ focus: false });
        } else {
          renderThreadList();
        }

        setStatus("Conversation deleted.", 1800);
        return true;
      } catch (error) {
        setStatus("The conversation could not be deleted.", 2400);
        return false;
      }
    }

    async function clearHistory() {
      if (remoteHistoryEnabled && activeThreadId) {
        await deleteThread(activeThreadId);
        return;
      }

      const confirmed = await confirmAction(
        remoteHistoryEnabled
          ? "Clear this unsent conversation draft?"
          : "Clear this conversation from this browser tab?",
        {
          title: remoteHistoryEnabled
            ? "Clear draft"
            : "Clear chat history",
          confirmText: "Clear",
          cancelText: "Keep conversation",
          danger: true
        }
      );

      if (!confirmed) {
        return;
      }

      history = [];
      saveHistory();
      renderHistory({ reload: false });

      setStatus(
        remoteHistoryEnabled
          ? "Draft cleared."
          : "Chat history cleared.",
        1800
      );
    }

    function createRequestController() {
      activeRequestController?.abort();

      const controller =
        new AbortController();

      const timeoutId =
        window.setTimeout(
          () => controller.abort(),
          REQUEST_TIMEOUT_MS
        );

      activeRequestController =
        controller;

      return {
        controller,

        clearTimeout() {
          window.clearTimeout(
            timeoutId
          );
        }
      };
    }

    function messageForRequestError(error) {
      const message =
        String(
          error?.message || ""
        ).trim();

      const normalized =
        message.toLowerCase();
      const status = Number(error?.status);

      if (
        error?.name === "AbortError"
      ) {
        return "That request took too long and was stopped. Please try again.";
      }

      if (
        navigator.onLine === false
      ) {
        return "You appear to be offline. Reconnect and try again.";
      }

      if (
        status === 401 || normalized.includes("401") ||
        normalized.includes(
          "unauthorized"
        ) ||
        normalized.includes(
          "authentication required"
        ) ||
        normalized.includes(
          "not authenticated"
        ) ||
        normalized.includes(
          "session expired"
        )
      ) {
        return "Your session could not be refreshed. Please reload the page, then sign in again if needed.";
      }

      if (
        status === 403 || normalized.includes("403") ||
        normalized.includes(
          "forbidden"
        ) ||
        normalized.includes(
          "permission"
        )
      ) {
        return "You are signed in, but you do not have permission to use this information.";
      }

      if (
        status === 429 || normalized.includes("429") ||
        normalized.includes(
          "too many requests"
        ) ||
        normalized.includes(
          "rate limit"
        )
      ) {
        return "Echo is receiving too many requests right now. Please wait a moment and try again.";
      }

      if (
        status >= 500 || normalized.includes("500") ||
        normalized.includes("502") ||
        normalized.includes("503") ||
        normalized.includes("504") ||
        normalized.includes(
          "server error"
        ) ||
        normalized.includes(
          "temporarily unavailable"
        )
      ) {
        return "The assistant service is temporarily unavailable. Please try again shortly.";
      }

      if (
        normalized.includes(
          "failed to fetch"
        ) ||
        normalized.includes(
          "networkerror"
        ) ||
        normalized.includes(
          "network error"
        ) ||
        normalized.includes(
          "load failed"
        )
      ) {
        return "I couldn’t connect right now. Please check your connection and try again.";
      }

      return "Echo could not complete that request. Please try again.";
    }

    async function sendMessage() {
      const message =
        elements.input.value.trim();

      if (
        !message ||
        isSending
      ) {
        return;
      }

      // Resolve identity before loading/saving/sending any private conversation.
      setSending(true);
      if (!await resolveHistoryScope()) {
        setSending(false);
        setStatus("Please sign in again to ask about your classrooms. Quick help is still available.");
        return;
      }
      if (message.length > 2000) {
        setSending(false);
        setStatus("Please shorten your message to 2000 characters.");
        return;
      }
      const previousTurns = history.filter(item => !item.failed).slice(-10)
        .map(item => ({ role: item.role, text: item.text.slice(0, 2000) }));
      const requestScope = scopeRevision;
      const requestUser = authenticatedUser;
      addPersistentMessage(message, "user");

      elements.input.value = "";
      autoGrowInput();
      setSending(true);

      setStatus(
        `${BOT_NAME} is thinking…`
      );

      const thinking =
        renderMessage(
          {
            role: "assistant",
            text:
              `${BOT_NAME} is thinking…`,
            timestamp: Date.now()
          },
          {
            temporary: true
          }
        );

      thinking.classList.add(
        "chatbot-thinking"
      );

      const request =
        createRequestController();

      try {
        if (
          !window.ApiClient?.request
        ) {
          throw new Error(
            "CodeTracker API client is unavailable"
          );
        }

        /*
         * Important authentication fix:
         *
         * Use CodeTracker's shared API client instead of direct fetch().
         * The API client can refresh an expired session and retry this
         * chatbot request once.
         */
        const data =
          await window.ApiClient.request(
            "/chatbot",
            {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json",

                Accept:
                  "application/json"
              },

              signal:
                request.controller.signal,

              body: JSON.stringify(
                createChatRequestBody(
                  message,
                  selectedClassroomId,
                  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
                  previousTurns
                )
              )
            },
            {
              redirectOnUnauthorized:
                false,

              retryOnRefresh:
                true
            }
          );

        thinking.remove();
        if (requestScope !== scopeRevision || requestUser !== authenticatedUser) return;

        const reply =
          data?.reply ||
          data?.message ||
          data?.data?.reply ||
          data?.data?.message ||
          "Sorry, I could not generate a response.";

        const returnedThreadId = String(
          data?.threadId || data?.data?.threadId || ""
        ).trim();

        if (returnedThreadId) {
          const wasDraft = !activeThreadId;
          activeThreadId = returnedThreadId;
          historyKey = getThreadHistoryKey(returnedThreadId);
          saveHistory();

          if (wasDraft) {
            safeRemove(getDraftHistoryKey());
          }
        }

        addPersistentMessage(
          reply,
          "assistant"
        );

        if (returnedThreadId) {
          await loadThreads({ selectLatest: false });
        }
      } catch (error) {
        thinking.remove();
        if (requestScope !== scopeRevision || requestUser !== authenticatedUser) return;

        console.error(
          "Echo chatbot error:",
          error?.name || "RequestError", Number(error?.status) || ""
        );

        if (Number(error?.status) === 401 || /session expired|unauthorized/i.test(error?.message || "")) {
          authenticatedUser = null;
          scopeRevision++;
          history = [];
          try { Object.keys(sessionStorage).filter(key => key.startsWith("ct_echo_history_"))
            .forEach(key => sessionStorage.removeItem(key)); } catch (_) {}
          renderHistory({ reload: false });
        }
        if (Number(error?.status) === 403) {
          safeRemove(historyKey);
          history = [];
          renderHistory({ reload: false });
        }
        addPersistentMessage(messageForRequestError(error), "assistant");
        if (history.length) history[history.length - 1].failed = true;
        saveHistory();
      } finally {
        request.clearTimeout();

        activeRequestController =
          null;

        setSending(false);
        setStatus("");

        if (
          isOpen &&
          !elements.window.classList.contains(
            "chatbot-minimized"
          )
        ) {
          focusSafely(
            elements.input
          );
        }
      }
    }

    function applyConversationScope(identifier) {
      const changedAccount = authenticatedUser !== identifier;
      const key = `ct_echo_history_${escapeKeyPart(identifier)}_v${HISTORY_VERSION}_${selectedClassroomId || "all"}`;
      if (changedAccount || historyBaseKey !== key) {
        if (changedAccount) {
          try {
            if (sessionStorage.getItem("ct_echo_account") !== identifier) {
              Object.keys(sessionStorage).filter(k => k.startsWith("ct_echo_history_"))
                .forEach(k => sessionStorage.removeItem(k));
            }
            sessionStorage.setItem("ct_echo_account", identifier);
          } catch (_) {}
        }
        authenticatedUser = identifier;
        scopeRevision++;
        activeRequestController?.abort();
        historyBaseKey = key;
        historyKey = key;
        activeThreadId = null;
        threads = [];
        renderHistory();
      }
      // This repository has no account conversation endpoints. Keep the UI honest.
      elements.threadsToggle.hidden = true;
    }

    async function resolveHistoryScope() {
      if (!window.ApiClient?.request) return false;
      if (identityRequest) return identityRequest;
      identityRequest = (async () => {
        try {
          const profile = await window.ApiClient.request("/users/profile", {
            method: "GET", headers: { Accept: "application/json" }, cache: "no-store"
          }, { redirectOnUnauthorized: false, retryOnRefresh: true });
          const identifier = profile?.userId || profile?.id || profile?.data?.userId || profile?.data?.id;
          if (!identifier) throw new Error("Authentication required");
          applyConversationScope(String(identifier));
          return true;
        } catch (_) {
          authenticatedUser = null;
          scopeRevision++;
          activeRequestController?.abort();
          history = [];
          try { Object.keys(sessionStorage).filter(key => key.startsWith("ct_echo_history_"))
            .forEach(key => sessionStorage.removeItem(key)); } catch (_) {}
          renderHistory({ reload: false });
          return false;
        }
      })();
      try { return await identityRequest; } finally { identityRequest = null; }
    }

    async function refreshClassroomChoices() {
      const revision = ++classroomLoadRevision;
      if (!await resolveHistoryScope()) return;
      const user = authenticatedUser;
      const results = await Promise.allSettled(["/classrooms/me", "/classrooms/join"].map(path =>
        window.ApiClient.request(path, { method: "GET", cache: "no-store" },
          { redirectOnUnauthorized: false, retryOnRefresh: true })));
      if (revision !== classroomLoadRevision || user !== authenticatedUser) return;
      const options = new Map();
      results.forEach((result, index) => {
        if (result.status !== "fulfilled") return;
        extractResponseList(result.value).forEach(item => {
          const data = item.classroom || item.classroomData || item;
          const id = data.classroomId || data.id;
          if (!id || options.has(id)) return;
          options.set(id, {
            label: `${data.className || data.name || "Classroom"} (${index === 0 ? "Instructor" : "Student"})`,
            role: index === 0 ? "INSTRUCTOR" : "STUDENT"
          });
        });
      });
      elements.classroom.replaceChildren();
      const all = document.createElement("option");
      all.value = "";
      all.textContent = "All my classrooms";
      elements.classroom.appendChild(all);
      if (selectedClassroomId && !options.has(selectedClassroomId)) {
        options.set(selectedClassroomId, { label: "Selected classroom (access checked on send)", role: "" });
      }
      options.forEach((item, id) => {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = item.label;
        option.dataset.role = item.role;
        elements.classroom.appendChild(option);
      });
      elements.classroom.value = selectedClassroomId || "";
      if (!history.length) renderHistory({ reload: false });
      if (results.some(r => r.status === "rejected")) {
        setStatus("Some classroom choices could not be loaded. Try reopening Echo.", 3000);
      }
    }

    addManagedEvent(elements.classroom, "change", () => {
      selectedClassroomId = elements.classroom.value || null;
      if (authenticatedUser) applyConversationScope(authenticatedUser);
      setStatus(selectedClassroomId ? "Answers now focus on the selected classroom." : "Answers now cover your accessible classrooms.", 2200);
    });
    addManagedEvent(elements.help, "click", () => {
      elements.quickHelp.hidden = !elements.quickHelp.hidden;
      elements.help.setAttribute("aria-expanded", String(!elements.quickHelp.hidden));
    });

    function handleViewportChange() {
      window.requestAnimationFrame(
        clampWindowToViewport
      );
    }

    function ensureAvailable() {
      if (
        !document.body.contains(
          elements.container
        )
      ) {
        return;
      }

      if (
        !isOpen &&
        !launcherSuppressed
      ) {
        elements.reveal.hidden =
          true;

        elements.toggle.hidden =
          false;

        elements.toggle.classList.remove(
          "chatbot-toggle-hidden"
        );
      }
    }

    addManagedEvent(
      elements.toggle,
      "click",
      openChatbot
    );

    addManagedEvent(
      elements.reveal,
      "click",
      revealAndOpen
    );

    addManagedEvent(
      elements.close,
      "click",
      () => closeChatbot()
    );

    addManagedEvent(
      elements.clear,
      "click",
      () => void clearHistory()
    );

    addManagedEvent(
      elements.threadsToggle,
      "click",
      () => setThreadsPanel(!threadsPanelOpen)
    );

    addManagedEvent(
      elements.threadsClose,
      "click",
      () => {
        setThreadsPanel(false);
        focusSafely(elements.threadsToggle);
      }
    );

    const beginNewThread = () =>
      startNewConversation();

    addManagedEvent(
      elements.newThread,
      "click",
      beginNewThread
    );

    addManagedEvent(
      elements.threadsNew,
      "click",
      beginNewThread
    );

    addManagedEvent(
      elements.threadsMore,
      "click",
      () => void loadThreads({
        selectLatest: false,
        page: threadPage + 1,
        append: true
      })
    );

    addManagedEvent(
      elements.threadsList,
      "click",
      (event) => {
        const deleteButton = event.target.closest(
          "[data-delete-thread-id]"
        );

        if (deleteButton) {
          void deleteThread(deleteButton.dataset.deleteThreadId);
          return;
        }

        const selectButton = event.target.closest(
          "[data-thread-id]"
        );

        if (selectButton) {
          void loadThreadMessages(selectButton.dataset.threadId);
        }
      }
    );

    addManagedEvent(
      elements.messages,
      "click",
      (event) => {
        if (
          event.target.closest("[data-load-older-messages]") &&
          activeThreadId &&
          nextBeforePosition
        ) {
          void loadThreadMessages(activeThreadId, {
            beforePosition: nextBeforePosition,
            appendOlder: true
          });
        }
      }
    );

    addManagedEvent(
      elements.hideLauncher,
      "click",
      hideLauncher
    );

    addManagedEvent(
      elements.minimize,
      "click",
      toggleMinimize
    );

    addManagedEvent(
      elements.maximize,
      "click",
      toggleMaximize
    );

    addManagedEvent(
      elements.form,
      "submit",
      (event) => {
        event.preventDefault();
        void sendMessage();
      }
    );

    addManagedEvent(
      elements.input,
      "input",
      autoGrowInput
    );

    addManagedEvent(
      elements.input,
      "keydown",
      (event) => {
        if (
          event.key === "Enter" &&
          !event.shiftKey
        ) {
          event.preventDefault();
          void sendMessage();
        }
      }
    );

    addManagedEvent(
      document,
      "keydown",
      (event) => {
        if (
          event.key === "Escape" &&
          isOpen
        ) {
          if (threadsPanelOpen) {
            setThreadsPanel(false);
            focusSafely(elements.threadsToggle);
            return;
          }

          closeChatbot();
          return;
        }

        if (
          event.altKey &&
          event.shiftKey &&
          event.key.toLowerCase() ===
            "e"
        ) {
          event.preventDefault();
          launcherSuppressed = false;
          elements.reveal.hidden = true;
          openChatbot();
        }
      }
    );

    addManagedEvent(
      window,
      "resize",
      handleViewportChange,
      {
        passive: true
      }
    );

    addManagedEvent(
      window,
      "orientationchange",
      handleViewportChange,
      {
        passive: true
      }
    );

    addManagedEvent(
      window,
      "online",
      () =>
        setStatus(
          "You’re back online.",
          1400
        )
    );

    addManagedEvent(
      window,
      "offline",
      () =>
        setStatus(
          "You’re offline."
        )
    );

    if (window.visualViewport) {
      addManagedEvent(
        window.visualViewport,
        "resize",
        handleViewportChange,
        {
          passive: true
        }
      );

      addManagedEvent(
        window.visualViewport,
        "scroll",
        handleViewportChange,
        {
          passive: true
        }
      );
    }

    addManagedEvent(
      window,
      "pagehide",
      (event) => {
        activeRequestController?.abort();
        scopeRevision++;
        history = [];
        renderHistory({ reload: false });
        closeChatbot({ restoreFocus: false });
        // A restored back/forward-cache page must retain its handlers and
        // authenticate again before restoring cached private messages.
        if (event.persisted) return;

        window.clearTimeout(
          statusTimer
        );

        window.clearTimeout(
          closeTimer
        );

        window.clearTimeout(
          resizeSaveTimer
        );

        resizeObserver?.disconnect();

        cleanupCallbacks
          .splice(0)
          .forEach(
            (cleanup) => cleanup()
          );

        window[INSTANCE_KEY] =
          null;
      }
    );
    addManagedEvent(window, "pageshow", (event) => {
      if (event.persisted) {
        authenticatedUser = null;
        setSending(false);
        void resolveHistoryScope();
      }
    });

    applySavedLayout();
    renderHistory();
    autoGrowInput();

    void resolveHistoryScope();

    if (window.ResizeObserver) {
      resizeObserver =
        new ResizeObserver(() => {
          if (
            !isOpen ||
            isCompactViewport() ||
            elements.window.classList.contains(
              "chatbot-maximized"
            ) ||
            elements.window.classList.contains(
              "chatbot-minimized"
            )
          ) {
            return;
          }

          window.clearTimeout(
            resizeSaveTimer
          );

          resizeSaveTimer =
            window.setTimeout(() => {
              clampWindowToViewport();

              saveLayout({
                width:
                  elements.window
                    .offsetWidth,

                height:
                  elements.window
                    .offsetHeight
              });
            }, 180);
        });

      resizeObserver.observe(
        elements.window
      );
    }

    publicApi = Object.freeze({
      open: openChatbot,
      close: closeChatbot,
      hideLauncher,
      ensureAvailable
    });

    window[INSTANCE_KEY] =
      publicApi;

    window.CodeTrackerEcho =
      publicApi;
  });
})();
