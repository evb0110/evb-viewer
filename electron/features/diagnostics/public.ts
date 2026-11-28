export {captureMainFailure, type IMainFailureInput} from '@electron/utils/captureMainFailure';
export {
    consumeStartupCrashMarker,
    getMainDiagnosticsPreference,
    installStartupCrashMarker,
    setMainDiagnosticsPreference,
    waitForMainDiagnosticsReady,
} from '@electron/features/diagnostics/sentry';
export {
    isStartupSettingsSnapshotCurrent,
    readCompleteSettingsSync,
    readDiagnosticsPreferenceSync,
    readStartupSettingsSnapshotSync,
} from '@electron/features/diagnostics/readDiagnosticsPreferenceSync';
