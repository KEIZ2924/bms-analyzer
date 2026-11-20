// Builds a synthetic osu!mania beatmap text from the neutral BMS model.
//
// Why an .osu text instead of a native parser object?
// Every om-analyzer entry point takes osu *text* and re-parses it, so a text
// bridge makes the whole pipeline (Sunny / Daniel / Azusa / Etterna MSD /
// Patterns / Interlude) work without touching a single line of their code.
//
// The only thing that has to stay exact is (column, start, end): the bridge
// writes column centers on the 512 px grid and integer milliseconds, which is
// exactly what OsuFileParser reconstructs.

const DEFAULT_OD = 8;

function columnToX(column, keys) {
    // OsuFileParser: trunc(x * K / 512) must give back `column`.
    return Math.round(((column + 0.5) * 512) / keys);
}

/**
 * Removes notes that a merged lane made illegal. osu!mania (and therefore
 * patternOsuParser) cannot represent these, so they have to be resolved before
 * the text is written:
 *  - duplicate (column, floor(time)) pairs -> dropped
 *  - a tap inside a long note of the same column -> the tap is dropped
 *    (this is what happens when the turntable lane is merged into key 1)
 *  - two overlapping long notes -> the first one is clipped, or demoted to a tap
 *
 * Returns { notes, clipped, deduped, droppedInsideLn }.
 */
export function sanitizeLaneNotes(notes) {
    const byColumn = new Map();
    for (const note of notes) {
        const column = note.column;
        if (!byColumn.has(column)) byColumn.set(column, []);
        byColumn.get(column).push({
            column,
            start: Math.round(note.start),
            end: note.end == null ? null : Math.round(note.end),
        });
    }

    const out = [];
    let clipped = 0;
    let deduped = 0;
    let droppedInsideLn = 0;

    for (const [column, lane] of byColumn) {
        lane.sort((a, b) => a.start - b.start || (a.end ?? -1) - (b.end ?? -1));
        const kept = [];
        for (const note of lane) {
            const prev = kept[kept.length - 1];
            if (prev && note.start <= prev.start) {
                deduped += 1;
                continue;
            }
            if (prev && prev.end != null && note.start < prev.end) {
                if (note.end != null) {
                    // two long notes: trim the earlier one so both survive
                    prev.end = Math.max(prev.start, note.start - 1);
                    clipped += 1;
                    if (prev.end <= prev.start) {
                        prev.end = null;
                    }
                } else {
                    droppedInsideLn += 1;
                    continue;
                }
            } else if (prev && prev.end != null && note.start === prev.end) {
                // A note exactly on the tail is legal in osu but patternOsuParser
                // still sees the cell as HOLDBODY at that instant and throws.
                prev.end -= 1;
                clipped += 1;
                if (prev.end <= prev.start) {
                    prev.end = null;
                }
            }
            kept.push(note);
        }
        for (const note of kept) {
            if (note.end != null && note.end <= note.start) {
                note.end = null;
                clipped += 1;
            }
            out.push(note);
        }
    }

    out.sort((a, b) => a.start - b.start || a.column - b.column);
    return { notes: out, clipped, deduped, droppedInsideLn };
}

/**
 * @param {object} input
 * @param {number} input.keys
 * @param {Array<{column:number,start:number,end:number|null}>} input.dedupedNotes
 */
export function buildOsuText({
    keys,
    notes,
    bpmPoints = [],
    title = "",
    artist = "",
    version = "",
    od = DEFAULT_OD,
}) {
    const safeKeys = Math.max(1, Math.min(18, Number(keys) || 4));
    const lines = [];

    lines.push("osu file format v14", "");
    lines.push("[General]");
    lines.push("AudioFilename: virtual.wav");
    lines.push("Mode: 3");
    lines.push("PreviewTime: -1");
    lines.push("");

    lines.push("[Metadata]");
    lines.push(`Title:${sanitizeText(title)}`);
    lines.push(`TitleUnicode:${sanitizeText(title)}`);
    lines.push(`Artist:${sanitizeText(artist)}`);
    lines.push("Creator:om-analyzer-bms");
    lines.push(`Version:${sanitizeText(version || "BMS")}`);
    lines.push("Source:");
    lines.push("Tags:bms converted");
    lines.push("");

    lines.push("[Difficulty]");
    lines.push("HPDrainRate:5");
    lines.push(`CircleSize:${safeKeys}`);
    lines.push(`OverallDifficulty:${Number.isFinite(Number(od)) ? Number(od) : DEFAULT_OD}`);
    lines.push("ApproachRate:5");
    lines.push("SliderMultiplier:1.4");
    lines.push("SliderTickRate:1");
    lines.push("");

    lines.push("[TimingPoints]");
    const seenTimes = new Map();
    for (const point of bpmPoints) {
        const t = Math.round(point.time);
        seenTimes.set(t, point.bpm);
    }
    const sortedTimes = [...seenTimes.keys()].sort((a, b) => a - b);
    if (!sortedTimes.length) {
        lines.push("0,500,4,2,1,100,1,0");
    } else {
        for (const t of sortedTimes) {
            const bpm = seenTimes.get(t);
            const beatLength = 60000 / bpm;
            lines.push(`${t},${beatLength.toFixed(6)},4,2,1,100,1,0`);
        }
    }
    lines.push("");

    lines.push("[HitObjects]");
    for (const note of notes) {
        const x = columnToX(note.column, safeKeys);
        const start = Math.round(note.start);
        if (note.end != null && note.end > note.start) {
            const end = Math.round(note.end);
            lines.push(`${x},192,${start},128,0,${end}:0:0:0:0:`);
        } else {
            lines.push(`${x},192,${start},1,0,0:0:0:0:`);
        }
    }
    lines.push("");

    return lines.join("\n");
}

function sanitizeText(value) {
    return String(value ?? "").replace(/:/g, "-").replace(/[\r\n]+/g, " ").trim();
}
