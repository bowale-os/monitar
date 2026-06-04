import { api, getTokens, setTokens, SessionExpiredError } from "./api.js";

// --- element refs ---
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
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString();
}

// The popup is destroyed every time it closes, so typed text is lost. Persist
// the non-sensitive auth fields (email + name) as a draft and restore them on
// reopen. The password is deliberately never stored.
const AUTH_DRAFT_KEY = "auth_draft";

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

// --- views ---
function showAuthView() {
  authView.classList.remove("hidden");
  mainView.classList.add("hidden");
  signoutBtn.classList.add("hidden");
}

function showMainView() {
  authView.classList.add("hidden");
  mainView.classList.remove("hidden");
  signoutBtn.classList.remove("hidden");
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
    const count = Array.isArray(s.tabs) ? s.tabs.length : 0;

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
    const urls = (data.tabs || []).map((t) => t.url).filter(Boolean);
    if (urls.length === 0) {
      showStatus("This session has no restorable tabs.");
      return;
    }
    await chrome.windows.create({ url: urls });
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
  try {
    await chrome.runtime.sendMessage({ type: "STOP_SESSION" });
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
  await chrome.storage.local.clear();
  // Clear the visible fields too, since the popup stays open after sign-out.
  authForm.reset();
  intentInput.value = "";
  clearStatus();
  setAuthMode("signin");
  showAuthView();
}

// --- wire up ---
tabSignin.addEventListener("click", () => setAuthMode("signin"));
tabSignup.addEventListener("click", () => setAuthMode("signup"));
authForm.addEventListener("submit", handleAuth);
startForm.addEventListener("submit", handleStart);
stopBtn.addEventListener("click", handleStop);
signoutBtn.addEventListener("click", handleSignout);

// Persist drafts as the user types (password is intentionally excluded).
emailInput.addEventListener("input", saveAuthDraft);
nameInput.addEventListener("input", saveAuthDraft);
intentInput.addEventListener("input", saveIntentDraft);

// --- init ---
(async function init() {
  setAuthMode("signin");
  await loadAuthDraft();
  const { access_token } = await getTokens();
  if (access_token) {
    showMainView();
    await refreshSessionUI();
    await loadSessions();
  } else {
    showAuthView();
  }
})();
