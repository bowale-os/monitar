import { api, getTokens, setTokens, SessionExpiredError } from "./api.js";
import { deriveAndStoreKey, clearKey, loadKey, decrypt} from "./crypto.js";

// --- embed worker ---
let _worker = null;
let _reqId = 0;
const _pending = new Map();

function getWorker() {
  if (_worker) return _worker;
  _worker = new Worker(chrome.runtime.getURL("embed.worker.js"), { type: "module" });
  _worker.addEventListener("message", ({ data }) => {
    if (data.type === "download_progress") return;
    if (data.type === "status") {
      if (data.message === "ready") {
        modelStatus.classList.add("hidden");
      } else {
        modelStatus.textContent = "Setting up search...";
        modelStatus.classList.remove("hidden");
      }
      return;
    }
    const { id, vector, error } = data;
    const handlers = _pending.get(id);
    if (!handlers) return;
    _pending.delete(id);
    error ? handlers.reject(new Error(error)) : handlers.resolve(vector);
  });
  return _worker;
}

function embed(text) {
  return new Promise((resolve, reject) => {
    const id = ++_reqId;
    _pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, text });
  });
}

const JUNK_TITLES = new Set(["new tab", "loading...", "404 not found", "untitled", "about:blank"]);

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

// Mirrors isTrackable() in background.js — tabs that won't end up in a session
// (chrome://, extension pages, etc.) shouldn't be counted or shown in the picker.
function isTrackableUrl(url) {
  return !!url && /^https?:/i.test(url);
}

function buildEmbedText(payload) {
  const allTabs = Object.values(payload.windows ?? {}).flatMap(w => w.tabs ?? []);

  const groupNames = Object.values(payload.windows ?? {})
    .flatMap(w => Object.values(w.groups ?? {}).map(g => g.title).filter(Boolean));

  const domains = [...new Set(allTabs.map(t => hostnameOf(t.url)).filter(Boolean))];

  const titles = allTabs
    .map(t => (t.title || "").trim())
    .filter(t => t && !JUNK_TITLES.has(t.toLowerCase()));

  const parts = [
    `Intent: ${payload.intent || "Untitled"}.`,
    groupNames.length ? `Topics: ${groupNames.join(", ")}.` : "",
    domains.length ? `Sites: ${domains.join(", ")}.` : "",
    titles.length ? `Pages: ${titles.join("; ")}.` : "",
  ].filter(Boolean).join(" ");

  return parts.slice(0, 1000);
}

// --- element refs ---
const setupNudge = document.getElementById("setup-nudge");
const nudgeBtn = document.getElementById("nudge-btn");

const authView = document.getElementById("auth-view");
const mainView = document.getElementById("main-view");
const signoutBtn = document.getElementById("signout-btn");

const tabSignin = document.getElementById("tab-signin");
const tabSignup = document.getElementById("tab-signup");
const authForm = document.getElementById("auth-form");
const authSubmit = document.getElementById("auth-submit");
const nameInput = document.getElementById("name");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");

const startForm = document.getElementById("start-form");
const startBtn = document.getElementById("start-btn");
const intentInput = document.getElementById("intent");
const includeOpen = document.getElementById("include-open");
const windowPicker = document.getElementById("window-picker");
const activePanel = document.getElementById("active-panel");
const activeIntent = document.getElementById("active-intent");
const activeMeta = document.getElementById("active-meta");
const stopBtn = document.getElementById("stop-btn");
const newSessionBtn = document.getElementById("new-session-btn");
const conflictPrompt = document.getElementById("conflict-prompt");
const conflictText = document.getElementById("conflict-text");
const conflictSave = document.getElementById("conflict-save");
const conflictDiscard = document.getElementById("conflict-discard");
const conflictCancel = document.getElementById("conflict-cancel");
const sessionList = document.getElementById("session-list");
const recentList = document.getElementById("recent-list");
const seeAllBtn = document.getElementById("see-all-btn");
const emptyState = document.getElementById("empty-state");

const historyBtn = document.getElementById("history-btn");
const historyBackBtn = document.getElementById("history-back-btn");
const homeScreen = document.getElementById("home-screen");
const historyScreen = document.getElementById("history-screen");

const searchInput = document.getElementById("search-input");
const searchSpinner = document.getElementById("search-spinner");
const searchResults = document.getElementById("search-results");
const noResults = document.getElementById("no-results");
const resultsHeading = document.getElementById("results-heading");
const modelStatus = document.getElementById("model-status");

const statusEl = document.getElementById("status");

let authMode = "signin"; // "signin" | "signup"

// --- helpers ---
let _statusTimer = null;

function showStatus(message, kind = "error") {
  clearTimeout(_statusTimer);
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`;
  statusEl.classList.remove("hidden");
  if (kind === "success") {
    _statusTimer = setTimeout(clearStatus, 5000);
  }
}

function clearStatus() {
  clearTimeout(_statusTimer);
  statusEl.classList.add("hidden");
}

// Like showStatus, but with an inline "Undo" action that runs onUndo and
// dismisses itself. Auto-dismisses after durationMs either way.
function showUndoToast(message, onUndo, durationMs = 9000) {
  clearTimeout(_statusTimer);
  statusEl.textContent = "";
  statusEl.className = "status success undo-toast";
  statusEl.classList.remove("hidden");

  const text = document.createElement("span");
  text.textContent = message;

  const undoBtn = document.createElement("button");
  undoBtn.type = "button";
  undoBtn.className = "undo-btn";
  undoBtn.textContent = "Undo";
  undoBtn.addEventListener("click", () => {
    clearTimeout(_statusTimer);
    clearStatus();
    onUndo();
  });

  statusEl.append(text, undoBtn);
  _statusTimer = setTimeout(clearStatus, durationMs);
}

// Central error handling: if the session expired (refresh failed), drop back to
// the login view; otherwise just surface the message.
function handleError(err) {
  if (err instanceof SessionExpiredError || err?.name === "SessionExpiredError") {
    setAuthMode("signin");
    showAuthView();
    showStatus("Your session expired — please sign in again.");
  } else {
    showStatus(err.message);
  }
}

function parseDate(iso) {
  if (!iso) return null;
  const d = new Date(iso.replace("+00:00", "Z"));
  return isNaN(d) ? null : d;
}

function formatTime(d) {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Relative, scannable dates for session cards: "Today 2:14 PM", "Yesterday",
// "3 days ago", then "Jun 12" (with the year once it's not this year).
function formatRelativeDate(iso) {
  const d = parseDate(iso);
  if (!d) return "";

  const now = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);

  if (dayDiff <= 0) return `Today ${formatTime(d)}`;
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff < 7) return `${dayDiff} days ago`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

// For the active-session card: "since 2:14 PM" today, otherwise the date too.
function formatSince(iso) {
  const d = parseDate(iso);
  if (!d) return "";
  const rel = formatRelativeDate(iso);
  return rel.startsWith("Today ") ? rel.slice(6) : rel;
}

// The popup is destroyed every time it closes, so typed text is lost. Persist
// the non-sensitive auth fields (email + name) as a draft and restore them on
// reopen. The password is deliberately never stored.
const AUTH_DRAFT_KEY = "@#$%^%sDFGHGMw4354567c0dzxcb@#$%^&CVXCV&T&$%eqDF1sEWSDFgvndf";

function saveAuthDraft() {
  chrome.storage.local.set({
    [AUTH_DRAFT_KEY]: { email: emailInput.value, name: nameInput.value },
  });
}

async function loadAuthDraft() {
  const { [AUTH_DRAFT_KEY]: draft } = await chrome.storage.local.get(AUTH_DRAFT_KEY);
  if (draft) {
    emailInput.value = draft.email || "";
    nameInput.value = draft.name || "";
  }
}

function clearAuthDraft() {
  chrome.storage.local.remove(AUTH_DRAFT_KEY);
}

// Same idea for the intent field: if the popup is closed mid-typing, keep what
// was entered so it's still there next time. Cleared once a session starts.
const INTENT_DRAFT_KEY = "intent_draft";

function saveIntentDraft() {
  chrome.storage.local.set({ [INTENT_DRAFT_KEY]: intentInput.value });
}

async function loadIntentDraft() {
  const { [INTENT_DRAFT_KEY]: draft } = await chrome.storage.local.get(INTENT_DRAFT_KEY);
  intentInput.value = draft || "";
}

function clearIntentDraft() {
  chrome.storage.local.remove(INTENT_DRAFT_KEY);
}

// Ask the background worker whether a session is running.
function getStatus() {
  return chrome.runtime.sendMessage({ type: "GET_STATUS" });
}

// Toggle between the "start" form and the "active session" panel.
async function refreshSessionUI() {
  const status = await getStatus();
  // Stale prompt with no decision pending (e.g. after a refresh) — drop it.
  if (!pendingStart) conflictPrompt.classList.add("hidden");
  if (status?.active) {
    startForm.classList.add("hidden");
    activePanel.classList.remove("hidden");
    activeIntent.textContent = status.intent || "Untitled session";
    activeMeta.textContent =
      `Tracking · ${status.tabCount} tab${status.tabCount === 1 ? "" : "s"} · since ${formatSince(status.started_at)}`;
      if (status.lastFlushAt) {
        const secondsSinceFlush = (Date.now() - new Date(status.lastFlushAt)) / 1000;
        if (secondsSinceFlush > 300) {
          showStatus("Autosave may have stopped. Try stopping and restarting the session.", "error");
        }
      } else {
        // no flush yet — check if we've been running long enough that there should have been one
        const secondsSinceStart = (Date.now() - new Date(status.started_at)) / 1000;
        if (secondsSinceStart > 120) {
          // session is 2 minutes old but never successfully flushed
          showStatus("Autosave hasn't started, please check your connection.", "error");
        }
      }
  } else {
    activePanel.classList.add("hidden");
    startForm.classList.remove("hidden");
    // Restore the last-used "capture already-open tabs" choice (default off).
    const { capture_existing_pref } = await chrome.storage.local.get("capture_existing_pref");
    includeOpen.checked = Boolean(capture_existing_pref);
    await renderWindowPicker();
    // Restore a half-typed intent from a previous (possibly accidental) close.
    await loadIntentDraft();
  }

}

// --- onboarding ---
// Full onboarding lives in onboarding.html (opened in a tab on install). The
// popup only shows a nudge to finish it until the flag is set.
const ONBOARDED_KEY = "has_onboarded";

function showSetupNudge() {
  setupNudge.classList.remove("hidden");
  authView.classList.add("hidden");
  mainView.classList.add("hidden");
  signoutBtn.classList.add("hidden");
  historyBtn.classList.add("hidden");
}

nudgeBtn.addEventListener("click", async () => {
  const onboardingUrl = chrome.runtime.getURL("onboarding.html");
  const [existing] = await chrome.tabs.query({ url: onboardingUrl });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: onboardingUrl });
  }
  window.close();
});

// --- views ---
function showAuthView() {
  setupNudge.classList.add("hidden");
  authView.classList.remove("hidden");
  mainView.classList.add("hidden");
  signoutBtn.classList.add("hidden");
  historyBtn.classList.add("hidden");
}

function showMainView() {
  setupNudge.classList.add("hidden");
  authView.classList.add("hidden");
  mainView.classList.remove("hidden");
  signoutBtn.classList.remove("hidden");
  showHomeScreen();
  // Start the worker now so the model downloads in the background while the
  // user looks at their sessions — by first search it should already be ready.
  getWorker();
}

// --- home / history screens (both live inside main-view) ---
function showHomeScreen() {
  homeScreen.classList.remove("hidden");
  historyScreen.classList.add("hidden");
  historyBtn.classList.remove("hidden");
  resetSearch();
}

function showHistoryScreen() {
  homeScreen.classList.add("hidden");
  historyScreen.classList.remove("hidden");
  historyBtn.classList.add("hidden");
}

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  tabSignin.classList.toggle("active", !signup);
  tabSignup.classList.toggle("active", signup);
  nameInput.classList.toggle("hidden", !signup);
  authSubmit.textContent = signup ? "Sign up" : "Sign in";
  clearStatus();
}

const TRASH_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
  '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>' +
  '<line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

const CHEVRON_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="9 6 15 12 9 18"/></svg>';

const RECENT_COUNT = 3;

// Decrypted session payloads, cached per session id so re-expanding a preview
// doesn't re-decrypt. Value is the decrypted payload, or an Error if decrypt
// failed (also cached, so we don't retry a session that has no key / no
// content on every expand).
const _previewCache = new Map();

// Write-through mirror of _previewCache in chrome.storage.session (memory-only,
// same lifetime as the AES key in crypto.js), so keyword search doesn't have to
// re-decrypt every session on every popup open. Distinct key from crypto.js's
// KEY_STORAGE. Only successful decrypts are persisted; cached Errors stay
// in-memory only, as before.
const PREVIEW_CACHE_STORAGE_KEY = "search_decrypt_cache_v1";

// Always writes the full current in-memory map (never reads-then-modifies
// storage first), so concurrent decrypts during ensureAllSessionsDecrypted()
// can't race and clobber each other's entries.
async function persistPreviewCache() {
  const obj = {};
  for (const [id, val] of _previewCache) {
    if (!(val instanceof Error)) obj[id] = val;
  }
  await chrome.storage.session.set({ [PREVIEW_CACHE_STORAGE_KEY]: obj });
}

async function hydratePreviewCache() {
  const { [PREVIEW_CACHE_STORAGE_KEY]: cached } = await chrome.storage.session.get(PREVIEW_CACHE_STORAGE_KEY);
  if (!cached) return;
  for (const [id, payload] of Object.entries(cached)) _previewCache.set(id, payload);
}

async function getDecryptedPayload(s) {
  if (_previewCache.has(s._id)) {
    const cached = _previewCache.get(s._id);
    if (cached instanceof Error) throw cached;
    return cached;
  }
  try {
    if (!s.content_encrypted) throw new Error("no-content");
    const key = await loadKey();
    if (!key) throw new Error("no-key");
    const payload = await decrypt(key, s.content_encrypted);
    _previewCache.set(s._id, payload);
    await persistPreviewCache();
    return payload;
  } catch (err) {
    _previewCache.set(s._id, err);
    throw err;
  }
}

// --- keyword search (client-side, over decrypted content) ---
const MIN_QUERY_LENGTH = 2;
const KEYWORD_SESSIONS_CAP = 5;
const KEYWORD_TABS_PER_SESSION_CAP = 3;

// Fetches every session and decrypts each (skipping ones that fail), sorted
// newest-first. GET / has no sort clause server-side, so recency order isn't
// guaranteed and must be applied here.
async function ensureAllSessionsDecrypted() {
  const { data } = await api.listSessions();
  const sessions = data || [];
  const settled = await Promise.allSettled(
    sessions.map(async (session) => ({ session, payload: await getDecryptedPayload(session) }))
  );
  const entries = settled
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value);
  entries.sort((a, b) => (parseDate(b.session.started_at)?.getTime() ?? 0) - (parseDate(a.session.started_at)?.getTime() ?? 0));
  return entries;
}

// Plain case-insensitive substring match over tab title/url and group title.
function keywordSearchSessions(query, entries) {
  const q = query.toLowerCase();
  const matches = [];

  for (const { session, payload } of entries) {
    const windows = Object.values(payload.windows ?? {});
    const allTabs = windows.flatMap((w) => w.tabs ?? []);
    const groupTitles = windows.flatMap((w) => Object.values(w.groups ?? {}).map((g) => g.title).filter(Boolean));

    const allMatchedTabs = allTabs.filter((t) =>
      (t.title || "").toLowerCase().includes(q) || (t.url || "").toLowerCase().includes(q)
    );
    const matchedGroupTitles = groupTitles.filter((title) => title.toLowerCase().includes(q));

    if (allMatchedTabs.length === 0 && matchedGroupTitles.length === 0) continue;

    matches.push({
      session,
      matchedTabs: allMatchedTabs.slice(0, KEYWORD_TABS_PER_SESSION_CAP),
      allMatchedTabs,
      overflowTabCount: Math.max(0, allMatchedTabs.length - KEYWORD_TABS_PER_SESSION_CAP),
      matchedGroupTitles,
      groupOnlyMatch: allMatchedTabs.length === 0 && matchedGroupTitles.length > 0,
    });
  }

  return {
    results: matches.slice(0, KEYWORD_SESSIONS_CAP),
    overflowSessionCount: Math.max(0, matches.length - KEYWORD_SESSIONS_CAP),
  };
}

// --- highlighting (escape-then-wrap; never escape first and search inside
// the escaped string, offsets from the raw string won't line up) ---
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function highlightMatch(text, query) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);
  return `${escapeHtml(before)}<mark class="hl">${escapeHtml(match)}</mark>${escapeHtml(after)}`;
}

function renderPreview(panel, payload) {
  panel.innerHTML = "";

  const windows = Object.values(payload.windows ?? {});
  const allTabs = windows.flatMap(w => w.tabs ?? []);

  if (allTabs.length === 0) {
    panel.innerHTML = '<p class="preview-empty muted">This session has no restorable tabs.</p>';
    return;
  }

  const windowCount = windows.length;
  const summary = document.createElement("p");
  summary.className = "preview-summary muted";
  summary.textContent =
    `${windowCount} window${windowCount === 1 ? "" : "s"} · restoring opens ${allTabs.length} tab${allTabs.length === 1 ? "" : "s"} in a new window`;
  panel.append(summary);

  const groups = windows.flatMap(w => Object.values(w.groups ?? {})).filter(g => g.title);
  if (groups.length) {
    const groupsRow = document.createElement("div");
    groupsRow.className = "preview-groups";
    for (const g of groups) {
      const chip = document.createElement("span");
      chip.className = `group-chip group-${g.color || "grey"}`;
      chip.textContent = g.title;
      groupsRow.append(chip);
    }
    panel.append(groupsRow);
  }

  const sampleTabs = allTabs
    .filter(t => (t.title || "").trim() && !JUNK_TITLES.has(t.title.trim().toLowerCase()))
    .slice(0, 3);

  if (sampleTabs.length) {
    const tabsList = document.createElement("ul");
    tabsList.className = "preview-tabs";
    for (const t of sampleTabs) {
      const row = document.createElement("li");
      const tTitle = document.createElement("span");
      tTitle.className = "preview-tab-title";
      tTitle.textContent = t.title;
      const tHost = document.createElement("span");
      tHost.className = "preview-tab-host muted";
      tHost.textContent = hostnameOf(t.url) || "";
      row.append(tTitle, tHost);
      tabsList.append(row);
    }
    panel.append(tabsList);
  }
}

const PREVIEW_ERROR_MESSAGES = {
  "no-content": "This session has no restorable content.",
  "no-key": "You need to sign in again to preview or restore sessions.",
};

async function togglePreview(s, panel, expandBtn) {
  const isOpen = !panel.classList.contains("hidden");
  if (isOpen) {
    panel.classList.add("hidden");
    expandBtn.setAttribute("aria-expanded", "false");
    expandBtn.classList.remove("expanded");
    return;
  }

  panel.classList.remove("hidden");
  expandBtn.setAttribute("aria-expanded", "true");
  expandBtn.classList.add("expanded");

  if (panel.dataset.rendered) return;
  panel.innerHTML = '<p class="preview-loading muted">Loading preview…</p>';

  try {
    const payload = await getDecryptedPayload(s);
    renderPreview(panel, payload);
  } catch (err) {
    panel.innerHTML = `<p class="preview-empty muted">${PREVIEW_ERROR_MESSAGES[err.message] || "Couldn't load a preview for this session."}</p>`;
  }
  panel.dataset.rendered = "1";
}

function buildSessionRow(s, { showDelete, variant = "default" }) {
  const count = s.tab_count ?? 0;

  const li = document.createElement("li");
  li.className = "session";

  const row = document.createElement("div");
  row.className = "session-row";

  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "expand-btn";
  expandBtn.innerHTML = CHEVRON_ICON;
  expandBtn.title = "Preview session";
  expandBtn.setAttribute("aria-label", "Preview session");
  expandBtn.setAttribute("aria-expanded", "false");

  const info = document.createElement("div");
  info.className = "session-info";
  const title = document.createElement("div");
  title.className = "session-title";
  title.textContent = s.intent || "Untitled session";
  const meta = document.createElement("div");
  meta.className = "session-meta";
  meta.textContent = `${count} tab${count === 1 ? "" : "s"} · ${formatRelativeDate(s.started_at)}`;
  info.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "session-actions";

  const restoreBtn = document.createElement("button");
  restoreBtn.className = "restore-btn";
  if (variant === "semantic") restoreBtn.classList.add("btn-outline");
  restoreBtn.textContent = "Restore";
  restoreBtn.addEventListener("click", () => restoreSession(s._id, restoreBtn));
  actions.append(restoreBtn);

  if (showDelete) {
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "trash-btn";
    deleteBtn.innerHTML = TRASH_ICON;
    deleteBtn.title = "Delete session";
    deleteBtn.setAttribute("aria-label", "Delete session");
    deleteBtn.addEventListener("click", () => deleteSession(s._id, deleteBtn));
    actions.append(deleteBtn);
  }

  row.append(expandBtn, info, actions);
  li.append(row);

  if (variant === "semantic") {
    const relatedNote = document.createElement("p");
    relatedNote.className = "kw-related-note muted";
    relatedNote.textContent = "Related by topic, no literal match";
    li.append(relatedNote);
  }

  const preview = document.createElement("div");
  preview.className = "session-preview hidden";
  expandBtn.addEventListener("click", () => togglePreview(s, preview, expandBtn));

  li.append(preview);
  return li;
}

function buildSemanticOnlyRow(s) {
  return buildSessionRow(s, { showDelete: true, variant: "semantic" });
}

// --- keyword result rendering ---
function buildKeywordTabRow(t, query) {
  const li = document.createElement("li");
  li.className = "kw-tab-row";

  const text = document.createElement("div");
  text.className = "kw-tab-text";
  const title = document.createElement("div");
  title.className = "kw-tab-title";
  title.innerHTML = highlightMatch(t.title || t.url || "", query);
  const url = document.createElement("div");
  url.className = "kw-tab-url muted";
  url.innerHTML = highlightMatch(t.url || "", query);
  text.append(title, url);

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "link kw-tab-open-btn";
  openBtn.textContent = "Open";
  openBtn.addEventListener("click", () => chrome.tabs.create({ url: t.url }));

  li.append(text, openBtn);
  return li;
}

function buildKeywordSessionRow(match, query) {
  const { session: s, matchedTabs, allMatchedTabs, overflowTabCount, matchedGroupTitles, groupOnlyMatch } = match;
  const li = buildSessionRow(s, { showDelete: true });
  let anchor = li.querySelector(".session-row");

  if (matchedGroupTitles.length) {
    const chips = document.createElement("div");
    chips.className = "kw-group-chips";
    for (const title of matchedGroupTitles) {
      const chip = document.createElement("span");
      chip.className = "group-chip";
      chip.innerHTML = highlightMatch(title, query);
      chips.append(chip);
    }
    anchor.after(chips);
    anchor = chips;
  }

  if (groupOnlyMatch) {
    const note = document.createElement("p");
    note.className = "kw-group-only-note muted";
    note.textContent = "Matched by group name";
    anchor.after(note);
  } else if (matchedTabs.length) {
    const tabTree = document.createElement("ul");
    tabTree.className = "kw-tab-tree";
    for (const t of matchedTabs) tabTree.append(buildKeywordTabRow(t, query));
    anchor.after(tabTree);

    if (overflowTabCount > 0) {
      const moreBtn = document.createElement("button");
      moreBtn.type = "button";
      moreBtn.className = "link kw-tab-more-btn";
      moreBtn.textContent = `+${overflowTabCount} more`;
      moreBtn.addEventListener("click", () => {
        tabTree.innerHTML = "";
        for (const t of allMatchedTabs) tabTree.append(buildKeywordTabRow(t, query));
        moreBtn.remove();
      }, { once: true });
      tabTree.after(moreBtn);
    }
  }

  return li;
}

// Renders the full list (History screen) and the recent slice (Home screen)
// from the same fetched array, so there's only ever one API call.
function renderSessions(sessions) {
  sessionList.innerHTML = "";
  for (const s of sessions) sessionList.append(buildSessionRow(s, { showDelete: true }));

  recentList.innerHTML = "";
  for (const s of sessions.slice(0, RECENT_COUNT)) recentList.append(buildSessionRow(s, { showDelete: true }));

  emptyState.classList.toggle("hidden", sessions.length > 0);
  seeAllBtn.classList.toggle("hidden", sessions.length <= RECENT_COUNT);
}

// --- actions ---
async function loadSessions() {
  try {
    const { data } = await api.listSessions();
    renderSessions(data || []);
  } catch (err) {
    handleError(err);
  }
}

async function restoreSession(id, btn) {
  btn.disabled = true;
  try {
    const { data } = await api.getSession(id);

    if (!data.content_encrypted) {
      showStatus("This session has no restorable content.");
      return;
    }

    const key = await loadKey();
    if (!key) {
      showStatus("You need to sign in again to restore sessions.");
      return;
    }

    const payload = await decrypt(key, data.content_encrypted);

    if (!payload.windows || Object.keys(payload.windows).length === 0) {
      showStatus("This session has no restorable tabs.");
      return;
    }

    const createdWindowIds = [];

    for (const [, windowData] of Object.entries(payload.windows)) {
      const urls = windowData.tabs.map(t => t.url).filter(Boolean);
      if (urls.length === 0) continue;

      // create window with first tab
      const newWindow = await chrome.windows.create({ url: urls[0] });
      const newWindowId = newWindow.id;
      createdWindowIds.push(newWindowId);

      // create remaining tabs in same window
      const newTabs = [newWindow.tabs[0]];
      for (let i = 1; i < urls.length; i++) {
        const tab = await chrome.tabs.create({ url: urls[i], windowId: newWindowId });
        newTabs.push(tab);
      }

      const groupToTabIndices = {};
      for (let i = 0; i < windowData.tabs.length; i++) {
        const gid = windowData.tabs[i].group_id;
        if (gid) {
          if (!groupToTabIndices[gid]) groupToTabIndices[gid] = [];
          groupToTabIndices[gid].push(i);
        }
      }

      // recreate groups and map old IDs to new IDs
      for (const [oldGroupId, groupMeta] of Object.entries(windowData.groups ?? {})) {
        const indices = groupToTabIndices[oldGroupId] ?? [];
        if (indices.length === 0) continue;

        const tabIds = indices
          .map(i => newTabs[i]?.id)
          .filter(Boolean)
          .map(Number);              // ← ensure integers

        if (tabIds.length === 0) continue;

        const newGroupId = await chrome.tabs.group({ 
          tabIds, 
          createProperties: { windowId: newWindowId } 
        });

        await chrome.tabGroups.update(newGroupId, {
          title: groupMeta.title,
          color: groupMeta.color,
        });
      }
    }

    if (createdWindowIds.length > 0) {
      showUndoToast(
        `Restored ${createdWindowIds.length} window${createdWindowIds.length === 1 ? "" : "s"}.`,
        () => {
          // Undo just closes whatever's left in the windows restore opened. If
          // the user already closed or navigated a restored tab, there's
          // nothing to reconcile — we simply remove what remains.
          for (const wid of createdWindowIds) chrome.windows.remove(wid).catch(() => {});
        }
      );
    }
  } catch (err) {
    handleError(err);
  } finally {
    btn.disabled = false;
  }
}

async function deleteSession(id, btn) {
  if (!confirm("Delete this session?")) return;
  btn.disabled = true;
  try {
    await api.deleteSession(id);
    // Deleting from search results doesn't get picked up by loadSessions
    // (it only rebuilds session-list/recent-list), so drop the row directly too.
    btn.closest("li.session")?.remove();
    await loadSessions();
  } catch (err) {
    handleError(err);
    btn.disabled = false;
  }
}

// --- per-window picker (shown under "Also capture tabs already open" when
// more than one window is open, so the user chooses which windows a new
// session captures instead of it being all-or-nothing) ---
function faviconEl(tab) {
  if (!tab.favIconUrl) {
    const ph = document.createElement("span");
    ph.className = "fav-placeholder";
    return ph;
  }
  const img = document.createElement("img");
  img.className = "fav";
  img.src = tab.favIconUrl;
  img.alt = "";
  img.addEventListener("error", () => {
    const ph = document.createElement("span");
    ph.className = "fav-placeholder";
    img.replaceWith(ph);
  });
  return img;
}

function checkIconSvg() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "check-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "3");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  poly.setAttribute("points", "4 12 9 17 20 6");
  svg.appendChild(poly);
  return svg;
}

// wpWindows/wpSelected reflect the last render; empty wpWindows means the
// picker isn't showing (single window, or the checkbox is off) — in which
// case getSelectedWindowIds() returns null and every open window is captured.
let wpWindows = [];
let wpSelected = new Set();

async function renderWindowPicker() {
  windowPicker.innerHTML = "";
  windowPicker.classList.remove("open");
  wpWindows = [];
  wpSelected = new Set();
  if (!includeOpen.checked) return;

  const [wins, current] = await Promise.all([
    chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }),
    chrome.windows.getCurrent(),
  ]);
  if (wins.length <= 1) return; // nothing to choose between — checkbox alone is enough

  wpWindows = wins;
  wpSelected = new Set(wins.map((w) => w.id));

  const toolbar = document.createElement("div");
  toolbar.className = "wp-toolbar";
  const countEl = document.createElement("span");
  countEl.className = "wp-count";
  const selectAllBtn = document.createElement("button");
  selectAllBtn.type = "button";
  selectAllBtn.className = "link";
  toolbar.append(countEl, selectAllBtn);

  const list = document.createElement("ul");
  list.className = "wp-list";

  const updateCount = () => {
    countEl.innerHTML = "";
    const selB = document.createElement("b");
    selB.textContent = String(wpSelected.size);
    const totalB = document.createElement("b");
    totalB.textContent = String(wins.length);
    countEl.append(selB, " of ", totalB, ` open window${wins.length === 1 ? "" : "s"} selected`);
    selectAllBtn.textContent = wpSelected.size === wins.length ? "Select none" : "Select all";
  };

  selectAllBtn.addEventListener("click", () => {
    wpSelected = wpSelected.size === wins.length ? new Set() : new Set(wins.map((w) => w.id));
    for (const row of list.children) {
      const checked = wpSelected.has(Number(row.dataset.id));
      row.classList.toggle("unchecked", !checked);
      row.querySelector('input[type="checkbox"]').checked = checked;
    }
    updateCount();
  });

  for (const w of wins) {
    const trackableTabs = (w.tabs || []).filter((t) => isTrackableUrl(t.url));
    const anchorTab = trackableTabs.find((t) => t.active) || trackableTabs[0];

    const row = document.createElement("li");
    row.className = "wp-row";
    row.dataset.id = w.id;

    const main = document.createElement("div");
    main.className = "wp-row-main";

    const cbWrap = document.createElement("span");
    cbWrap.className = "checkbox small";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.setAttribute("aria-label", `Include this window (${trackableTabs.length} tabs)`);
    cbWrap.append(cb, checkIconSvg());

    const text = document.createElement("div");
    text.className = "wp-text";

    const labelLine = document.createElement("div");
    labelLine.className = "wp-label-line";
    const label = document.createElement("span");
    label.className = "wp-label";
    label.textContent = anchorTab ? anchorTab.title || anchorTab.url : "Empty window";
    labelLine.appendChild(label);
    if (w.id === current.id) {
      const tag = document.createElement("span");
      tag.className = "wp-tag";
      tag.textContent = "This window";
      labelLine.appendChild(tag);
    }
    const countPill = document.createElement("span");
    countPill.className = "wp-count-pill";
    countPill.textContent = `${trackableTabs.length} tab${trackableTabs.length === 1 ? "" : "s"}`;
    labelLine.appendChild(countPill);

    const favRow = document.createElement("div");
    favRow.className = "wp-favicons";
    trackableTabs.slice(0, 5).forEach((t) => favRow.appendChild(faviconEl(t)));
    if (trackableTabs.length > 5) {
      const more = document.createElement("span");
      more.className = "fav-more";
      more.textContent = `+${trackableTabs.length - 5} more`;
      favRow.appendChild(more);
    }

    text.append(labelLine, favRow);

    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "wp-expand-btn";
    expandBtn.setAttribute("aria-label", "Show tabs in this window");
    expandBtn.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';

    main.append(cbWrap, text, expandBtn);
    row.appendChild(main);

    const tabsList = document.createElement("ul");
    tabsList.className = "wp-tabs";
    trackableTabs.forEach((t) => {
      const li = document.createElement("li");
      const tt = document.createElement("span");
      tt.className = "tt";
      tt.textContent = t.title || t.url;
      li.append(faviconEl(t), tt);
      tabsList.appendChild(li);
    });
    row.appendChild(tabsList);

    cb.addEventListener("change", () => {
      if (cb.checked) wpSelected.add(w.id);
      else wpSelected.delete(w.id);
      row.classList.toggle("unchecked", !cb.checked);
      updateCount();
    });
    main.addEventListener("click", (e) => {
      if (e.target === cb || e.target.closest(".checkbox")) return;
      if (e.target.closest(".wp-expand-btn")) {
        row.classList.toggle("expanded");
        return;
      }
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change"));
    });

    list.appendChild(row);
  }

  updateCount();
  windowPicker.append(toolbar, list);
  windowPicker.classList.add("open");
}

// null means "picker wasn't shown" — background.js treats that as capture every window.
function getSelectedWindowIds() {
  if (wpWindows.length === 0) return null;
  return Array.from(wpSelected);
}

async function handleStart(e) {
  e.preventDefault();
  clearStatus();
  const intent = intentInput.value.trim();
  if (!intent) {
    showStatus("Describe what you're working on to start a session.");
    return;
  }
  startBtn.disabled = true;
  try {
    const captureExisting = includeOpen.checked;
    const windowIds = captureExisting ? getSelectedWindowIds() : null;
    // Remember this choice for the next session.
    await chrome.storage.local.set({ capture_existing_pref: captureExisting });
    const res = await chrome.runtime.sendMessage({
      type: "START_SESSION",
      intent,
      captureExisting,
      windowIds,
    });
    if (res?.code === "SESSION_ACTIVE") {
      // A session is still running — the user decides its fate before the
      // new one starts. Keep the typed intent around until they do.
      showConflictPrompt(res.intent, { intent, captureExisting, windowIds });
      return;
    }
    intentInput.value = "";
    clearIntentDraft();
    await refreshSessionUI();
  } catch (err) {
    showStatus(err.message);
  } finally {
    startBtn.disabled = false;
  }
}

// --- session conflict (start requested while another session is running) ---
// The background worker refuses to overwrite a running session; it hands back
// SESSION_ACTIVE and we ask the user to save or discard the old one first.
let pendingStart = null; // { intent, captureExisting } waiting on the choice

function showConflictPrompt(runningIntent, pending) {
  pendingStart = pending;
  conflictText.textContent =
    `"${runningIntent || "Untitled session"}" is still running. Save it or discard it before starting the new session?`;
  conflictPrompt.classList.remove("hidden");
}

function hideConflictPrompt() {
  pendingStart = null;
  conflictPrompt.classList.add("hidden");
}

async function resolveConflict(onConflict) {
  if (!pendingStart) return;
  const pending = pendingStart;
  conflictSave.disabled = conflictDiscard.disabled = true;
  try {
    let vector = null;
    if (onConflict === "save") {
      showStatus("Saving previous session...", "success");
      vector = await computeSessionVector();
    }
    const res = await chrome.runtime.sendMessage({
      type: "START_SESSION",
      ...pending,
      onConflict,
      vector,
    });
    if (!res?.ok) throw new Error("Couldn't start the new session. Please try again.");
    hideConflictPrompt();
    intentInput.value = "";
    clearIntentDraft();
    showStatus(
      onConflict === "save"
        ? "Previous session saved. New session started."
        : "Previous session discarded. New session started.",
      "success"
    );
    await refreshSessionUI();
    await loadSessions();
  } catch (err) {
    showStatus(err.message);
  } finally {
    conflictSave.disabled = conflictDiscard.disabled = false;
  }
}

// Embed the running session's content so it's searchable once saved.
// Returns null when there's nothing to embed or embedding fails (non-fatal).
async function computeSessionVector() {
  const { payload } = await chrome.runtime.sendMessage({ type: "GET_SESSION_DATA" });
  if (!payload) return null;
  try {
    const embedText = buildEmbedText(payload);
    return await embed(embedText);
  } catch (_) {
    return null;
  }
}

async function handleStop() {
  clearStatus();
  stopBtn.disabled = true;
  try {
    // Compute the embedding BEFORE stopping, then stop with it.
    showStatus("Saving session...", "success");
    const vector = await computeSessionVector();
    await chrome.runtime.sendMessage({ type: "STOP_SESSION", vector });
    showStatus("Session saved.", "success");
    await refreshSessionUI();
    await loadSessions();
  } catch (err) {
    showStatus(err.message);
  } finally {
    stopBtn.disabled = false;
  }
}

async function handleAuth(e) {
  e.preventDefault();
  clearStatus();
  authSubmit.disabled = true;
  try {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const res =
      authMode === "signup"
        ? await api.signUp(nameInput.value.trim(), email, password)
        : await api.signIn(email, password);

    await setTokens(res);
    if (!res.enc_salt) {
      showStatus("Encryption is not working at the moment. Please, contact admin.");
      return;
    }
    await deriveAndStoreKey(password, res.enc_salt);
    await setTokens(res);
    authForm.reset();
    clearAuthDraft();
    showMainView();
    await refreshSessionUI();
    await loadSessions();
  } catch (err) {
    showStatus(err.message);
  } finally {
    authSubmit.disabled = false;
  }
}

async function handleSignout() {
  // Revoke the refresh token server-side first (needs the token still in storage).
  await api.logout();
  // Stop any active tracking, then wipe ALL local state (drafts, prefs, tokens).
  try {
    await chrome.runtime.sendMessage({ type: "ABORT_SESSION" });
  } catch (_) {}
  await clearKey();
  _previewCache.clear();
  await chrome.storage.session.remove(PREVIEW_CACHE_STORAGE_KEY);
  // Wipe all local state, but keep the onboarding flag — signing out must not
  // re-onboard a returning user.
  const { [ONBOARDED_KEY]: hasOnboarded } = await chrome.storage.local.get(ONBOARDED_KEY);
  await chrome.storage.local.clear();
  if (hasOnboarded) await chrome.storage.local.set({ [ONBOARDED_KEY]: true });
  // Clear the visible fields and the rendered session list so the next person
  // doesn't see the previous user's data (it stays safe in their account).
  authForm.reset();
  intentInput.value = "";
  sessionList.innerHTML = "";
  recentList.innerHTML = "";
  seeAllBtn.classList.add("hidden");
  emptyState.classList.add("hidden");
  resetSearch();
  clearStatus();
  setAuthMode("signin");
  showAuthView();
}

// --- search ---
function showSessionsSection() {
  sessionList.classList.remove("hidden");
  searchResults.classList.add("hidden");
  searchResults.innerHTML = "";
  noResults.classList.add("hidden");
  resultsHeading.classList.add("hidden");
  resultsHeading.textContent = "";
}

function showSearchSection() {
  sessionList.classList.add("hidden");
}

function resetSearch() {
  searchInput.value = "";
  showSessionsSection();
}

// Dedups by _id (a session matching both engines renders once, in the
// keyword/highlighted shape), renders keyword rows first then semantic-only
// rows after, and shows one combined overflow line sourced only from the
// keyword side (semantic has no "N more" concept of its own).
function renderSearchResults(keywordResult, semanticSessions, query) {
  searchResults.innerHTML = "";
  noResults.classList.add("hidden");
  resultsHeading.classList.add("hidden");

  const matchedIds = new Set(keywordResult.results.map((m) => m.session._id));
  const semanticOnly = semanticSessions.filter((s) => !matchedIds.has(s._id));

  const total = keywordResult.results.length + semanticOnly.length;
  if (total === 0) {
    searchResults.classList.add("hidden");
    noResults.classList.remove("hidden");
    return;
  }

  searchResults.classList.remove("hidden");
  resultsHeading.textContent = `Sessions · ${total}`;
  resultsHeading.classList.remove("hidden");

  for (const match of keywordResult.results) searchResults.append(buildKeywordSessionRow(match, query));
  for (const s of semanticOnly) searchResults.append(buildSemanticOnlyRow(s));

  if (keywordResult.overflowSessionCount > 0) {
    const note = document.createElement("p");
    note.className = "search-overflow-note";
    note.textContent = `${keywordResult.overflowSessionCount} more matched. Keep typing to narrow it down.`;
    searchResults.append(note);
  }
}

let _searchDebounce = null;

async function handleSearch() {
  const query = searchInput.value.trim();
  if (query.length < MIN_QUERY_LENGTH) {
    showSessionsSection();
    return;
  }

  showSearchSection();
  searchSpinner.classList.remove("hidden");
  try {
    // Both engines always run in parallel; one failing shouldn't block the
    // other. Only render once BOTH settle — semantic-only cards rely on
    // ensureAllSessionsDecrypted() (the keyword branch) having already warmed
    // _previewCache with that session's real decrypted payload, so their
    // preview chevron works without a separate fetch/decrypt.
    const [keywordSettled, semanticSettled] = await Promise.allSettled([
      (async () => {
        const entries = await ensureAllSessionsDecrypted();
        return keywordSearchSessions(query, entries);
      })(),
      (async () => {
        const vector = await embed(query);
        const { data } = await api.searchSessions(vector);
        return data || [];
      })(),
    ]);

    if (keywordSettled.status === "rejected" && semanticSettled.status === "rejected") {
      const authError = [keywordSettled.reason, semanticSettled.reason].find(
        (err) => err instanceof SessionExpiredError || err?.name === "SessionExpiredError"
      );
      if (authError) {
        handleError(authError);
        return;
      }
    }

    const keywordResult = keywordSettled.status === "fulfilled"
      ? keywordSettled.value
      : { results: [], overflowSessionCount: 0 };
    const semanticSessions = semanticSettled.status === "fulfilled" ? semanticSettled.value : [];

    renderSearchResults(keywordResult, semanticSessions, query);
  } finally {
    searchSpinner.classList.add("hidden");
  }
}

// --- wire up ---
tabSignin.addEventListener("click", () => setAuthMode("signin"));
tabSignup.addEventListener("click", () => setAuthMode("signup"));
authForm.addEventListener("submit", handleAuth);
startForm.addEventListener("submit", handleStart);
includeOpen.addEventListener("change", renderWindowPicker);
stopBtn.addEventListener("click", handleStop);
// While a session runs the start form is hidden; "New session" reveals it so
// submitting can trigger the save/discard conflict flow.
newSessionBtn.addEventListener("click", () => {
  startForm.classList.remove("hidden");
  intentInput.focus();
});
conflictSave.addEventListener("click", () => resolveConflict("save"));
conflictDiscard.addEventListener("click", () => resolveConflict("discard"));
conflictCancel.addEventListener("click", () => {
  hideConflictPrompt();
  startForm.classList.add("hidden"); // back to just the active card
});
signoutBtn.addEventListener("click", handleSignout);
historyBtn.addEventListener("click", showHistoryScreen);
historyBackBtn.addEventListener("click", showHomeScreen);
seeAllBtn.addEventListener("click", showHistoryScreen);


searchInput.addEventListener("input", () => {
  clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(handleSearch, 300);
});
searchInput.addEventListener("search", () => {
  // fires when the native clear (×) button is clicked
  clearTimeout(_searchDebounce);
  handleSearch();
});

// Persist drafts as the user types (password is intentionally excluded).
emailInput.addEventListener("input", saveAuthDraft);
nameInput.addEventListener("input", saveAuthDraft);
intentInput.addEventListener("input", saveIntentDraft);

window.addEventListener("focus", async () => {   // ← add this
  const { access_token } = await getTokens();
  if (access_token) {
    await loadSessions();
    await refreshSessionUI();
  }
});


// --- init ---
(async function init() {
  setAuthMode("signin");
  await loadAuthDraft();
  const { access_token } = await getTokens();
  if (access_token) {
    const key = await loadKey();
    if (key) {
      // Signed in and able to decrypt — go straight to sessions, even if the
      // onboarding tab was closed early.
      await hydratePreviewCache();
      showMainView();
      await refreshSessionUI();
      await loadSessions();
      return;
    }
    // key gone, need the password again — fall through to auth/nudge
  }

  const { [ONBOARDED_KEY]: hasOnboarded } = await chrome.storage.local.get(ONBOARDED_KEY);
  if (hasOnboarded) {
    showAuthView();
  } else {
    showSetupNudge();
  }
})();
