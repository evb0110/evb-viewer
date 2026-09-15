/**
 * Synthetic Sentry events use this registry instead of sharing runtime
 * diagnostic definitions. Release scripts consume the JavaScript contract
 * directly, while TypeScript code re-exports it from diagnosticCodes.ts.
 */
const SENTRY_SOURCE_MAP_CANARY = Object.freeze({
    exceptionType: 'EVBViewerSourceMapCanary',
    exceptionValue: 'EVB Viewer source-map canary',
    fingerprintPrefix: 'evb-viewer-sourcemap-canary-v8',
    logger: 'evb-viewer.sourcemap-canary',
    tagKey: 'evb_canary',
    tagValue: 'sourcemap-v8',
});

export const DIAGNOSTIC_EVENT_DEFINITIONS = Object.freeze({SENTRY_SOURCE_MAP_CANARY});
