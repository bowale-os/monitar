import { describe, it, expect, afterEach, vi } from "vitest";
import {
  JUNK_TITLES,
  hostnameOf,
  isTrackableUrl,
  buildEmbedText,
  parseDate,
  formatRelativeDate,
  formatSince,
  sessionRecency,
  sortSessionsByRecency,
  escapeHtml,
  highlightMatch,
  keywordSearchSessions,
  MIN_QUERY_LENGTH,
  KEYWORD_SESSIONS_CAP,
  KEYWORD_TABS_PER_SESSION_CAP,
} from "../extension/helpers.js";

describe("hostnameOf", () => {
  it("strips a leading www.", () => {
    expect(hostnameOf("https://www.example.com/path?q=1")).toBe("example.com");
  });
  it("keeps non-www subdomains", () => {
    expect(hostnameOf("https://docs.example.com")).toBe("docs.example.com");
  });
  it("returns null for junk input", () => {
    expect(hostnameOf("not a url")).toBeNull();
    expect(hostnameOf("")).toBeNull();
    expect(hostnameOf(undefined)).toBeNull();
  });
});

describe("isTrackableUrl", () => {
  it("accepts http and https", () => {
    expect(isTrackableUrl("http://example.com")).toBe(true);
    expect(isTrackableUrl("https://example.com")).toBe(true);
    expect(isTrackableUrl("HTTPS://EXAMPLE.COM")).toBe(true);
  });
  it("rejects chrome://, extension pages, blanks", () => {
    expect(isTrackableUrl("chrome://extensions")).toBe(false);
    expect(isTrackableUrl("about:blank")).toBe(false);
    expect(isTrackableUrl("")).toBe(false);
    expect(isTrackableUrl(null)).toBe(false);
    expect(isTrackableUrl(undefined)).toBe(false);
  });
});

describe("parseDate", () => {
  it("returns null for falsy input", () => {
    expect(parseDate(null)).toBeNull();
    expect(parseDate("")).toBeNull();
    expect(parseDate(undefined)).toBeNull();
  });
  it("normalises a +00:00 offset to Z", () => {
    const a = parseDate("2026-01-01T12:00:00+00:00");
    const b = new Date("2026-01-01T12:00:00Z");
    expect(a.getTime()).toBe(b.getTime());
  });
  it("returns null for an unparseable string", () => {
    expect(parseDate("banana")).toBeNull();
  });
});

describe("formatRelativeDate / formatSince", () => {
  afterEach(() => vi.useRealTimers());

  it("says Today <time> for the same calendar day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 18, 0, 0));
    expect(formatRelativeDate(new Date(2026, 5, 15, 9, 30, 0).toISOString())).toMatch(/^Today /);
  });

  it("says Yesterday for the previous calendar day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 1, 0, 0));
    expect(formatRelativeDate(new Date(2026, 5, 14, 23, 0, 0).toISOString())).toBe("Yesterday");
  });

  it("says N days ago inside the last week", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
    expect(formatRelativeDate(new Date(2026, 5, 12, 12, 0, 0).toISOString())).toBe("3 days ago");
  });

  it("falls back to a calendar date past a week", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
    const out = formatRelativeDate(new Date(2026, 4, 1, 12, 0, 0).toISOString());
    expect(out).not.toMatch(/Today|Yesterday|days ago/);
  });

  it("returns '' for no date", () => {
    expect(formatRelativeDate(null)).toBe("");
    expect(formatSince(null)).toBe("");
  });

  it("formatSince drops the 'Today ' prefix", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 18, 0, 0));
    const iso = new Date(2026, 5, 15, 9, 30, 0).toISOString();
    expect(formatSince(iso)).toBe(formatRelativeDate(iso).replace(/^Today /, ""));
    expect(formatSince(iso)).not.toMatch(/Today/);
  });
});

describe("sessionRecency", () => {
  it("uses started_at when present", () => {
    expect(sessionRecency({ started_at: "2026-01-02T00:00:00Z" }))
      .toBe(new Date("2026-01-02T00:00:00Z").getTime());
  });
  it("falls back to created_at when started_at is null/missing", () => {
    const t = new Date("2026-03-03T00:00:00Z").getTime();
    expect(sessionRecency({ started_at: null, created_at: "2026-03-03T00:00:00Z" })).toBe(t);
    expect(sessionRecency({ created_at: "2026-03-03T00:00:00Z" })).toBe(t);
  });
  it("returns 0 when nothing parses", () => {
    expect(sessionRecency({})).toBe(0);
    expect(sessionRecency(null)).toBe(0);
  });
});

describe("sortSessionsByRecency", () => {
  it("orders newest-first regardless of input order (the Past Sessions bug)", () => {
    const sessions = [
      { _id: "old", started_at: "2026-01-01T00:00:00Z" },
      { _id: "newest", started_at: "2026-06-01T00:00:00Z" },
      { _id: "mid", started_at: "2026-03-01T00:00:00Z" },
    ];
    expect(sortSessionsByRecency(sessions).map((s) => s._id))
      .toEqual(["newest", "mid", "old"]);
  });

  it("does not mutate the input array", () => {
    const sessions = [
      { _id: "a", started_at: "2026-01-01T00:00:00Z" },
      { _id: "b", started_at: "2026-02-01T00:00:00Z" },
    ];
    const copy = [...sessions];
    sortSessionsByRecency(sessions);
    expect(sessions).toEqual(copy);
  });

  it("puts sessions with no usable date last", () => {
    const sessions = [
      { _id: "nodate" },
      { _id: "dated", started_at: "2026-01-01T00:00:00Z" },
    ];
    expect(sortSessionsByRecency(sessions).map((s) => s._id)).toEqual(["dated", "nodate"]);
  });

  it("tolerates null / undefined", () => {
    expect(sortSessionsByRecency(null)).toEqual([]);
    expect(sortSessionsByRecency(undefined)).toEqual([]);
  });

  it("takes the top 3 correctly after sorting (recent slice)", () => {
    const sessions = [
      { _id: "1", started_at: "2026-01-01T00:00:00Z" },
      { _id: "2", started_at: "2026-02-01T00:00:00Z" },
      { _id: "3", started_at: "2026-03-01T00:00:00Z" },
      { _id: "4", started_at: "2026-04-01T00:00:00Z" },
      { _id: "5", started_at: "2026-05-01T00:00:00Z" },
    ];
    expect(sortSessionsByRecency(sessions).slice(0, 3).map((s) => s._id))
      .toEqual(["5", "4", "3"]);
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x" class='y'>&</a>`))
      .toBe("&lt;a href=&quot;x&quot; class=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });
});

describe("highlightMatch", () => {
  it("wraps the matched span case-insensitively", () => {
    expect(highlightMatch("Hello World", "world"))
      .toBe('Hello <mark class="hl">World</mark>');
  });
  it("escapes around and inside the match", () => {
    expect(highlightMatch("<b>xss</b>", "xss"))
      .toBe('&lt;b&gt;<mark class="hl">xss</mark>&lt;/b&gt;');
  });
  it("returns the escaped text unchanged when there is no match", () => {
    expect(highlightMatch("<b>plain</b>", "zzz")).toBe("&lt;b&gt;plain&lt;/b&gt;");
  });
});

describe("buildEmbedText", () => {
  it("assembles intent, topics, sites and pages", () => {
    const payload = {
      intent: "compare vacuum cleaners",
      windows: {
        w1: {
          tabs: [
            { title: "Dyson V15 Review", url: "https://www.wirecutter.com/dyson" },
            { title: "New Tab", url: "https://www.google.com" },
          ],
          groups: { g1: { title: "Research" } },
        },
      },
    };
    const out = buildEmbedText(payload);
    expect(out).toContain("Intent: compare vacuum cleaners.");
    expect(out).toContain("Topics: Research.");
    expect(out).toContain("wirecutter.com");
    expect(out).toContain("Dyson V15 Review");
    expect(out).not.toContain("New Tab"); // junk title filtered
  });

  it("defaults a missing intent to Untitled and caps at 1000 chars", () => {
    const tabs = Array.from({ length: 200 }, (_, i) => ({
      title: `Page number ${i} with a fairly long descriptive title`,
      url: `https://example${i}.com`,
    }));
    const out = buildEmbedText({ windows: { w1: { tabs } } });
    expect(out.startsWith("Intent: Untitled.")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(1000);
  });

  it("handles an empty payload", () => {
    expect(buildEmbedText({})).toBe("Intent: Untitled.");
  });
});

describe("keywordSearchSessions", () => {
  const entry = (id, tabs, groups = []) => ({
    session: { _id: id },
    payload: { windows: { w1: { tabs, groups: Object.fromEntries(groups.map((t, i) => [i, { title: t }])) } } },
  });

  it("matches on tab title and url, case-insensitively", () => {
    const entries = [
      entry("s1", [{ title: "React docs", url: "https://react.dev" }]),
      entry("s2", [{ title: "Vue", url: "https://vuejs.org" }]),
    ];
    const { results } = keywordSearchSessions("REACT", entries);
    expect(results.map((r) => r.session._id)).toEqual(["s1"]);
    expect(results[0].matchedTabs).toHaveLength(1);
  });

  it("matches on group title only and flags groupOnlyMatch", () => {
    const entries = [entry("s1", [{ title: "nothing", url: "https://x.com" }], ["Tax stuff"])];
    const { results } = keywordSearchSessions("tax", entries);
    expect(results).toHaveLength(1);
    expect(results[0].groupOnlyMatch).toBe(true);
    expect(results[0].matchedGroupTitles).toEqual(["Tax stuff"]);
  });

  it("caps matched tabs per session and reports the overflow", () => {
    const tabs = Array.from({ length: 7 }, (_, i) => ({ title: `foo ${i}`, url: "https://x.com" }));
    const { results } = keywordSearchSessions("foo", [entry("s1", tabs)]);
    expect(results[0].matchedTabs).toHaveLength(KEYWORD_TABS_PER_SESSION_CAP);
    expect(results[0].allMatchedTabs).toHaveLength(7);
    expect(results[0].overflowTabCount).toBe(7 - KEYWORD_TABS_PER_SESSION_CAP);
  });

  it("caps the number of sessions and reports overflowSessionCount", () => {
    const entries = Array.from({ length: 8 }, (_, i) =>
      entry(`s${i}`, [{ title: "match", url: "https://x.com" }]),
    );
    const { results, overflowSessionCount } = keywordSearchSessions("match", entries);
    expect(results).toHaveLength(KEYWORD_SESSIONS_CAP);
    expect(overflowSessionCount).toBe(8 - KEYWORD_SESSIONS_CAP);
  });

  it("returns nothing when there is no match", () => {
    const { results, overflowSessionCount } = keywordSearchSessions("zzz", [
      entry("s1", [{ title: "abc", url: "https://x.com" }]),
    ]);
    expect(results).toEqual([]);
    expect(overflowSessionCount).toBe(0);
  });
});

describe("constants", () => {
  it("are the expected values", () => {
    expect(MIN_QUERY_LENGTH).toBe(2);
    expect(KEYWORD_SESSIONS_CAP).toBe(5);
    expect(KEYWORD_TABS_PER_SESSION_CAP).toBe(3);
    expect(JUNK_TITLES.has("new tab")).toBe(true);
  });
});
