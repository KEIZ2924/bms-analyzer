// Port of plugins/BmsInfo/difficulty/ChartFeatures.cpp (itself a port of the
// training-time Python feature extractor).
//
// The numbers here have to match the C++ side bit for bit, because the model was
// trained on those exact inputs.  Two numpy behaviours matter:
//   * np.cumsum on a float32 array accumulates in float32 even when the result is
//     later upcast, so the marked arrays below accumulate through Math.fround.
//   * np.round is half-to-even, and np.searchsorted(..., side='left') returns the
//     first index whose value is >= the probe.

const F = Math.fround;

const TIME_LIMIT = 400;
const LANE_COUNT = 7;
const ALL_COUNT = 8;
const FEATURE_DIM = 46;
const WINDOW_COUNT = 600;
const WINDOW_MS = 600;
const WINDOW_STRIDE = 200;

function round6(value) {
    return Math.round(value * 1e6) / 1e6;
}

function roundHalfEven(value) {
    const floor = Math.floor(value);
    const diff = value - floor;
    if (diff > 0.5) return floor + 1;
    if (diff < 0.5) return floor;
    return floor % 2 === 0 ? floor : floor + 1;
}

/** Cumulative sum over `values`, either in float64 or in float32 like numpy. */
function cumsum(values, asFloat32) {
    const out = new Float64Array(values.length + 1);
    if (asFloat32) {
        let acc = 0;
        for (let i = 0; i < values.length; i++) {
            acc = F(acc + F(values[i]));
            out[i + 1] = acc;
        }
    } else {
        let acc = 0;
        for (let i = 0; i < values.length; i++) {
            acc += values[i];
            out[i + 1] = acc;
        }
    }
    return out;
}

/** Cumulative sum per column of a row-major `rows x cols` matrix. */
function cumsum2(values, rows, cols, asFloat32) {
    const out = new Float64Array((rows + 1) * cols);
    for (let c = 0; c < cols; c++) {
        if (asFloat32) {
            let acc = 0;
            for (let i = 0; i < rows; i++) {
                acc = F(acc + F(values[i * cols + c]));
                out[(i + 1) * cols + c] = acc;
            }
        } else {
            let acc = 0;
            for (let i = 0; i < rows; i++) {
                acc += values[i * cols + c];
                out[(i + 1) * cols + c] = acc;
            }
        }
    }
    return out;
}

function toDouble(values) {
    return values instanceof Float64Array ? values : Float64Array.from(values);
}

/** Port of get_centroid_drift(): mean posture over the last k rows, then drift. */
function centroidDrift(data, cols, times, rows, lagCount, limit, out) {
    const accLane = new Float32Array(rows * cols);
    const accCount = new Float32Array(rows);

    for (let lag = 1; lag <= lagCount; lag++) {
        for (let r = 0; r < rows; r++) {
            let src = (r - lag) % rows;
            if (src < 0) src += rows;
            if (!(times[r] - times[src] <= limit && r >= lag)) continue;
            for (let c = 0; c < cols; c++) {
                accLane[r * cols + c] = F(accLane[r * cols + c] + F(data[src * cols + c]));
            }
            accCount[r] = F(accCount[r] + 1);
        }
    }

    for (let r = 0; r < rows; r++) {
        const safe = accCount[r] > 1 ? accCount[r] : 1;
        let drift = 0;
        for (let c = 0; c < cols; c++) {
            const posture = F(accLane[r * cols + c] / safe);
            drift += Math.abs(data[r * cols + c] - posture);
        }
        out[r] = accCount[r] > 0 ? drift : 0;
    }
}

/** Port of extract_stream_features_global(). */
function computeStreams(model, active, strokes, crossings) {
    const { n, times, lane } = model;
    const eventIndex = [];
    const laneIndex = [];
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < LANE_COUNT; j++) {
            if (lane[i * LANE_COUNT + j] !== 0) {
                eventIndex.push(i);
                laneIndex.push(j);
            }
        }
    }
    const m = eventIndex.length;
    if (m === 0) return;

    const eventTimes = new Float64Array(m);
    for (let i = 0; i < m; i++) eventTimes[i] = times[eventIndex[i]];

    const nextNode = new Int32Array(m).fill(-1);
    const inDegree = new Int32Array(m);

    const MAX_TIME = 100;
    const MAX_LANE = 4;
    const TIME_PENALTY = 0.015;
    const LOOKAHEAD = 8;

    for (let i = 0; i < m; i++) {
        const end = Math.min(i + 1 + LOOKAHEAD, m);
        if (i + 1 === end) continue;
        let best = -1;
        let bestCost = 0;
        for (let k = i + 1; k < end; k++) {
            const dt = eventTimes[k] - eventTimes[i];
            const dist = Math.abs(laneIndex[k] - laneIndex[i]);
            if (!(dt <= MAX_TIME && dist <= MAX_LANE && inDegree[k] === 0)) continue;
            const cost = dist + TIME_PENALTY * dt;
            if (best < 0 || cost < bestCost) {
                best = k;
                bestCost = cost;
            }
        }
        if (best >= 0) {
            nextNode[i] = best;
            inDegree[best] += 1;
        }
    }

    const edges = [];
    for (let start = 0; start < m; start++) {
        if (inDegree[start] !== 0) continue;
        let curr = start;
        let currentDir = 0;
        while (nextNode[curr] !== -1) {
            const nxt = nextNode[curr];
            const evU = eventIndex[curr];
            const evV = eventIndex[nxt];
            const tU = eventTimes[curr];
            const tV = eventTimes[nxt];
            const lU = laneIndex[curr];
            const lV = laneIndex[nxt];
            edges.push({ evU, tU, lU, evV, tV, lV });

            for (let r = evU; r < evV; r++) active[r] = F(active[r] + 1);

            const distVal = lV - lU;
            if (distVal !== 0) {
                const newDir = distVal > 0 ? 1 : -1;
                if (currentDir !== newDir) {
                    strokes[evV] = F(strokes[evV] + 1);
                    currentDir = newDir;
                }
            }
            curr = nxt;
        }
    }

    edges.sort((a, b) => a.tU - b.tU);   // stable in V8 for this size, and ties are rare

    for (let i = 0; i < edges.length; i++) {
        const a = edges[i];
        for (let j = i + 1; j < edges.length; j++) {
            const b = edges[j];
            if (b.tU > a.tV) break;
            if (Math.min(a.tU, a.tV) > Math.max(b.tU, b.tV) ||
                Math.min(b.tU, b.tV) > Math.max(a.tU, a.tV)) continue;

            const ccw = (tA, lA, tB, lB, tC, lC) =>
                (tC - tA) * (lB - lA) > (tB - tA) * (lC - lA);
            const c1 = ccw(a.tU, a.lU, b.tU, b.lU, b.tV, b.lV);
            const c2 = ccw(a.tV, a.lV, b.tU, b.lU, b.tV, b.lV);
            const c3 = ccw(a.tU, a.lU, a.tV, a.lV, b.tU, b.lU);
            const c4 = ccw(a.tU, a.lU, a.tV, a.lV, b.tV, b.lV);
            if ((c1 !== c2) && (c3 !== c4)) {
                const crossEvent = Math.max(a.evU, b.evU);
                crossings[crossEvent] = F(crossings[crossEvent] + 1);
            }
        }
    }
}

/** Builds every cumulative array the window features need. */
function computeModel(notes, total, totalNotes, songLastMs) {
    const sorted = notes
        .filter((note) => note.lane >= 0 && note.lane <= 7 && Number.isFinite(note.timeMs))
        .map((note, index) => ({ t: note.timeMs, lane: note.lane, index }))
        .sort((a, b) => (a.t - b.t) || (a.index - b.index));

    const times = [];
    const lanes = [];
    const all = [];
    for (const note of sorted) {
        const grouped = round6(note.t);
        if (times.length === 0 || grouped !== times[times.length - 1]) {
            times.push(grouped);
            for (let j = 0; j < LANE_COUNT; j++) lanes.push(0);
            for (let j = 0; j < ALL_COUNT; j++) all.push(0);
        }
        const row = times.length - 1;
        if (note.lane < LANE_COUNT) lanes[row * LANE_COUNT + note.lane] = 1;
        all[row * ALL_COUNT + note.lane] = 1;
    }

    const n = times.length;
    const model = { n, times, lane: lanes, all };
    if (n === 0) return model;

    let lastMs = Number.isFinite(songLastMs) ? songLastMs : 0;
    if (lastMs > 1e9) lastMs = 1e9;
    const maxMs = Math.max(0, Math.ceil(lastMs));
    model.maxMs = maxMs;

    const msToIdx = new Int32Array(maxMs + 2);
    let current = 0;
    for (let ms = 0; ms <= maxMs; ms++) {
        while (current < n && times[current] < ms) current++;
        msToIdx[ms] = current;
    }
    msToIdx[maxMs + 1] = n;
    model.msToIdx = msToIdx;

    const intervals = new Float64Array(n);
    const ncpe = new Float64Array(n);
    const chordIds = new Int32Array(n);
    intervals[0] = 100;
    for (let i = 1; i < n; i++) intervals[i] = times[i] - times[i - 1];

    const buttonPerEvent = new Float64Array(n);
    const scratchPerEvent = new Float64Array(n);
    const ones = new Float64Array(n).fill(1);

    for (let i = 0; i < n; i++) {
        let button = 0;
        let allSum = 0;
        for (let j = 0; j < LANE_COUNT; j++) {
            button += lanes[i * LANE_COUNT + j];
            allSum += all[i * ALL_COUNT + j];
        }
        allSum += all[i * ALL_COUNT + LANE_COUNT];
        buttonPerEvent[i] = button;
        scratchPerEvent[i] = all[i * ALL_COUNT + LANE_COUNT];
        ncpe[i] = allSum;

        let id = 0;
        for (let j = 0; j < ALL_COUNT; j++) {
            if (all[i * ALL_COUNT + j] !== 0) id |= 1 << j;
        }
        chordIds[i] = allSum < 2 ? 0 : id;
    }

    const getIdx = (t) => {
        if (!(t > 0)) return msToIdx[0];
        if (t >= maxMs) return msToIdx[maxMs];
        return msToIdx[Math.trunc(t)];
    };
    model.getIdx = getIdx;

    const laneCountCum = cumsum2(lanes, n, LANE_COUNT, false);
    const notesCountCum = cumsum(ncpe, false);
    const buttonCountCum = cumsum(buttonPerEvent, false);
    const scratchCountCum = cumsum(scratchPerEvent, false);
    const simulCountCum = cumsum(ones, false);

    const buttonMoving = new Float64Array(n);
    const scratchMoving = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const t = times[i];
        const idxS = getIdx(t - 25);
        const idxE = getIdx(t + 25);
        buttonMoving[i] = buttonCountCum[idxE] - buttonCountCum[idxS];
        scratchMoving[i] = scratchCountCum[idxE] - scratchCountCum[idxS];
    }

    const interaction = new Float64Array(n);
    for (let i = 0; i < n; i++) interaction[i] = buttonMoving[i] * scratchPerEvent[i];
    const buttonScratchInteractionCum = cumsum(interaction, false);

    const isFast = new Float64Array(n);
    const movementPure = new Float64Array(n);
    const jitterStep = new Float64Array(n);
    const sizeDeltas = new Float64Array(n);
    const persistenceMs = new Float64Array(n);

    for (let i = 0; i < n; i++) isFast[i] = intervals[i] <= 40 ? 1 : 0;
    isFast[0] = 0;

    for (let i = 0; i < n; i++) {
        let movement = 0;
        for (let j = 0; j < LANE_COUNT; j++) {
            const prev = i === 0 ? 0 : lanes[(i - 1) * LANE_COUNT + j];
            movement += Math.abs(lanes[i * LANE_COUNT + j] - prev);
        }
        movementPure[i] = intervals[i] <= TIME_LIMIT ? movement : 0;

        const jitter = i > 0 ? Math.abs(intervals[i] - intervals[i - 1]) : 0;
        jitterStep[i] = intervals[i] <= TIME_LIMIT ? jitter : 0;

        const sizeDelta = i > 0 ? Math.abs(ncpe[i] - ncpe[i - 1]) : 0;
        sizeDeltas[i] = intervals[i] <= TIME_LIMIT ? sizeDelta : 0;

        if (i > 0 && isFast[i] > 0 && isFast[i - 1] > 0) persistenceMs[i] = intervals[i];
    }

    const delayTimingCum = cumsum(isFast, true);
    const delayedMovement = new Float64Array(n);
    for (let i = 0; i < n; i++) delayedMovement[i] = movementPure[i] * isFast[i];
    const delayMovementCum = cumsum(delayedMovement, false);
    const rhythmJitterCum = cumsum(jitterStep, false);
    const delayPersistenceCum = cumsum(persistenceMs, false);

    const chordCounts2dCum = new Float64Array((n + 1) * 9);
    {
        const hist = new Float64Array(9);
        for (let i = 1; i <= n; i++) {
            const size = ncpe[i - 1];
            if (size >= 1 && size <= 8) hist[size] += 1;
            let run = 0;
            for (let c = 1; c <= 8; c++) {
                run += hist[c];
                chordCounts2dCum[i * 9 + c] = run;
            }
        }
    }

    const chordSizeDeltaCum = cumsum(sizeDeltas, false);

    let chordOscillationCum;
    let heavyHitJitterCum;
    let shapeFluxCum;
    {
        const tmp = new Float64Array(n);
        const heavy = new Float64Array(n);
        const flux = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            let v = i > 0 ? ncpe[i] - ncpe[i - 1] : 0;
            if (intervals[i] > TIME_LIMIT) v = 0;
            tmp[i] = v;
        }
        const prev = new Float64Array(n);
        for (let i = 1; i < n; i++) prev[i] = tmp[i - 1];

        for (let i = 0; i < n; i++) {
            const product = tmp[i] * prev[i];
            const oscillation = product < 0 ? Math.abs(product) : 0;
            const prevSize = i === 0 ? 0 : ncpe[i - 1];
            heavy[i] = intervals[i] <= TIME_LIMIT ? prevSize * jitterStep[i] : 0;
            flux[i] = intervals[i] <= TIME_LIMIT
                ? sizeDeltas[i] * (1000 / (intervals[i] + 10))
                : 0;
            tmp[i] = oscillation;
        }
        chordOscillationCum = cumsum(tmp, false);
        heavyHitJitterCum = cumsum(heavy, false);
        shapeFluxCum = cumsum(flux, false);
    }

    const laneJack = new Float64Array(n * LANE_COUNT);
    {
        const tStart = 140;
        const span = 10;
        for (let j = 0; j < LANE_COUNT; j++) {
            const act = [];
            for (let i = 0; i < n; i++) {
                if (lanes[i * LANE_COUNT + j] !== 0) act.push(i);
            }
            if (act.length <= 1) continue;
            for (let k = 1; k < act.length; k++) {
                const dist = times[act[k]] - times[act[k - 1]];
                let w = (tStart - dist) / span;
                if (w < 0) w = 0;
                else if (w > 1) w = 1;
                laneJack[act[k] * LANE_COUNT + j] = F(w * (tStart - dist));
            }
        }
    }
    const laneJackCum = cumsum2(laneJack, n, LANE_COUNT, true);

    const isJackEvt = new Float64Array(n);
    let isJackEvtCum;
    let jackChordSizeCum;
    let jackChordSizeSqCum;
    let jackChordConflictDelayCum;
    {
        const jackSize = new Float64Array(n);
        const jackSizeSq = new Float64Array(n);
        const conflict = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            let totalJack = 0;
            let count = 0;
            for (let j = 0; j < LANE_COUNT; j++) {
                const v = laneJack[i * LANE_COUNT + j];
                totalJack += v;
                if (v > 0) count++;
            }
            const flag = totalJack > 0 ? 1 : 0;
            isJackEvt[i] = flag;
            jackSize[i] = ncpe[i] * flag;
            jackSizeSq[i] = ncpe[i] * ncpe[i] * flag;
            conflict[i] = count * (buttonMoving[i] + scratchMoving[i]);
        }
        isJackEvtCum = cumsum(isJackEvt, true);
        jackChordSizeCum = cumsum(jackSize, false);
        jackChordSizeSqCum = cumsum(jackSizeSq, false);
        jackChordConflictDelayCum = cumsum(conflict, false);
    }

    let movementCum;
    let movementInteractionCum;
    let movementStayedCum;
    let stayedCountCum;
    {
        const movementInteraction = new Float64Array(n);
        const stayed = new Float64Array(n);
        const stayedWeighted = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            movementInteraction[i] = movementPure[i] * ncpe[i];
            let count = 0;
            if (intervals[i] <= TIME_LIMIT) {
                for (let j = 0; j < LANE_COUNT; j++) {
                    const cur = lanes[i * LANE_COUNT + j];
                    const prev = i === 0 ? 0 : lanes[(i - 1) * LANE_COUNT + j];
                    if (cur === 1 && prev === 1) count += 1;
                }
            }
            stayed[i] = count;
            stayedWeighted[i] = movementPure[i] * count;
        }
        movementCum = cumsum(movementPure, false);
        movementInteractionCum = cumsum(movementInteraction, false);
        movementStayedCum = cumsum(stayedWeighted, false);
        stayedCountCum = cumsum(stayed, false);
    }

    const movementLag = [];
    for (let lag = 2; lag <= 4; lag++) {
        const mov = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const laggedTime = i < lag ? -1e9 : times[i - lag];
            const dt = times[i] - laggedTime;
            let d = 0;
            for (let j = 0; j < LANE_COUNT; j++) {
                const lagged = i < lag ? 0 : lanes[(i - lag) * LANE_COUNT + j];
                d += Math.abs(lanes[i * LANE_COUNT + j] - lagged);
            }
            mov[i] = dt <= TIME_LIMIT ? d : 0;
        }
        movementLag.push(cumsum(mov, false));
    }

    let centroidDriftCum;
    let triangleGapCum;
    {
        const drift = new Float64Array(n);
        centroidDrift(lanes, LANE_COUNT, times, n, 4, TIME_LIMIT, drift);
        centroidDriftCum = cumsum(drift, false);

        const h2 = new Float64Array(n);
        const gap = new Float64Array(n);
        if (n > 2) {
            for (let i = 2; i < n; i++) {
                const dt2 = times[i] - times[i - 2];
                let d2 = 0;
                for (let j = 0; j < LANE_COUNT; j++) {
                    d2 += Math.abs(lanes[i * LANE_COUNT + j] - lanes[(i - 2) * LANE_COUNT + j]);
                }
                h2[i] = dt2 <= TIME_LIMIT ? d2 : 0;
            }
            for (let i = 2; i < n; i++) {
                const g = movementPure[i] + movementPure[i - 1] - h2[i];
                gap[i] = g > 0 ? g : 0;
            }
        }
        triangleGapCum = cumsum(gap, false);
    }

    let clusteredMovement40Cum;
    let clusteredStrikeCount40Cum;
    let clusteredStrikeJitter40Cum;
    let clusteredStrikeSize40Cum;
    let clusteredStrikeSizeSq40Cum;
    let driftStrike40Cum;
    let gapStrike40Cum;
    let laneStrike40Cum;
    {
        const starts = new Float64Array(n);
        starts[0] = 1;
        const configs = [];
        const active = all.slice(0, ALL_COUNT);
        let currentStart = 0;

        for (let i = 1; i < n; i++) {
            const dt = times[i] - times[currentStart];
            let conflict = false;
            for (let j = 0; j < ALL_COUNT; j++) {
                if (all[i * ALL_COUNT + j] > 0 && active[j] > 0) {
                    conflict = true;
                    break;
                }
            }
            if (dt <= 40 && !conflict) {
                for (let j = 0; j < ALL_COUNT; j++) {
                    const v = all[i * ALL_COUNT + j];
                    if (v > active[j]) active[j] = v;
                }
            } else {
                configs.push(...active);
                starts[i] = 1;
                currentStart = i;
                for (let j = 0; j < ALL_COUNT; j++) active[j] = all[i * ALL_COUNT + j];
            }
        }
        configs.push(...active);

        const strikeIndices = [];
        for (let i = 0; i < n; i++) if (starts[i] !== 0) strikeIndices.push(i);
        const m = strikeIndices.length;

        const strikeTimes = new Float64Array(m);
        for (let k = 0; k < m; k++) strikeTimes[k] = times[strikeIndices[k]];

        const strikeKeys = new Float64Array(m * LANE_COUNT);
        const clusterSizes = new Float64Array(m);
        for (let k = 0; k < m; k++) {
            let sum = 0;
            for (let j = 0; j < ALL_COUNT; j++) {
                const v = configs[k * ALL_COUNT + j];
                sum += v;
                if (j < LANE_COUNT) strikeKeys[k * LANE_COUNT + j] = v;
            }
            clusterSizes[k] = sum;
        }

        const driftS = new Float64Array(m);
        const gapS = new Float64Array(m);
        const h1S = new Float64Array(m);

        if (m > 1) {
            centroidDrift(strikeKeys, LANE_COUNT, strikeTimes, m, 4, TIME_LIMIT, driftS);

            const diffS = new Float64Array(m);
            for (let k = 0; k < m; k++) {
                let d = 0;
                for (let j = 0; j < LANE_COUNT; j++) {
                    const prev = k === 0 ? 0 : strikeKeys[(k - 1) * LANE_COUNT + j];
                    d += Math.abs(strikeKeys[k * LANE_COUNT + j] - prev);
                }
                diffS[k] = d;
            }
            for (let k = 0; k < m; k++) {
                const dt1 = k === 0 ? 1000 : strikeTimes[k] - strikeTimes[k - 1];
                h1S[k] = dt1 <= TIME_LIMIT ? diffS[k] : 0;
            }

            if (m > 2) {
                for (let k = 2; k < m; k++) {
                    const dt2 = strikeTimes[k] - strikeTimes[k - 2];
                    let d2 = 0;
                    for (let j = 0; j < LANE_COUNT; j++) {
                        d2 += Math.abs(strikeKeys[k * LANE_COUNT + j] -
                            strikeKeys[(k - 2) * LANE_COUNT + j]);
                    }
                    const h2Value = dt2 <= TIME_LIMIT ? d2 : 0;
                    const g = h1S[k] + h1S[k - 1] - h2Value;
                    gapS[k] = g > 0 ? g : 0;
                }
            }
        }

        const driftTimeline = new Float64Array(n);
        const gapTimeline = new Float64Array(n);
        const moveTimeline = new Float64Array(n);
        const laneTimeline = new Float64Array(n * LANE_COUNT);
        const sizeSum = new Float64Array(n);
        const sizeSq = new Float64Array(n);
        const jitter = new Float64Array(n);

        for (let k = 0; k < m; k++) {
            const idx = strikeIndices[k];
            driftTimeline[idx] = F(driftS[k]);
            gapTimeline[idx] = F(gapS[k]);
            moveTimeline[idx] = F(h1S[k]);
            for (let j = 0; j < LANE_COUNT; j++) {
                laneTimeline[idx * LANE_COUNT + j] = F(strikeKeys[k * LANE_COUNT + j]);
            }
            sizeSum[idx] = F(clusterSizes[k]);
            sizeSq[idx] = F(clusterSizes[k] * clusterSizes[k]);
        }

        if (m > 2) {
            const strikeIntervals = new Float64Array(m - 1);
            for (let k = 0; k + 1 < m; k++) strikeIntervals[k] = strikeTimes[k + 1] - strikeTimes[k];
            const strikeJitter = new Float64Array(m - 1);
            for (let k = 0; k + 1 < m; k++) {
                const prev = k === 0 ? strikeIntervals[0] : strikeIntervals[k - 1];
                strikeJitter[k] = Math.abs(strikeIntervals[k] - prev);
            }
            for (let k = 1; k < m; k++) {
                let v = strikeJitter[k - 1];
                if (v > 400) v = 400;
                jitter[strikeIndices[k]] = F(v);
            }
        }

        clusteredMovement40Cum = cumsum(moveTimeline, true);
        clusteredStrikeCount40Cum = cumsum(starts, true);
        clusteredStrikeJitter40Cum = cumsum(jitter, true);
        clusteredStrikeSize40Cum = cumsum(sizeSum, true);
        clusteredStrikeSizeSq40Cum = cumsum(sizeSq, true);
        driftStrike40Cum = cumsum(driftTimeline, true);
        gapStrike40Cum = cumsum(gapTimeline, true);
        laneStrike40Cum = cumsum2(laneTimeline, n, LANE_COUNT, true);
    }

    const streamActive = new Float64Array(n);
    const streamStrokes = new Float64Array(n);
    const streamCrossings = new Float64Array(n);
    computeStreams(model, streamActive, streamStrokes, streamCrossings);

    Object.assign(model, {
        total,
        totalNotes,
        intervals,
        ncpe,
        chordIds,
        buttonMoving,
        scratchMoving,
        cum: {
            laneCount: laneCountCum,
            notesCount: notesCountCum,
            buttonCount: buttonCountCum,
            scratchCount: scratchCountCum,
            simulCount: simulCountCum,
            buttonScratchInteraction: buttonScratchInteractionCum,
            rhythmJitter: rhythmJitterCum,
            delayPersistence: delayPersistenceCum,
            chordCounts2d: chordCounts2dCum,
            chordSizeDelta: chordSizeDeltaCum,
            chordOscillation: chordOscillationCum,
            heavyHitJitter: heavyHitJitterCum,
            shapeFlux: shapeFluxCum,
            laneJack: laneJackCum,
            isJackEvt: isJackEvtCum,
            jackChordSize: jackChordSizeCum,
            jackChordSizeSq: jackChordSizeSqCum,
            jackChordConflictDelay: jackChordConflictDelayCum,
            movement: movementCum,
            movementInteraction: movementInteractionCum,
            movementStayed: movementStayedCum,
            stayedCount: stayedCountCum,
            movementLag2: movementLag[0],
            movementLag3: movementLag[1],
            movementLag4: movementLag[2],
            centroidDrift: centroidDriftCum,
            triangleGap: triangleGapCum,
            clusteredMovement40: clusteredMovement40Cum,
            clusteredStrikeCount40: clusteredStrikeCount40Cum,
            clusteredStrikeJitter40: clusteredStrikeJitter40Cum,
            clusteredStrikeSize40: clusteredStrikeSize40Cum,
            clusteredStrikeSizeSq40: clusteredStrikeSizeSq40Cum,
            driftStrike40: driftStrike40Cum,
            gapStrike40: gapStrike40Cum,
            laneStrike40: laneStrike40Cum,
            streamActive: cumsum(streamActive, true),
            streamStrokes: cumsum(streamStrokes, true),
            streamCrossings: cumsum(streamCrossings, true),
        },
    });
    return model;
}

function lowerBoundLeft(array, length, value) {
    let i = 0;
    while (i < length && array[i] < value) i++;
    return i;
}

function meanOf(values) {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
}

/** Port of get_window_meta(): one 46-dimensional row per 600 ms window. */
function buildWindowMeta(model, timeStart, timeEnd, out) {
    out.fill(0);
    const { getIdx, n, intervals, times } = model;
    const cum = model.cum;

    const idxS = getIdx(timeStart);
    const idxE = getIdx(timeEnd);
    const from = (array) => array[Math.min(idxE, array.length - 1)] - array[Math.min(idxS, array.length - 1)];

    const buttonCount = from(cum.buttonCount);
    const scratchCount = from(cum.scratchCount);
    const total = model.total;
    const totalNotes = model.totalNotes;

    let recovery = 0;
    if (totalNotes > 0) recovery = total * (buttonCount + scratchCount) / totalNotes;

    const idxW2S = getIdx(timeStart - 2000);

    const buttonScratchInteraction = from(cum.buttonScratchInteraction);

    const laneCounts = new Float64Array(LANE_COUNT);
    for (let j = 0; j < LANE_COUNT; j++) {
        laneCounts[j] = cum.laneCount[idxE * LANE_COUNT + j] - cum.laneCount[idxS * LANE_COUNT + j];
    }

    let laneBiasEntropy = 0;
    if (buttonCount > 0) {
        let sum = 0;
        for (let j = 0; j < LANE_COUNT; j++) {
            const r = laneCounts[j] / buttonCount;
            sum += r * Math.log(r + 1e-9);
        }
        laneBiasEntropy = -sum;
    }

    const simulCount = from(cum.simulCount);
    const rhythmJitter = Math.log1p(simulCount > 0 ? from(cum.rhythmJitter) / simulCount : 0);
    const delayPersistence = from(cum.delayPersistence);

    let chordMean = 0;
    let chordSizeDelta = 0;
    let chordQ1 = 0;
    let chordQ2 = 0;
    let chordQ3 = 0;
    let chordPatternCountPerSimul = 0;
    let oscillation = 0;
    let heavyHitJitter = 0;
    let shapeFlux = 0;

    if (simulCount > 0) {
        chordMean = (buttonCount + scratchCount) / simulCount;
        chordSizeDelta = from(cum.chordSizeDelta) / simulCount;

        const windowCum = new Float64Array(8);
        for (let c = 1; c <= 8; c++) {
            windowCum[c - 1] = cum.chordCounts2d[idxE * 9 + c] - cum.chordCounts2d[idxS * 9 + c];
        }

        const getPercentile = (p) => {
            const position = (simulCount - 1) * p;
            const low = Math.floor(position);
            const high = Math.ceil(position);
            const idxL = Math.min(lowerBoundLeft(windowCum, 8, low + 1), 7);
            const idxH = Math.min(lowerBoundLeft(windowCum, 8, high + 1), 7);
            const vL = idxL + 1;
            const vH = idxH + 1;
            return vL + (position - low) * (vH - vL);
        };
        chordQ1 = getPercentile(0.25);
        chordQ2 = getPercentile(0.5);
        chordQ3 = getPercentile(0.75);

        let chordPatternCount = 0;
        if (idxE > idxS) {
            const seen = new Set();
            for (let i = idxS; i < idxE; i++) {
                const id = model.chordIds[i];
                if (id > 0 && id < 256) seen.add(id);
            }
            chordPatternCount = seen.size;
        }
        chordPatternCountPerSimul = chordPatternCount / simulCount;

        oscillation = from(cum.chordOscillation) / simulCount;
        heavyHitJitter = Math.log1p(from(cum.heavyHitJitter) / simulCount);
        shapeFlux = from(cum.shapeFlux) / simulCount;
    }

    let movement = 0;
    let movementInteraction = 0;
    let movementStayed = 0;
    let stayedCount = 0;
    let movementLag2 = 0;
    let movementLag3 = 0;
    let movementLag4 = 0;
    if (simulCount > 0) {
        movement = from(cum.movement) / simulCount;
        movementInteraction = from(cum.movementInteraction) / simulCount;
        movementStayed = from(cum.movementStayed) / simulCount;
        stayedCount = from(cum.stayedCount) / simulCount;
        movementLag2 = from(cum.movementLag2) / simulCount;
        movementLag3 = from(cum.movementLag3) / simulCount;
        movementLag4 = from(cum.movementLag4) / simulCount;
    }

    const laneJack = new Float64Array(LANE_COUNT);
    for (let j = 0; j < LANE_COUNT; j++) {
        laneJack[j] = cum.laneJack[idxE * LANE_COUNT + j] - cum.laneJack[idxS * LANE_COUNT + j];
    }
    let jack = 0;
    for (let j = 0; j < LANE_COUNT; j++) jack += laneJack[j];

    let jackMean = 0;
    {
        let sum = 0;
        let count = 0;
        for (let j = 0; j < LANE_COUNT; j++) {
            if (laneJack[j] > 0) {
                sum += laneJack[j];
                count++;
            }
        }
        if (count > 0) jackMean = sum / count;
    }

    const jackChordConflictDelay = from(cum.jackChordConflictDelay);
    const jackEventCount = from(cum.isJackEvt);
    const jackChordSizeSum = from(cum.jackChordSize);
    const jackChordSizeSqSum = from(cum.jackChordSizeSq);

    let chordJackSizeMean = 0;
    let chordJackSizeCv = 0;
    if (jackEventCount > 0) {
        chordJackSizeMean = jackChordSizeSum / jackEventCount;
        let variance = jackChordSizeSqSum / jackEventCount - chordJackSizeMean * chordJackSizeMean;
        if (variance < 0) variance = 0;
        chordJackSizeCv = Math.sqrt(variance) / chordJackSizeMean;
    }

    const idx5sS = getIdx(timeEnd - 5000);
    const count5s = idxE - idx5sS;

    let ratioMean = 0;
    let ratioCv = Math.log1p(0);

    if (count5s >= 8) {
        const candidates = [];
        for (let i = idx5sS; i < idxE; i++) {
            const interval = intervals[i];
            if (interval > 5 && interval <= TIME_LIMIT) candidates.push(interval);
        }
        if (candidates.length >= 4) {
            const rounded = candidates.map((v) => roundHalfEven(v)).sort((a, b) => a - b);
            let modeInterval = 0;
            let bestCount = 0;
            let i = 0;
            while (i < rounded.length) {
                let j = i + 1;
                while (j < rounded.length && rounded[j] === rounded[i]) j++;
                const runLength = j - i;
                if (runLength > bestCount) {
                    bestCount = runLength;
                    modeInterval = rounded[i];
                }
                i = j;
            }
            if (modeInterval < 18) modeInterval = 18;

            if (idxE > idxS) {
                const ratios = [];
                for (let k = idxS; k < idxE; k++) {
                    const r = intervals[k] / modeInterval;
                    if (r <= 8 && r > 0.01) ratios.push(r);
                }
                if (ratios.length > 0) {
                    ratioMean = meanOf(ratios);
                    let variance = 0;
                    for (const r of ratios) {
                        const d = r - ratioMean;
                        variance += d * d;
                    }
                    variance /= ratios.length;
                    ratioCv = Math.log1p(Math.sqrt(variance) / (ratioMean + 1e-9));
                }
            }
        }
    }

    let driftVelocity = 0;
    let triangleGapRate = 0;
    let radiusGyration = 0;
    if (simulCount > 0) {
        driftVelocity = from(cum.centroidDrift) / simulCount;

        const movementTotal = from(cum.movement);
        if (movementTotal > 0) triangleGapRate = from(cum.triangleGap) / movementTotal;

        let gyration = 0;
        for (let j = 0; j < LANE_COUNT; j++) {
            const p = laneCounts[j] / simulCount;
            gyration += 2 * p * (1 - p);
        }
        radiusGyration = gyration;
    }

    const strikeCount40 = from(cum.clusteredStrikeCount40);
    const strikeCount = simulCount - strikeCount40;
    const strikeJitter40 = Math.log1p(
        strikeCount40 > 0 ? from(cum.clusteredStrikeJitter40) / strikeCount40 : 0);

    let staggerMean40 = 0;
    if (strikeCount40 > 0) {
        staggerMean40 = from(cum.clusteredStrikeSize40) / strikeCount40;
    }

    let driftVelocityStrike40 = 0;
    let triangleGapRateStrike40 = 0;
    let radiusGyrationStrike40 = 0;
    if (strikeCount40 > 0) {
        driftVelocityStrike40 = from(cum.driftStrike40) / strikeCount40;
        const strikeMovementTotal = from(cum.clusteredMovement40);
        if (strikeMovementTotal > 0) {
            triangleGapRateStrike40 = from(cum.gapStrike40) / strikeMovementTotal;
        }
        let gyration = 0;
        for (let j = 0; j < LANE_COUNT; j++) {
            const p = (cum.laneStrike40[idxE * LANE_COUNT + j] -
                cum.laneStrike40[idxS * LANE_COUNT + j]) / strikeCount40;
            gyration += 2 * p * (1 - p);
        }
        radiusGyrationStrike40 = gyration;
    }

    const streamActive = from(cum.streamActive);
    const streamStrokes = from(cum.streamStrokes);
    const streamCrossings = from(cum.streamCrossings);

    let streamActiveMean = 0;
    let streamStrokesRate = 0;
    let streamCrossingsRate = 0;
    if (strikeCount > 0) {
        streamActiveMean = streamActive / strikeCount;
        streamStrokesRate = streamStrokes / strikeCount;
        streamCrossingsRate = streamCrossings / strikeCount;
    }

    out[0] = buttonCount;
    out[1] = scratchCount;
    out[2] = recovery;
    out[3] = buttonScratchInteraction;
    out[4] = laneBiasEntropy;
    out[5] = rhythmJitter;
    out[6] = delayPersistence;
    out[7] = simulCount;
    out[8] = chordMean;
    out[9] = chordSizeDelta;
    out[10] = chordQ1;
    out[11] = chordQ2;
    out[12] = chordQ3;
    out[13] = chordPatternCountPerSimul;
    out[14] = oscillation;
    out[15] = heavyHitJitter;
    out[16] = shapeFlux;
    out[17] = movement;
    out[18] = movementInteraction;
    out[19] = movementStayed;
    out[20] = stayedCount;
    out[21] = movementLag2;
    out[22] = movementLag3;
    out[23] = movementLag4;
    out[24] = jack;
    out[25] = jackMean;
    out[26] = jackChordConflictDelay;
    out[27] = chordJackSizeMean;
    out[28] = chordJackSizeCv;
    out[29] = ratioMean;
    out[30] = ratioCv;
    out[31] = driftVelocity;
    out[32] = triangleGapRate;
    out[33] = radiusGyration;
    out[34] = strikeCount;
    out[35] = strikeJitter40;
    out[36] = staggerMean40;
    out[37] = driftVelocityStrike40;
    out[38] = triangleGapRateStrike40;
    out[39] = radiusGyrationStrike40;
    out[40] = streamActive;
    out[41] = streamStrokes;
    out[42] = streamCrossings;
    out[43] = streamActiveMean;
    out[44] = streamStrokesRate;
    out[45] = streamCrossingsRate;
}

/**
 * Port of BuildInferenceWindows(): 600 rows of 46 features, zero padded at the
 * front when the chart is shorter than 600 windows.
 */
export function buildInferenceWindows({ notes, total, totalNotes, songLastMs }) {
    const windows = new Float32Array(WINDOW_COUNT * FEATURE_DIM);
    const model = computeModel(notes, total, totalNotes, songLastMs);
    if (model.n === 0) return null;

    let lastMs = 0;
    if (Number.isFinite(songLastMs) && songLastMs > 0) {
        lastMs = Math.trunc(Math.min(songLastMs, 1e9));
    }

    const metas = [];
    for (let start = 0; start < lastMs; start += WINDOW_STRIDE) {
        const meta = new Float64Array(FEATURE_DIM);
        buildWindowMeta(model, start, start + WINDOW_MS, meta);
        metas.push(meta);
    }
    const count = metas.length;
    if (count === 0) return null;

    const noteCounts = new Float64Array(count);
    let lastValid = -1;
    for (let i = 0; i < count; i++) {
        const sum = F(metas[i][0]) + F(metas[i][1]);
        noteCounts[i] = sum;
        if (sum > 0) lastValid = i;
    }
    if (lastValid < 0) return null;

    const validLength = lastValid + 1;
    let startIndex = 0;
    if (validLength > WINDOW_COUNT) {
        startIndex = validLength - WINDOW_COUNT;
        let maxDensityIndex = 0;
        let best = noteCounts[0];
        for (let i = 1; i < validLength; i++) {
            if (noteCounts[i] > best) {
                best = noteCounts[i];
                maxDensityIndex = i;
            }
        }
        if (maxDensityIndex < startIndex) {
            startIndex = Math.max(0, maxDensityIndex - 10);
        }
    }

    const endIndex = Math.min(startIndex + WINDOW_COUNT, validLength);
    const finalLength = endIndex - startIndex;
    const shift = WINDOW_COUNT - finalLength;

    for (let i = 0; i < finalLength; i++) {
        for (let k = 0; k < FEATURE_DIM; k++) {
            windows[(shift + i) * FEATURE_DIM + k] = F(metas[startIndex + i][k]);
        }
    }
    return windows;
}
