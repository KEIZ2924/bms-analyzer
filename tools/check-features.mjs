// Compares the browser feature pipeline against the windows the plugin dumps
// with `bmsinfo.exe --features <chart> <out.bin>`.
import { readFileSync } from "node:fs";
import { decodeBms } from "../src/bmsParser.js";
import { parseTimeline } from "../src/featureParser.js";
import { buildInferenceWindows } from "../src/features.js";

const [chartPath, binPath] = process.argv.slice(2);
if (!chartPath || !binPath) {
    console.error("usage: node tools/check-features.mjs <chart> <windows.bin>");
    process.exit(2);
}

const timeline = parseTimeline(decodeBms(readFileSync(chartPath)));
if (!timeline) {
    console.error("timeline parse produced no notes");
    process.exit(1);
}
const reference = new Float32Array(readFileSync(binPath).buffer);
const windows = buildInferenceWindows(timeline);

if (!windows) {
    console.error("no windows produced");
    process.exit(1);
}

let worst = 0;
let worstAt = "";
const columns = new Float64Array(46);
for (let i = 0; i < windows.length; i++) {
    const diff = Math.abs(windows[i] - reference[i]);
    columns[i % 46] = Math.max(columns[i % 46], diff);
    if (diff > worst) {
        worst = diff;
        worstAt = `row ${Math.floor(i / 46)} feature ${i % 46}: ${windows[i]} vs ${reference[i]}`;
    }
}
console.log(`notes ${timeline.notes.length}  windows ${windows.length / 46}  max abs diff ${worst.toExponential(2)}`);
if (worst > 1e-4) {
    console.log(`worst: ${worstAt}`);
    const listing = [];
    for (let f = 0; f < 46; f++) {
        if (columns[f] > 1e-4) listing.push(`[${f}] ${columns[f].toExponential(2)}`);
    }
    console.log(`per-feature: ${listing.join(" ")}`);
    process.exit(1);
}
