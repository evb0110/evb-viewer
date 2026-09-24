import type {
    IDebugLogEntry,
    TMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';

export type TClientDiagnosticsPreference = 'unknown' | 'granted' | 'denied';

export function parseClientDiagnosticsPreference(value: unknown): TClientDiagnosticsPreference {
    return value === 'granted' || value === 'denied' ? value : 'unknown';
}

/** The consent main passed to this window at creation, readable before settings load. */
export interface IDiagnosticsStartupPolicy {mode: TClientDiagnosticsPreference;}

/** The diagnostics capability available to renderer application code. */
export interface IDiagnosticsRendererCapability {
    startupPolicy: Readonly<IDiagnosticsStartupPolicy>;
    onDebugLog: (callback: (entry: IDebugLogEntry) => void) => TMenuEventUnsubscribe;
}
