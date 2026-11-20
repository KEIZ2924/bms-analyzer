// Compares the browser pipeline with the plugin's console harness.
//
//   node tools/verify.mjs <chart> [chart...]
//
// Prints one line per chart: the JS star, the harness star and the delta.

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { analyseChart } from "../src/pipeline.js";

const run = promisify(execFile);
const HARNESS = process.env.BMSINFO || String.raw`D:\Code\_scratch\bmsinfo-build\bmsinfo.exe`;

const files = process.argv.slice(2);
if (!files.length) {
    console.error("usage: node tools/verify.mjs <chart> [chart...]");
    process.exit(2);
}

for (const file of files) {
    const bytes = new Uint8Array(await readFile(file));
    let js;
    try {
        js = analyseChart(bytes, { keymode: "keep" });
    } catch (error) {
        console.log(`${file}\tjs error: ${error.message}`);
        continue;
    }

    let out = "";
    try {
        out = (await run(HARNESS, ["--sunny", file])).stdout;
    } catch (error) {
        out = error.stdout || "";
    }
    const match = /star=([0-9.]+)/.exec(out);
    const harnessStar = match ? Number(match[1]) : NaN;
    const delta = Number.isFinite(harnessStar) ? js.star - harnessStar : NaN;
    const cat = /category=(.*)$/m.exec(out);

    console.log([
        file.split(/[\\/]/).pop(),
        `star=${js.star.toFixed(6)}`,
        `harness=${Number.isFinite(harnessStar) ? harnessStar.toFixed(6) : "n/a"}`,
        `d=${Number.isFinite(delta) ? delta.toExponential(2) : "n/a"}`,
        `cat=${js.category}`,
        `harness cat=${cat ? cat[1].trim() : "n/a"}`,
    ].join("\t"));
}
