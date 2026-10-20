// crypto.js

// Storage key for the exported AES key in chrome.storage.session. The odd name
// just avoids colliding with any other key; it is not a secret.
const KEY_STORAGE = "23wdf@#%^&^&fvfbxfy74sdf$#$@#$%^";

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // chunked to avoid call stack overflow on large buffers
  for (let i = 0; i < bytes.length; i += 1024) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 1024));
  }
  return btoa(binary);
}

function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Derive the AES-256-GCM key from the password and the server-issued per-user
// salt, then keep it in session storage (memory only, cleared when the browser
// closes). The same password + salt always yields the same key, which is what
// lets any device decrypt sessions without the key ever being uploaded.
// 100k PBKDF2 iterations keeps sign-in snappy; see docs/ARCHITECTURE.md for the
// trade-off.
export async function deriveAndStoreKey(password, saltBase64) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: base64ToBuffer(saltBase64),
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true,              // needs to be true so we can export to JWK for storage
    ["encrypt", "decrypt"]
  );

  // CryptoKey isn't directly serializable — export to JWK first
  const jwk = await crypto.subtle.exportKey("jwk", key);
  await chrome.storage.session.set({ [KEY_STORAGE]: jwk });
}

export async function loadKey() {
  const { [KEY_STORAGE]: jwk } = await chrome.storage.session.get(KEY_STORAGE);
  if (!jwk) return null;

  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "AES-GCM", length: 256 },
    false,             // no longer needs to be extractable once re-imported
    ["encrypt", "decrypt"]
  );
}

export async function clearKey() {
  await chrome.storage.session.remove(KEY_STORAGE);
}

// Output layout is base64( IV[12] || ciphertext+tag ). A fresh random IV per
// call is essential: reusing an IV with the same AES-GCM key breaks its
// confidentiality and authenticity guarantees.
export async function encrypt(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(obj));

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );

  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);

  return bufferToBase64(combined.buffer);
}

// Splits the IV back off the front. GCM authenticates as well as decrypts, so
// a wrong key or tampered data makes subtle.decrypt reject. Callers treat that
// as "this session can't be read" rather than as a crash.
export async function decrypt(key, base64) {
  const combined = new Uint8Array(base64ToBuffer(base64));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ciphertext
  );

  return JSON.parse(new TextDecoder().decode(plaintext));
}


// Change detection only, not integrity. JSON.stringify is order-sensitive, but
// the payload is always built by the same code, so identical content hashes
// identically and background.js can skip redundant uploads.
export async function hashPayload(payload) {
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return bufferToBase64(hashBuffer);
}