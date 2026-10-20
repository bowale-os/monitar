// Benchmark the extension's real crypto.js (AES-256-GCM) and the PBKDF2 key
// derivation it uses (same parameters as deriveAndStoreKey). Runs in Node 20+.
//
//   node scripts/bench_crypto.mjs
import { webcrypto } from "node:crypto";
import { performance } from "node:perf_hooks";

globalThis.crypto ??= webcrypto;
const { encrypt, decrypt, hashPayload } = await import("../frontend/extension/crypto.js");

async function time(label, fn, runs) {
  await fn(); // warm-up
  const t = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  console.log(`${label.padEnd(34)} median ${t[Math.floor(t.length / 2)].toFixed(2).padStart(8)} ms`);
}

// Same PBKDF2 parameters as crypto.js deriveAndStoreKey (100k iterations, SHA-256).
const material = await crypto.subtle.importKey("raw", new TextEncoder().encode("correct-horse-battery"), "PBKDF2", false, ["deriveKey"]);
const salt = crypto.getRandomValues(new Uint8Array(16));
const derive = () => crypto.subtle.deriveKey(
  { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
  material, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
const key = await derive();

const session = (tabs) => ({
  intent: "Vector databases research",
  windows: { 1: { groups: {}, tabs: Array.from({ length: tabs }, (_, i) => ({
    url: `https://example.com/articles/${i}?ref=bench`, title: `Example article number ${i} about databases`,
    opened_at: "2026-10-19T09:30:00Z", time_spent: 42, time_since_prev: 7,
    is_last_opened: false, fetched: false, page_snippet: null })) } },
});

console.log(`Node ${process.version}`);
await time("PBKDF2 key derivation (100k iters)", derive, 5);
for (const tabs of [10, 100, 1000]) {
  const payload = session(tabs);
  const size = JSON.stringify(payload).length;
  const blob = await encrypt(key, payload);
  await time(`encrypt  ${String(tabs).padStart(4)} tabs (${(size / 1024).toFixed(0)} KB)`, () => encrypt(key, payload), 30);
  await time(`decrypt  ${String(tabs).padStart(4)} tabs`, () => decrypt(key, blob), 30);
  await time(`hashPayload ${String(tabs).padStart(4)} tabs`, () => hashPayload(payload), 30);
}
