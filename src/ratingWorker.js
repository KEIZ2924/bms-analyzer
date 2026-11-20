// Runs the sl/st network off the main thread: one chart at a time, because a
// pass is a few hundred milliseconds and blocking the UI for that long on every
// row would make a folder drop feel broken.

import { loadDifficultyModel } from "./difficulty.js";

let modelPromise = null;

self.onmessage = async (event) => {
    const { id, windows } = event.data;
    // Relative to this module, not to the page: the worker lives in src/.
    modelPromise ??= loadDifficultyModel(new URL("../models/difficulty.bin", import.meta.url));

    try {
        const model = await modelPromise;
        const result = model.score(new Float32Array(windows));
        self.postMessage({
            id,
            ok: true,
            raw: result.raw,
            table: result.table,
            display: result.display,
            label: result.label,
            subLabel: result.subLabel,
            modelCount: model.modelCount,
        });
    } catch (error) {
        self.postMessage({ id, ok: false, error: String(error?.message || error) });
    }
};
