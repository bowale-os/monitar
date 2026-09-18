import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The extension ships in two tracked copies: extension/ and uploadzip/extension/.
// They are meant to be byte-identical; a drift here means a fix landed in one
// copy but not the other. Keep this list in step with the shared source files.
const SHARED_FILES = [
  "popup.js",
  "helpers.js",
  "background.js",
  "api.js",
  "crypto.js",
  "popup.html",
  "popup.css",
  "onboarding.js",
  "onboarding.html",
  "onboarding.css",
  "manifest.json",
  "embed.worker.js",
];

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

describe("extension/ and uploadzip/extension/ stay in sync", () => {
  for (const name of SHARED_FILES) {
    it(name, () => {
      expect(read(`extension/${name}`)).toBe(read(`uploadzip/extension/${name}`));
    });
  }
});
