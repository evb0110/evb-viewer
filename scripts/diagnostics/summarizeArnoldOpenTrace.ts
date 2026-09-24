function readFiniteNumber(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readByteLength(value: unknown) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
}

export function summarizeArnoldOpenTrace(
    renderTrace: ReadonlyArray<{
        event: string;
        payload: Record<string, unknown>;
    }>,
) {
    const find = (event: string, predicate?: (payload: Record<string, unknown>) => boolean) => (
        renderTrace.find(entry => entry.event === event && (predicate?.(entry.payload) ?? true))
    );
    const claim = find('viewport-session-open-requested') ?? find('pdf-open-direct-start');
    const claimAtMs = readFiniteNumber(claim?.payload.traceAtMs);
    const elapsed = (event: string, predicate?: (payload: Record<string, unknown>) => boolean) => {
        const atMs = readFiniteNumber(find(event, predicate)?.payload.traceAtMs);
        return claimAtMs === null || atMs === null ? null : Math.max(0, atMs - claimAtMs);
    };
    const validationEnd = find('pdf-open-validate-end');
    const requestedByteTotal = renderTrace
        .filter(entry => entry.event === 'pdf-document-range-request')
        .reduce((total, entry) => total + (readByteLength(entry.payload.length) ?? 0), 0);
    return {
        validationCacheResult: typeof validationEnd?.payload.cacheResult === 'string'
            ? validationEnd.payload.cacheResult
            : null,
        pdfjsRequestedByteTotal: requestedByteTotal,
        milestonesMs: {
            openingClaim: claimAtMs === null ? null : 0,
            validationStart: elapsed('pdf-open-validate-start'),
            validationEnd: elapsed('pdf-open-validate-end'),
            pdfjsSubmit: elapsed('pdf-document-get-document-submit'),
            pdfjsResolve: elapsed('pdf-document-get-document-resolve'),
            firstPdfjsCanvas: elapsed('renderer-canvas-mounted'),
        },
    };
}
