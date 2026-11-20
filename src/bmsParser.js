// BMS / BME / BML parser -> neutral note model.
// No dependencies. Times are in milliseconds from measure 0 beat 0.
//
// Lane ids follow the BMS channel order:
//   0..6 = keys 1..7 (channels 11,12,13,14,15,18,19)
//   7    = scratch  (channel 16)
// Lane 7 is kept as its own id so the caller can decide whether to keep,
// merge or drop the turntable lane.

const KEY_LANE_BY_CHANNEL = new Map([
    ["11", 0], ["12", 1], ["13", 2], ["14", 3],
    ["15", 4], ["18", 5], ["19", 6], ["16", 7],
]);

// long-note channels 51..59 mirror 11..19
const LN_LANE_BY_CHANNEL = new Map();
for (const [ch, lane] of KEY_LANE_BY_CHANNEL) {
    LN_LANE_BY_CHANNEL.set(String(Number(ch) + 40), lane);
}

const CHANNEL_BPM = "03";
const CHANNEL_EXT_BPM = "08";
const CHANNEL_STOP = "09";
const CHANNEL_MEASURE_LENGTH = "02";

export const SCRATCH_LANE = 7;

export function decodeBms(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return new TextDecoder("utf-8").decode(bytes.subarray(3));
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    }

    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        // BMS is overwhelmingly CP932 (Shift_JIS)
    }
    try {
        return new TextDecoder("shift_jis").decode(bytes);
    } catch {
        return new TextDecoder("utf-8").decode(bytes);
    }
}

function channelPriority(channel) {
    if (channel === CHANNEL_BPM || channel === CHANNEL_EXT_BPM) return 0;
    if (channel === CHANNEL_STOP) return 2;
    return 1;
}

function isNoteChannel(channel) {
    return KEY_LANE_BY_CHANNEL.has(channel);
}

function isLnChannel(channel) {
    return LN_LANE_BY_CHANNEL.has(channel);
}

/**
 * Parses BMS text into a neutral chart model.
 *
 * Returns:
 * {
 *   meta,                     // header values (title/artist/bpm/total/rank/...)
 *   notes: [{ lane, start, end|null, lns }],   // end is null for taps
 *   bpmPoints: [{ time, bpm }],
 *   measureRatios: Map<number, number>,
 *   scratchUsed: boolean,
 *   warnings: string[]
 * }
 */
export function parseBms(text, { randomSeedValue = 1 } = {}) {
    const headers = Object.create(null);
    const bpmDefs = new Map();
    const stopDefs = new Map();
    const measureRatios = new Map();
    const events = new Map(); // measure -> event[]
    const warnings = [];

    const stack = [];       // { kind: "random" | "if", ... }
    let skipping = 0;       // number of inactive #IF frames currently open

    const currentRandomValue = () => {
        for (let i = stack.length - 1; i >= 0; i -= 1) {
            if (stack[i].kind === "random") return stack[i].value;
        }
        return 1;
    };

    const lines = text.split(/\r\n|\r|\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line[0] === "*" || line.startsWith("//") || line[0] === ";") continue;
        if (line[0] !== "#") continue;

        // ---------- control flow ----------
        const cmdMatch = /^#([A-Za-z]+)([0-9]*)(.*)$/.exec(line);
        const dataMatch = /^#(\d{3})([0-9A-Za-z]{2}):(.*)$/.exec(line);

        if (dataMatch) {
            if (skipping > 0) continue;
            const measure = Number.parseInt(dataMatch[1], 10);
            const channel = dataMatch[2].toUpperCase();
            const payload = dataMatch[3].replace(/\s+\/\/.*$/, "").trim();
            if (!payload) continue;

            if (channel === CHANNEL_MEASURE_LENGTH) {
                const ratio = Number.parseFloat(payload);
                if (Number.isFinite(ratio) && ratio > 0) measureRatios.set(measure, ratio);
                continue;
            }

            if (!isNoteChannel(channel) && !isLnChannel(channel)
                && channel !== CHANNEL_BPM && channel !== CHANNEL_EXT_BPM
                && channel !== CHANNEL_STOP) {
                continue; // BGM(01), BGA(04/06/07), invisible(31..39), landmine(D1..E9), 2P lanes, ...
            }

            const body = payload.replace(/\s+/g, "");
            const pairs = [];
            for (let i = 0; i + 1 < body.length; i += 2) {
                pairs.push(body.slice(i, i + 2).toUpperCase());
            }
            if (body.length % 2 !== 0) {
                warnings.push(`measure ${measure} channel ${channel}: odd digit count, trailing digit ignored`);
            }
            if (!pairs.length) continue;

            const bucket = events.get(measure) || [];
            for (let i = 0; i < pairs.length; i += 1) {
                const obj = pairs[i];
                if (obj === "00") continue;
                bucket.push({ pos: i / pairs.length, channel, obj });
            }
            events.set(measure, bucket);
            continue;
        }

        if (!cmdMatch) continue;
        const name = cmdMatch[1].toUpperCase();
        const suffix = cmdMatch[2];
        const value = cmdMatch[3].trim();

        if (name === "RANDOM") {
            stack.push({ kind: "random", value: randomSeedValue });
            continue;
        }
        if (name === "IF" || name === "ELSEIF") {
            const frame = name === "IF" ? null : stack[stack.length - 1];
            if (name === "IF") {
                const parentActive = skipping === 0;
                const matched = Number.parseInt(value, 10) === currentRandomValue();
                const active = parentActive && matched;
                if (!active) skipping += 1;
                stack.push({ kind: "if", active, matched, parentActive });
            } else if (frame && frame.kind === "if") {
                const desired = !frame.matched && Number.parseInt(value, 10) === currentRandomValue();
                if (!frame.active && frame.parentActive && desired) skipping -= 1;
                else if (frame.active && !desired) skipping += 1;
                frame.active = frame.parentActive && desired;
                frame.matched = frame.matched || desired;
            }
            continue;
        }
        if (name === "ELSE") {
            const frame = stack[stack.length - 1];
            if (frame && frame.kind === "if") {
                const desired = !frame.matched;
                if (!frame.active && frame.parentActive && desired) skipping -= 1;
                else if (frame.active && !desired) skipping += 1;
                frame.active = frame.parentActive && desired;
                frame.matched = true;
            }
            continue;
        }
        if (name === "ENDIF" || name === "ENDRANDOM") {
            const frame = stack.pop();
            if (frame && frame.kind === "if" && !frame.active) skipping -= 1;
            continue;
        }

        if (skipping > 0) continue;

        // ---------- definitions ----------
        if (name === "BPM" && !suffix) {
            headers.BPM = value;
            continue;
        }
        if (name === "BPM" && suffix) {
            const bpm = Number.parseFloat(value);
            if (Number.isFinite(bpm) && bpm > 0) bpmDefs.set(suffix, bpm);
            continue;
        }
        if (name === "STOP" && suffix) {
            const stop = Number.parseFloat(value);
            if (Number.isFinite(stop)) stopDefs.set(suffix, stop);
            continue;
        }
        if (name === "LNOBJ") {
            headers.LNOBJ = value.toUpperCase();
            continue;
        }
        headers[name + suffix] = value;
    }

    // ---------- timeline ----------
    const maxMeasure = events.size ? Math.max(...events.keys()) : 0;
    let bpm = Number.parseFloat(headers.BPM);
    if (!Number.isFinite(bpm) || bpm <= 0) {
        bpm = 130;
        warnings.push("no #BPM header, assuming 130");
    }

    const bpmPoints = [{ time: 0, bpm }];
    const rawNotes = []; // { lane, time, obj, ln }

    let time = 0;
    for (let measure = 0; measure <= maxMeasure; measure += 1) {
        const measureRatio = measureRatios.get(measure) ?? 1;
        const beatsInMeasure = 4 * measureRatio;
        const evs = (events.get(measure) || []).slice().sort(
            (a, b) => (a.pos - b.pos) || (channelPriority(a.channel) - channelPriority(b.channel)),
        );

        let lastPos = 0;
        for (const ev of evs) {
            time += (ev.pos - lastPos) * beatsInMeasure * (60000 / bpm);
            lastPos = ev.pos;

            if (ev.channel === CHANNEL_BPM) {
                const next = Number.parseInt(ev.obj, 16);
                if (Number.isFinite(next) && next > 0) {
                    bpm = next;
                    bpmPoints.push({ time, bpm });
                }
            } else if (ev.channel === CHANNEL_EXT_BPM) {
                const next = bpmDefs.get(ev.obj);
                if (Number.isFinite(next) && next > 0) {
                    bpm = next;
                    bpmPoints.push({ time, bpm });
                }
            } else if (ev.channel === CHANNEL_STOP) {
                const stopUnits = stopDefs.get(ev.obj);
                if (Number.isFinite(stopUnits) && stopUnits > 0) {
                    // #STOP unit = 1/48 beat (192 units per 4/4 measure)
                    time += (stopUnits / 48) * (60000 / bpm);
                }
            } else {
                const tapLane = KEY_LANE_BY_CHANNEL.get(ev.channel);
                const lnLane = LN_LANE_BY_CHANNEL.get(ev.channel);
                if (tapLane == null && lnLane == null) continue;
                rawNotes.push({
                    lane: tapLane ?? lnLane,
                    time,
                    obj: ev.obj,
                    ln: tapLane == null,
                });
            }
        }
        time += (1 - lastPos) * beatsInMeasure * (60000 / bpm);
    }

    // ---------- long notes ----------
    const lnobj = headers.LNOBJ ? String(headers.LNOBJ).toUpperCase() : null;
    const byLane = new Map();
    for (const note of rawNotes) {
        if (!byLane.has(note.lane)) byLane.set(note.lane, []);
        byLane.get(note.lane).push(note);
    }
    for (const lane of byLane.keys()) {
        byLane.get(lane).sort((a, b) => a.time - b.time);
    }

    const notes = [];
    let scratchUsed = false;

    for (const [lane, laneNotes] of byLane) {
        if (lane === SCRATCH_LANE) scratchUsed = true;

        // 5x channels: consecutive objects delimit the long notes of that lane.
        const channelLn = laneNotes.filter((n) => n.ln);
        for (let i = 0; i + 1 < channelLn.length; i += 2) {
            const head = channelLn[i];
            const tail = channelLn[i + 1];
            if (tail.time > head.time) {
                notes.push({ lane, start: head.time, end: tail.time });
            } else {
                notes.push({ lane, start: head.time, end: null });
                notes.push({ lane, start: tail.time, end: null });
            }
        }
        if (channelLn.length % 2 === 1) {
            const orphan = channelLn[channelLn.length - 1];
            warnings.push(`lane ${lane}: unpaired long note at ${Math.round(orphan.time)} ms, kept as a tap`);
            notes.push({ lane, start: orphan.time, end: null });
        }

        // #LNOBJ: the object whose id equals LNOBJ terminates the previous note.
        let pending = null;
        const taps = [];
        for (const note of laneNotes) {
            if (note.ln) continue;
            if (lnobj && note.obj === lnobj) {
                if (pending) {
                    notes.push({ lane, start: pending.time, end: note.time });
                    pending = null;
                }
                continue;
            }
            if (pending) taps.push(pending);
            pending = note;
        }
        if (pending) taps.push(pending);

        for (const tap of taps) notes.push({ lane, start: tap.time, end: null });
    }

    notes.sort((a, b) => (a.start - b.start) || (a.lane - b.lane));

    const meta = {
        title: headers.TITLE || "",
        subtitle: headers.SUBTITLE || "",
        artist: headers.ARTIST || "",
        subartist: headers.SUBARTIST || "",
        genre: headers.GENRE || "",
        bpm: headers.BPM || "",
        playlevel: headers.PLAYLEVEL || "",
        difficulty: headers.DIFFICULTY || "",
        rank: headers.RANK || "",
        total: headers.TOTAL || "",
        lntype: headers.LNTYPE || "1",
        lnobj,
        player: headers.PLAYER || "",
        stagefile: headers.STAGEFILE || "",
    };

    return { meta, notes, bpmPoints, measureRatios, scratchUsed, warnings, headers };
}

/**
 * Collapses the lane model onto a concrete keymode.
 *
 * mode:
 *   "keep"  - every lane keeps its own column (scratch becomes column 0)
 *   "merge" - scratch notes are folded into key 1 (7 lanes for a 7-key chart)
 *   "drop"  - scratch notes are discarded
 *   "auto"  - keep when the resulting keycount is 4/6/7, otherwise merge
 *
 * Returns { keys, mode, notes: [{ column, start, end }], droppedNotes }
 */
export function toKeymode(chart, mode = "auto") {
    const usedLanes = new Set(chart.notes.map((n) => n.lane));
    const usesScratch = usedLanes.has(SCRATCH_LANE);
    const keyLanes = [...usedLanes].filter((l) => l !== SCRATCH_LANE);
    const keyCount = keyLanes.length ? Math.max(...keyLanes) + 1 : 0;

    const build = (resolved) => {
        const out = [];
        let dropped = 0;
        for (const note of chart.notes) {
            let column;
            if (note.lane === SCRATCH_LANE) {
                if (resolved === "drop") { dropped += 1; continue; }
                if (resolved === "merge") column = 0;
                else column = 0;
            } else {
                column = usesScratch && resolved === "keep" ? note.lane + 1 : note.lane;
            }
            out.push({ column, start: note.start, end: note.end });
        }
        const maxColumn = out.reduce((acc, n) => Math.max(acc, n.column), 0);
        return { keys: out.length ? maxColumn + 1 : keyCount, notes: out, dropped };
    };

    let resolved = mode;
    if (mode === "auto") {
        const keepKeys = build("keep").keys;
        resolved = [4, 6, 7].includes(keepKeys) ? "keep" : "merge";
    }

    const { keys, notes, dropped } = build(resolved);
    return { keys, mode: resolved, usesScratch, keyCount, notes, droppedNotes: dropped };
}
