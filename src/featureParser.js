// Port of plugins/BmsInfo/difficulty/BmsTimeline.cpp.
//
// This is deliberately *not* the same parse as src/bmsParser.js: the difficulty
// model was trained on the reference Python parser, which
//   * reads every #RANDOM branch (no branch selection),
//   * counts each end of a 5x long note as a separate note,
//   * ignores #STOP, #LNOBJ and #SCROLL,
//   * stops the chart at the last note rather than at the last measure.
// Matching those quirks is what keeps the features bit-comparable, so the chart
// statistics and the pattern pass keep using the ordinary parser.

const NAME_TO_LANE = new Map([
    [11, 0], [12, 1], [13, 2], [14, 3], [15, 4], [18, 5], [19, 6], [16, 7],
]);

function isSpace(c) {
    return c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\v" || c === "\f";
}

function trim(value) {
    let begin = 0;
    let end = value.length;
    while (begin < end && isSpace(value[begin])) begin++;
    while (end > begin && isSpace(value[end - 1])) end--;
    return value.slice(begin, end);
}

function isDigit(c) {
    return c >= "0" && c <= "9";
}

function isChannelChar(c) {
    const upper = c.toUpperCase();
    return isDigit(upper) || (upper >= "A" && upper <= "Z");
}

function parseNumber(text) {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text)) return null;
    const value = Number(text);
    return Number.isFinite(value) ? value : null;
}

function roundTo(value, decimals) {
    const scale = 10 ** decimals;
    return Math.round(value * scale) / scale;
}

function matchMainData(line) {
    if (line.length < 8 || line[0] !== "#") return null;
    for (let i = 1; i <= 3; i++) if (!isDigit(line[i])) return null;
    if (!isChannelChar(line[4]) || !isChannelChar(line[5])) return null;
    if (line[6] !== ":") return null;
    return {
        measure: Number(line.slice(1, 4)),
        channel: line.slice(4, 6).toUpperCase(),
        data: line.slice(7),
    };
}

function matchBpmExt(line) {
    if (line.length < 7 || line[0] !== "#") return null;
    if (line.slice(1, 4).toUpperCase() !== "BPM") return null;
    if (!isChannelChar(line[4]) || !isChannelChar(line[5])) return null;
    if (!isSpace(line[6])) return null;
    const text = trim(line.slice(6));
    const value = parseNumber(text);
    if (value === null) return null;
    return { key: line.slice(4, 6).toUpperCase(), value };
}

function matchHeader(line) {
    if (line.length < 4 || line[0] !== "#") return null;
    if (!/[A-Za-z]/.test(line[1])) return null;
    let i = 2;
    while (i < line.length) {
        const c = line[i];
        if (isDigit(c) || /[A-Za-z]/.test(c) || c === "_") i++;
        else break;
    }
    if (i >= line.length || !isSpace(line[i])) return null;
    const key = line.slice(1, i).toLowerCase();
    const value = trim(line.slice(i));
    return value ? { key, value } : null;
}

function hexValue(token) {
    let value = 0;
    for (const c of token) {
        const upper = c.toUpperCase();
        let digit;
        if (upper >= "0" && upper <= "9") digit = upper.charCodeAt(0) - 48;
        else if (upper >= "A" && upper <= "F") digit = upper.charCodeAt(0) - 55;
        else return -1;
        value = value * 16 + digit;
    }
    return value;
}

function beatsToMs(beats, bpm) {
    if (bpm <= 0) return 0;
    return (beats * 60000) / bpm;
}

/**
 * Parses a chart the way the difficulty network expects.
 * Returns { notes: [{timeMs, lane}], totalNotes, songLastMs, total }.
 */
export function parseTimeline(text) {
    const measureLengths = new Map();
    const extendedBpms = new Map();
    const headers = new Map();
    const events = [];

    for (const raw of text.split(/\r\n|\r|\n/)) {
        const line = trim(raw);
        if (line.length === 0) continue;
        if (line.startsWith("//")) continue;

        const main = matchMainData(line);
        if (main) {
            const payload = trim(main.data);
            if (main.channel === "02") {
                const value = parseNumber(payload);
                if (value !== null && value > 0) measureLengths.set(main.measure, value);
                continue;
            }
            if (payload.length < 2) continue;

            const count = Math.floor(payload.length / 2);
            for (let i = 0; i < count; i++) {
                const token = payload.slice(i * 2, i * 2 + 2);
                if (token === "00") continue;
                const fraction = i / count;
                const value = (main.channel.charCodeAt(0) - 48) * 10 +
                    (main.channel.charCodeAt(1) - 48);
                // 51..59 are the long-note channels and repeat the 11..19 mapping.
                const base = value >= 50 && value <= 59 ? value - 40 : value;
                const lane = NAME_TO_LANE.get(base);
                if (lane !== undefined) {
                    events.push({ measure: main.measure, fraction, lane, isBpm: false, bpm: 0 });
                    continue;
                }
                if (main.channel === "03") {
                    const bpm = hexValue(token);
                    if (bpm < 0) continue;
                    events.push({ measure: main.measure, fraction, lane: -1, isBpm: true, bpm });
                    continue;
                }
                if (main.channel === "08") {
                    const found = extendedBpms.get(token);
                    if (found === undefined) continue;
                    events.push({ measure: main.measure, fraction, lane: -1, isBpm: true, bpm: found });
                }
            }
            continue;
        }

        const bpmExt = matchBpmExt(line);
        if (bpmExt) {
            extendedBpms.set(bpmExt.key, bpmExt.value);
            continue;
        }
        const header = matchHeader(line);
        if (header) headers.set(header.key, header.value);
    }

    let baseBpm = 120;
    const bpmHeader = headers.get("bpm");
    if (bpmHeader !== undefined) {
        const parsed = parseNumber(bpmHeader);
        if (parsed !== null && parsed > 0) baseBpm = parsed;
    }

    if (events.length === 0) return null;

    let maxMeasure = 0;
    for (const event of events) maxMeasure = Math.max(maxMeasure, event.measure);
    for (const measure of measureLengths.keys()) maxMeasure = Math.max(maxMeasure, measure);

    const byMeasure = new Map();
    for (const event of events) {
        if (!byMeasure.has(event.measure)) byMeasure.set(event.measure, []);
        byMeasure.get(event.measure).push(event);
    }

    const notes = [];
    let now = 0;
    let bpm = baseBpm;

    for (let measure = 0; measure <= maxMeasure; measure++) {
        const ratio = measureLengths.get(measure) ?? 1;
        const measureBeats = 4 * ratio;
        let lastFraction = 0;

        const found = byMeasure.get(measure);
        if (found) {
            const groups = new Map();
            for (const event of found) {
                const key = roundTo(event.fraction, 10);
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key).push(event);
            }
            const keys = [...groups.keys()].sort((a, b) => a - b);
            for (const key of keys) {
                now += beatsToMs((key - lastFraction) * measureBeats, bpm);
                const group = groups.get(key);
                for (const event of group) {
                    if (event.lane < 0) continue;
                    notes.push({ timeMs: now, lane: event.lane });
                }
                for (const event of group) {
                    if (event.isBpm) bpm = event.bpm;
                }
                lastFraction = key;
            }
        }
        now += beatsToMs((1 - lastFraction) * measureBeats, bpm);
    }

    if (notes.length === 0) return null;
    notes.sort((a, b) => a.timeMs - b.timeMs);

    let total = 200;
    const totalHeader = headers.get("total");
    if (totalHeader !== undefined) {
        const parsed = parseNumber(totalHeader);
        if (parsed !== null && parsed > 0) total = parsed;
    }

    return {
        notes,
        totalNotes: notes.length,
        songLastMs: notes[notes.length - 1].timeMs,
        total,
    };
}
