/**
 * The rem base every scaled layout metric is derived from.
 *
 * `main.css` sets `html { font-size: calc(16px * var(--app-ui-scale, 1)) }`, and
 * `useUiScale` writes `--app-ui-scale` as an inline style on the document
 * element. Reading the resolved root font size therefore yields the one
 * authoritative pixel value for a rem at the user's current UI scale, including
 * host-driven auto compensation and browser zoom.
 */
export const BASE_ROOT_FONT_SIZE_PX = 16;

export function normalizeRootFontSizePx(rootFontSizePx: number) {
    return Number.isFinite(rootFontSizePx) && rootFontSizePx > 0 ? rootFontSizePx : BASE_ROOT_FONT_SIZE_PX;
}

export function readRootFontSizePx() {
    if (typeof document === 'undefined' || typeof globalThis.getComputedStyle !== 'function') {
        return BASE_ROOT_FONT_SIZE_PX;
    }

    return normalizeRootFontSizePx(Number.parseFloat(globalThis.getComputedStyle(document.documentElement).fontSize));
}
