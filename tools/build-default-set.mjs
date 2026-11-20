// Build the default table: every chart in the given playlist of an LR2 song.db,
// analysed with the same pipeline the page runs in the browser.
//
//   node tools/build-default-set.mjs --db "E:/_BMS_/_OpenLR2_/LR2files/Database/song.db"
//
// sl/st comes from the plugin's cache (difficulty_cache.db), so the build does not
// have to run the network 35k times; charts missing from the cache get an empty
// sl/st and are filled in by the page when opened by hand.
//
// Options: --playlists 66,29,51 --out data/default-charts.json --threads 6
//          --cache <difficulty_cache.db> --limit N (for a quick sample run)

import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function arg(name, fallback) {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dbPath = arg("db", "E:/_BMS_/_OpenLR2_/LR2files/Database/song.db");
const cachePath = arg("cache", "E:/_BMS_/_OpenLR2_/LR2files/Database/difficulty_cache.db");
const playlists = arg("playlists", "66,29,51,62,73,88,91,78")
    .split(",").map((value) => Number(value.trim())).filter(Number.isFinite);
const outPath = resolve(root, arg("out", "data/default-charts.json"));
const limit = Number(arg("limit", "0"));
const threads = Number(arg("threads", String(Math.max(1, Math.min(8, availableParallelism() - 1)))));

const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec(`attach database '${cachePath.replaceAll("'", "''")}' as cache`);

const marks = playlists.map(() => "?").join(",");
const rows = db.prepare(`
    select distinct s.hash as hash, s.path as path,
           c.raw as raw, c.display as display, s.subartist as subartist
    from playlist_entry p
    join song s on s.hash = p.md5
    left join cache.md5_model_cache c on c.md5 = p.md5
    where p.playlist_id in (${marks}) and s.path is not null and s.path <> ''
    order by s.hash
`).all(...playlists);

const items = rows.map((row) => ({
    md5: row.hash,
    path: row.path,
    slr: row.raw,
    sl: row.display || "",
    sa: row.subartist || "",
}));
const targets = limit > 0 ? items.slice(0, limit) : items;
const cached = targets.filter((item) => item.sl).length;

console.log(`db       ${dbPath}`);
console.log(`cache    ${cachePath}`);
console.log(`lists    ${playlists.join(", ")}`);
console.log(`charts   ${targets.length}${limit > 0 ? ` (of ${items.length})` : ""}, cached sl/st ${cached}`);
console.log(`threads  ${threads}`);

const started = Date.now();
const collected = [];
let finished = 0;

const chunkSize = Math.max(1, Math.ceil(targets.length / threads));
const workers = [];
for (let i = 0; i < threads; i++) {
    const slice = targets.slice(i * chunkSize, (i + 1) * chunkSize);
    if (!slice.length) continue;
    const worker = new Worker(join(here, "build-worker.mjs"), { workerData: { items: slice } });
    workers.push(new Promise((resolveWorker, rejectWorker) => {
        const local = [];
        worker.on("message", ({ rows: built }) => {
            local.push(...built);
            finished += built.length;
            const rate = finished / ((Date.now() - started) / 1000);
            process.stdout.write(`\r  ${finished}/${targets.length}  ${rate.toFixed(1)}/s  `);
        });
        worker.on("error", rejectWorker);
        worker.on("exit", () => {
            collected.push(...local);
            resolveWorker();
        });
    }));
}

await Promise.all(workers);
process.stdout.write("\n");

const charts = [];
const seen = new Set();
for (const row of collected) {
    if (row.error) continue;
    // The same md5 can sit in several playlists and even map to two song rows;
    // the table wants one line per chart.
    if (seen.has(row.h)) continue;
    seen.add(row.h);
    charts.push(row);
}
charts.sort((a, b) => b.s - a.s || a.t.localeCompare(b.t, "ja"));
const failed = collected.filter((row) => row.error);
if (failed.length) {
    console.log(`failed   ${failed.length}, first: ${failed[0].path} (${failed[0].error})`);
}

const payload = {
    generated: new Date().toISOString(),
    source: { db: dbPath, cache: cachePath, playlists },
    count: charts.length,
    failed: failed.length,
    charts,
};

await mkdir(dirname(outPath), { recursive: true });
const text = JSON.stringify(payload);
await writeFile(outPath, text);

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`wrote    ${outPath}`);
console.log(`rows     ${charts.length} ok, ${failed.length} failed`);
console.log(`size     ${(text.length / 1024 / 1024).toFixed(2)} MiB in ${seconds}s`);
