// Central place to change where the backend lives.
const API_BASE = "https://monitar.up.railway.app";

// Thrown when the access token is rejected and the refresh token can't renew
// it — the user must sign in again.
class SessionExpiredError extends Error {
  constructor(message = "Session expired") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

async function getTokens() {
  const { access_token, refresh_token } = await chrome.storage.local.get([
    "access_token",
    "refresh_token",
  ]);
  return { access_token: access_token || null, refresh_token: refresh_token || null };
}

async function setTokens({ access_token, refresh_token }) {
  const update = {};
  if (access_token !== undefined) update.access_token = access_token;
  if (refresh_token !== undefined) update.refresh_token = refresh_token;
  await chrome.storage.local.set(update);
}

async function clearTokens() {
  await chrome.storage.local.remove(["access_token", "refresh_token"]);
}

// Low-level fetch + JSON parse. Returns { res, data }; never throws on non-2xx.
async function rawFetch(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

// Rotate the refresh token; returns a fresh access token or throws
// SessionExpiredError (and clears storage) if it can't.
async function doRefresh() {
  const { refresh_token } = await getTokens();
  if (!refresh_token) {
    await clearTokens();
    throw new SessionExpiredError();
  }

  const { res, data } = await rawFetch("/refresh", {
    method: "POST",
    body: { refresh_token },
  });

  if (!res.ok) {
    await clearTokens();
    throw new SessionExpiredError();
  }

  await setTokens({ access_token: data.access_token, refresh_token: data.refresh_token });
  return data.access_token;
}

// Main wrapper: attaches the access token and, on a 401, transparently rotates
// the refresh token and retries the request once.
async function request(path, { method = "GET", body, auth = true } = {}) {
  let token = auth ? (await getTokens()).access_token : undefined;

  let { res, data } = await rawFetch(path, { method, body, token });

  if (auth && res.status === 401) {
    const newToken = await doRefresh(); // throws SessionExpiredError if it fails
    ({ res, data } = await rawFetch(path, { method, body, token: newToken }));
  }

  if (!res.ok) {
    throw new Error(data.detail || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  signUp: (name, email, password) =>
    request("/sign-up", { method: "POST", auth: false, body: { name, email, password } }),
  signIn: (email, password) =>
    request("/sign-in", { method: "POST", auth: false, body: { email, password } }),
  storeSession: (session) =>
    request("/store", { method: "POST", body: session }),
  updateSession: (id, session) =>
    request(`/${id}`, { method: "PUT", body: session }),
  listSessions: () => request("/"),
  getSession: (id) => request(`/${id}`),
  deleteSession: (id) => request(`/${id}`, { method: "DELETE" }),
  refresh: doRefresh,
  logout: async () => {
    const { refresh_token } = await getTokens();
    if (refresh_token) {
      // Best-effort server-side revocation; clear locally regardless.
      try {
        await rawFetch("/logout", { method: "POST", body: { refresh_token } });
      } catch (_) {}
    }
    await clearTokens();
  },
};

export { getTokens, setTokens, clearTokens, SessionExpiredError };
