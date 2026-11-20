// Panel layer: turns the raw pattern windows into the family / subtype numbers
// the plugin and this page display.
//
// This mirrors `plugins/BmsInfo/rating/PatternAnalysis.cpp`: a family is measured
// with the real union of all its windows (the upstream `Amount` double counts
// overlapping windows), while the subtype split is a weighted average of the
// per-window labels, normalised over the mass that actually carries a label.

import { calculateClusteredPatterns } from "../vendor/om-analyzer/patterns/clustering.js";

const MIN_FAMILY_SHARE = 0.01;
const MIN_SUBTYPE_SHARE = 0.005;
const MAX_SUBTYPES = 4;

export function unionLength(ranges) {
    if (!ranges.length) return 0;
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    let total = 0;
    let [start, end] = sorted[0];
    for (const [s, e] of sorted) {
        if (s > end) {
            total += end - start;
            start = s;
            end = e;
        } else if (e > end) {
            end = e;
        }
    }
    return total + (end - start);
}

export function analyseWindows(windows, durationMs, modeTag = "RC") {
    const clusters = calculateClusteredPatterns(windows, { modeTag })
        .filter((c) => Number(c.BPM) > 25 || Number(c.BPM) === 0);

    const families = new Map();
    const minFamilyMs = durationMs * MIN_FAMILY_SHARE;

    for (const cluster of clusters) {
        const spans = cluster.StartsEnds || [];
        if (!spans.length) continue;
        const union = unionLength(spans);
        if (union < minFamilyMs) continue;

        const family = families.get(cluster.Pattern)
            || { pattern: cluster.Pattern, spans: [], mixedSpans: [], subtypes: new Map(), subtypeMass: 0 };
        family.spans.push(...spans);
        if (cluster.Mixed) family.mixedSpans.push(...spans);
        for (const [name, ratio] of cluster.SpecificTypes) {
            if (name == null || ratio <= 0) continue;
            const mass = union * ratio;
            family.subtypes.set(name, (family.subtypes.get(name) || 0) + mass);
            family.subtypeMass += mass;
        }
        // A stream window that no subtype claimed is still a stream.
        if (cluster.Pattern === "Stream") {
            const claimed = cluster.SpecificTypes.reduce((sum, [name, ratio]) => (name == null ? sum : sum + ratio), 0);
            const leftover = union * Math.max(0, 1 - claimed);
            if (leftover > 0) {
                family.subtypes.set("Stream", (family.subtypes.get("Stream") || 0) + leftover);
                family.subtypeMass += leftover;
            }
        }
        families.set(cluster.Pattern, family);
    }

    // The speed family is called "Speed", and the light chordstreams of the other
    // keys modes are folded into it.
    const speedFamily = families.get("Speed") || families.get("Stream");
    families.delete("Speed");
    families.delete("Stream");

    const speed = speedFamily
        || { pattern: "Speed", spans: [], mixedSpans: [], subtypes: new Map(), subtypeMass: 0 };

    const renamed = speed.subtypes.get("Speed");
    if (renamed) {
        speed.subtypes.delete("Speed");
        speed.subtypes.set("Stream", (speed.subtypes.get("Stream") || 0) + renamed);
    }

    const list = [...families.values()];
    if (speed.spans.length || speed.subtypes.size) list.push(speed);

    // Measure first, then move the light chordstream seconds over to the speed
    // family, the way the plugin does.
    const measured = list.map((family) => ({ family, covered: unionLength(family.spans) }));
    let speedCovered = 0;
    const speedEntry = measured.find((entry) => entry.family === speed);
    if (speedEntry) speedCovered = speedEntry.covered;

    for (const entry of measured) {
        if (entry.family === speed) continue;
        const moved = entry.family.subtypes.get("Light Chordstream") || 0;
        if (!moved) continue;
        entry.family.subtypes.delete("Light Chordstream");
        entry.family.subtypeMass -= moved;
        entry.covered -= moved;
        speed.subtypes.set("Light Chordstream", (speed.subtypes.get("Light Chordstream") || 0) + moved);
        speed.subtypeMass += moved;
        speedCovered += moved;
    }
    if (speedEntry) speedEntry.covered = speedCovered;

    const totalMs = durationMs > 0 ? durationMs : 1;
    return {
        families: measured
            .map(({ family, covered }) => {
                const subtypes = [...family.subtypes.entries()]
                    .map(([name, mass]) => ({ name, share: family.subtypeMass > 0 ? mass / family.subtypeMass : 0 }))
                    .filter((s) => s.share >= MIN_SUBTYPE_SHARE)
                    .sort((a, b) => b.share - a.share)
                    .slice(0, MAX_SUBTYPES);
                return {
                    pattern: family.pattern === "Stream" ? "Speed" : family.pattern,
                    share: covered / totalMs,
                    amountMs: covered,
                    mixedShare: covered > 0 ? unionLength(family.mixedSpans) / covered : 0,
                    subtypes,
                };
            })
            .filter((f) => f.amountMs > 0)
            .sort((a, b) => b.share - a.share),
        clusters: [...clusters].sort((a, b) => b.Amount - a.Amount),
    };
}

export function categorise(families) {
    const top = families.find((f) => f.share > 0);
    if (!top) return "Uncategorised";
    const heaviest = top.subtypes.find((s) => s.share > 0.05);
    const name = heaviest ? heaviest.name : top.pattern;
    const tech = top.mixedShare > 0.5 ? " Tech" : "";
    return `${name}${tech}`;
}

export function clusterLabel(cluster, rate = 1) {
    const name = cluster.SpecificTypes.length ? cluster.SpecificTypes[0][0] : cluster.Pattern;
    const bpm = Math.round(Number(cluster.BPM) * rate);
    return cluster.Mixed ? `~${bpm}BPM Mixed ${name}` : `${bpm}BPM ${name}`;
}
