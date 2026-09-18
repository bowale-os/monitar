// Pure, DOM-free, chrome-free helpers extracted from popup.js so they can be
// unit-tested (see frontend/tests/helpers.test.js). Keep this file free of side
// effects and browser globals — anything that touches `document`, `chrome`, or
// `Worker` belongs in popup.js, not here.
//
// This file is duplicated verbatim in uploadzip/extension/helpers.js; the test
// suite asserts the two copies stay identical.

export const JUNK_TITLES = new Set([
  "new tab",
  "loading...",
  "404 not found",
  "untitled",
  "about:blank",
]);

export function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; }
}

// Mirrors isTrackable() in background.js — tabs that won't end up in a session
// (chrome://, extension pages, etc.) shouldn't be counted or shown in the picker.
export function isTrackableUrl(url) {
  return !!url && /^https?:/i.test(url);
}

export function buildEmbedText(payload) {
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

export function parseDate(iso) {
  if (!iso) return null;
  const d = new Date(iso.replace("+00:00", "Z"));
  return isNaN(d) ? null : d;
}

function formatTime(d) {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Relative, scannable dates for session cards: "Today 2:14 PM", "Yesterday",
// "3 days ago", then "Jun 12" (with the year once it's not this year).
export function formatRelativeDate(iso) {
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
export function formatSince(iso) {
  const d = parseDate(iso);
  if (!d) return "";
  const rel = formatRelativeDate(iso);
  return rel.startsWith("Today ") ? rel.slice(6) : rel;
}

// started_at can be null on older sessions, so fall back to created_at. Returns
// a millisecond timestamp (0 when neither parses), suitable for sort compares.
export function sessionRecency(session) {
  return parseDate(session?.started_at ?? session?.created_at)?.getTime() ?? 0;
}

// Newest-first. GET / has no sort clause server-side, so recency order isn't
// guaranteed and must be applied by any caller that shows sessions in order.
export function sortSessionsByRecency(sessions) {
  return [...(sessions ?? [])].sort((a, b) => sessionRecency(b) - sessionRecency(a));
}

// --- highlighting (escape-then-wrap; never escape first and search inside
// the escaped string, offsets from the raw string won't line up) ---
export function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function highlightMatch(text, query) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);
  return `${escapeHtml(before)}<mark class="hl">${escapeHtml(match)}</mark>${escapeHtml(after)}`;
}

// --- keyword search (client-side, over decrypted content) ---
export const MIN_QUERY_LENGTH = 2;
export const KEYWORD_SESSIONS_CAP = 5;
export const KEYWORD_TABS_PER_SESSION_CAP = 3;

// Plain case-insensitive substring match over tab title/url and group title.
// `entries` is [{ session, payload }], already sorted newest-first by the caller.
export function keywordSearchSessions(query, entries) {
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
