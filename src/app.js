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
const detail = $("detail");

let rows = [];
let sortKey = "star";
let sortDir = -1;
let selected = null;
let pendingRating = 0;

// The sl/st network is heavy, so it runs in a worker; each row gets its value a
// moment after the rest of its analysis lands.
const ratingWorker = new Worker(new URL("./ratingWorker.js", import.meta.url), { type: "module" });
const ratingQueue = [];
const ratingWaiters = new Map();
let ratingBusy = false;

function waitForRating(id) {
    if (rows.find((row) => row.id === id)?.slSt) return Promise.resolve();
    return new Promise((resolve) => ratingWaiters.set(id, resolve));
}

ratingWorker.onerror = (event) => {
    ratingBusy = false;
    const queued = ratingQueue.splice(0, ratingQueue.length);
    for (const item of [...queued]) {
        const row = rows.find((entry) => entry.id === item.id);
        if (row) row.slSt = { error: event.message || "worker failed" };
    }
    setStatus(`sl/st worker failed: ${event.message || "unknown"}`);
    render();
    drainRatingQueue();
};

ratingWorker.onmessage = (event) => {
    const { id, ok, error } = event.data;
    const row = rows.find((item) => item.id === id && !item.error);
    ratingBusy = false;
    if (row) {
        if (ok) {
            row.slSt = event.data;
        } else {
            row.slSt = { error };
        }
    }
    render();
    if (selected && selected.id === id) showDetail(selected);
    ratingWaiters.get(id)?.();
    ratingWaiters.delete(id);
    drainRatingQueue();
};

function drainRatingQueue() {
    if (ratingBusy || !ratingQueue.length) {
        pendingRating = ratingQueue.length;
        return;
    }
    const next = ratingQueue.shift();
    ratingBusy = true;
    pendingRating = ratingQueue.length + 1;
    ratingWorker.postMessage({ id: next.id, windows: next.windows.buffer }, [next.windows.buffer]);
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
    if (!row.slSt) return '<span class="pending">…</span>';
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
    const sorted = [...rows].sort((a, b) => {
        const av = sortValue(a);
        const bv = sortValue(b);
        if (typeof av === "number" && typeof bv === "number") return (av - bv) * sortDir;
        return String(av).localeCompare(String(bv), "ja") * sortDir;
    });

    tbody.replaceChildren(...sorted.map((row, index) => {
        const tr = document.createElement("tr");
        if (row === selected) tr.classList.add("active");
        tr.addEventListener("click", () => select(row));
        tr.innerHTML = `
            <td>${escapeHtml(row.title || row.name)}</td>
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
    const metaBits = [row.artist, `${row.keys}k`, `${row.rows} rows`, fmtDuration(row.durationMs)];
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
    const head = document.createElement("tr");
    head.innerHTML = "<td>cluster</td><td>bpm</td><td>amount</td><td>labels</td>";
    const body = row.clusters.slice(0, 12).map((cluster) => {
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

    const keymode = $("keymode").value;
    const rate = Number($("rate").value) || 1;
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
    render();
}

$("pickFiles").addEventListener("click", () => $("files").click());
$("pickFolder").addEventListener("click", () => $("folder").click());
$("files").addEventListener("change", (event) => addFiles(event.target.files));
$("folder").addEventListener("change", (event) => addFiles(event.target.files));
$("clear").addEventListener("click", () => {
    rows = [];
    selected = null;
    detail.hidden = true;
    table.hidden = true;
    setStatus("");
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

$("keymode").addEventListener("change", () => {
    if (rows.length) {
        rows = [];
        setStatus("keymode changed — drop the charts again");
        table.hidden = true;
        detail.hidden = true;
    }
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
}
