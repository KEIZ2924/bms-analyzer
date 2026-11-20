// Port of plugins/BmsInfo/difficulty/DifficultyNet.cpp + DifficultyMap.cpp.
//
// models/difficulty.bin holds a few of the 25 ONNX folds in a compact form (see
// tools/export_weights.py in the plugin repo): int8 weights with one scale per
// tensor, float32 biases.  Their predictions are combined with the same
// IQR-trimmed mean the plugin uses, so the level matches the in-game "sl/st".

const MAGIC = "BMSD";
const ROW_COUNT = 600;
const FEATURE_DIM = 46;
const ENCODER0 = 512;
const ENCODER1 = 512;
const PREDICTOR0 = 256;
const PREDICTOR1 = 64;
const CONV_CHANNELS = 6;
const DILATIONS = [1, 4, 12, 36, 108, 324];

/** Tensor order inside the blob, mirroring tools/export_weights.py. */
const TENSOR_SHAPES = [
    [46, 512], [512],
    [512, 512], [512],
    [512, 256], [256],
    [256, 64], [64],
    [64, 1], [1],
    // the first conv sees one channel, every later one sees six
    [6, 1, 3], [6],
    [6, 6, 3], [6],
    [6, 6, 3], [6],
    [6, 6, 3], [6],
    [6, 6, 3], [6],
    [6, 6, 3], [6],
    [6], [1],
];

function sigmoid(value) {
    return 1 / (1 + Math.exp(-value));
}

function roundHalfEven(value) {
    const floor = Math.floor(value);
    const diff = value - floor;
    if (diff > 0.5) return floor + 1;
    if (diff < 0.5) return floor;
    return floor % 2 === 0 ? floor : floor + 1;
}

class Reader {
    constructor(buffer) {
        this.view = new DataView(buffer);
        this.offset = 0;
    }

    u8() {
        const value = this.view.getUint8(this.offset);
        this.offset += 1;
        return value;
    }

    f32() {
        const value = this.view.getFloat32(this.offset, true);
        this.offset += 4;
        return value;
    }

    f32Array(count) {
        const out = new Float32Array(count);
        for (let i = 0; i < count; i++) out[i] = this.f32();
        return out;
    }

    tensor(count) {
        const kind = this.u8();
        if (kind === 0) return this.f32Array(count);
        const scale = this.f32();
        const out = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const raw = this.view.getInt8(this.offset + i);
            out[i] = raw * scale;
        }
        this.offset += count;
        return out;
    }
}

/** y = x @ w + b, w stored row-major as [inDim][outDim]. */
function linear(x, rows, inDim, outDim, w, b, out, relu) {
    for (let r = 0; r < rows; r++) {
        const xo = r * inDim;
        const yo = r * outDim;
        out.set(b, yo);
        for (let i = 0; i < inDim; i++) {
            const value = x[xo + i];
            if (value === 0) continue;
            const wo = i * outDim;
            for (let o = 0; o < outDim; o++) out[yo + o] += value * w[wo + o];
        }
        if (relu) {
            for (let o = 0; o < outDim; o++) if (out[yo + o] < 0) out[yo + o] = 0;
        }
    }
}

/** Time-major convolution with the plugin's same-length, zero padded layout. */
function conv1d(input, inChannels, length, weight, bias, outChannels, dilation, out) {
    const pad = dilation;
    const kernel = 3;
    for (let o = 0; o < outChannels; o++) {
        for (let t = 0; t < length; t++) out[t * outChannels + o] = bias[o];
        for (let i = 0; i < inChannels; i++) {
            for (let k = 0; k < kernel; k++) {
                const w = weight[(o * inChannels + i) * kernel + k];
                const offset = k * dilation - pad;
                const begin = Math.max(0, -offset);
                const end = Math.min(length, length - offset);
                for (let t = begin; t < end; t++) {
                    out[t * outChannels + o] += w * input[(t + offset) * inChannels + i];
                }
            }
        }
        for (let t = 0; t < length; t++) {
            const index = t * outChannels + o;
            if (out[index] < 0) out[index] = 0;
        }
    }
}

function runModel(model, windows, scratch) {
    const { norm, h1, h2, h3, h4, sig, convA, convB, attn } = scratch;

    for (let r = 0; r < ROW_COUNT; r++) {
        for (let f = 0; f < FEATURE_DIM; f++) {
            let value = windows[r * FEATURE_DIM + f] / model.add[f];
            if (value < model.clipMin) value = model.clipMin;
            if (value > model.clipMax) value = model.clipMax;
            norm[r * FEATURE_DIM + f] = value;
        }
    }

    linear(norm, ROW_COUNT, FEATURE_DIM, ENCODER0, model.w1, model.b1, h1, true);
    linear(h1, ROW_COUNT, ENCODER0, ENCODER1, model.w2, model.b2, h2, true);
    linear(h2, ROW_COUNT, ENCODER1, PREDICTOR0, model.w3, model.b3, h3, true);
    linear(h3, ROW_COUNT, PREDICTOR0, PREDICTOR1, model.w4, model.b4, h4, true);
    linear(h4, ROW_COUNT, PREDICTOR1, 1, model.w5, model.b5, sig, false);
    for (let t = 0; t < ROW_COUNT; t++) sig[t] = sigmoid(sig[t]);

    let current = sig;
    let channels = 1;
    for (let i = 0; i < 6; i++) {
        const target = i % 2 === 0 ? convA : convB;
        conv1d(current, channels, ROW_COUNT, model.convWeights[i], model.convBiases[i],
            CONV_CHANNELS, DILATIONS[i], target);
        current = target;
        channels = CONV_CHANNELS;
    }

    let maxAttention = -1e30;
    for (let t = 0; t < ROW_COUNT; t++) {
        let value = model.headBias[0];
        for (let c = 0; c < CONV_CHANNELS; c++) value += model.headWeight[c] * current[t * CONV_CHANNELS + c];
        attn[t] = value;
        if (value > maxAttention) maxAttention = value;
    }

    let sum = 0;
    for (let t = 0; t < ROW_COUNT; t++) {
        const value = Math.exp(attn[t] - maxAttention);
        attn[t] = value;
        sum += value;
    }
    let result = 0;
    for (let t = 0; t < ROW_COUNT; t++) result += (attn[t] / sum) * sig[t];
    return result;
}

function percentile(sorted, p) {
    const position = (sorted.length - 1) * p;
    const base = Math.trunc(position);
    const rest = position - base;
    if (base + 1 < sorted.length) {
        return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    }
    return sorted[base];
}

/** IQR-trimmed mean of the fold predictions, as in DifficultyNet.cpp. */
function iqrMean(predictions) {
    if (predictions.length === 0) return 0;
    if (predictions.length <= 2) {
        return predictions.reduce((a, b) => a + b, 0) / predictions.length;
    }
    const sorted = Float32Array.from(predictions).sort();
    const q1 = percentile(sorted, 0.25);
    const q3 = percentile(sorted, 0.75);
    const iqr = Math.max(q3 - q1, 0.02);
    const lower = q1 - 1.5 * iqr;
    const upper = q3 + 1.5 * iqr;
    let sum = 0;
    let count = 0;
    for (const value of predictions) {
        if (value >= lower && value <= upper) {
            sum += value;
            count += 1;
        }
    }
    return count > 0 ? sum / count : 0;
}

/** Port of MapDifficultyScore(): the sl/st ladder the plugin prints. */
export function mapDifficultyScore(value) {
    const totalDiv = 27;
    const slOffset = 1;
    const stOffset = 14;
    const y = Math.max(0, Math.min(1, value));

    const thresholdSlMinus = 0.5 / totalDiv;
    const thresholdStStart = 13.5 / totalDiv;
    const thresholdStPlus = 26.5 / totalDiv;

    if (y < thresholdSlMinus) {
        return { table: "sl-", display: "sl-", label: "sl-", subLabel: "sl-", level: null };
    }

    let prefix = "sl";
    let rawValue = y * totalDiv - slOffset;
    if (y >= thresholdStStart) {
        if (y >= thresholdStPlus) {
            return { table: "st+", display: "st+", label: "st+", subLabel: "st+", level: null };
        }
        prefix = "st";
        rawValue = y * totalDiv - stOffset;
    }

    const level = roundHalfEven(rawValue * 10) === 0 ? 0 : rawValue;
    const base = Math.trunc(rawValue + 0.5);
    const remainder = rawValue - base;
    const suffix = remainder < -0.2 ? "-" : remainder >= 0.2 ? "+" : "";

    return {
        table: prefix,
        level,
        display: `${prefix}${level.toFixed(1)}`,
        label: `${prefix}${roundHalfEven(level)}`,
        subLabel: `${prefix}${base}${suffix}`,
    };
}

/** Loads models/difficulty.bin and returns a scorer. */
export async function loadDifficultyModel(url = "models/difficulty.bin") {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`cannot load ${url}: ${response.status}`);
    return loadDifficultyFromBuffer(await response.arrayBuffer());
}

/** Same as loadDifficultyModel but takes the blob bytes directly (used by tools). */
export function loadDifficultyFromBuffer(buffer, { limit = 0 } = {}) {
    const reader = new Reader(buffer);

    const magic = String.fromCharCode(reader.u8(), reader.u8(), reader.u8(), reader.u8());
    if (magic !== MAGIC) throw new Error("unexpected model blob");
    const version = reader.u8();
    if (version !== 1) throw new Error(`unsupported model version ${version}`);
    const modelCount = reader.u8();

    const models = [];
    for (let i = 0; i < modelCount; i++) {
        const model = {
            add: reader.f32Array(FEATURE_DIM),
            clipMin: reader.f32(),
            clipMax: reader.f32(),
            convWeights: [],
            convBiases: [],
        };
        const shapes = TENSOR_SHAPES.slice();
        const tensors = shapes.map((shape) => {
            const count = shape.reduce((a, b) => a * b, 1);
            return reader.tensor(count);
        });
        model.w1 = tensors[0];
        model.b1 = tensors[1];
        model.w2 = tensors[2];
        model.b2 = tensors[3];
        model.w3 = tensors[4];
        model.b3 = tensors[5];
        model.w4 = tensors[6];
        model.b4 = tensors[7];
        model.w5 = tensors[8];
        model.b5 = tensors[9];
        for (let c = 0; c < 6; c++) {
            model.convWeights.push(tensors[10 + c * 2]);
            model.convBiases.push(tensors[11 + c * 2]);
        }
        model.headWeight = tensors[22];
        model.headBias = tensors[23];
        models.push(model);
    }

    if (limit > 0 && limit < models.length) models.length = limit;

    const scratch = {
        norm: new Float32Array(ROW_COUNT * FEATURE_DIM),
        h1: new Float32Array(ROW_COUNT * ENCODER0),
        h2: new Float32Array(ROW_COUNT * ENCODER1),
        h3: new Float32Array(ROW_COUNT * PREDICTOR0),
        h4: new Float32Array(ROW_COUNT * PREDICTOR1),
        sig: new Float32Array(ROW_COUNT),
        convA: new Float32Array(ROW_COUNT * CONV_CHANNELS),
        convB: new Float32Array(ROW_COUNT * CONV_CHANNELS),
        attn: new Float32Array(ROW_COUNT),
    };

    return {
        modelCount,
        /** Returns { raw, ...mapped } for a 600x46 window matrix. */
        score(windows) {
            const predictions = models.map((model) => runModel(model, windows, scratch));
            const raw = iqrMean(predictions);
            return { raw, ...mapDifficultyScore(raw), predictions };
        },
    };
}
