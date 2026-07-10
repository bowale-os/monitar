import { api, getTokens, setTokens } from "./api.js";
import { deriveAndStoreKey, loadKey } from "./crypto.js";

const ONBOARDED_KEY = "has_onboarded";
const STEP_KEY = "onboarding_step";

// Step order: hook → privacy → account → session → done.
const steps = [
  document.getElementById("step-hook"),
  document.getElementById("step-privacy"),
  document.getElementById("step-account"),
  document.getElementById("step-session"),
  document.getElementById("step-done"),
];
const DONE_INDEX = steps.length - 1;

const dots = [...document.querySelectorAll(".dot")];
const skipBtn = document.getElementById("skip-btn");
const backBtn = document.getElementById("back-btn");
const footer = document.getElementById("ob-footer");

const accountForm = document.getElementById("account-form");
const accountSubmit = document.getElementById("account-submit");
const authToggle = document.getElementById("auth-toggle");
const nameInput = document.getElementById("name");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const accountStatus = document.getElementById("account-status");

const sessionForm = document.getElementById("session-form");
const sessionSubmit = document.getElementById("session-submit");
const intentInput = document.getElementById("intent");
const includeOpen = document.getElementById("include-open");
const sessionStatus = document.getElementById("session-status");

let index = 0;
let authMode = "signup"; // onboarding leads with sign-up

// --- helpers ---
function showStatus(el, message, kind = "error") {
  el.textContent = message;
  el.className = `status ${kind}`;
  el.classList.remove("hidden");
}

function clearStatus(el) {
  el.classList.add("hidden");
}

function show(i) {
  index = i;
  steps.forEach((step, idx) => step.classList.toggle("hidden", idx !== i));
  dots.forEach((dot, idx) => dot.classList.toggle("active", idx === i));

  const showBack = i > 0 && i !== DONE_INDEX;
  backBtn.classList.toggle("hidden", !showBack);
  if (showBack) {
    // Sit the back button on the same line as this step's forward button.
    steps[i].querySelector(".step-actions")?.prepend(backBtn);
  }

  // Once the flow is complete there's nothing left to skip or step through.
  skipBtn.classList.toggle("hidden", i === DONE_INDEX);
  footer.classList.toggle("invisible", i === DONE_INDEX);

  // Remember progress so reopening onboarding resumes here instead of
  // restarting — but the terminal step should never be resumed into directly.
  if (i !== DONE_INDEX) chrome.storage.local.set({ [STEP_KEY]: i });
}

async function markOnboarded() {
  await chrome.storage.local.set({ [ONBOARDED_KEY]: true });
  await chrome.storage.local.remove(STEP_KEY);
}

// Completed users don't get the flow again — just a pointer to the popup.
function showBlocked() {
  steps.forEach((step) => step.classList.add("hidden"));
  document.getElementById("step-blocked").classList.remove("hidden");
  skipBtn.classList.add("hidden");
  backBtn.classList.add("hidden");
  footer.classList.add("invisible");
}

async function closeTab() {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch (_) {}
  window.close();
}

async function isSignedIn() {
  const { access_token } = await getTokens();
  if (!access_token) return false;
  return Boolean(await loadKey()); // key gone means restore/save can't work
}

// --- navigation ---
document.getElementById("hook-next").addEventListener("click", () => show(1));

document.getElementById("privacy-next").addEventListener("click", async () => {
  // Already signed in (e.g. re-opened onboarding) — skip straight to the aha.
  show((await isSignedIn()) ? 3 : 2);
});

backBtn.addEventListener("click", () => {
  // From the session step, hop over the account step if it was auto-skipped.
  if (index === 3) {
    isSignedIn().then((signedIn) => show(signedIn ? 1 : 2));
  } else if (index > 0) {
    show(index - 1);
  }
});

skipBtn.addEventListener("click", async () => {
  await markOnboarded();
  await closeTab();
});

// --- account (same logic as the popup's handleAuth) ---
function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  nameInput.classList.toggle("hidden", !signup);
  passwordInput.autocomplete = signup ? "new-password" : "current-password";
  accountSubmit.textContent = signup ? "Create my account" : "Sign in";
  authToggle.textContent = signup
    ? "Already have an account? Sign in"
    : "New here? Create an account";
  clearStatus(accountStatus);
}

authToggle.addEventListener("click", () => {
  setAuthMode(authMode === "signup" ? "signin" : "signup");
});

accountForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearStatus(accountStatus);
  accountSubmit.disabled = true;
  try {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const res =
      authMode === "signup"
        ? await api.signUp(nameInput.value.trim(), email, password)
        : await api.signIn(email, password);

    await setTokens(res);
    if (!res.enc_salt) {
      showStatus(accountStatus, "Encryption is not working at the moment. Please contact admin.");
      return;
    }
    await deriveAndStoreKey(password, res.enc_salt);
    accountForm.reset();
    show(3);
  } catch (err) {
    showStatus(accountStatus, err.message);
  } finally {
    accountSubmit.disabled = false;
  }
});

// --- first session ---
sessionForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearStatus(sessionStatus);
  const intent = intentInput.value.trim();
  if (!intent) {
    showStatus(sessionStatus, "Tell us what you're working on to continue.");
    return;
  }
  sessionSubmit.disabled = true;
  try {
    const captureExisting = includeOpen.checked;
    await chrome.storage.local.set({ capture_existing_pref: captureExisting });
    const res = await chrome.runtime.sendMessage({
      type: "START_SESSION",
      intent,
      captureExisting,
    });
    if (res?.code === "SESSION_ACTIVE") {
      // Never clobber a running session from here; the popup owns that choice.
      showStatus(sessionStatus, "A session is already running — manage it from the Monitar popup.");
      return;
    }
    await markOnboarded();
    show(DONE_INDEX);
  } catch (err) {
    showStatus(sessionStatus, err.message);
  } finally {
    sessionSubmit.disabled = false;
  }
});

document.getElementById("done-btn").addEventListener("click", closeTab);

document.getElementById("blocked-open-btn").addEventListener("click", async () => {
  // openPopup needs a user gesture and Chrome 127+; the copy on screen already
  // points at the toolbar, so closing the tab is a fine fallback.
  try {
    await chrome.action.openPopup();
  } catch (_) {
    await closeTab();
  }
});

// --- demo video: fall back to the poster image until demo.webm ships ---
const demoVideo = document.getElementById("demo-video");
const demoSource = document.getElementById("demo-source");
demoSource.addEventListener("error", () => {
  const img = document.createElement("img");
  img.src = "media/demo-poster.svg";
  img.alt = "Monitar demo preview";
  img.className = "video-fallback";
  demoVideo.replaceWith(img);
});

// --- init ---
(async function init() {
  setAuthMode("signup");
  const [{ [ONBOARDED_KEY]: hasOnboarded, [STEP_KEY]: savedStep }, signedIn] = await Promise.all([
    chrome.storage.local.get([ONBOARDED_KEY, STEP_KEY]),
    isSignedIn(),
  ]);
  if (hasOnboarded) {
    showBlocked();
    return;
  }
  let start = Number.isInteger(savedStep) && savedStep > 0 && savedStep < DONE_INDEX ? savedStep : 0;
  // Resuming into the account step after already signing up elsewhere is
  // wrong — same skip the privacy step already applies going forward.
  if (start === 2 && signedIn) start = 3;
  show(start);
})();
