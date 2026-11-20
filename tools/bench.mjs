import { readFile } from "node:fs/promises";
import { analyseChart } from "../src/pipeline.js";
const files = process.argv.slice(2);
const t0 = performance.now();
for (const f of files) analyseChart(new Uint8Array(await readFile(f)), { keymode: "keep" });
const dt = performance.now() - t0;
console.log(`${files.length} charts in ${dt.toFixed(0)} ms (${(dt / files.length).toFixed(1)} ms/chart)`);
