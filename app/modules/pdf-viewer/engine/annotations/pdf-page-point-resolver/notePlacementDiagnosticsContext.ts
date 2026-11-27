export interface INotePlacementDiagnosticsContext {
    attemptId?: string;
    source?: string;
    clickCapturedAtMs?: number;
    clickMeta?: Record<string, unknown>;
}
