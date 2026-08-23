import { api } from "./api.js";
import { loadKey, encrypt, hashPayload } from "./crypto.js";

// MV3 service workers are killed when idle and restarted on events, so NOTHING
// can live in module-scope variables between events. The whole session state
// lives in chrome.storage.local and is read/written on every event.

// First install opens the onboarding tab (story → privacy → account → first
// session). Updates and browser restarts must not re-trigger it.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html") });
  }
});

const STATE_KEY = "active_session";
const ALARM = "monitar-autosave";
const SAVE_INTERVAL_MINUTES = 1; // chrome.alarms practical floor; bump as needed

// --- state helpers ---
async function getState() {
  const { [STATE_KEY]: s } = await chrome.storage.local.get(STATE_KEY);
  return s || null;
}
async function setState(s) {
  await chrome.storage.local.set({ [STATE_KEY]: s });
}
async function clearState() {
  await chrome.storage.local.remove(STATE_KEY);
}

const isTrackable = (url) => !!url && /^https?:/i.test(url);
const nowMs = () => Date.now();
const nowIso = () => new Date().toISOString();

function newTabRecord(url, title, timeSincePrevMs, windowId, groupId) {
  return {
    url,
    title: title || url,
    opened_at: nowIso(),
    time_spent: 0, // seconds, accumulated as the tab stays active
    time_since_prev: Math.max(0, Math.round((timeSincePrevMs ?? 0) / 1000)),
    is_last_opened: true,
    fetched: false,
    page_snippet: null,
    window_id: windowId ?? null,
    group_id: groupId === -1 ? null : (groupId ?? null),
  };
}

// Add elapsed time to the currently-active tab, then reset the clock.
function bankActiveTime(s, atMs) {
  if (s.activeTabId != null && s.activeSince != null) {
    const t = s.tabs[s.activeTabId];
    if (t) t.time_spent += Math.max(0, Math.round((atMs - s.activeSince) / 1000));
  }
  s.activeSince = atMs;
}

// Strip internal bookkeeping and shape the state into a Session payload.
function toPayload(s) {
  const windows = {};

  for (const tab of Object.values(s.tabs)) {
    const wid = tab.window_id ?? "default";
    if (!windows[wid]) windows[wid] = { tabs: [], groups: {} };
    windows[wid].tabs.push(tab);
  }

  for (const [groupId, group] of Object.entries(s.groups ?? {})) {
    const wid = group.window_id ?? "default";
    if (windows[wid]) {
      windows[wid].groups[groupId] = { title: group.title, color: group.color };
    }
  }
  
  return {
    intent: s.intent,
    started_at: s.started_at,
    stopped_at: nowIso(),
    windows,
  };
}

// --- session lifecycle ---
// captureExisting: when true, seed the session with tabs already open; when
// false, start empty and only capture tabs opened/navigated after start.
// (With captureExisting=false, navigating a pre-existing tab to a new URL still
// counts as new — onUpdated adds it. That's intended.)
async function startSession(intent, captureExisting, windowIds) {
  const tabs = {};
  const groups = {};
  let activeTabId = null;

  if (captureExisting) {
    const inScope = (windowId) => windowIds == null || windowIds.includes(windowId);

    const allTabs = await chrome.tabs.query({}); // all windows
    for (const t of allTabs) {
      if (isTrackable(t.url) && inScope(t.windowId)) {
        const rec = newTabRecord(t.url, t.title, 0, t.windowId, t.groupId);
        rec.is_last_opened = false;
        tabs[t.id] = rec;
      }
    }

    const allGroups = await chrome.tabGroups.query({});
    for (const g of allGroups) {
      if (!inScope(g.windowId)) continue;
      groups[g.id] = {
        title: g.title,
        color: g.color,
        window_id: g.windowId,
      };
    }

    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active && tabs[active.id]) activeTabId = active.id;
  }

  const s = {
    intent: intent || "Untitled session",
    started_at: nowIso(),
    backend_id: null,
    tabs,
    groups,
    lastHash: null,
    lastFlushAt: null,
    activeTabId,
    activeSince: nowMs(),
    lastOpenedAt: nowMs(),
  };

  await setState(s);
  await chrome.alarms.create(ALARM, { periodInMinutes: SAVE_INTERVAL_MINUTES });
}

// Push current state to the backend: first flush creates (POST), later flushes
// update the same session (PUT). Returns true on success.
async function flush(vector = null) {
  console.log("[monitar] flush called with vector:", vector ? `${vector.length} dims` : "null");
  
  const s = await getState();
  if (!s) return false;

  bankActiveTime(s, nowMs());
  const payload = toPayload(s);

  const allTabs = Object.values(payload.windows).flatMap(w => w.tabs);
  if (allTabs.length === 0) {
    await setState(s);
    return true;
  }

  const hash = await hashPayload(payload);
  if (hash === s.lastHash) {
    await setState(s);
    return true;
  }

  const key = await loadKey();
  if (!key) {
    console.warn("[monitar] no encryption key available, skipping flush");
    return false;
  }

  const content_encrypted = await encrypt(key, payload);

  const envelope = {
    content_encrypted,
    intent: payload.intent,
    tab_count: allTabs.length,
    window_count: Object.keys(payload.windows).length,
    started_at: payload.started_at,
    content_hash: hash,
    ...(vector ? { embedding: vector } : {}),
  };

  try {
    if (!s.backend_id) {
      const res = await api.storeSession(envelope);
      s.backend_id = res.id;
    } else {
      await api.updateSession(s.backend_id, envelope);
    }

    s.lastHash = hash;
    s.lastFlushAt = nowIso();
    await setState(s);
    return true;
  } catch (e) {
    console.error("[monitar] flush failed:", e.message);
    await setState(s);
    return false;
  }
}

async function stopSession(vector = null) {
  await flush(vector);
  await chrome.alarms.clear(ALARM);
  await clearState();
}

// Discard the in-progress session without flushing.
async function abortSession() {
  await chrome.alarms.clear(ALARM);
  await clearState();
}

// --- tab event listeners (only act while a session is active) ---
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url && !changeInfo.title && changeInfo.status !== "complete") return;
  const s = await getState();
  if (!s) return;
  if (!isTrackable(tab.url)) return;

  const existing = s.tabs[tabId];
  if (!existing) {
    // A newly navigated tab joins the session.
    for (const id in s.tabs) s.tabs[id].is_last_opened = false;
    
    s.tabs[tabId] = newTabRecord(
      tab.url, 
      tab.title, 
      nowMs() - s.lastOpenedAt,
      tab.windowId,
      tab.groupId
    );
    s.lastOpenedAt = nowMs();
  } else {
    // Navigation within an existing tab — keep timing, refresh url/title.
    existing.url = tab.url;
    existing.title = tab.title || existing.title;
    existing.window_id = tab.windowId;                            
    existing.group_id = tab.groupId === -1 ? null : tab.groupId; 

  }
  await setState(s);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const s = await getState();
  if (!s) return;
  bankActiveTime(s, nowMs());
  s.activeTabId = tabId;
  s.activeSince = nowMs();
  await setState(s);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getState();
  if (!s) return;
  if (s.activeTabId === tabId) {
    bankActiveTime(s, nowMs());
    s.activeTabId = null;
  }
  await setState(s); // keep the closed tab's record in the session
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) flush();
});

// --- popup <-> worker messaging ---
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === "START_SESSION") {
      // Never clobber a running session: without an explicit resolution the
      // caller gets a conflict back and must ask the user what to do.
      const existing = await getState();
      if (existing && !msg.onConflict) {
        sendResponse({ ok: false, code: "SESSION_ACTIVE", intent: existing.intent });
      } else {
        if (existing) {
          if (msg.onConflict === "save") await stopSession(msg.vector ?? null);
          else await abortSession();
        }
        await startSession(msg.intent, msg.captureExisting, msg.windowIds);
        sendResponse({ ok: true });
      }
    } else if (msg.type === "GET_SESSION_DATA") {
      const s = await getState();
      if (!s) {
        sendResponse({ payload: null });
      } else {
        bankActiveTime(s, nowMs());
        await setState(s);
        sendResponse({ payload: toPayload(s) });
      }
    } else if (msg.type === "STOP_SESSION") {
      await stopSession(msg.vector ?? null);
      sendResponse({ ok: true });
    } else if (msg.type === "ABORT_SESSION") {
      // Used on sign-out, when there's no longer a valid token to save with.
      await abortSession();
      sendResponse({ ok: true });
    } else if (msg.type === "GET_STATUS") {
      const s = await getState();
      sendResponse({
        active: !!s,
        intent: s?.intent ?? null,
        started_at: s?.started_at ?? null,
        tabCount: s ? Object.keys(s.tabs).length : 0,
        lastFlushAt: s?.lastFlushAt ?? null,
      });
    }
  })();
  return true; // keep the message channel open for the async response
});
