function readPositivePixels(value: string | undefined) {
    if (!value?.endsWith('px')) {
        return null;
    }
    const number = Number.parseFloat(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * Creates geometry only after trusted or authoritative raw page metrics exist.
 * Fit dimensions are viewport-derived and uncapped; the exact page ratio comes
 * from those metrics, so the opening record never fabricates paper geometry.
 */
export function buildPdfCommittedOpenPageShellStyle(input: {pageStyle: Record<string, string> | null}) {
    const rawWidth = readPositivePixels(input.pageStyle?.width);
    const rawHeight = readPositivePixels(input.pageStyle?.height);
    if (rawWidth === null || rawHeight === null) {
        // A cold open keeps the committed empty surface. Exposing a guessed
        // paper ratio would necessarily resize for non-A-series documents.
        return null;
    }
    // This must be the exact canonical style used by the live page wrapper.
    // Applying another viewport gutter here double-subtracts the viewer's own
    // padding and guarantees a shell-to-canvas resize on the following frame.
    return {
        width: `${String(rawWidth)}px`,
        height: `${String(rawHeight)}px`,
    } as const;
}
