// The whole chart pipeline: bytes -> notes -> osu text -> ratings.
//
// The engine below is the same one the BmsInfo plugin runs (native C++ there,
// vendored JavaScript here), so the numbers match what the game shows.

import { decodeBms, parseBms, toKeymode } from "./bmsParser.js";
import { sanitizeLaneNotes, buildOsuText } from "./osuBridge.js";
import { calculate } from "../vendor/om-analyzer/rework/sunnyAlgorithm.js";
import { parseOsuManiaFromText } from "../vendor/om-analyzer/parser/patternOsuParser.js";
import { fromChart } from "../vendor/om-analyzer/patterns/summary.js";
import { find } from "../vendor/om-analyzer/patterns/findPatterns.js";
import { estDiff } from "../vendor/om-analyzer/estimator/reworkEstimatorUtils.js";
import { analyseWindows, categorise } from "./panel.js";

const SUNNY_OD = 8;

export function decodeFile(bytes) {
    return decodeBms(bytes);
}

/** Fixes up the column count the way the plugin does: no scratch means no gap. */
function normaliseColumns(chart, keymode) {
    const usesScratch = keymode.usesScratch;
    return { usesScratch, keys: keymode.keys };
}

function buildCharts(bytes, keymodeName) {
    const text = decodeFile(bytes);
    const chart = parseBms(text);
    const sunnyMode = toKeymode(chart, keymodeName === "drop" ? "keep" : keymodeName);
    const sunnyNotes = sanitizeLaneNotes(sunnyMode.notes).notes;
    const patternMode = toKeymode(chart, "drop");
    const patternNotes = sanitizeLaneNotes(patternMode.notes).notes;

    const sunnyText = buildOsuText({
        keys: sunnyMode.keys,
        notes: sunnyNotes,
        bpmPoints: chart.bpmPoints,
        title: chart.meta.title || "",
        artist: chart.meta.artist || "",
        version: keymodeName,
        od: SUNNY_OD,
    });
    const patternText = buildOsuText({
        keys: patternMode.keys,
        notes: patternNotes,
        bpmPoints: chart.bpmPoints,
        title: chart.meta.title || "",
        artist: chart.meta.artist || "",
        version: keymodeName,
        od: SUNNY_OD,
    });

    return { chart, sunnyText, patternText, sunnyMode, patternMode, sunnyNotes, patternNotes };
}

export function analyseChart(bytes, options = {}) {
    const keymodeName = options.keymode || "keep";
    const rate = options.rate || 1.0;
    const built = buildCharts(bytes, keymodeName);
    const { chart, sunnyText, patternText, sunnyMode, patternNotes } = built;

    // --- xxy star rating -------------------------------------------------
    const sunny = calculate(sunnyText, rate, String(SUNNY_OD), null);
    if (typeof sunny === "number") {
        throw new Error(`sunny rating failed (${sunny === -1 ? "parse" : "not mania"})`);
    }
    const [star, lnRatio, columns] = sunny;
    const dan = estDiff(star, lnRatio, columns >= 7 ? 7 : columns === 6 ? 6 : 4);

    // --- pattern analysis ------------------------------------------------
    const patternChart = parseOsuManiaFromText(patternText);
    const report = fromChart(patternChart);
    const windows = find(patternChart);
    const durationMs = Math.max(1, patternChart.LastNote - patternChart.FirstNote);
    const panel = analyseWindows(windows, durationMs, report.ModeTag);

    return {
        title: chart.meta.title || "",
        artist: chart.meta.artist || "",
        meta: chart.meta,
        keys: sunnyMode.keys,
        notes: built.sunnyNotes.length,
        longNotes: built.sunnyNotes.filter((n) => n.end != null && n.end > n.start).length,
        rows: patternNotes.length,
        durationMs,
        warnings: chart.warnings || [],
        star,
        dan,
        lnRatio,
        columns,
        modeTag: report.ModeTag,
        category: categorise(panel.families),
        families: panel.families,
        clusters: panel.clusters.map((c) => ({
            pattern: c.Pattern,
            bpm: Math.round(Number(c.BPM) * rate),
            mixed: c.Mixed,
            amountMs: c.Amount,
            importance: c.Importance,
            specificTypes: c.SpecificTypes,
        })),
        upstreamCategory: report.Category,
    };
}

export { buildCharts };
