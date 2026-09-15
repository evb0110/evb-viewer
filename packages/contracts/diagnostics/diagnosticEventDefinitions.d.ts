export interface SentrySourceMapCanaryDefinition {
    readonly exceptionType: 'EVBViewerSourceMapCanary';
    readonly exceptionValue: 'EVB Viewer source-map canary';
    readonly fingerprintPrefix: 'evb-viewer-sourcemap-canary-v8';
    readonly logger: 'evb-viewer.sourcemap-canary';
    readonly tagKey: 'evb_canary';
    readonly tagValue: 'sourcemap-v8';
}

export interface DiagnosticEventDefinitions {readonly SENTRY_SOURCE_MAP_CANARY: SentrySourceMapCanaryDefinition;}

export declare const DIAGNOSTIC_EVENT_DEFINITIONS: DiagnosticEventDefinitions;
