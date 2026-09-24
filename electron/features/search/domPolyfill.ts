// Minimal stubs for browser-only globals used by pdfjs-dist at module evaluation
// time (e.g. `var SCALE_MATRIX = new DOMMatrix()` in canvas rendering code).
// These stubs must be in place before pdfjs-dist is imported.
// Text extraction never invokes the canvas rendering path, so the stubs
// only need to prevent ReferenceErrors — they don't need real implementations.

if (typeof globalThis.DOMMatrix === 'undefined') {
    Object.defineProperty(globalThis, 'DOMMatrix', {
        value: class {
            preMultiplySelf() { return this; }
            multiply() { return this; }
            invertSelf() { return this; }
            inverse() { return this; }
            translate() { return this; }
            scale() { return this; }
        },
        configurable: true,
        writable: true,
    });
}
