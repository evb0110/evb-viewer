// The smallest module that uses a SIMD128 instruction; the engine needs SIMD.
const WASM_SIMD_PROBE = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

export function canStoreBrowserOcrModels() {
    return typeof caches !== 'undefined' && typeof crypto?.subtle !== 'undefined';
}

/** Why this browser cannot run the engine, or null when it can. */
export function findBrowserOcrUnsupportedReason() {
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
        return 'This browser cannot run the OCR engine (it needs Web Workers and WebAssembly).';
    }
    if (!WebAssembly.validate(WASM_SIMD_PROBE)) {
        return 'This browser cannot run the OCR engine (it needs WebAssembly SIMD); update the browser or use the desktop app.';
    }
    if (!canStoreBrowserOcrModels()) {
        return 'This browser cannot store OCR language models here (Cache Storage is unavailable, for example in a private window).';
    }
    return null;
}

export function canUseBrowserOcr() {
    return findBrowserOcrUnsupportedReason() === null;
}
