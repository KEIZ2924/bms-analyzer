// Compares the browser forward pass against the numbers the plugin printed for
// the same charts (bmsinfo.exe --difficulty).
//
//   node tools/check-model.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { loadDifficultyFromBuffer } from "../src/difficulty.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const CASES = [
    ["win1.bin", "mig17.bms", 0.798180],
    ["win2.bin", "4k_test.bms", 0.009845],
    ["win3.bin", "TriumphalG.bms", 0.734859],
    ["win4.bin", "_Lin_Xe -LN.bms", 0.994728],
    ["win5.bin", "_6KX.bms", 0.633509],
    ["win6.bin", "_anti.bms", 0.789653],
];

const blob = readFileSync(join(root, "models/difficulty.bin"));
const model = loadDifficultyFromBuffer(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
console.log(`models ${model.modelCount}`);

let worst = 0;
for (const [file, chart, expected] of CASES) {
    const raw = readFileSync(join("D:/Code/_scratch", file));
    const windows = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const started = performance.now();
    const result = model.score(windows);
    const elapsed = performance.now() - started;
    const diff = Math.abs(result.raw - expected);
    worst = Math.max(worst, diff);
    console.log(
        `${chart.padEnd(16)} js=${result.raw.toFixed(6)} cpp=${expected.toFixed(6)} ` +
        `diff=${diff.toExponential(2)} ${result.display} (${result.label}) ${elapsed.toFixed(0)} ms`);
}
console.log(`worst diff ${worst.toExponential(2)}`);
