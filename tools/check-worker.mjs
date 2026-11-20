// Drives ratingWorker.js outside the browser: stubs `self`, `fetch` and hands it
// a real window matrix, then prints the message it posts back.
//
//   node tools/check-worker.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const messages = [];
globalThis.self = { postMessage: (message) => messages.push(message) };
globalThis.fetch = async (url) => {
    const path = url instanceof URL ? fileURLToPath(url) : resolve(root, String(url));
    const bytes = readFileSync(path);
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
};

await import("../src/ratingWorker.js");

const raw = readFileSync("D:/Code/_scratch/win1.bin");
const windows = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);

const started = performance.now();
await self.onmessage({ data: { id: 7, windows } });
console.log(`elapsed ${(performance.now() - started).toFixed(0)} ms`);
console.log(messages);
