// One slice of the default-set build: analyses the charts and posts rows.
//
// Started by tools/build-default-set.mjs; not meant to be run by hand.
//
// sl/st is not computed here: the plugin's difficulty_cache.db already holds a
// 25-fold estimate for essentially every chart in the library, which is both
// faster and closer to what the plugin shows.

import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";

const { items } = workerData;

const { analyseChart } = await import("../src/pipeline.js");

function compact(row, item) {
    const meta = row.meta || {};
    return {
        h: item.md5,
        t: meta.title || row.title || "",
        st: meta.subtitle || "",
        a: meta.artist || row.artist || "",
        sa: item.sa || meta.subartist || "",
        k: row.keys,
        n: row.notes,
        d: Math.round(row.durationMs),
        s: Number(row.star.toFixed(4)),
        dan: row.dan,
        sl: item.sl || "",
        slr: item.slr ?? null,
        m: row.modeTag,
        c: row.category,
        f: row.families.slice(0, 5).map((family) => [
            family.pattern,
            Number(family.share.toFixed(4)),
            family.subtypes.slice(0, 3).map((s) => [s.name, Number(s.share.toFixed(4))]),
        ]),
    };
}

const rows = [];
for (const item of items) {
    try {
        const bytes = new Uint8Array(await readFile(item.path));
        rows.push(compact(analyseChart(bytes, { keymode: "drop", rate: 1 }), item));
    } catch (error) {
        rows.push({ h: item.md5, path: item.path, error: String(error?.message || error) });
    }
}

parentPort.postMessage({ rows });
