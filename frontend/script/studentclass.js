(function () {
  const apiClient = window.ApiClient;

  const submissionModal       = document.getElementById('submissionModal');
  const modalAssignmentDetail = document.getElementById('modalAssignmentDetail');
  const detailsModal          = document.getElementById('activityDetailsModal');
  const detailsContent        = document.getElementById('activityDetailsContent');
  const submissionModeSelect  = document.getElementById('submissionMode');
  const assignmentsList       = document.getElementById('assignmentsList');
  const assignmentCount       = document.getElementById('assignmentCount');
  const pendingCount          = document.getElementById('pendingCount');
  const submitAssignmentBtn   = document.getElementById('submitAssignmentBtn');
  const studentAnnouncementsList = document.getElementById('studentAnnouncementsList');

  const params      = new URLSearchParams(window.location.search);
  const classroomId = params.get('classroomId') || params.get('id') || '';

  const state = {
    allActivities: [],
    unsubmitted: [],
    currentActivity: null,
    filters: { trackedSubmission: 'ALL' },
    currentActivityTab: 'needs-submission',
    isLoading: true,
    announcements: [],
    repositorySubmissionInFlight: false,
    activitySubmissionsInFlight: new Set(),
    confirmedActivities: new Map(),
    loadRevision: 0,
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }

  function formatDate(value) {
    if (!value) return '';
    const d = new Date(value);
    return isNaN(d) ? '' : new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', year: 'numeric' }).format(d);
  }

  function formatDateTime(value) {
    if (!value) return '';
    const d = new Date(value);
    return isNaN(d) ? '' : d.toLocaleString();
  }

  function formatScoreValue(value) {
    if (value === null || value === undefined || String(value).trim() === '') return 'X';
    const number = Number(value);
    return Number.isFinite(number) ? String(Number(number.toFixed(2))) : String(value);
  }

  function renderPrimaryMetaField(icon, label, value, isLink = false, valueClass = '') {
    const text = String(value ?? '').trim() || 'X';
    const url = isLink ? normalizeGithubRepositoryUrl(text) : '';
    const valueHtml = url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`
      : escapeHtml(text);
    return `
      <div class="assignment-meta-field">
        <div class="assignment-meta-field-label"><i class="${icon}"></i> ${escapeHtml(label)}</div>
        <div class="assignment-meta-field-value ${valueClass}">${valueHtml}</div>
      </div>`;
  }

  function getDaysLeft(value) {
    if (!value) return null;
    const d = new Date(value);
    if (isNaN(d)) return null;
    d.setHours(23, 59, 59, 999);
    return Math.ceil((d.getTime() - Date.now()) / 86400000);
  }

  function getActivityId(a) { return a?.activityId || a?.id || ''; }
  function getActivityTitle(a) { return a?.title || 'Untitled activity'; }
  function getActivityDescription(a) { return a?.description || ''; }
  function getActivityLifecycleStatus(a) {
    return String(a?.activityStatus || a?.status || '').trim().toUpperCase();
  }

  function getStatusBadgeClass(a) {
    const s = getActivityLifecycleStatus(a);
    const d = getDaysLeft(a?.dueDate);
    if (s === 'ARCHIVED' || s === 'CLOSED') return 'expired';
    if (typeof d === 'number' && d <= 7) return 'due-soon';
    return 'due-later';
  }

  function getStatusLabel(a) {
    const s  = getActivityLifecycleStatus(a);
    const d  = getDaysLeft(a?.dueDate);
    const fd = formatDate(a?.dueDate);
    if (s) return s;
    if (d === null) return 'Active';
    if (d < 0) return 'Overdue';
    return fd ? `Due ${fd}` : 'Active';
  }

  function getTrackedSubmissionStatus(a) {
    const s = String(a?.submissionStatus ?? '').trim().toUpperCase();
    return (s === 'SUBMITTED' || s === 'PENDING' || s === 'GRADED') ? s : '';
  }

  function needsRepository(activity) {
    const status = getTrackedSubmissionStatus(activity);
    if (status === 'SUBMITTED' || status === 'GRADED') return false;
    return !activity?.repositoryAttached && !activity?.repositoryUrl && !activity?.repositoryName;
  }

  // Keep an accepted write visible until the list endpoint catches up.
  // A failed refresh must not make a successful submission look unsuccessful.
  function rememberActivity(activity, changes) {
    const updated = { ...activity, ...changes };
    const id = getActivityId(updated);
    state.confirmedActivities.set(id, updated);
    state.allActivities = [updated, ...state.allActivities.filter(a => getActivityId(a) !== id)];
    state.unsubmitted = state.unsubmitted.filter(a => getActivityId(a) !== id);
    renderActivities();
  }

  function mergeConfirmedActivities(activities) {
    const rank = { PENDING: 1, SUBMITTED: 2, GRADED: 3 };
    return mergeActivities(activities, [...state.confirmedActivities.values()]).map(activity => {
      const id = getActivityId(activity);
      const confirmed = state.confirmedActivities.get(id);
      if (!confirmed) return activity;
      if (!needsRepository(activity) &&
          rank[getTrackedSubmissionStatus(activity)] >= rank[getTrackedSubmissionStatus(confirmed)]) {
        state.confirmedActivities.delete(id);
        return activity;
      }
      return { ...activity, ...confirmed };
    });
  }

  function extractActivityList(response) {
    const candidates = [
      response,
      response?.data,
      response?.content,
      response?.items,
      response?.data?.content,
      response?.data?.items,
    ];
    return candidates.find(Array.isArray) || [];
  }

  function mergeActivities(...lists) {
    const seen = new Set();
    return lists.flat().filter((activity) => {
      const id = getActivityId(activity);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  function getSubmissionStatusMeta(status) {
    if (status === 'SUBMITTED') return { label: 'SUBMITTED', cls: 'submitted', icon: 'fas fa-paper-plane' };
    if (status === 'GRADED') return { label: 'GRADED', cls: 'graded', icon: 'fas fa-square-check' };
    if (status === 'PENDING') return { label: 'PENDING', cls: 'pending', icon: 'fas fa-hourglass-half' };
    return null;
  }

  function renderEmptyState(msg, desc, icon = 'fas fa-inbox') {
    return `<div class="empty-state"><i class="${icon}"></i><h4>${escapeHtml(msg)}</h4><p>${escapeHtml(desc)}</p></div>`;
  }

  function renderLoadingSkeleton() {
    const c = document.getElementById('activitiesContainer');
    if (!c) return;

    if (state.currentActivityTab === 'tracked') {
      c.innerHTML = `
        <div class="studentclass-loading" aria-live="polite" aria-label="Loading tracked activities">
          <span class="studentclass-loading-spinner" aria-hidden="true"></span>
          <span>Loading tracked activities…</span>
        </div>`;
      return;
    }

    c.innerHTML = Array(3).fill(`
      <div class="assignment">
        <div style="height:16px;width:55%;margin-bottom:10px;" class="skeleton"></div>
        <div style="height:12px;width:35%;margin-bottom:14px;" class="skeleton"></div>
        <div style="height:12px;width:80%;" class="skeleton"></div>
      </div>`).join('');
  }

  function renderCard(activity, needsRepo) {
    const id          = getActivityId(activity);
    const title       = escapeHtml(getActivityTitle(activity));
    const desc        = getActivityDescription(activity);
    const badgeClass  = getStatusBadgeClass(activity);
    const statusLabel = escapeHtml(getStatusLabel(activity));
    const statusIcon  = badgeClass === 'expired' ? 'fas fa-hourglass-end' : 'fas fa-clock';
    const daysLeft    = getDaysLeft(activity?.dueDate);
    const dueDate     = formatDate(activity?.dueDate);
    const daysStr     = daysLeft != null ? (daysLeft > 0 ? `${daysLeft}d left` : 'Overdue') : (dueDate || 'No due date');
    const urgentClass = daysLeft != null && daysLeft <= 7 ? 'urgent' : 'normal';
    const points      = formatScoreValue(activity?.maxScore);
    const score       = formatScoreValue(activity?.score);

    const repoBadge = needsRepo
      ? '<span class="assignment-repo-badge"><i class="fas fa-code-branch"></i> Needs repository</span>'
      : '';

    const trackedSubmissionStatus = getTrackedSubmissionStatus(activity);
    const submissionMeta = getSubmissionStatusMeta(trackedSubmissionStatus);
    const lifecycleStatus = getActivityLifecycleStatus(activity);

    const submitRepoBtn = needsRepo
      ? `<button type="button" class="submit-repo-btn" data-submit-activity-id="${escapeHtml(id)}"><i class="fab fa-github"></i> Attach repository</button>`
      : '';

    const submittedPill = submissionMeta
      ? `<span class="submission-status-pill ${submissionMeta.cls}"><i class="${submissionMeta.icon}"></i> ${submissionMeta.label}</span>`
      : '';

    const submitActivityBtn = trackedSubmissionStatus === 'PENDING' && !needsRepo
      ? `<button type="button" class="submit-activity-btn" data-submit-pending-activity-id="${escapeHtml(id)}"><i class="fas fa-check"></i> Submit activity</button>`
      : '';
    const viewDetailsBtn = `<button type="button" class="assignment-detail-btn" data-view-activity-id="${escapeHtml(id)}"><i class="fas fa-circle-info"></i> More info</button>`;

    const hideActiveStatusPill = !needsRepo && statusLabel.trim().toUpperCase() === 'ACTIVE';
    const assignmentStatus = hideActiveStatusPill
      ? ''
      : `<div class="assignment-status ${badgeClass}"><i class="${statusIcon}"></i> ${statusLabel}</div>`;

    const leftMetaItems = `
      ${renderPrimaryMetaField('fas fa-calendar-alt', 'Assignment due', daysStr, false, `days-left ${urgentClass}`)}
      ${renderPrimaryMetaField('fas fa-calendar-day', 'Due date', dueDate)}
      ${renderPrimaryMetaField('fas fa-star', 'Points', points === 'X' ? 'X' : `${points} pts`, false, 'points')}
      ${renderPrimaryMetaField('fas fa-chart-line', 'Score', score === 'X' ? 'X' : `${score} pts`)}
      ${renderPrimaryMetaField('fas fa-clock', 'Submitted at', trackedSubmissionStatus === 'SUBMITTED' || trackedSubmissionStatus === 'GRADED' ? formatDateTime(activity?.submittedAt) : 'Not submitted')}
      ${renderPrimaryMetaField('fab fa-github', 'Repository URL', activity?.repositoryUrl, true)}
    `;

    const rightMetaItems = `
      ${submittedPill}
      ${submitRepoBtn}
      ${submitActivityBtn}
      ${viewDetailsBtn}
    `;

    const subtitleItems = [];
    if (repoBadge) subtitleItems.push(repoBadge);
    if (needsRepo && lifecycleStatus) {
      subtitleItems.push(`<span class="assignment-lifecycle-pill">${escapeHtml(lifecycleStatus)}</span>`);
    }
    const subtitleHtml = subtitleItems.length
      ? `<div class="assignment-subtitle">${subtitleItems.join('')}</div>`
      : '';

    return `
      <div class="assignment ${needsRepo ? 'needs-submission' : ''}" data-assignment-id="${escapeHtml(id)}">
        <div class="assignment-header">
          <div class="assignment-title-wrap">
            <div class="assignment-title"><i class="fas fa-project-diagram"></i> ${title}</div>
            ${subtitleHtml}
          </div>
          ${assignmentStatus}
        </div>
        ${desc ? `<div class="assignment-desc">${escapeHtml(desc)}</div>` : ''}
        <div class="assignment-meta">
          <div class="assignment-meta-primary">${leftMetaItems}</div>
          <div class="assignment-meta-actions">${rightMetaItems}</div>
        </div>
      </div>`;
  }

  function renderDetailsField(icon, label, value, isLink = false) {
    const cleanValue = String(value ?? '').trim();
    if (!cleanValue) return '';
    const url = isLink ? normalizeGithubRepositoryUrl(cleanValue) : '';
    const valueHtml = url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(cleanValue)}</a>`
      : escapeHtml(cleanValue);
    return `
      <div class="activity-details-item">
        <div class="activity-details-label"><i class="${icon}"></i> ${escapeHtml(label)}</div>
        <div class="activity-details-value">${valueHtml}</div>
      </div>`;
  }

  function openDetailsModal(activityId) {
    const activity = state.allActivities.find(a => getActivityId(a) === activityId)
      || state.unsubmitted.find(a => getActivityId(a) === activityId);
    if (!activity || !detailsModal || !detailsContent) return;

    const submissionStatus = getTrackedSubmissionStatus(activity) || 'NOT SUBMITTED';
    detailsContent.innerHTML = `
      <div class="activity-details-grid">
        ${renderDetailsField('fas fa-id-card', 'Activity ID', activity.activityId)}
        ${renderDetailsField('fas fa-heading', 'Title', getActivityTitle(activity))}
        ${renderDetailsField('fas fa-file-lines', 'Description', getActivityDescription(activity) || 'No description provided')}
        ${renderDetailsField('fas fa-star', 'Max score', activity.maxScore != null ? `${activity.maxScore}` : 'Not set')}
        ${renderDetailsField('fas fa-calendar-alt', 'Due date', formatDate(activity.dueDate) || 'No due date')}
        ${renderDetailsField('fas fa-hourglass-half', 'Activity status', getActivityLifecycleStatus(activity) || 'N/A')}
        ${renderDetailsField('fas fa-flag-checkered', 'Submission status', submissionStatus)}
        ${renderDetailsField('fas fa-fingerprint', 'Student activity ID', activity.studentActivityId || 'N/A')}
        ${renderDetailsField('fas fa-code-branch', 'Repository name', activity.repositoryName || 'N/A')}
        ${renderDetailsField('fab fa-github', 'Repository URL', activity.repositoryUrl || '', true)}
        ${renderDetailsField('fas fa-sliders', 'Repository mode', activity.repositoryMode || 'N/A')}
        ${renderDetailsField('fas fa-clock', 'Submitted at', (submissionStatus === 'SUBMITTED' || submissionStatus === 'GRADED') && activity.submittedAt ? new Date(activity.submittedAt).toLocaleString() : 'Not submitted')}
        ${renderDetailsField('fas fa-chart-line', 'Score', activity.score != null ? `${activity.score}` : 'Not graded')}
        ${renderDetailsField('fas fa-comment-dots', 'Feedback', activity.feedback || 'No feedback yet')}
      </div>`;

    detailsModal.style.display = 'block';
  }

  function closeDetailsModal() {
    if (!detailsModal) return;
    detailsModal.style.opacity = '0';
    setTimeout(() => {
      detailsModal.style.display = 'none';
      detailsModal.style.opacity = '';
    }, 180);
  }

  async function submitPendingActivity(activityId, buttonEl) {
    if (!activityId || state.activitySubmissionsInFlight.has(activityId)) return;
    const activity = state.allActivities.find(a => getActivityId(a) === activityId);
    if (!activity || needsRepository(activity) || getTrackedSubmissionStatus(activity) !== 'PENDING') return;
    const activityTitle = getActivityTitle(activity);
    state.activitySubmissionsInFlight.add(activityId);
    const originalLabel = buttonEl?.innerHTML;
    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.classList.add('is-disabled');
    }
    try {
      const approved = await window.AppDialog?.confirm(
        `Submit "${activityTitle}" now? This saves the latest commit on your repository's default branch. Push your work to GitHub first.`,
        { title: 'Confirm Submission', confirmText: 'Submit Activity', cancelText: 'Cancel' }
      );
      if (!approved) return;
      if (buttonEl) buttonEl.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting…';
      const response = await apiClient.request(
        `/classrooms/${encodeURIComponent(classroomId)}/activities/${encodeURIComponent(activityId)}/submit`,
        { method: 'POST' },
        { redirectOnUnauthorized: false }
      );
      rememberActivity(activity, {
        ...response?.data,
        submissionStatus: response?.data?.submissionStatus || 'SUBMITTED',
        submittedAt: response?.data?.submittedAt || new Date().toISOString(),
      });
      await loadAll();
      await window.AppDialog?.alert(`${activityTitle} submitted successfully.`, { title: 'Activity Submitted' });
    } catch (err) {
      await window.AppDialog?.alert(err?.message || 'Failed to submit activity.', { title: 'Submission Failed' });
    } finally {
      state.activitySubmissionsInFlight.delete(activityId);
      if (buttonEl) {
        buttonEl.disabled = false;
        buttonEl.classList.remove('is-disabled');
        buttonEl.innerHTML = originalLabel;
      }
    }
  }

  function renderActivities() {
    const container = document.getElementById('activitiesContainer');
    if (!container) return;

    const tracked = state.allActivities.filter(a => getTrackedSubmissionStatus(a) && !needsRepository(a));

    if (assignmentCount) assignmentCount.textContent = state.allActivities.length;
    if (pendingCount)    pendingCount.textContent    = state.unsubmitted.length + tracked.filter(a => getTrackedSubmissionStatus(a) === 'PENDING').length;

    const submittedCountEl = document.getElementById('submittedCount');
    if (submittedCountEl) {
      submittedCountEl.textContent = state.allActivities.filter(a => {
        const s = getTrackedSubmissionStatus(a);
        return s === 'SUBMITTED' || s === 'GRADED';
      }).length;
    }

    const needsBadge   = document.getElementById('tabNeedsCount');
    const trackedBadge = document.getElementById('tabTrackedCount');
    if (needsBadge)   needsBadge.textContent   = state.unsubmitted.length;
    if (trackedBadge) trackedBadge.textContent = tracked.length;

    const trackedFilterGroup = document.getElementById('trackedFilterGroup');
    if (trackedFilterGroup) trackedFilterGroup.style.display = state.currentActivityTab === 'tracked' ? 'flex' : 'none';

    if (state.isLoading) {
      renderLoadingSkeleton();
      return;
    }

    if (state.currentActivityTab === 'needs-submission') {
      container.innerHTML = state.unsubmitted.length === 0
        ? renderEmptyState('All caught up!', 'Every assignment already has a repository attached.', 'fas fa-check-double')
        : state.unsubmitted.map(a => renderCard(a, true)).join('');
    } else {
      const filter = state.filters.trackedSubmission;
      const filtered = tracked.filter(a => {
        const s = getTrackedSubmissionStatus(a);
        if (filter === 'SUBMITTED')     return s === 'SUBMITTED';
        if (filter === 'NOT_SUBMITTED') return s === 'PENDING';
        if (filter === 'GRADED')        return s === 'GRADED';
        return true;
      });
      container.innerHTML = filtered.length === 0
        ? renderEmptyState('No tracked activities yet', 'Activities appear here after you attach a repository.', 'fas fa-tasks')
        : filtered.map(a => renderCard(a, false)).join('');
    }
  }

  async function loadAll() {
    const revision = ++state.loadRevision;
    state.isLoading = true;
    renderActivities();
    try {
      const [profileResult, activitiesResult, unsubmittedResult] = await Promise.allSettled([
        apiClient.request('/users/profile', { method: 'GET' }, { redirectOnUnauthorized: false }),
        apiClient.request(
          `/classrooms/${encodeURIComponent(classroomId)}/activities/student`,
          { method: 'GET', headers: { 'Cache-Control': 'no-cache' }, cache: 'no-store' },
          { redirectOnUnauthorized: false },
        ),
        apiClient.request(
          `/classrooms/${encodeURIComponent(classroomId)}/activities/unsubmitted`,
          { method: 'GET', headers: { 'Cache-Control': 'no-cache' }, cache: 'no-store' },
          { redirectOnUnauthorized: false },
        ),
      ]);

      if (revision !== state.loadRevision) return;

      if (profileResult.status === 'fulfilled') setStudentProfile(profileResult.value);

      state.allActivities = mergeConfirmedActivities(activitiesResult.status === 'fulfilled'
        ? extractActivityList(activitiesResult.value)
        : state.allActivities);
      const unsubmitted = unsubmittedResult.status === 'fulfilled'
        ? extractActivityList(unsubmittedResult.value)
        : state.unsubmitted;

      // Some API responses include every student activity but omit the separate
      // unsubmitted collection. Keep those untracked activities visible.
      const untracked = state.allActivities.filter(needsRepository);
      const trackedIds = new Set(state.allActivities.filter(a => !needsRepository(a)).map(getActivityId));
      state.unsubmitted = mergeActivities(unsubmitted, untracked)
        .filter(a => !trackedIds.has(getActivityId(a)));
      state.allActivities = mergeActivities(state.allActivities, state.unsubmitted);

      const notice = document.getElementById('activityLoadNotice');
      if (notice) notice.hidden = activitiesResult.status === 'fulfilled' && unsubmittedResult.status === 'fulfilled';

      if (activitiesResult.status === 'rejected') {
        console.error('[student activities error]', activitiesResult.reason);
      }
      if (unsubmittedResult.status === 'rejected') {
        console.warn('[unsubmitted activities error]', unsubmittedResult.reason);
      }
      await loadAnnouncements();
    } catch (err) {
      console.error('[loadAll error]', err);
    } finally {
      if (revision === state.loadRevision) {
        state.isLoading = false;
        renderActivities();
        loadClassroomInfo();
      }
    }
  }

  async function loadAnnouncements() {
    try {
      let res = null;
      if (apiClient?.classroom?.listAnnouncements) {
        res = await apiClient.classroom.listAnnouncements(classroomId);
      } else if (apiClient?.request) {
        res = await apiClient.request(
          `/classroom/${encodeURIComponent(classroomId)}/announcement`,
          { method: 'GET' },
          { redirectOnUnauthorized: false }
        );
      }
      state.announcements = normalizeAnnouncementCollection(res)
        .filter((announcement) => !announcement.classroomId || announcement.classroomId === classroomId);
      if (state.announcements.length) {
        cacheAnnouncements(classroomId, state.announcements);
      }
    } catch (_) {
      state.announcements = readCachedAnnouncements(classroomId);
    }

    if (!state.announcements.length) {
      state.announcements = readCachedAnnouncements(classroomId);
    }

    renderAnnouncements();
  }

  function setStudentProfile(data) {
    const first    = data?.firstName || '';
    const last     = data?.lastName  || '';
    const fullName = `${first} ${last}`.trim() || 'Student';
    const url      = data?.profileUrl || '';
    const initials = `${first.charAt(0)}${last.charAt(0)}`.toUpperCase() || 'ST';
    const nameEl   = document.getElementById('studentName');
    const avatarEl = document.getElementById('studentAvatar');
    if (nameEl)   nameEl.textContent = fullName;
    if (avatarEl) avatarEl.innerHTML = url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(fullName)}">` : initials;
  }

  function loadClassroomInfo() {
    const p = new URLSearchParams(window.location.search);
    const nameEl = document.getElementById('classroomInfoName');
    const codeEl = document.getElementById('classroomInfoCode');
    if (nameEl) nameEl.textContent = decodeURIComponent(p.get('name') || '—');
    if (codeEl) codeEl.textContent = decodeURIComponent(p.get('code') || '—');
  }

  function renderAnnouncements() {
    if (!studentAnnouncementsList) return;
    if (!state.announcements.length) {
      studentAnnouncementsList.innerHTML = `
        <div class="announcement-empty">
          <i class="fas fa-bullhorn"></i>
          <p>No announcements yet.</p>
        </div>`;
      return;
    }

    studentAnnouncementsList.innerHTML = state.announcements.slice(0, 3).map((announcement) => `
      <article class="announcement-card">
        <div class="announcement-card-head">
          <strong>Announcement</strong>
          <span>${escapeHtml(formatAnnouncementTime(announcement.createdAt))}</span>
        </div>
        <div class="announcement-card-message">${escapeHtml(announcement.message || '')}</div>
        ${announcement.attachments.length ? `
          <div class="announcement-card-attachments">
            ${announcement.attachments.map((attachment) => renderAnnouncementAttachment(attachment)).join('')}
          </div>` : ''}
      </article>
    `).join('');
  }

  function formatAnnouncementTime(value) {
    if (!value) return 'Just now';
    const d = new Date(value);
    return isNaN(d) ? 'Just now' : d.toLocaleString();
  }

  function normalizeAnnouncementCollection(result) {
    if (Array.isArray(result)) return result.map(normalizeAnnouncement).filter(Boolean);
    if (Array.isArray(result?.data)) return result.data.map(normalizeAnnouncement).filter(Boolean);
    if (Array.isArray(result?.content)) return result.content.map(normalizeAnnouncement).filter(Boolean);
    if (Array.isArray(result?.items)) return result.items.map(normalizeAnnouncement).filter(Boolean);
    if (result && typeof result === 'object' && result.announcementId) return [normalizeAnnouncement(result)].filter(Boolean);
    return [];
  }

  function normalizeAnnouncement(item) {
    if (!item || typeof item !== 'object') return null;
    return {
      announcementId: String(item.announcementId || ''),
      classroomId: String(item.classroomId || ''),
      message: String(item.message || ''),
      createdAt: String(item.createdAt || ''),
      attachments: Array.isArray(item.attachments)
        ? item.attachments.map(normalizeAttachment).filter(Boolean)
        : []
    };
  }

  function normalizeAttachment(item) {
    if (!item || typeof item !== 'object') return null;
    return {
      attachmentId: String(item.attachmentId || ''),
      url: String(item.url || ''),
      type: String(item.type || ''),
      resourceType: String(item.resourceType || ''),
    };
  }

  function getAttachmentLabel(attachment) {
    const resourceType = String(attachment?.resourceType || '').trim();
    const type = String(attachment?.type || '').trim();
    const url = String(attachment?.url || '').trim();
    if (resourceType) return resourceType;
    if (type) return type;
    if (url) {
      try {
        const pathname = new URL(url, window.location.origin).pathname;
        const last = pathname.split('/').filter(Boolean).pop();
        if (last) return decodeURIComponent(last);
      } catch (_) {}
    }
    return 'Attachment';
  }

  function getAttachmentKind(attachment) {
    const value = String(attachment?.type || attachment?.resourceType || '').trim().toLowerCase();
    if (value.includes('image')) return 'image';
    if (value.includes('video')) return 'video';
    const url = String(attachment?.url || '').trim().toLowerCase();
    if (/\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$/.test(url)) return 'image';
    if (/\.(mp4|webm|mov|avi|mkv)(\?.*)?$/.test(url)) return 'video';
    return 'file';
  }

  function getAttachmentKindLabel(kind) {
    if (kind === 'image') return 'image';
    if (kind === 'video') return 'video';
    return 'attachment';
  }

  function renderAnnouncementAttachment(attachment) {
    const url = String(attachment?.url || '').trim();
    if (!url) return '';
    const label = getAttachmentLabel(attachment);
    const kind = getAttachmentKind(attachment);

    if (kind === 'image') {
      return `
        <a class="announcement-attachment-media" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" download>
          <img class="announcement-attachment-preview" src="${escapeHtml(url)}" alt="${escapeHtml(label)}">
          <span class="announcement-attachment-body">
            <i class="fas fa-image"></i>
            <span>${escapeHtml(getAttachmentKindLabel(kind))}</span>
            <i class="fas fa-download"></i>
          </span>
        </a>`;
    }

    if (kind === 'video') {
      return `
        <div class="announcement-attachment-media">
          <video class="announcement-attachment-preview" controls playsinline preload="metadata" src="${escapeHtml(url)}"></video>
          <a class="announcement-attachment-body" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" download>
            <i class="fas fa-video"></i>
            <span>${escapeHtml(getAttachmentKindLabel(kind))}</span>
            <i class="fas fa-download"></i>
          </a>
        </div>`;
    }

    return `
      <a class="announcement-attachment-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" download>
        <span class="announcement-attachment-body">
          <i class="fas fa-download"></i>
          <span>${escapeHtml(label)}</span>
        </span>
      </a>`;
  }

  function cacheKeyForClassroom(id) { return `ct_announcements_${String(id || '')}`; }
  function readCachedAnnouncements(id) {
    try {
      const raw = localStorage.getItem(cacheKeyForClassroom(id));
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.map(normalizeAnnouncement).filter(Boolean) : [];
    } catch (_) {
      return [];
    }
  }
  function cacheAnnouncements(id, announcements) {
    try { localStorage.setItem(cacheKeyForClassroom(id), JSON.stringify(announcements || [])); } catch (_) {}
  }

  // submit/existing accepts a browser-facing GitHub URL. GitHub's `url`
  // property is its REST API URL and must never be sent to that endpoint.
  function normalizeGithubRepositoryUrl(value) {
    try {
      const url = new URL(String(value || '').trim());
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return '';
      const host = url.hostname.toLowerCase();
      if (host !== 'github.com' && host !== 'www.github.com') return '';

      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length !== 2) return '';

      const [owner, repository] = segments;
      const name = repository.replace(/\.git$/i, '');
      if (!/^[a-zA-Z0-9-]+$/.test(owner) || !/^[a-zA-Z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') return '';
      return `https://github.com/${owner}/${name}`;
    } catch (_) {
      return '';
    }
  }

  async function loadGithubRepos() {
    const sel = document.getElementById('repoSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Loading repositories... —</option>';
    sel.disabled = true;
    try {
      const res   = await apiClient.request('/github/repositories', { method: 'GET' });
      const repos = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : [];
      const options = repos.map(r => {
        const name = r.fullName || r.full_name || r.name || '';
        const url = normalizeGithubRepositoryUrl(r.htmlUrl || r.html_url || r.htmlURL);
        return name && url ? `<option value="${escapeHtml(url)}">${escapeHtml(name)}</option>` : '';
      }).filter(Boolean);
      sel.innerHTML = options.length === 0
        ? '<option value="">No repositories found</option>'
        : '<option value="">— Select a repository —</option>' + options.join('');
    } catch {
      sel.innerHTML = '<option value="">Failed to load repositories</option>';
    } finally {
      sel.disabled = state.repositorySubmissionInFlight;
    }
  }

  function setSubmitButtonState(mode) {
    if (!submitAssignmentBtn) return;
    submitAssignmentBtn.classList.remove('is-loading', 'is-success', 'is-error');
    if (mode === 'loading') {
      submitAssignmentBtn.disabled = true;
      submitAssignmentBtn.classList.add('is-loading');
      submitAssignmentBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Attaching…';
    } else if (mode === 'success') {
      submitAssignmentBtn.disabled = true;
      submitAssignmentBtn.classList.add('is-success');
      submitAssignmentBtn.innerHTML = '<i class="fas fa-check"></i> Attached!';
    } else if (mode === 'error') {
      submitAssignmentBtn.disabled = false;
      submitAssignmentBtn.classList.add('is-error');
      submitAssignmentBtn.innerHTML = '<i class="fas fa-triangle-exclamation"></i> Try Again';
    } else {
      submitAssignmentBtn.disabled = false;
      submitAssignmentBtn.innerHTML = '<i class="fab fa-github"></i> Attach Repository';
    }
  }

  async function submitAssignment() {
    if (state.repositorySubmissionInFlight || submitAssignmentBtn?.disabled) return;
    const activity = state.currentActivity;
    if (!activity) { await window.AppDialog?.alert('Select an activity first.', { title: 'Missing Activity' }); return; }

    const mode = submissionModeSelect?.value;
    if (mode !== 'new' && mode !== 'existing') {
      await window.AppDialog?.alert('Choose an existing repository or create a new one.', { title: 'Choose Repository Type' });
      return;
    }
    let repositoryUrl = '';

    if (mode === 'existing') {
      repositoryUrl = normalizeGithubRepositoryUrl(
        document.getElementById('repoSelect')?.value
      );
      if (!repositoryUrl) { await window.AppDialog?.alert('Please select a repository.', { title: 'No Repository Selected' }); return; }
    } else {
      const name = document.getElementById('repositoryName')?.value.trim() || '';
      if (!name) { await window.AppDialog?.alert('Please enter a repository name.', { title: 'Missing Name' }); return; }
      if (!/^[a-zA-Z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') {
        await window.AppDialog?.alert('Use 1–100 letters, numbers, periods, hyphens, or underscores.', { title: 'Invalid Repository Name' });
        return;
      }
      repositoryUrl = name;
    }

    state.repositorySubmissionInFlight = true;
    setSubmissionInputsDisabled(true);
    setSubmitButtonState('loading');
    try {
      const approved = await window.AppDialog?.confirm(
        `Attach a repository to "${getActivityTitle(activity)}"? You will submit your finished work from Tracked Activities.`,
        { title: 'Attach Repository', confirmText: 'Attach Repository', cancelText: 'Review' }
      );
      if (!approved) return;
      const body = mode === 'new' ? { repositoryName: repositoryUrl } : { repositoryUrl };
      const response = await apiClient.request(
        `/classrooms/${encodeURIComponent(classroomId)}/activities/${encodeURIComponent(getActivityId(activity))}/submit/${mode}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
        { redirectOnUnauthorized: false }
      );

      rememberActivity(activity, {
        ...response?.data,
        submissionStatus: response?.data?.submissionStatus || 'PENDING',
        repositoryAttached: true,
        repositoryUrl: mode === 'existing' ? repositoryUrl : null,
        repositoryName: mode === 'new' ? repositoryUrl : repositoryUrl.split('/').pop(),
        repositoryMode: mode.toUpperCase(),
      });
      state.currentActivityTab = 'tracked';
      state.filters.trackedSubmission = 'ALL';
      document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === 'tracked'));
      document.querySelectorAll('[data-tracked-filter]').forEach(b => b.classList.toggle('active', b.dataset.trackedFilter === 'ALL'));
      renderActivities();
      setSubmitButtonState('success');
      closeSubmissionModal({ force: true });
      clearSubmissionForm();
      await loadAll();
      await window.AppDialog?.alert('Repository attached. Push your finished work to GitHub, then click Submit Activity in Tracked Activities.', { title: 'Repository Attached' });
    } catch (err) {
      setSubmitButtonState('error');
      await window.AppDialog?.alert(err?.message || 'Failed to attach repository. Please try again.', { title: 'Attachment Failed' });
    } finally {
      state.repositorySubmissionInFlight = false;
      setSubmissionInputsDisabled(false);
      setSubmitButtonState('idle');
    }
  }

  function openSubmissionModal(activityId) {
    if (state.repositorySubmissionInFlight) return;
    const activity = state.unsubmitted.find(a => getActivityId(a) === activityId)
      || state.allActivities.find(a => getActivityId(a) === activityId);
    if (!activity) { window.AppDialog?.alert('Activity not found.', { title: 'Missing Activity' }); return; }
    state.currentActivity = activity;
    if (modalAssignmentDetail) {
      modalAssignmentDetail.innerHTML = `
        <div class="modal-assignment-title"><i class="fas fa-project-diagram"></i> ${escapeHtml(getActivityTitle(activity))}</div>
        <div class="modal-assignment-meta">
          <span><i class="fas fa-calendar-alt"></i> ${formatDate(activity?.dueDate) || 'No due date'}</span>
          <span><i class="fas fa-circle-info"></i> ${escapeHtml(getStatusLabel(activity))}</span>
        </div>
        <p class="modal-assignment-description">${escapeHtml(getActivityDescription(activity) || 'No description provided.')}</p>`;
    }
    if (submissionModeSelect) submissionModeSelect.value = '';
    applySubmissionMode('');
    if (submissionModal) {
      const mc = submissionModal.querySelector('.modal-content');
      if (mc) mc.scrollTop = 0;
      submissionModal.style.display = 'block';
      setTimeout(() => submissionModeSelect?.focus(), 100);
    }
  }

  function closeSubmissionModal({ force = false } = {}) {
    if (state.repositorySubmissionInFlight && !force) return;
    if (!submissionModal) return;
    submissionModal.style.opacity = '0';
    setTimeout(() => { submissionModal.style.display = 'none'; submissionModal.style.opacity = ''; }, 200);
  }

  function clearSubmissionForm() {
    const r = document.getElementById('repositoryName');
    if (r) r.value = '';
    if (submissionModeSelect) submissionModeSelect.value = '';
    const select = document.getElementById('repoSelect');
    if (select) select.value = '';
    applySubmissionMode('');
  }

  function setSubmissionInputsDisabled(disabled) {
    for (const id of ['submissionMode', 'repositoryName', 'repoSelect', 'cancelSubmitBtn', 'closeModal']) {
      const element = document.getElementById(id);
      if (element) element.disabled = disabled;
    }
    submissionModal?.setAttribute('aria-busy', String(disabled));
  }

  function applySubmissionMode(mode) {
    const isNew = mode === 'new', isExisting = mode === 'existing';
    const eg = document.getElementById('existingRepoGroup');
    const ng = document.getElementById('newRepoGroup');
    const ri = document.getElementById('repositoryName');
    const rs = document.getElementById('repoSelect');
    if (eg) eg.style.display = isExisting ? 'block' : 'none';
    if (ng) ng.style.display = isNew ? 'block' : 'none';
    if (rs) rs.required = isExisting;
    if (ri) { ri.required = isNew; if (!isNew) ri.value = ''; }
    if (isExisting) loadGithubRepos();
  }

  function attachEventHandlers() {
    setSubmitButtonState('idle');
    attachProfileMenu();

    document.getElementById('reloadActivitiesBtn')?.addEventListener('click', loadAll);

    document.querySelectorAll('[data-tab]').forEach(btn => btn.addEventListener('click', () => {
      state.currentActivityTab = btn.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === btn.dataset.tab));
      renderActivities();
    }));

    document.getElementById('closeModal')?.addEventListener('click', closeSubmissionModal);
    document.getElementById('cancelSubmitBtn')?.addEventListener('click', closeSubmissionModal);
    document.getElementById('closeActivityDetailsModal')?.addEventListener('click', closeDetailsModal);
    window.addEventListener('click', e => {
      if (e.target === submissionModal) closeSubmissionModal();
      if (e.target === detailsModal) closeDetailsModal();
    });
    window.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      closeSubmissionModal();
      closeDetailsModal();
    });

    document.getElementById('backDashboardBtn')?.addEventListener('click', e => {
      e.preventDefault(); window.location.href = '/dashboard/';
    });

    if (submissionModeSelect) {
      submissionModeSelect.addEventListener('change', e => applySubmissionMode(e.target.value));
      applySubmissionMode(submissionModeSelect.value || '');
    }

    document.getElementById('submissionForm')?.addEventListener('submit', e => {
      e.preventDefault();
      submitAssignment();
    });

    assignmentsList?.addEventListener('click', async e => {
      const repoBtn = e.target.closest('[data-submit-activity-id]');
      if (repoBtn) {
        openSubmissionModal(repoBtn.getAttribute('data-submit-activity-id'));
        return;
      }

      const pendingBtn = e.target.closest('[data-submit-pending-activity-id]');
      if (pendingBtn) {
        await submitPendingActivity(
          pendingBtn.getAttribute('data-submit-pending-activity-id'),
          pendingBtn
        );
        return;
      }

      const detailsBtn = e.target.closest('[data-view-activity-id]');
      if (detailsBtn) {
        openDetailsModal(detailsBtn.getAttribute('data-view-activity-id'));
      }
    });

    document.querySelectorAll('[data-tracked-filter]').forEach(btn => btn.addEventListener('click', () => {
      state.filters.trackedSubmission = btn.getAttribute('data-tracked-filter') || 'ALL';
      document.querySelectorAll('[data-tracked-filter]').forEach(b =>
        b.classList.toggle('active', b.getAttribute('data-tracked-filter') === state.filters.trackedSubmission));
      renderActivities();
    }));
  }

  function attachProfileMenu() {
    const profile = document.getElementById('studentProfile');
    const trigger = document.getElementById('studentAvatar');
    const menu = document.getElementById('studentProfileDropdown');
    const logoutButton = document.getElementById('studentLogoutBtn');
    if (!profile || !trigger || !menu || !logoutButton) return;

    const closeMenu = () => {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    };

    trigger.addEventListener('click', event => {
      event.stopPropagation();
      const isOpen = !menu.hidden;
      menu.hidden = isOpen;
      trigger.setAttribute('aria-expanded', String(!isOpen));
    });

    document.addEventListener('click', event => {
      if (!profile.contains(event.target)) closeMenu();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeMenu();
    });

    logoutButton.addEventListener('click', async () => {
      closeMenu();
      const confirmed = window.AppDialog?.confirm
        ? await window.AppDialog.confirm('Are you sure you want to log out?', {
            title: 'Log Out', confirmText: 'Log Out', danger: true
          })
        : window.confirm('Are you sure you want to log out?');
      if (!confirmed) return;

      logoutButton.disabled = true;
      try {
        await window.ApiClient?.logout?.();
      } finally {
        localStorage.clear();
        sessionStorage.clear();
        window.location.href = '/';
      }
    });
  }

  renderLoadingSkeleton();
  attachEventHandlers();
  loadAll();
})();
