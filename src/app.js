import { analyseChart } from "./pipeline.js";

const FAMILY_COLOR = {
    Speed: "#3b82f6",
    Chordstream: "#8b5cf6",
    Jacks: "#ef4444",
    Coordination: "#f59e0b",
    Density: "#14b8a6",
    Wildcard: "#a3a3a3",
};

const $ = (id) => document.getElementById(id);
const table = $("results");
const tbody = table.querySelector("tbody");
const status = $("status");
const count = $("count");
const detail = $("detail");
const filter = $("filter");
const patternFilter = $("patternFilter");

const RENDER_LIMIT = 400;

// A startup failure (a blocked module, an old browser) used to leave the page
// looking alive but doing nothing; surface it instead.
window.addEventListener("error", (event) => setStatus(`error: ${event.message}`));
window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    setStatus(`error: ${reason?.message || reason}`);
});

let rows = [];
let sortKey = "slStValue";
let sortDir = -1;
let selected = null;
let filterText = "";

// The sl/st network is heavy, so it runs in a worker; each row gets its value a
// moment after the rest of its analysis lands.  If the browser cannot start a
// module worker (or the script fails to load) the same model runs on the main
// thread instead, a chart at a time, rather than leaving the column empty.
const ratingQueue = [];
const ratingWaiters = new Map();
let ratingWorker = null;
let ratingUseInline = false;
let ratingBusy = false;
let inlineModelPromise = null;

function waitForRating(id) {
    if (rows.find((row) => row.id === id)?.slSt) return Promise.resolve();
    return new Promise((resolve) => ratingWaiters.set(id, resolve));
}

function finishRating(id, payload) {
    const row = rows.find((item) => item.id === id && !item.error);
    ratingBusy = false;
    if (row) row.slSt = payload;
    render();
    if (selected && selected.id === id) showDetail(selected);
    ratingWaiters.get(id)?.();
    ratingWaiters.delete(id);
    drainRatingQueue();
}

function createRatingWorker() {
    if (ratingWorker || ratingUseInline) return ratingWorker;
    try {
        const worker = new Worker(new URL("./ratingWorker.js", import.meta.url), { type: "module" });
        worker.onmessage = (event) => finishRating(event.data.id, event.data.ok
            ? event.data
            : { error: event.data.error || "rating failed" });
        worker.onerror = (event) => {
            // The worker never started (blocked, not supported, script error):
            // fall back to the main thread for this and every later chart.
            console.warn("sl/st worker unavailable, using the main thread", event.message);
            ratingUseInline = true;
            ratingWorker?.terminate();
            ratingWorker = null;
            ratingBusy = false;
            drainRatingQueue();
        };
        worker.onmessageerror = () => {
            ratingUseInline = true;
            ratingBusy = false;
            drainRatingQueue();
        };
        ratingWorker = worker;
    } catch (error) {
        console.warn("cannot start the sl/st worker", error);
        ratingUseInline = true;
    }
    return ratingWorker;
}

async function scoreInline(windows) {
    inlineModelPromise ??= import("./difficulty.js")
        .then((module) => module.loadDifficultyModel(new URL("../models/difficulty.bin", import.meta.url)));
    const model = await inlineModelPromise;
    const result = model.score(windows);
    return { ...result, modelCount: model.modelCount };
}

function drainRatingQueue() {
    if (ratingBusy || !ratingQueue.length) return;
    const next = ratingQueue.shift();
    ratingBusy = true;

    const worker = createRatingWorker();
    if (worker) {
        worker.postMessage({ id: next.id, windows: next.windows.buffer }, [next.windows.buffer]);
        return;
    }

    scoreInline(next.windows)
        .then((result) => finishRating(next.id, result))
        .catch((error) => finishRating(next.id, { error: error.message }));
}

function fmtDuration(ms) {
    const total = Math.round(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtShare(share) {
    return `${(share * 100).toFixed(1)}%`;
}

function fmtSlSt(row) {
    if (row.error) return "—";
    if (!row.slSt) return row.fromDefaultSet ? "—" : '<span class="pending">…</span>';
    if (row.slSt.error) return `<span class="error">${escapeHtml(row.slSt.error)}</span>`;
    return `<span class="slst-value">${escapeHtml(row.slSt.display)}</span>`;
}

function setStatus(text) {
    status.textContent = text;
}

function render() {
    const sortValue = (row) => {
        if (sortKey === "slStValue") return row.slSt && !row.slSt.error ? row.slSt.raw : -1;
        return row[sortKey];
    };
    const needle = filterText.trim().toLowerCase();
    const patternWanted = patternFilter.value;
    const matched = rows.filter((row) => {
        if (patternWanted && row.category !== patternWanted) return false;
        if (!needle) return true;
        return `${row.title || row.name} ${row.subtitle || ""} ${row.category} ${row.dan}`
            .toLowerCase().includes(needle);
    });
    const sorted = [...matched].sort((a, b) => {
        const av = sortValue(a);
        const bv = sortValue(b);
        if (typeof av === "number" && typeof bv === "number") return (av - bv) * sortDir;
        return String(av).localeCompare(String(bv), "ja") * sortDir;
    });

    // A default set can hold tens of thousands of charts; only the first screenful
    // is worth putting in the DOM.
    const visible = sorted.slice(0, RENDER_LIMIT);
    tbody.replaceChildren(...visible.map((row, index) => {
        const tr = document.createElement("tr");
        if (row === selected) tr.classList.add("active");
        tr.addEventListener("click", () => select(row));
        tr.innerHTML = `
            <td class="chart"><span class="chart-title">${escapeHtml(row.title || row.name)}</span>${
                row.subtitle ? `<span class="chart-sub">${escapeHtml(row.subtitle)}</span>` : ""}</td>
            <td class="num"><span class="star">${row.error ? "—" : row.star.toFixed(2)}</span></td>
            <td class="num slst">${fmtSlSt(row)}</td>
            <td class="dan">${row.error ? "—" : escapeHtml(row.dan)}</td>
            <td class="cat">${row.error ? `<span class="error">${escapeHtml(row.error)}</span>` : escapeHtml(row.category)}</td>
            <td class="num">${row.error ? "—" : row.notes}</td>
            <td class="num">${row.error ? "—" : row.keys}</td>
            <td class="num">${row.error ? "—" : fmtDuration(row.durationMs)}</td>`;
        tr.dataset.index = String(index);
        return tr;
    }));

    count.textContent = sorted.length > visible.length
        ? `${visible.length} of ${sorted.length} shown`
        : sorted.length ? `${sorted.length} chart${sorted.length === 1 ? "" : "s"}` : "";
    table.hidden = rows.length === 0;
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function select(row) {
    selected = row;
    render();
    showDetail(row);
}

function showDetail(row) {
    detail.hidden = false;
    $("detailTitle").textContent = row.title || row.name;
    const metaBits = [row.artist];
    if (row.keys) metaBits.push(`${row.keys}k`);
    if (row.rows) metaBits.push(`${row.rows} rows`);
    if (row.durationMs) metaBits.push(fmtDuration(row.durationMs));
    if (row.longNotes) metaBits.push(`${row.longNotes} LN`);
    if (row.meta?.level) metaBits.push(`level ${row.meta.level}`);
    $("detailMeta").textContent = metaBits.filter(Boolean).join(" · ");

    if (row.error) {
        $("detailValues").innerHTML = `<div><dt>error</dt><dd class="error">${escapeHtml(row.error)}</dd></div>`;
        $("detailPatterns").replaceChildren();
        $("clusterTable").replaceChildren();
        return;
    }

    $("detailValues").innerHTML = `
        <div><dt>xxy star</dt><dd class="star">${row.star.toFixed(2)}</dd></div>
        <div><dt>sl/st</dt><dd class="slst-value">${row.slSt ? (row.slSt.error ? "n/a" : escapeHtml(row.slSt.display)) : "…"}</dd></div>
        <div><dt>dan</dt><dd>${escapeHtml(row.dan)}</dd></div>
        <div><dt>pattern</dt><dd>${escapeHtml(row.category)}</dd></div>
        <div><dt>mode</dt><dd>${escapeHtml(row.modeTag)}</dd></div>`;

    const patterns = $("detailPatterns");
    patterns.replaceChildren(...row.families.slice(0, 6).map((family) => {
        const color = FAMILY_COLOR[family.pattern] || "#a3a3a3";
        const wrap = document.createElement("div");
        wrap.className = "family";
        const subs = family.subtypes
            .slice(0, 4)
            .map((s) => `${escapeHtml(s.name)} ${fmtShare(s.share)}`)
            .join("，");
        wrap.innerHTML = `
            <div class="row">
                <span class="name" style="color:${color}">${escapeHtml(family.pattern)}</span>
                <span class="share">${fmtShare(family.share)}</span>
                <span class="bar"><span style="width:${Math.min(100, family.share * 100).toFixed(1)}%;background:${color}"></span></span>
            </div>
            ${subs ? `<div class="subs">${subs}</div>` : ""}`;
        return wrap;
    }));

    const clusterTable = $("clusterTable");
    const clusters = row.clusters || [];
    $("clusterBox").hidden = clusters.length === 0;
    const head = document.createElement("tr");
    head.innerHTML = "<td>cluster</td><td>bpm</td><td>amount</td><td>labels</td>";
    const body = clusters.slice(0, 12).map((cluster) => {
        const tr = document.createElement("tr");
        const labels = cluster.specificTypes.map(([name, ratio]) => `${name} ${fmtShare(ratio)}`).join("，");
        tr.innerHTML = `<td>${escapeHtml(cluster.pattern)}</td><td>${cluster.mixed ? "~" : ""}${cluster.bpm}</td>`
            + `<td>${(cluster.amountMs / 1000).toFixed(1)}s</td><td>${escapeHtml(labels) || "—"}</td>`;
        return tr;
    });
    clusterTable.replaceChildren(head, ...body);
}

async function addFiles(fileList) {
    const files = [...fileList].filter((file) => /\.(bms|bme|bml|pms|bmx)$/i.test(file.name));
    if (!files.length) {
        setStatus("no chart files in that selection");
        return;
    }

    const keymode = "drop";
    const rate = 1;
    let done = 0;
    setStatus(`analysing 0/${files.length}`);

    for (const file of files) {
        const row = { id: `${file.name}:${rows.length}`, name: file.name, title: file.name };
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            Object.assign(row, analyseChart(bytes, { keymode, rate }));
            row.title = row.meta?.title ? `${row.meta.title}${row.meta.version ? ` [${row.meta.version}]` : ""}` : file.name;
            if (row.windows) {
                ratingQueue.push({ id: row.id, windows: row.windows });
                delete row.windows;
                drainRatingQueue();
            }
        } catch (error) {
            row.error = error.message;
        }
        rows.push(row);
        done += 1;
        setStatus(`analysing ${done}/${files.length}`);
        if (done % 4 === 0 || done === files.length) render();
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    setStatus(`${rows.length} chart${rows.length === 1 ? "" : "s"} analysed`);
    fillPatternFilter(rows);
    render();
}

// The repository ships a table built from a local LR2 library (see
// tools/build-default-set.mjs): it is what the page shows before anything is
// dropped onto it, and what "clear" goes back to.
let defaultSet = [];

function fromDefaultSet(chart, index) {
    return {
        id: `set:${index}`,
        name: chart.t,
        title: chart.t,
        subtitle: chart.st || "",
        artist: chart.a,
        keys: chart.k,
        notes: chart.n,
        durationMs: chart.d,
        star: chart.s,
        dan: chart.dan,
        modeTag: chart.m,
        category: chart.c,
        slSt: chart.sl ? { display: chart.sl, raw: chart.slr } : null,
        families: (chart.f || []).map(([pattern, share, subs]) => ({
            pattern,
            share,
            subtypes: (subs || []).map(([name, ratio]) => ({ name, share: ratio })),
        })),
        clusters: [],
        fromDefaultSet: true,
    };
}

function fillPatternFilter(source) {
    const counts = new Map();
    for (const row of source) {
        if (!row.category) continue;
        counts.set(row.category, (counts.get(row.category) || 0) + 1);
    }
    const options = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"));
    const keep = patternFilter.value;
    patternFilter.replaceChildren(
        new Option("all patterns", ""),
        ...options.map(([name, n]) => new Option(`${name} (${n})`, name)),
    );
    if (keep && counts.has(keep)) patternFilter.value = keep;
}

async function loadDefaultSet() {
    try {
        const response = await fetch("data/default-charts.json");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        defaultSet = (payload.charts || []).map(fromDefaultSet);
        fillPatternFilter(defaultSet);
        if (!rows.length) {
            rows = defaultSet;
            render();
            setStatus("default set");
        }
    } catch (error) {
        setStatus(`default set unavailable (${error.message}) — drop charts to analyse them`);
    }
}

$("pickFiles").addEventListener("click", () => $("files").click());
filter.addEventListener("input", () => {
    filterText = filter.value;
    render();
});
patternFilter.addEventListener("change", () => render());
$("pickFolder").addEventListener("click", () => $("folder").click());
$("files").addEventListener("change", (event) => addFiles(event.target.files));
$("folder").addEventListener("change", (event) => addFiles(event.target.files));
$("clear").addEventListener("click", () => {
    rows = defaultSet;
    selected = null;
    detail.hidden = true;
    table.hidden = rows.length === 0;
    render();
    setStatus(rows.length ? "default set" : "");
});
$("closeDetail").addEventListener("click", () => {
    detail.hidden = true;
    selected = null;
    render();
});

document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
        const key = th.dataset.sort;
        if (sortKey === key) sortDir *= -1;
        else {
            sortKey = key;
            sortDir = key === "title" ? 1 : -1;
        }
        render();
    });
});

const drop = $("drop");
for (const type of ["dragenter", "dragover"]) {
    drop.addEventListener(type, (event) => {
        event.preventDefault();
        drop.classList.add("dragging");
    });
}
for (const type of ["dragleave", "drop"]) {
    drop.addEventListener(type, (event) => {
        event.preventDefault();
        drop.classList.remove("dragging");
    });
}
drop.addEventListener("drop", (event) => {
    if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
});

// `?sample=1` analyses the bundled 4k demo chart, which is handy for a quick
// smoke test in a headless browser.  `?chart=<url>` loads any chart the page can
// fetch (handy for testing a specific file without the file picker).
const params = new URLSearchParams(location.search);
if (params.has("sample") || params.has("chart")) {
    const source = params.has("chart") ? params.get("chart") : "samples/demo.bms";
    const name = source.split("/").pop() || "chart.bms";
    fetch(source)
        .then((response) => {
            if (!response.ok) throw new Error(`${response.status} for ${source}`);
            return response.arrayBuffer();
        })
        .then((buffer) => addFiles([new File([buffer], name)]))
        .then(() => {
            if (params.has("open")) {
                // Wait for the worker so a headless screenshot shows a finished row.
                return waitForRating(rows[0]?.id).then(() => {
                    if (rows.length) select(rows[0]);
                });
            }
            return undefined;
        })
        .catch((error) => setStatus(`sample failed: ${error.message}`));
} else {
    loadDefaultSet();
}
