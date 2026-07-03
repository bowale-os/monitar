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
        modelStatus.textContent = "Preparing smart search for first use…";
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

function buildEmbedText(payload) {
  const JUNK = new Set(["new tab", "loading...", "404 not found", "untitled", "about:blank"]);

  const allTabs = Object.values(payload.windows ?? {}).flatMap(w => w.tabs ?? []);

  const groupNames = Object.values(payload.windows ?? {})
    .flatMap(w => Object.values(w.groups ?? {}).map(g => g.title).filter(Boolean));

  const domains = [...new Set(
    allTabs.map(t => { try { return new URL(t.url).hostname.replace(/^www\./, ""); } catch { return null; } })
      .filter(Boolean)
  )];

  const titles = allTabs
    .map(t => (t.title || "").trim())
    .filter(t => t && !JUNK.has(t.toLowerCase()));

  const parts = [
    `Intent: ${payload.intent || "Untitled"}.`,
    groupNames.length ? `Topics: ${groupNames.join(", ")}.` : "",
    domains.length ? `Sites: ${domains.join(", ")}.` : "",
    titles.length ? `Pages: ${titles.join("; ")}.` : "",
  ].filter(Boolean).join(" ");

  return parts.slice(0, 1000);
}

// --- element refs ---
const onboardingView = document.getElementById("onboarding-view");
const obSteps = [...document.querySelectorAll(".ob-step")];
const obDots = [...document.querySelectorAll(".ob-dot")];
const obBackBtn = document.getElementById("ob-back-btn");
const obNextBtn = document.getElementById("ob-next-btn");

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
const activePanel = document.getElementById("active-panel");
const activeIntent = document.getElementById("active-intent");
const activeMeta = document.getElementById("active-meta");
const stopBtn = document.getElementById("stop-btn");
const sessionList = document.getElementById("session-list");
const emptyState = document.getElementById("empty-state");
const sessionsSection = document.getElementById("sessions-section");

const searchInput = document.getElementById("search-input");
const searchSpinner = document.getElementById("search-spinner");
const searchResults = document.getElementById("search-results");
const noResults = document.getElementById("no-results");
const modelStatus = document.getElementById("model-status");

const statusEl = document.getElementById("status");

let authMode = "signin"; // "signin" | "signup"

// --- helpers ---
function showStatus(message, kind = "error") {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`;
  statusEl.classList.remove("hidden");
}

function clearStatus() {
  statusEl.classList.add("hidden");
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

function formatDate(iso) {
  if (!iso) return "";                        // ← add this
  const normalized = iso.replace("+00:00", "Z");
  const d = new Date(normalized);
  if (isNaN(d)) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
  if (status?.active) {
    startForm.classList.add("hidden");
    activePanel.classList.remove("hidden");
    activeIntent.textContent = status.intent || "Untitled session";
    activeMeta.textContent =
      `Tracking · ${status.tabCount} tab${status.tabCount === 1 ? "" : "s"} · since ${formatDate(status.started_at)}`;
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
    // Restore a half-typed intent from a previous (possibly accidental) close.
    await loadIntentDraft();
  }

}

// --- onboarding ---
const ONBOARDED_KEY = "has_onboarded";
let obIndex = 0;

function showOnboardingStep(index) {
  obSteps.forEach((step, i) => step.classList.toggle("hidden", i !== index));
  obDots.forEach((dot, i) => dot.classList.toggle("active", i === index));
  obBackBtn.classList.toggle("hidden", index === 0);
  obNextBtn.textContent = index === obSteps.length - 1 ? "Start my first session" : "Next";
  obIndex = index;
}

function showOnboardingView() {
  onboardingView.classList.remove("hidden");
  authView.classList.add("hidden");
  mainView.classList.add("hidden");
  signoutBtn.classList.add("hidden");
  showOnboardingStep(0);
}

async function finishOnboarding() {
  await chrome.storage.local.set({ [ONBOARDED_KEY]: true });
  onboardingView.classList.add("hidden");
  showAuthView();
}

obBackBtn.addEventListener("click", () => {
  if (obIndex > 0) showOnboardingStep(obIndex - 1);
});
obNextBtn.addEventListener("click", () => {
  if (obIndex < obSteps.length - 1) {
    showOnboardingStep(obIndex + 1);
  } else {
    finishOnboarding();
  }
});

// --- views ---
function showAuthView() {
  onboardingView.classList.add("hidden");
  authView.classList.remove("hidden");
  mainView.classList.add("hidden");
  signoutBtn.classList.add("hidden");
}

function showMainView() {
  authView.classList.add("hidden");
  mainView.classList.remove("hidden");
  signoutBtn.classList.remove("hidden");
  // Start the worker now so the model downloads in the background while the
  // user looks at their sessions — by first search it should already be ready.
  getWorker();
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

function renderSessions(sessions) {
  sessionList.innerHTML = "";
  emptyState.classList.toggle("hidden", sessions.length > 0);

  for (const s of sessions) {
    const count = s.tab_count ?? 0;

    const li = document.createElement("li");
    li.className = "session";

    const info = document.createElement("div");
    info.className = "session-info";
    const title = document.createElement("div");
    title.className = "session-title";
    title.textContent = s.intent || "Untitled session";
    const meta = document.createElement("div");
    meta.className = "session-meta";
    meta.textContent = `${count} tab${count === 1 ? "" : "s"} · ${formatDate(s.started_at)}`;
    info.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "session-actions";

    const restoreBtn = document.createElement("button");
    restoreBtn.className = "restore-btn";
    restoreBtn.textContent = "Restore";
    restoreBtn.addEventListener("click", () => restoreSession(s._id, restoreBtn));

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-btn";
    deleteBtn.textContent = "Delete";
    deleteBtn.title = "Delete session";
    deleteBtn.addEventListener("click", () => deleteSession(s._id, deleteBtn));

    actions.append(restoreBtn, deleteBtn);
    li.append(info, actions);
    sessionList.append(li);
  }
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

    for (const [, windowData] of Object.entries(payload.windows)) {
      const urls = windowData.tabs.map(t => t.url).filter(Boolean);
      if (urls.length === 0) continue;

      // create window with first tab
      const newWindow = await chrome.windows.create({ url: urls[0] });
      const newWindowId = newWindow.id;

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
    await loadSessions();
  } catch (err) {
    handleError(err);
    btn.disabled = false;
  }
}

async function handleStart(e) {
  e.preventDefault();
  clearStatus();
  startBtn.disabled = true;
  try {
    const captureExisting = includeOpen.checked;
    // Remember this choice for the next session.
    await chrome.storage.local.set({ capture_existing_pref: captureExisting });
    await chrome.runtime.sendMessage({
      type: "START_SESSION",
      intent: intentInput.value.trim(),
      captureExisting,
    });
    intentInput.value = "";
    clearIntentDraft();
    await refreshSessionUI();
  } catch (err) {
    showStatus(err.message);
  } finally {
    startBtn.disabled = false;
  }
}

async function handleStop() {
  clearStatus();
  stopBtn.disabled = true;
  let vector = null;
  try {
    // 1. get data BEFORE stopping
    const { payload } = await chrome.runtime.sendMessage({ type: "GET_SESSION_DATA" });
    if (payload) {
      try {
        showStatus("Saving session...", "success");
        const embedText = buildEmbedText(payload);
        console.log("embed text:", embedText);
        vector = await embed(embedText);
        console.log("vector length:", vector?.length, "first value:", vector?.[0]);
      } catch (_) {
        // embedding failure is non-fatal
      }
    }
    // 2. stop with vector
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
  await chrome.storage.local.clear();
  // Clear the visible fields and the rendered session list so the next person
  // doesn't see the previous user's data (it stays safe in their account).
  authForm.reset();
  intentInput.value = "";
  sessionList.innerHTML = "";
  emptyState.classList.add("hidden");
  clearStatus();
  setAuthMode("signin");
  showAuthView();
}

// --- search ---
function showSessionsSection() {
  sessionsSection.classList.remove("hidden");
  searchResults.classList.add("hidden");
  searchResults.innerHTML = "";
  noResults.classList.add("hidden");
}

function showSearchSection() {
  sessionsSection.classList.add("hidden");
}

function renderSearchResults(sessions) {
  searchResults.innerHTML = "";
  noResults.classList.add("hidden");

  if (sessions.length === 0) {
    searchResults.classList.add("hidden");
    noResults.classList.remove("hidden");
    return;
  }

  searchResults.classList.remove("hidden");
  for (const s of sessions) {
    const count = s.tab_count ?? 0;
    const li = document.createElement("li");
    li.className = "session";

    const info = document.createElement("div");
    info.className = "session-info";
    const title = document.createElement("div");
    title.className = "session-title";
    title.textContent = s.intent || "Untitled session";
    const meta = document.createElement("div");
    meta.className = "session-meta";
    meta.textContent = `${count} tab${count === 1 ? "" : "s"} · ${formatDate(s.started_at)}`;
    info.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "session-actions";
    const restoreBtn = document.createElement("button");
    restoreBtn.className = "restore-btn";
    restoreBtn.textContent = "Restore";
    restoreBtn.addEventListener("click", () => restoreSession(s._id, restoreBtn));
    actions.append(restoreBtn);

    li.append(info, actions);
    searchResults.append(li);
  }
}

let _searchDebounce = null;

async function handleSearch() {
  const query = searchInput.value.trim();
  if (!query) {
    showSessionsSection();
    return;
  }

  showSearchSection();
  searchSpinner.classList.remove("hidden");
  try {
    const vector = await embed(query);
    const { data } = await api.searchSessions(vector);
    renderSearchResults(data || []);
  } catch (err) {
    handleError(err);
  } finally {
    searchSpinner.classList.add("hidden");
  }
}

// --- wire up ---
tabSignin.addEventListener("click", () => setAuthMode("signin"));
tabSignup.addEventListener("click", () => setAuthMode("signup"));
authForm.addEventListener("submit", handleAuth);
startForm.addEventListener("submit", handleStart);
stopBtn.addEventListener("click", handleStop);
signoutBtn.addEventListener("click", handleSignout);


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
  const { [ONBOARDED_KEY]: hasOnboarded } = await chrome.storage.local.get(ONBOARDED_KEY);
  if (!hasOnboarded) {
    showOnboardingView();
    return;
  }

  setAuthMode("signin");
  await loadAuthDraft();
  const { access_token } = await getTokens();
  if (access_token) {
    
    const key = await loadKey();        // ← add this
    if (!key) {                         // ← and this
      showAuthView();                   // key gone, need password again
      return;
    }

    showMainView();
    await refreshSessionUI();
    await loadSessions();
  } else {
    showAuthView();
  }
})();
